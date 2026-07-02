import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { WsHub } from '../src/server/wsHub.js';
import { TokenStore } from '../src/server/pairing.js';

class FakeWebSocket extends EventEmitter {
  readonly sent: unknown[] = [];
  closed = false;
  closeCode?: number;

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(code?: number): void {
    this.closed = true;
    this.closeCode = code;
    this.emit('close');
  }

  lastSent(): any {
    return this.sent[this.sent.length - 1];
  }
}

function asWs(fake: FakeWebSocket): WebSocket {
  return fake as unknown as WebSocket;
}

describe('WsHub', () => {
  it('completes the hello/hello-ack handshake for a valid token', () => {
    const tokenStore = new TokenStore();
    const hub = new WsHub({ tokenStore });
    const { token, sessionId } = tokenStore.issue();

    const paired = vi.fn();
    hub.on('session-paired', paired);

    const ws = new FakeWebSocket();
    hub.handleConnection(asWs(ws));
    ws.emit('message', JSON.stringify({ v: 1, type: 'hello', token }));

    expect(paired).toHaveBeenCalledWith(sessionId);
    expect(ws.lastSent()).toMatchObject({ type: 'hello-ack', sessionId });
    expect(hub.isPaired).toBe(true);

    tokenStore.dispose();
  });

  it('rejects and closes the connection for an invalid token', () => {
    const tokenStore = new TokenStore();
    const hub = new WsHub({ tokenStore });

    const ws = new FakeWebSocket();
    hub.handleConnection(asWs(ws));
    ws.emit('message', JSON.stringify({ v: 1, type: 'hello', token: 'bogus' }));

    expect(ws.lastSent()).toMatchObject({ type: 'error', code: 'bad-token' });
    expect(ws.closed).toBe(true);
    expect(hub.isPaired).toBe(false);

    tokenStore.dispose();
  });

  it('correlates a list-identities request/response by id', async () => {
    const tokenStore = new TokenStore();
    const hub = new WsHub({ tokenStore });
    const { token } = tokenStore.issue();

    const ws = new FakeWebSocket();
    hub.handleConnection(asWs(ws));
    ws.emit('message', JSON.stringify({ v: 1, type: 'hello', token }));

    const resultPromise = hub.sendListIdentities();
    const request = ws.lastSent();
    expect(request).toMatchObject({ type: 'list-identities' });

    ws.emit(
      'message',
      JSON.stringify({
        v: 1,
        type: 'list-identities-result',
        id: request.id,
        identities: [{ keyBlob: 'AAAA', comment: 'test' }],
      })
    );

    const result = await resultPromise;
    expect(result.identities).toEqual([{ keyBlob: 'AAAA', comment: 'test' }]);

    tokenStore.dispose();
  });

  it('correlates concurrent sign requests independently by id', async () => {
    const tokenStore = new TokenStore();
    const hub = new WsHub({ tokenStore });
    const { token } = tokenStore.issue();

    const ws = new FakeWebSocket();
    hub.handleConnection(asWs(ws));
    ws.emit('message', JSON.stringify({ v: 1, type: 'hello', token }));

    const p1 = hub.sendSign('keyBlobA', 'dataA', 0);
    const p2 = hub.sendSign('keyBlobB', 'dataB', 0);
    const [req1, req2] = ws.sent.slice(-2) as any[];
    expect(req1.id).not.toBe(req2.id);

    // Reply out of order to prove correlation isn't positional.
    ws.emit('message', JSON.stringify({ v: 1, type: 'sign-result', id: req2.id, signature: 'sigB' }));
    ws.emit('message', JSON.stringify({ v: 1, type: 'sign-result', id: req1.id, signature: 'sigA' }));

    expect((await p1).signature).toBe('sigA');
    expect((await p2).signature).toBe('sigB');

    tokenStore.dispose();
  });

  it('fails pending requests when the browser disconnects', async () => {
    const tokenStore = new TokenStore();
    const hub = new WsHub({ tokenStore });
    const { token } = tokenStore.issue();

    const ws = new FakeWebSocket();
    hub.handleConnection(asWs(ws));
    ws.emit('message', JSON.stringify({ v: 1, type: 'hello', token }));

    const pending = hub.sendSign('keyBlob', 'data', 0);
    ws.emit('close');

    await expect(pending).rejects.toThrow('disconnected');
    expect(hub.isPaired).toBe(false);

    tokenStore.dispose();
  });

  it('rejects immediately when no session is paired', async () => {
    const tokenStore = new TokenStore();
    const hub = new WsHub({ tokenStore });
    await expect(hub.sendListIdentities()).rejects.toThrow('No paired browser session');
    tokenStore.dispose();
  });
});
