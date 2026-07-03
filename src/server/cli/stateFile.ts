import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface AgentState {
  pid: number;
  socketPath: string;
  wsPort: number;
  startedAt: number;
}

/** `name` defaults to `"default"` (see `--name`) — keyed from day one even though multi-instance UX isn't polished in v1. */
export function statePath(runtimeDir: string, name: string): string {
  return join(runtimeDir, `agent-${name}.json`);
}

export function writeState(runtimeDir: string, name: string, state: AgentState): void {
  writeFileSync(statePath(runtimeDir, name), JSON.stringify(state), { mode: 0o600 });
}

export function readState(runtimeDir: string, name: string): AgentState | null {
  const path = statePath(runtimeDir, name);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as AgentState;
  } catch {
    return null;
  }
}

export function removeState(runtimeDir: string, name: string): void {
  const path = statePath(runtimeDir, name);
  if (existsSync(path)) {
    try {
      unlinkSync(path);
    } catch {
      // Best-effort cleanup — nothing more useful to do if this fails.
    }
  }
}

/** `process.kill(pid, 0)` liveness probe — throws ESRCH if the pid is dead, EPERM if it's alive but owned by another user. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
