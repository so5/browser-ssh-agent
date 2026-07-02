import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const fixtureDir = fileURLToPath(new URL('./fixtures/', import.meta.url));

function generateKey(name: string, passphrase: string, comment: string): void {
  execFileSync('ssh-keygen', [
    '-t', 'ed25519',
    '-N', passphrase,
    '-C', comment,
    '-f', fixtureDir + name,
    '-q',
  ]);
}

/**
 * Test fixture SSH keys are generated fresh here rather than committed to
 * git: they're throwaway (no real system trusts them), but a committed
 * `-----BEGIN OPENSSH PRIVATE KEY-----` block is exactly what secret
 * scanners are built to flag, and it invites confused vulnerability reports
 * for what is actually harmless. `test/fixtures/` is gitignored — this runs
 * once before the whole suite (see `vitest.config.ts`'s `globalSetup`).
 */
export default function setup(): void {
  if (existsSync(fixtureDir)) {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
  mkdirSync(fixtureDir, { recursive: true });

  generateKey('id_ed25519_enc', 'correct horse battery staple', 'test-encrypted@fixture');
  generateKey('id_ed25519_plain', '', 'test-plain@fixture');
  generateKey('host_key', '', 'test-host-key');
}
