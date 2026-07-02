import { SSH_ED25519_KEY_TYPE, bytesToUtf8, readSshString, readUint32BE, utf8ToBytes } from '../../shared/sshWire.js';
import type { OpenSshKeyFile } from './opensshKey.js';
import { deriveKeyAndIv } from './bcryptKdf.js';

export interface DecryptedEd25519Key {
  /** 32-byte ed25519 public key. */
  publicKey: Uint8Array;
  /** 32-byte ed25519 signing seed (private scalar seed, NOT the libsodium 64-byte secret key). */
  seed: Uint8Array;
  comment: string;
}

function zero(bytes: Uint8Array): void {
  bytes.fill(0);
}

async function aesCtrDecrypt(key: Uint8Array, iv: Uint8Array, ciphertext: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key as BufferSource,
    { name: 'AES-CTR' },
    false,
    ['decrypt']
  );
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-CTR', counter: iv as BufferSource, length: 128 },
    cryptoKey,
    ciphertext as BufferSource
  );
  return new Uint8Array(plaintext);
}

/**
 * Decrypts (if necessary) and parses an `openssh-key-v1` private section for
 * an ed25519 key, verifying OpenSSH's built-in `checkint` wrong-passphrase
 * detector along the way. Best-effort zeroes intermediate key material
 * (passphrase bytes, derived AES key/IV, decrypted plaintext) before
 * returning — the returned `seed`/`publicKey` copies are what the caller
 * should hold onto (and eventually zero itself via `KeyHandle.zeroize()`).
 */
export async function decryptOpenSshEd25519Key(
  file: OpenSshKeyFile,
  passphrase: string
): Promise<DecryptedEd25519Key> {
  let plaintext: Uint8Array;

  if (file.cipherName === 'none') {
    plaintext = file.privateSection;
  } else if (file.cipherName === 'aes256-ctr') {
    if (!file.kdfSalt || file.kdfRounds === null) {
      throw new Error('Encrypted key is missing bcrypt KDF parameters');
    }
    const passphraseBytes = utf8ToBytes(passphrase);
    const { key, iv } = deriveKeyAndIv(passphraseBytes, file.kdfSalt, file.kdfRounds, 32, 16);
    try {
      plaintext = await aesCtrDecrypt(key, iv, file.privateSection);
    } finally {
      zero(passphraseBytes);
      zero(key);
      zero(iv);
    }
  } else {
    throw new Error(`Unsupported private key cipher: ${file.cipherName}`);
  }

  try {
    const checkint1 = readUint32BE(plaintext, 0);
    const checkint2 = readUint32BE(plaintext, 4);
    if (checkint1 !== checkint2) {
      throw new Error('Incorrect passphrase');
    }

    let offset = 8;
    const keyTypeField = readSshString(plaintext, offset);
    const keyType = bytesToUtf8(keyTypeField.value);
    offset = keyTypeField.offset;
    if (keyType !== SSH_ED25519_KEY_TYPE) {
      throw new Error(`Unsupported key type: ${keyType} (only ${SSH_ED25519_KEY_TYPE} is supported)`);
    }

    const publicKeyField = readSshString(plaintext, offset);
    offset = publicKeyField.offset;

    const secretField = readSshString(plaintext, offset);
    offset = secretField.offset;
    if (secretField.value.length !== 64) {
      throw new Error('Unexpected ed25519 private key section length');
    }
    const seed = secretField.value.slice(0, 32);
    const publicKey = secretField.value.slice(32, 64);

    const commentField = readSshString(plaintext, offset);
    const comment = bytesToUtf8(commentField.value);

    return { publicKey, seed, comment };
  } finally {
    zero(plaintext);
  }
}
