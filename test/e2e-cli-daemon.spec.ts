import { execFile, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connectAgent, loadKeyFromText } from '../src/browser/index.js';
import { startTestSshServer } from './helpers/testSshServer.js';

const execFileAsync = promisify(execFile);

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distBinPath = join(repoRoot, 'dist', 'bin', 'bssh-agent.js');
const distWidgetPath = join(repoRoot, 'dist', 'widget', 'index.js');

const fixtureDir = fileURLToPath(new URL('./fixtures/', import.meta.url));
const readFixture = (name: string) => readFileSync(fixtureDir + name, 'utf8');

function runCli(args: string[]): { stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [distBinPath, ...args], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`bssh-agent exited ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

function parseField(text: string, pattern: RegExp): string {
  const match = text.match(pattern);
  if (!match) throw new Error(`pattern ${pattern} not found in:\n${text}`);
  return match[1];
}

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!check()) throw new Error('waitFor: condition never became true');
}

/**
 * This file execs the real compiled `dist/bin/bssh-agent.js` (Node can't run
 * `.ts` directly the way vitest's in-process transform does for every other
 * spec), so it requires `npm run build` first — run via `npm run test:cli`,
 * not the default `npm test`. It's excluded from `vitest.config.ts`'s
 * `include` glob for that reason; `describe.skipIf` below also degrades
 * gracefully if this file is ever targeted directly without a prior build.
 */
describe.skipIf(!existsSync(distBinPath))('bssh-agent CLI daemon (built binary)', () => {
  let runtimeDir: string;

  beforeEach(() => {
    runtimeDir = mkdtempSync(join(tmpdir(), 'bssh-agent-e2e-'));
  });

  afterEach(() => {
    rmSync(runtimeDir, { recursive: true, force: true });
  });

  it(
    'eval-able output pairs a real browser session and serves ssh-add/ssh over the real SSH_AUTH_SOCK, then -k tears it down',
    async () => {
      const started = runCli(['--runtime-dir', runtimeDir, '--no-browser', '--name', 'combined']);

      const sshAuthSock = parseField(started.stdout, /^SSH_AUTH_SOCK=(.+); export SSH_AUTH_SOCK;$/m);
      const agentPid = Number(parseField(started.stdout, /^SSH_AGENT_PID=(\d+); export SSH_AGENT_PID;$/m));
      const pairingUrlRaw = parseField(started.stderr, /^Pairing URL: (.+)$/m);
      const pairingUrl = new URL(pairingUrlRaw);
      const token = new URLSearchParams(pairingUrl.hash.slice(1)).get('token');
      expect(token).toBeTruthy();

      const wsUrl = `ws://${pairingUrl.hostname}:${pairingUrl.port}/ws`;

      // Regression check tying the CLI's self-served pairing page to the
      // built widget bundle it depends on at runtime.
      const pageResponse = await fetch(`${pairingUrl.origin}/`);
      expect(pageResponse.headers.get('content-security-policy')).toBe("script-src 'self'");
      const widgetResponse = await fetch(`${pairingUrl.origin}/widget.js`);
      const servedWidgetJs = await widgetResponse.text();
      expect(servedWidgetJs).toBe(readFileSync(distWidgetPath, 'utf8'));

      // Act as "the browser": drive connectAgent() from Node, exactly like
      // the other e2e tests do, using the token/wsUrl the CLI just printed.
      const key = await loadKeyFromText(readFixture('id_ed25519_plain'), '');
      const connection = connectAgent({ wsUrl, token: token!, key });
      await new Promise<void>((resolve, reject) => {
        connection.on('status', (status) => {
          if (status === 'paired') resolve();
        });
        connection.on('error', reject);
      });

      const { stdout: sshAddOut } = await execFileAsync('ssh-add', ['-l'], {
        env: { ...process.env, SSH_AUTH_SOCK: sshAuthSock },
      });
      expect(sshAddOut).toContain('test-plain@fixture');

      const sshServer = await startTestSshServer(readFixture('id_ed25519_plain.pub'));
      try {
        await expect(
          execFileAsync(
            'ssh',
            [
              '-F',
              '/dev/null',
              '-o',
              'StrictHostKeyChecking=no',
              '-o',
              'UserKnownHostsFile=/dev/null',
              '-o',
              'BatchMode=yes',
              '-o',
              'PreferredAuthentications=publickey',
              '-p',
              String(sshServer.port),
              'testuser@127.0.0.1',
              'true',
            ],
            { env: { ...process.env, SSH_AUTH_SOCK: sshAuthSock }, timeout: 10_000 }
          )
        ).resolves.toBeTruthy();
      } finally {
        await sshServer.close();
      }

      connection.close();

      const killed = runCli(['-k', '--runtime-dir', runtimeDir, '--name', 'combined']);
      expect(killed.stdout).toBe(`unset SSH_AUTH_SOCK;\nunset SSH_AGENT_PID;\necho Agent pid ${agentPid} killed;\n`);

      // -k sends SIGTERM and returns immediately (fire-and-forget, matching
      // real ssh-agent -k) — the daemon's own async shutdown/cleanup may
      // still be in flight, so poll briefly rather than asserting instantly.
      await waitFor(() => {
        try {
          process.kill(agentPid, 0);
          return false;
        } catch {
          return true;
        }
      });
      await waitFor(() => !existsSync(sshAuthSock));
    },
    20_000
  );
});
