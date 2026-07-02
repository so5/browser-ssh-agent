import { ed25519Signer } from './ed25519.js';
import type { Signer } from './types.js';

// Adding RSA/ECDSA later = write a new file implementing `Signer` and
// register it here — no WS protocol change required, since `sign`/
// `sign-result` already carry opaque base64 blobs keyed only by keyType.
const registry = new Map<string, Signer>([[ed25519Signer.keyType, ed25519Signer]]);

export function getSigner(keyType: string): Signer | undefined {
  return registry.get(keyType);
}

export type { Signer } from './types.js';
export { ed25519Signer };
