import { describe, expect, it } from 'vitest';
import { TokenStore } from '../src/server/pairing.js';

describe('TokenStore', () => {
  it('issues a token that validates exactly once', () => {
    const store = new TokenStore();
    const { token, sessionId } = store.issue();

    expect(store.validateAndConsume(token)).toBe(sessionId);
    expect(store.validateAndConsume(token)).toBeNull();

    store.dispose();
  });

  it('rejects an unknown token', () => {
    const store = new TokenStore();
    expect(store.validateAndConsume('not-a-real-token')).toBeNull();
    store.dispose();
  });

  it('rejects an expired token', async () => {
    const store = new TokenStore();
    const { token } = store.issue(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(store.validateAndConsume(token)).toBeNull();
    store.dispose();
  });
});
