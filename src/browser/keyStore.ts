import { encodeBase64 } from '../shared/base64.js';
import { SSH_ED25519_KEY_TYPE, encodeEd25519PublicKeyBlob } from '../shared/sshWire.js';

/**
 * Holds decrypted key material for the lifetime of a paired session. The
 * private seed is never exposed via a public getter — only `Signer`
 * implementations (via `seed()`) can reach it — and `zeroize()` lets the
 * host page discard it on disconnect/idle-timeout/explicit "forget key".
 * This is best-effort: JS cannot guarantee no lingering copies exist
 * elsewhere in the heap (see the security notes in the project plan).
 */
export class KeyHandle {
  readonly keyType = SSH_ED25519_KEY_TYPE;
  readonly comment: string;
  private readonly publicKeyBytes: Uint8Array;
  private privateSeed: Uint8Array | null;

  constructor(publicKey: Uint8Array, seed: Uint8Array, comment: string) {
    this.publicKeyBytes = publicKey;
    this.privateSeed = seed;
    this.comment = comment;
  }

  get publicKeyBlob(): Uint8Array {
    return encodeEd25519PublicKeyBlob(this.publicKeyBytes);
  }

  get publicKeyBlobBase64(): string {
    return encodeBase64(this.publicKeyBlob);
  }

  get isZeroized(): boolean {
    return this.privateSeed === null;
  }

  /** For use by `Signer` implementations only. */
  seed(): Uint8Array {
    if (!this.privateSeed) {
      throw new Error('Key material has been zeroized and is no longer available');
    }
    return this.privateSeed;
  }

  zeroize(): void {
    if (this.privateSeed) {
      this.privateSeed.fill(0);
      this.privateSeed = null;
    }
  }
}
