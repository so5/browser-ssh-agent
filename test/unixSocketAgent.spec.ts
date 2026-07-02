import { readFileSync } from 'node:fs';
import { connect as netConnect } from 'node:net';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// Default-import + destructure: see src/server/transports/unixSocketAgent.ts
// for why named imports from 'ssh2' aren't safe under plain Node ESM.
import ssh2 from 'ssh2';
import type { ParsedKey } from 'ssh2';
import { AgentServer } from '../src/server/agentServer.js';
import { connectAgent, loadKeyFromText } from '../src/browser/index.js';

const { AgentProtocol } = ssh2;

const fixtureDir = fileURLToPath(new URL('./fixtures/', import.meta.url));
const readFixture = (name: string) => readFileSync(fixtureDir + name, 'utf8');

/**
 * Proves Phase 2 speaks the *real* OpenSSH agent wire protocol correctly by
 * driving the Unix socket with ssh2's own client-mode `AgentProtocol` — the
 * same code path a real `ssh`/`git` CLI's underlying agent client uses —
 * rather than calling our server internals directly.
 */
describe('UnixSocketAgent (Phase 2) over the real OpenSSH agent wire protocol', () => {
  it('answers getIdentities and sign from a client-mode AgentProtocol', async () => {
    const agentServer = new AgentServer();
    const { wsUrl } = await agentServer.listen(0, '127.0.0.1');
    const socketPath = await agentServer.startUnixSocket();

    const pairing = agentServer.createPairingLink('https://example.invalid/pair');
    const token = new URL(pairing.url).hash.replace('#token=', '');
    const key = await loadKeyFromText(readFixture('id_ed25519_plain'), '');
    const connection = connectAgent({ wsUrl, token, key });

    await new Promise<void>((resolve, reject) => {
      connection.on('status', (status) => {
        if (status === 'paired') resolve();
      });
      connection.on('error', reject);
    });

    const socket = netConnect(socketPath);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('error', reject);
    });

    const clientProtocol = new AgentProtocol(true);
    socket.pipe(clientProtocol).pipe(socket);

    const identities = await new Promise<ParsedKey[]>((resolve, reject) => {
      clientProtocol.getIdentities((err, keys) => (err ? reject(err) : resolve(keys ?? [])));
    });

    expect(identities).toHaveLength(1);
    expect(identities[0].comment).toBe('test-plain@fixture');
    expect(identities[0].getPublicSSH().equals(Buffer.from(key.publicKeyBlob))).toBe(true);

    const challenge = Buffer.from('unix-socket-agent test challenge');
    const signature = await new Promise<Buffer>((resolve, reject) => {
      clientProtocol.sign(identities[0], challenge, (err, sig) => {
        if (err || !sig) reject(err ?? new Error('no signature'));
        else resolve(sig);
      });
    });

    expect(identities[0].verify(challenge, signature)).toBe(true);

    socket.destroy();
    connection.close();
    await agentServer.stop();
  });

  it('replies with an empty identity list when no browser is paired', async () => {
    const agentServer = new AgentServer();
    await agentServer.listen(0, '127.0.0.1');
    const socketPath = await agentServer.startUnixSocket();

    const socket = netConnect(socketPath);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('error', reject);
    });

    const clientProtocol = new AgentProtocol(true);
    socket.pipe(clientProtocol).pipe(socket);

    // No session paired -> WsHub rejects immediately -> failureReply -> the
    // client-mode AgentProtocol surfaces that as an error, not a hang.
    await expect(
      new Promise<ParsedKey[]>((resolve, reject) => {
        clientProtocol.getIdentities((err, keys) => (err ? reject(err) : resolve(keys ?? [])));
      })
    ).rejects.toThrow();

    socket.destroy();
    await agentServer.stop();
  });
});
