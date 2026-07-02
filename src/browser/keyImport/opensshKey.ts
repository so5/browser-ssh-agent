import { decodeBase64 } from '../../shared/base64.js';
import { bytesToUtf8, readSshString, readUint32BE, utf8ToBytes } from '../../shared/sshWire.js';

const AUTH_MAGIC = 'openssh-key-v1\0';

export interface OpenSshKeyFile {
  cipherName: string;
  kdfName: string;
  kdfSalt: Uint8Array | null;
  kdfRounds: number | null;
  /** SSH wire-format public key blob (unencrypted, always present even for encrypted keys). */
  publicKeyBlob: Uint8Array;
  /** Possibly cipher-encrypted "list of private keys" section; still opaque at this stage. */
  privateSection: Uint8Array;
}

/**
 * Parses the `openssh-key-v1` container format (the PEM text between
 * `-----BEGIN/END OPENSSH PRIVATE KEY-----`) into its top-level fields.
 * Does not decrypt or interpret the private section — see `decrypt.ts`.
 */
export function parseOpenSshPrivateKeyPem(pem: string): OpenSshKeyFile {
  const body = pem
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('-----'))
    .join('');
  const bytes = decodeBase64(body);

  const magic = utf8ToBytes(AUTH_MAGIC);
  for (let i = 0; i < magic.length; i++) {
    if (bytes[i] !== magic[i]) {
      throw new Error('Not an OpenSSH private key file (bad magic header)');
    }
  }
  let offset = magic.length;

  const cipherField = readSshString(bytes, offset);
  const cipherName = bytesToUtf8(cipherField.value);
  offset = cipherField.offset;

  const kdfNameField = readSshString(bytes, offset);
  const kdfName = bytesToUtf8(kdfNameField.value);
  offset = kdfNameField.offset;

  const kdfOptionsField = readSshString(bytes, offset);
  offset = kdfOptionsField.offset;

  let kdfSalt: Uint8Array | null = null;
  let kdfRounds: number | null = null;
  if (kdfName === 'bcrypt') {
    const opts = kdfOptionsField.value;
    const saltField = readSshString(opts, 0);
    kdfSalt = saltField.value;
    kdfRounds = readUint32BE(opts, saltField.offset);
  }

  const numKeys = readUint32BE(bytes, offset);
  offset += 4;
  if (numKeys !== 1) {
    throw new Error(`Only single-key OpenSSH key files are supported (file contains ${numKeys})`);
  }

  const publicKeyField = readSshString(bytes, offset);
  offset = publicKeyField.offset;

  const privateSectionField = readSshString(bytes, offset);

  return {
    cipherName,
    kdfName,
    kdfSalt,
    kdfRounds,
    publicKeyBlob: publicKeyField.value,
    privateSection: privateSectionField.value,
  };
}
