import { PROTOCOL_VERSION } from './constants.js';

interface BaseMessage {
  v: typeof PROTOCOL_VERSION;
}

// --- Handshake ---
export interface HelloMessage extends BaseMessage {
  type: 'hello';
  /** Single-use pairing token, sent as the first application message after WS open. */
  token: string;
}
export interface HelloAckMessage extends BaseMessage {
  type: 'hello-ack';
  sessionId: string;
}

// --- List identities ---
export interface ListIdentitiesRequestMessage extends BaseMessage {
  type: 'list-identities';
  id: string;
}
export interface IdentityDescriptor {
  /** base64, SSH wire-format public key blob. */
  keyBlob: string;
  comment: string;
}
export interface ListIdentitiesResultMessage extends BaseMessage {
  type: 'list-identities-result';
  id: string;
  identities: IdentityDescriptor[];
}

// --- Sign ---
export interface SignRequestMessage extends BaseMessage {
  type: 'sign';
  id: string;
  /** base64, SSH wire-format public key blob identifying which loaded key to sign with. */
  keyBlob: string;
  /** base64, raw challenge bytes to sign (already includes the session-id prefix ssh2 builds). */
  data: string;
  /** Passthrough of ssh2's AgentProtocol/BaseAgent sign flags (e.g. RSA SHA2 algorithm preference). */
  flags: number;
}
export interface SignResultMessage extends BaseMessage {
  type: 'sign-result';
  id: string;
  /** base64, RAW signature bytes (NOT wrapped in an SSH sigformat+blob — ssh2 wraps it itself). */
  signature: string;
}

// --- Error / lifecycle ---
export type ErrorCode = 'user-declined' | 'key-not-found' | 'no-key-loaded' | 'bad-token' | 'internal';

export interface ErrorMessage extends BaseMessage {
  type: 'error';
  /** Present when this is a reply to a specific request id. */
  id?: string;
  code: ErrorCode;
  message: string;
}

export interface CloseMessage extends BaseMessage {
  type: 'close';
  reason: string;
}

export type ServerToBrowserMessage =
  | HelloAckMessage
  | ListIdentitiesRequestMessage
  | SignRequestMessage
  | ErrorMessage
  | CloseMessage;

export type BrowserToServerMessage =
  | HelloMessage
  | ListIdentitiesResultMessage
  | SignResultMessage
  | ErrorMessage;

export type AnyMessage = ServerToBrowserMessage | BrowserToServerMessage;

export function withVersion<T extends object>(msg: T): T & BaseMessage {
  return { ...msg, v: PROTOCOL_VERSION };
}
