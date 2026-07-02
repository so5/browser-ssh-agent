import type { KeyHandle } from '../keyStore.js';

export interface Signer {
  keyType: string;
  /** Returns the RAW signature bytes — ssh2 wraps them in the SSH sigformat+blob itself. */
  sign(handle: KeyHandle, data: Uint8Array): Promise<Uint8Array> | Uint8Array;
}
