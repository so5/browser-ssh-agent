import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { encodeBase64 } from '../src/shared/base64.js';
import { encodeEd25519PublicKeyBlob } from '../src/shared/sshWire.js';
import { parseOpenSshPrivateKeyPem } from '../src/browser/keyImport/opensshKey.js';
import { decryptOpenSshEd25519Key } from '../src/browser/keyImport/decrypt.js';

const fixtureDir = fileURLToPath(new URL('./fixtures/', import.meta.url));

function readFixture(name: string): string {
  return readFileSync(fixtureDir + name, 'utf8');
}

describe('parseOpenSshPrivateKeyPem + decryptOpenSshEd25519Key', () => {
  it('decrypts a passphrase-protected ed25519 key and recovers the public key', async () => {
    const pem = readFixture('id_ed25519_enc');
    const expectedPubBase64 = readFixture('id_ed25519_enc.pub').trim().split(' ')[1];

    const parsed = parseOpenSshPrivateKeyPem(pem);
    expect(parsed.cipherName).toBe('aes256-ctr');
    expect(parsed.kdfName).toBe('bcrypt');

    const key = await decryptOpenSshEd25519Key(parsed, 'correct horse battery staple');
    expect(key.publicKey).toHaveLength(32);
    expect(key.seed).toHaveLength(32);
    expect(key.comment).toBe('test-encrypted@fixture');

    const blob = encodeEd25519PublicKeyBlob(key.publicKey);
    expect(encodeBase64(blob)).toBe(expectedPubBase64);
  });

  it('rejects an incorrect passphrase via the checkint mismatch', async () => {
    const pem = readFixture('id_ed25519_enc');
    const parsed = parseOpenSshPrivateKeyPem(pem);
    await expect(decryptOpenSshEd25519Key(parsed, 'wrong passphrase')).rejects.toThrow();
  });

  it('parses an unencrypted (cipher=none) ed25519 key', async () => {
    const pem = readFixture('id_ed25519_plain');
    const expectedPubBase64 = readFixture('id_ed25519_plain.pub').trim().split(' ')[1];

    const parsed = parseOpenSshPrivateKeyPem(pem);
    expect(parsed.cipherName).toBe('none');
    expect(parsed.kdfName).toBe('none');

    const key = await decryptOpenSshEd25519Key(parsed, '');
    const blob = encodeEd25519PublicKeyBlob(key.publicKey);
    expect(encodeBase64(blob)).toBe(expectedPubBase64);
    expect(key.comment).toBe('test-plain@fixture');
  });
});
