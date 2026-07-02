import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { WebSocket, RawData } from 'ws';
import {
  DEFAULT_HANDSHAKE_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  PROTOCOL_VERSION,
} from '../shared/constants.js';
import type {
  BrowserToServerMessage,
  ListIdentitiesResultMessage,
  SignResultMessage,
} from '../shared/protocol.js';

interface PendingRequest {
  resolve: (msg: ListIdentitiesResultMessage | SignResultMessage) => void;
  reject: (err: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface Session {
  ws: WebSocket;
  pending: Map<string, PendingRequest>;
}

export interface TokenValidator {
  validateAndConsume(token: string): string | null;
}

export interface WsHubOptions {
  tokenStore: TokenValidator;
  requestTimeoutMs?: number;
  handshakeTimeoutMs?: number;
}

/**
 * Owns the session registry and request/response correlation for the single
 * WebSocket-per-browser-session. Server transports (Phase 1's in-process
 * BaseAgent, Phase 2's future Unix-socket AgentProtocol bridge) call
 * `sendListIdentities`/`sendSign` and never touch WebSocket framing directly.
 */
export class WsHub extends EventEmitter {
  private readonly tokenStore: TokenValidator;
  private readonly requestTimeoutMs: number;
  private readonly handshakeTimeoutMs: number;
  private readonly sessions = new Map<string, Session>();
  /** Phase 1 targets whichever session most recently completed pairing. */
  private currentSessionId: string | null = null;

  constructor(opts: WsHubOptions) {
    super();
    this.tokenStore = opts.tokenStore;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.handshakeTimeoutMs = opts.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  }

  get isPaired(): boolean {
    return this.currentSessionId !== null;
  }

  /** Wire up a freshly-accepted WebSocket connection (from `ws`'s `connection` event). */
  handleConnection(ws: WebSocket): void {
    let boundSessionId: string | null = null;
    let handshakeDone = false;

    const handshakeTimer = setTimeout(() => {
      if (!handshakeDone) ws.close(4001, 'handshake timeout');
    }, this.handshakeTimeoutMs);

    ws.on('message', (raw: RawData) => {
      let msg: BrowserToServerMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (!handshakeDone) {
        if (msg.type !== 'hello') return;
        clearTimeout(handshakeTimer);

        const sessionId = this.tokenStore.validateAndConsume(msg.token);
        if (!sessionId) {
          ws.send(
            JSON.stringify({
              v: PROTOCOL_VERSION,
              type: 'error',
              code: 'bad-token',
              message: 'Invalid or expired pairing token',
            })
          );
          ws.close(4002, 'bad token');
          return;
        }

        handshakeDone = true;
        boundSessionId = sessionId;
        this.sessions.set(sessionId, { ws, pending: new Map() });
        this.currentSessionId = sessionId;
        ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: 'hello-ack', sessionId }));
        this.emit('session-paired', sessionId);
        return;
      }

      if (boundSessionId) this.dispatchReply(boundSessionId, msg);
    });

    const onGone = () => {
      clearTimeout(handshakeTimer);
      if (boundSessionId) this.handleDisconnect(boundSessionId);
    };
    ws.on('close', onGone);
    ws.on('error', onGone);
  }

  /** Relays a list-identities request to the currently paired browser session. */
  sendListIdentities(): Promise<ListIdentitiesResultMessage> {
    return this.sendRequest((id) => ({
      v: PROTOCOL_VERSION,
      type: 'list-identities' as const,
      id,
    })) as Promise<ListIdentitiesResultMessage>;
  }

  /** Relays a sign request (challenge bytes + target key) to the currently paired browser session. */
  sendSign(keyBlobBase64: string, dataBase64: string, flags: number): Promise<SignResultMessage> {
    return this.sendRequest((id) => ({
      v: PROTOCOL_VERSION,
      type: 'sign' as const,
      id,
      keyBlob: keyBlobBase64,
      data: dataBase64,
      flags,
    })) as Promise<SignResultMessage>;
  }

  private sendRequest(
    build: (id: string) => { type: string; id: string }
  ): Promise<ListIdentitiesResultMessage | SignResultMessage> {
    const sessionId = this.currentSessionId;
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    if (!session || !sessionId) {
      return Promise.reject(new Error('No paired browser session'));
    }

    const id = randomUUID();
    const message = build(id);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        session.pending.delete(id);
        this.emit('request-timeout', sessionId, id);
        reject(new Error('Request timed out waiting for browser response'));
      }, this.requestTimeoutMs);

      session.pending.set(id, { resolve, reject, timeout });
      session.ws.send(JSON.stringify(message));
    });
  }

  private dispatchReply(sessionId: string, msg: BrowserToServerMessage): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (msg.type === 'list-identities-result' || msg.type === 'sign-result') {
      const pending = session.pending.get(msg.id);
      if (!pending) return;
      session.pending.delete(msg.id);
      clearTimeout(pending.timeout);
      pending.resolve(msg);
    } else if (msg.type === 'error' && msg.id) {
      const pending = session.pending.get(msg.id);
      if (!pending) return;
      session.pending.delete(msg.id);
      clearTimeout(pending.timeout);
      pending.reject(new Error(`${msg.code}: ${msg.message}`));
    }
  }

  private handleDisconnect(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    for (const pending of session.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Browser session disconnected'));
    }
    session.pending.clear();
    this.sessions.delete(sessionId);
    if (this.currentSessionId === sessionId) this.currentSessionId = null;
    this.emit('session-disconnected', sessionId);
  }

  dispose(): void {
    for (const sessionId of [...this.sessions.keys()]) {
      this.handleDisconnect(sessionId);
    }
  }
}
