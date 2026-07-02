// Minimal helpers for the length-prefixed binary structures used inside
// SSH wire-format public key blobs (RFC 4251 "string" encoding: a uint32
// big-endian length followed by that many bytes). We only need to build
// and read `ssh-ed25519` blobs for v1, but the helpers are generic.

export const SSH_ED25519_KEY_TYPE = 'ssh-ed25519';

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function writeUint32BE(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

export function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>>
    0
  );
}

/** SSH wire "string": uint32 length prefix + raw bytes. */
export function writeSshString(bytes: Uint8Array): Uint8Array {
  return concatBytes(writeUint32BE(bytes.length), bytes);
}

export function utf8ToBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function bytesToUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

export interface ReadResult {
  value: Uint8Array;
  offset: number;
}

/** Reads one length-prefixed SSH wire "string" starting at `offset`. */
export function readSshString(bytes: Uint8Array, offset: number): ReadResult {
  const len = readUint32BE(bytes, offset);
  const start = offset + 4;
  const end = start + len;
  if (end > bytes.length) {
    throw new Error('Truncated SSH wire string');
  }
  return { value: bytes.subarray(start, end), offset: end };
}

/** Builds the SSH wire-format public key blob for an ed25519 key: string("ssh-ed25519") + string(pubkey). */
export function encodeEd25519PublicKeyBlob(publicKey: Uint8Array): Uint8Array {
  if (publicKey.length !== 32) {
    throw new Error(`Expected 32-byte ed25519 public key, got ${publicKey.length}`);
  }
  return concatBytes(writeSshString(utf8ToBytes(SSH_ED25519_KEY_TYPE)), writeSshString(publicKey));
}

export interface ParsedEd25519PublicKeyBlob {
  keyType: string;
  publicKey: Uint8Array;
}

/** Parses an SSH wire-format public key blob, verifying it's an ed25519 key. */
export function parseEd25519PublicKeyBlob(blob: Uint8Array): ParsedEd25519PublicKeyBlob {
  const typeField = readSshString(blob, 0);
  const keyType = bytesToUtf8(typeField.value);
  if (keyType !== SSH_ED25519_KEY_TYPE) {
    throw new Error(`Unsupported key type: ${keyType}`);
  }
  const pubField = readSshString(blob, typeField.offset);
  return { keyType, publicKey: pubField.value };
}
