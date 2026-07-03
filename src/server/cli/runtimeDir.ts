import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Where daemon state files (`stateFile.ts`) live. Unlike real `ssh-agent`
 * (which has no persistent state — it relies solely on `SSH_AGENT_PID` in
 * the shell that spawned it), `bssh-agent -k` must find a running daemon
 * from a *different* shell session, so it needs a well-known directory.
 */
export function resolveRuntimeDir(override?: string): string {
  if (override) return override;
  if (process.env.BSSH_AGENT_RUNTIME_DIR) return process.env.BSSH_AGENT_RUNTIME_DIR;
  if (process.env.XDG_RUNTIME_DIR) return join(process.env.XDG_RUNTIME_DIR, 'bssh-agent');
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'nouid';
  return join(tmpdir(), `bssh-agent-${uid}`);
}

export function ensureRuntimeDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}
