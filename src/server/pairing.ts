import { randomBytes, randomUUID } from 'node:crypto';
import { DEFAULT_TOKEN_TTL_MS } from '../shared/index.js';

interface TokenEntry {
  sessionId: string;
  expiresAt: number;
  consumed: boolean;
}

export interface IssuedToken {
  token: string;
  sessionId: string;
  expiresAt: number;
}

/**
 * Single-use, short-TTL pairing tokens. A token only authorizes claiming a
 * session once; the session/WS connection it binds to then lives independently
 * of the token's TTL for as long as the browser tab stays connected.
 */
export class TokenStore {
  private readonly tokens = new Map<string, TokenEntry>();
  private readonly sweepInterval: ReturnType<typeof setInterval>;

  constructor() {
    this.sweepInterval = setInterval(() => this.sweep(), DEFAULT_TOKEN_TTL_MS).unref();
  }

  issue(ttlMs: number = DEFAULT_TOKEN_TTL_MS): IssuedToken {
    const token = randomBytes(32).toString('base64url');
    const sessionId = randomUUID();
    const expiresAt = Date.now() + ttlMs;
    this.tokens.set(token, { sessionId, expiresAt, consumed: false });
    return { token, sessionId, expiresAt };
  }

  /** Validates and single-use-consumes a token, returning its bound sessionId, or null if invalid/expired/already used. */
  validateAndConsume(token: string): string | null {
    const entry = this.tokens.get(token);
    if (!entry) return null;
    if (entry.consumed || entry.expiresAt < Date.now()) {
      this.tokens.delete(token);
      return null;
    }
    entry.consumed = true;
    this.tokens.delete(token);
    return entry.sessionId;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [token, entry] of this.tokens) {
      if (entry.consumed || entry.expiresAt < now) {
        this.tokens.delete(token);
      }
    }
  }

  dispose(): void {
    clearInterval(this.sweepInterval);
    this.tokens.clear();
  }
}
