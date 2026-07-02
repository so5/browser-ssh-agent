import { ed25519 } from '@noble/curves/ed25519';
import { SSH_ED25519_KEY_TYPE } from '../../shared/sshWire.js';
import type { KeyHandle } from '../keyStore.js';
import type { Signer } from './types.js';

export const ed25519Signer: Signer = {
  keyType: SSH_ED25519_KEY_TYPE,
  sign(handle: KeyHandle, data: Uint8Array): Uint8Array {
    return ed25519.sign(data, handle.seed());
  },
};
