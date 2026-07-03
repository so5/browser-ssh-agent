#!/usr/bin/env node
import { type ChildProcess, spawn } from 'node:child_process';
import { closeSync, openSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPairingHttpServer } from '../server/cli/pairingPage.js';
import { looksLikeRemoteSession, openBrowser } from '../server/cli/openBrowser.js';
import { ensureRuntimeDir, resolveRuntimeDir } from '../server/cli/runtimeDir.js';
import { type AgentState, isPidAlive, readState, removeState, writeState } from '../server/cli/stateFile.js';
import { AgentServer } from '../server/agentServer.js';
import { formatAgentKillScript, formatAgentStartScript } from '../server/shellEnv.js';

interface CliOptions {
  kill: boolean;
  foreground: boolean;
  name: string;
  force: boolean;
  noBrowser: boolean;
  runtimeDir?: string;
  port: number;
  help: boolean;
}

const HELP_TEXT = `usage: bssh-agent [options]
       bssh-agent -k

Starts a browser-ssh-agent daemon and prints shell export commands for
SSH_AUTH_SOCK, mirroring real ssh-agent's own UX:

    eval "$(bssh-agent)"

Options:
  -D, --foreground   run in the foreground instead of daemonizing
  -k, --kill         kill the running agent (by --name) and unset its env vars
      --name <name>  agent instance name, for running more than one (default: "default")
      --force        replace an already-running agent with the same --name
      --no-browser   don't try to open the pairing URL in a browser
      --port <n>     pairing HTTP/WS port (default: 0, i.e. an ephemeral port)
      --runtime-dir <dir>  where state files live (default: $XDG_RUNTIME_DIR/bssh-agent or a tmpdir)
  -h, --help         show this help
`;

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    kill: false,
    foreground: false,
    name: 'default',
    force: false,
    noBrowser: false,
    port: 0,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '-k':
      case '--kill':
        opts.kill = true;
        break;
      case '-D':
      case '--foreground':
        opts.foreground = true;
        break;
      case '--force':
        opts.force = true;
        break;
      case '--no-browser':
        opts.noBrowser = true;
        break;
      case '--name':
        opts.name = argv[++i] ?? opts.name;
        break;
      case '--runtime-dir':
        opts.runtimeDir = argv[++i];
        break;
      case '--port':
        opts.port = Number(argv[++i] ?? '0');
        break;
      case '-h':
      case '--help':
        opts.help = true;
        break;
      default:
        process.stderr.write(`bssh-agent: unknown argument: ${arg}\n`);
        process.exitCode = 1;
        opts.help = true;
        return opts;
    }
  }
  return opts;
}

function resolveWidgetDistPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', 'widget', 'index.js');
}

interface StartResult {
  ok: boolean;
  error?: string;
  state?: AgentState;
  pairingUrl?: string;
}

/**
 * Shared core for both daemonized and `-D`/`--foreground` operation: starts
 * `AgentServer`, the self-served pairing page (the CLI has no host app to
 * point `createPairingLink()` at, unlike a library consumer), writes the
 * state file `-k` later needs to find this process again, and installs
 * signal handlers that own shutdown/cleanup regardless of who triggers it.
 */
async function startAgent(runtimeDir: string, opts: CliOptions): Promise<StartResult> {
  const existing = readState(runtimeDir, opts.name);
  if (existing && isPidAlive(existing.pid) && !opts.force) {
    return {
      ok: false,
      error: `an agent named "${opts.name}" is already running (pid ${existing.pid}); use --force to replace it`,
    };
  }

  const agentServer = new AgentServer();
  const socketPath = await agentServer.startUnixSocket();
  const httpServer = createPairingHttpServer({ widgetJsPath: resolveWidgetDistPath() });
  agentServer.attachTo(httpServer, '/ws');

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(opts.port, '127.0.0.1', () => resolve());
  });

  const address = httpServer.address();
  const wsPort = typeof address === 'object' && address ? address.port : opts.port;
  const state: AgentState = { pid: process.pid, socketPath, wsPort, startedAt: Date.now() };
  writeState(runtimeDir, opts.name, state);

  const { url } = agentServer.createPairingLink(`http://127.0.0.1:${wsPort}/`);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await agentServer.stop();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    removeState(runtimeDir, opts.name);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());

  return { ok: true, state, pairingUrl: url };
}

