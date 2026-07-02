import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';
import { parseOpenSshPrivateKeyPem } from '../src/browser/keyImport/opensshKey.js';
import { decryptOpenSshEd25519Key } from '../src/browser/keyImport/decrypt.js';
import { KeyHandle } from '../src/browser/keyStore.js';
import { ed25519Signer } from '../src/browser/signers/ed25519.js';

const fixtureDir = fileURLToPath(new URL('./fixtures/', import.meta.url));

describe('ed25519Signer', () => {
  it('produces a signature verifiable against the public key', async () => {
    const pem = readFileSync(fixtureDir + 'id_ed25519_plain', 'utf8');
    const parsed = parseOpenSshPrivateKeyPem(pem);
    const decrypted = await decryptOpenSshEd25519Key(parsed, '');
    const handle = new KeyHandle(decrypted.publicKey, decrypted.seed, decrypted.comment);

    const challenge = new TextEncoder().encode('some ssh auth challenge bytes');
    const signature = await ed25519Signer.sign(handle, challenge);

    expect(signature).toHaveLength(64);
    expect(ed25519.verify(signature, challenge, decrypted.publicKey)).toBe(true);
  });

  it('throws once the key handle has been zeroized', async () => {
    const pem = readFileSync(fixtureDir + 'id_ed25519_plain', 'utf8');
    const parsed = parseOpenSshPrivateKeyPem(pem);
    const decrypted = await decryptOpenSshEd25519Key(parsed, '');
    const handle = new KeyHandle(decrypted.publicKey, decrypted.seed, decrypted.comment);

    handle.zeroize();
    expect(handle.isZeroized).toBe(true);
    await expect(async () => ed25519Signer.sign(handle, new Uint8Array(4))).rejects.toThrow();
  });
});
