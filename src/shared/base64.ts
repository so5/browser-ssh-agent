// Hand-rolled base64 codec so `shared/` has zero runtime dependency on
// Node's `Buffer` or the browser's `btoa`/`atob` (both are awkward for
// arbitrary binary data) and works identically on both platforms.

const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const CHAR_INDEX: Record<string, number> = {};
for (let i = 0; i < CHARS.length; i++) CHAR_INDEX[CHARS[i]] = i;

export function encodeBase64(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 3 <= bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += CHARS[(n >> 18) & 63] + CHARS[(n >> 12) & 63] + CHARS[(n >> 6) & 63] + CHARS[n & 63];
  }
  const remaining = bytes.length - i;
  if (remaining === 1) {
    const n = bytes[i] << 16;
    out += CHARS[(n >> 18) & 63] + CHARS[(n >> 12) & 63] + '==';
  } else if (remaining === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += CHARS[(n >> 18) & 63] + CHARS[(n >> 12) & 63] + CHARS[(n >> 6) & 63] + '=';
  }
  return out;
}

export function decodeBase64(input: string): Uint8Array {
  const clean = input.replace(/[^A-Za-z0-9+/]/g, '');
  const byteLength = Math.floor((clean.length * 6) / 8);
  const out = new Uint8Array(byteLength);
  let bitBuffer = 0;
  let bitCount = 0;
  let outIdx = 0;
  for (const ch of clean) {
    const val = CHAR_INDEX[ch];
    if (val === undefined) continue;
    bitBuffer = (bitBuffer << 6) | val;
    bitCount += 6;
    if (bitCount >= 8) {
      bitCount -= 8;
      out[outIdx++] = (bitBuffer >> bitCount) & 0xff;
    }
  }
  return out;
}
