import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isPidAlive, readState, removeState, statePath, writeState } from '../../src/server/cli/stateFile.js';

describe('stateFile', () => {
  let runtimeDir: string;

  beforeEach(() => {
    runtimeDir = mkdtempSync(join(tmpdir(), 'bssh-agent-statefile-test-'));
  });

  afterEach(() => {
    rmSync(runtimeDir, { recursive: true, force: true });
  });

  it('round-trips write/read/remove', () => {
    const state = { pid: process.pid, socketPath: '/tmp/x.sock', wsPort: 1234, startedAt: Date.now() };
    writeState(runtimeDir, 'default', state);

    expect(readState(runtimeDir, 'default')).toEqual(state);

    removeState(runtimeDir, 'default');
    expect(readState(runtimeDir, 'default')).toBeNull();
  });

  it('keys state files by name', () => {
    writeState(runtimeDir, 'a', { pid: 1, socketPath: '/a.sock', wsPort: 1, startedAt: 0 });
    writeState(runtimeDir, 'b', { pid: 2, socketPath: '/b.sock', wsPort: 2, startedAt: 0 });

    expect(readState(runtimeDir, 'a')?.socketPath).toBe('/a.sock');
    expect(readState(runtimeDir, 'b')?.socketPath).toBe('/b.sock');
    expect(statePath(runtimeDir, 'a')).not.toBe(statePath(runtimeDir, 'b'));
  });

  it('returns null for a missing state file', () => {
    expect(readState(runtimeDir, 'nonexistent')).toBeNull();
  });

  it('returns null for a corrupt state file', () => {
    writeState(runtimeDir, 'default', { pid: 1, socketPath: '/x.sock', wsPort: 1, startedAt: 0 });
    const path = statePath(runtimeDir, 'default');
    writeFileSync(path, 'not json');
    expect(readState(runtimeDir, 'default')).toBeNull();
  });

  it('detects a live pid and a stale (dead) pid', () => {
    expect(isPidAlive(process.pid)).toBe(true);

    // A pid essentially guaranteed not to exist right now.
    expect(isPidAlive(999_999)).toBe(false);
  });

  it('removeState is a no-op when nothing is there', () => {
    expect(() => removeState(runtimeDir, 'never-written')).not.toThrow();
  });
});
