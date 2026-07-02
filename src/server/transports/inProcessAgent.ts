// See unixSocketAgent.ts for why 'ssh2' value imports go through the
// default-import + destructure pattern rather than named imports.
import ssh2 from 'ssh2';
import type { IdentityCallback, ParsedKey, SignCallback, SigningRequestOptions } from 'ssh2';
import type { WsHub } from '../wsHub.js';
import { decodeBase64, encodeBase64 } from '../../shared/base64.js';

const { BaseAgent } = ssh2;

type AgentPublicKey = Buffer | ParsedKey;

function publicKeyBlob(pubKey: AgentPublicKey): Buffer {
  return Buffer.isBuffer(pubKey) ? pubKey : pubKey.getPublicSSH();
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * Phase 1 transport: a `BaseAgent` ssh2's own `Client` can use directly
 * (`new Client().connect({ agent: relayAgent, agentForward: true })`), with
 * every `getIdentities`/`sign` call relayed to the paired browser tab over
 * `WsHub`. No Unix socket or wire-protocol parsing involved — see the plan's
 * "fork" discussion for why this covers `ssh -A` semantics for SSH
 * connections ssh2 itself makes, but not for spawned external CLI binaries.
 */
export class WsRelayAgent extends BaseAgent<AgentPublicKey> {
  constructor(private readonly hub: WsHub) {
    super();
  }

  getIdentities(cb: IdentityCallback<AgentPublicKey>): void {
    this.hub
      .sendListIdentities()
      .then((result) => {
        const keys = result.identities.map((identity) => Buffer.from(decodeBase64(identity.keyBlob)));
        cb(null, keys);
      })
      .catch((err) => cb(toError(err)));
  }

  sign(
    pubKey: AgentPublicKey,
    data: Buffer,
    optionsOrCb?: SigningRequestOptions | SignCallback,
    maybeCb?: SignCallback
  ): void {
    const callback = typeof optionsOrCb === 'function' ? optionsOrCb : maybeCb;
    if (!callback) return;

    let keyBlob: Buffer;
    try {
      keyBlob = publicKeyBlob(pubKey);
    } catch (err) {
      callback(toError(err));
      return;
    }

    const keyBlobB64 = encodeBase64(new Uint8Array(keyBlob));
    const dataB64 = encodeBase64(new Uint8Array(data));

    this.hub
      .sendSign(keyBlobB64, dataB64, 0)
      .then((result) => {
        callback(null, Buffer.from(decodeBase64(result.signature)));
      })
      .catch((err) => callback(toError(err)));
  }
}
