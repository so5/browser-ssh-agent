import bcryptPbkdf from 'bcrypt-pbkdf';

export interface DerivedKeyMaterial {
  key: Uint8Array;
  iv: Uint8Array;
}

/** Derives an AES key + CTR IV from a passphrase using OpenSSH's bcrypt_pbkdf. */
export function deriveKeyAndIv(
  passphrase: Uint8Array,
  salt: Uint8Array,
  rounds: number,
  keyLen = 32,
  ivLen = 16
): DerivedKeyMaterial {
  const totalLen = keyLen + ivLen;
  const out = new Uint8Array(totalLen);
  const rc = bcryptPbkdf.pbkdf(passphrase, passphrase.length, salt, salt.length, out, totalLen, rounds);
  if (rc !== 0) {
    throw new Error('bcrypt_pbkdf failed to derive key material');
  }
  return { key: out.slice(0, keyLen), iv: out.slice(keyLen, keyLen + ivLen) };
}