function printSuccess(result: StartResult, opts: CliOptions): void {
  if (!result.ok || !result.state) return;
  process.stdout.write(formatAgentStartScript({ sshAuthSock: result.state.socketPath, agentPid: result.state.pid }));
  process.stderr.write(`Pairing URL: ${result.pairingUrl}\n`);
  if (!opts.noBrowser && !looksLikeRemoteSession() && result.pairingUrl) {
    openBrowser(result.pairingUrl);
  }
}

async function runForeground(runtimeDir: string, opts: CliOptions): Promise<void> {
  const result = await startAgent(runtimeDir, opts);
  if (!result.ok) {
    process.stderr.write(`bssh-agent: ${result.error}\n`);
    process.exitCode = 1;
    return;
  }
  printSuccess(result, opts);
  // startAgent()'s own SIGTERM/SIGINT handlers call process.exit() for us.
  await new Promise(() => {});
}

async function runDaemonChild(runtimeDir: string, opts: CliOptions): Promise<void> {
  const result = await startAgent(runtimeDir, opts);
  if (!process.send) {
    // Only reachable if BSSH_AGENT_DAEMON_CHILD was set without an IPC
    // channel (e.g. a manual invocation) — degrade to foreground-style output.
    if (!result.ok) process.stderr.write(`bssh-agent: ${result.error}\n`);
    else printSuccess(result, opts);
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (!result.ok) {
    process.send({ ok: false, error: result.error }, () => process.exit(1));
    return;
  }
  process.send({ ok: true, state: result.state, pairingUrl: result.pairingUrl });
  // Keep running — the process stays alive until SIGTERM/SIGINT.
}

interface DaemonReadyMessage {
  ok: boolean;
  error?: string;
  state?: AgentState;
  pairingUrl?: string;
}

function runLauncher(runtimeDir: string, opts: CliOptions): void {
  const thisFile = fileURLToPath(import.meta.url);
  const logPath = join(runtimeDir, `agent-${opts.name}.log`);
  const logFd = openSync(logPath, 'a');

  const forwardedArgs = ['--name', opts.name, '--port', String(opts.port), '--runtime-dir', runtimeDir];
  if (opts.force) forwardedArgs.push('--force');
  if (opts.noBrowser) forwardedArgs.push('--no-browser');

  let child: ChildProcess;
  try {
    child = spawn(process.execPath, [thisFile, ...forwardedArgs], {
      detached: true,
      stdio: ['ignore', logFd, logFd, 'ipc'],
      env: { ...process.env, BSSH_AGENT_DAEMON_CHILD: '1' },
    });
  } finally {
    closeSync(logFd);
  }

  const timeout = setTimeout(() => {
    process.stderr.write('bssh-agent: timed out waiting for the agent to start\n');
    child.kill();
    process.exitCode = 1;
  }, 5000);

  child.once('message', (msg: DaemonReadyMessage) => {
    clearTimeout(timeout);
    if (!msg.ok || !msg.state) {
      process.stderr.write(`bssh-agent: ${msg.error}\n`);
      process.exitCode = 1;
      child.disconnect();
      return;
    }
    printSuccess({ ok: true, state: msg.state, pairingUrl: msg.pairingUrl }, opts);
    child.disconnect();
    child.unref();
  });

  child.once('error', (err) => {
    clearTimeout(timeout);
    process.stderr.write(`bssh-agent: failed to start agent: ${err.message}\n`);
    process.exitCode = 1;
  });
}

function runKill(runtimeDir: string, name: string): void {
  const state = readState(runtimeDir, name);
  if (!state) {
    process.stderr.write('bssh-agent: no agent running\n');
    process.exitCode = 1;
    return;
  }

  if (isPidAlive(state.pid)) {
    process.kill(state.pid, 'SIGTERM');
  }
  try {
    unlinkSync(state.socketPath);
  } catch {
    // Best-effort — the daemon's own shutdown handler also cleans this up.
  }
  removeState(runtimeDir, name);
  process.stdout.write(formatAgentKillScript(state.pid));
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    process.stderr.write(HELP_TEXT);
    return;
  }

  const runtimeDir = resolveRuntimeDir(opts.runtimeDir);
  ensureRuntimeDir(runtimeDir);

  if (opts.kill) {
    runKill(runtimeDir, opts.name);
    return;
  }

  if (process.env.BSSH_AGENT_DAEMON_CHILD === '1') {
    await runDaemonChild(runtimeDir, opts);
    return;
  }

  if (opts.foreground) {
    await runForeground(runtimeDir, opts);
    return;
  }

  runLauncher(runtimeDir, opts);
}

main().catch((err) => {
  process.stderr.write(`bssh-agent: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
