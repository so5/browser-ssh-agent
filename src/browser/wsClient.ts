import { decodeBase64, encodeBase64 } from '../shared/base64.js';
import { PROTOCOL_VERSION } from '../shared/constants.js';
import type {
  ErrorCode,
  ListIdentitiesRequestMessage,
  ServerToBrowserMessage,
  SignRequestMessage,
} from '../shared/protocol.js';
import type { KeyHandle } from './keyStore.js';
import { getSigner } from './signers/index.js';

export type AgentConnectionStatus = 'connecting' | 'paired' | 'disconnected';

export interface ConfirmSignInfo {
  comment: string;
  fingerprint: string;
}

export interface ConnectAgentOptions {
  wsUrl: string;
  /** Single-use pairing token, e.g. read from `location.hash`. */
  token: string;
  key: KeyHandle;
  /**
   * Gate each sign request behind explicit user approval, mirroring
   * `ssh-add -c`. Strongly recommended — without it, anything relaying
   * through the paired server can silently authenticate as the user.
   * Defaults to auto-approving if omitted (host app's choice to opt out).
   */
  confirmSign?: (info: ConfirmSignInfo) => Promise<boolean> | boolean;
}

export interface AgentConnection {
  readonly status: AgentConnectionStatus;
  close(): void;
  on(event: 'status', handler: (status: AgentConnectionStatus) => void): void;
  on(event: 'error', handler: (err: Error) => void): void;
}

async function computeFingerprint(blob: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', blob as BufferSource);
  return `SHA256:${encodeBase64(new Uint8Array(digest)).replace(/=+$/, '')}`;
}

export class AgentConnectionImpl implements AgentConnection {
  status: AgentConnectionStatus = 'connecting';
  private readonly ws: WebSocket;
  private readonly statusListeners = new Set<(status: AgentConnectionStatus) => void>();
  private readonly errorListeners = new Set<(err: Error) => void>();
  private closedByUser = false;

  constructor(private readonly opts: ConnectAgentOptions) {
    this.ws = new WebSocket(opts.wsUrl);
    this.ws.addEventListener('open', () => this.send({ v: PROTOCOL_VERSION, type: 'hello', token: opts.token }));
    this.ws.addEventListener('message', (ev) => {
      void this.handleMessage(ev);
    });
    this.ws.addEventListener('close', () => this.setStatus('disconnected'));
    this.ws.addEventListener('error', () => {
      if (!this.closedByUser) this.emitError(new Error('WebSocket connection error'));
    });
  }

  on(event: 'status', handler: (status: AgentConnectionStatus) => void): void;
  on(event: 'error', handler: (err: Error) => void): void;
  on(event: 'status' | 'error', handler: ((status: AgentConnectionStatus) => void) | ((err: Error) => void)): void {
    if (event === 'status') this.statusListeners.add(handler as (status: AgentConnectionStatus) => void);
    else this.errorListeners.add(handler as (err: Error) => void);
  }

  close(): void {
    this.closedByUser = true;
    this.ws.close();
  }

  private send(msg: Record<string, unknown>): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private setStatus(status: AgentConnectionStatus): void {
    if (this.status === status) return;
    this.status = status;
    for (const listener of this.statusListeners) listener(status);
  }

  private emitError(err: Error): void {
    for (const listener of this.errorListeners) listener(err);
  }

  private sendError(id: string, code: ErrorCode, message: string): void {
    this.send({ v: PROTOCOL_VERSION, type: 'error', id, code, message });
  }

  private async handleMessage(ev: MessageEvent): Promise<void> {
    let msg: ServerToBrowserMessage;
    try {
      msg = JSON.parse(String(ev.data));
    } catch {
      return;
    }

    switch (msg.type) {
      case 'hello-ack':
        this.setStatus('paired');
        return;
      case 'list-identities':
        this.handleListIdentities(msg);
        return;
      case 'sign':
        await this.handleSign(msg);
        return;
      case 'error':
        this.emitError(new Error(`${msg.code}: ${msg.message}`));
        return;
      case 'close':
        this.ws.close();
        return;
    }
  }

  private handleListIdentities(msg: ListIdentitiesRequestMessage): void {
    const { key } = this.opts;
    const identities = key.isZeroized
      ? []
      : [{ keyBlob: key.publicKeyBlobBase64, comment: key.comment }];
    this.send({ v: PROTOCOL_VERSION, type: 'list-identities-result', id: msg.id, identities });
  }

  private async handleSign(msg: SignRequestMessage): Promise<void> {
    const { key, confirmSign } = this.opts;

    if (key.isZeroized || msg.keyBlob !== key.publicKeyBlobBase64) {
      this.sendError(msg.id, 'key-not-found', 'Requested key is not currently loaded');
      return;
    }

    if (confirmSign) {
      let approved: boolean;
      try {
        const fingerprint = await computeFingerprint(key.publicKeyBlob);
        approved = await confirmSign({ comment: key.comment, fingerprint });
      } catch {
        approved = false;
      }
      if (!approved) {
        this.sendError(msg.id, 'user-declined', 'User declined to sign');
        return;
      }
    }

    const signer = getSigner(key.keyType);
    if (!signer) {
      this.sendError(msg.id, 'key-not-found', `No signer registered for key type ${key.keyType}`);
      return;
    }

    try {
      const data = decodeBase64(msg.data);
      const signature = await signer.sign(key, data);
      this.send({ v: PROTOCOL_VERSION, type: 'sign-result', id: msg.id, signature: encodeBase64(signature) });
    } catch (err) {
      this.sendError(msg.id, 'internal', err instanceof Error ? err.message : String(err));
    }
  }
}

export function connectAgent(opts: ConnectAgentOptions): AgentConnection {
  return new AgentConnectionImpl(opts);
}
