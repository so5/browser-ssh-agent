import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// Default-import + destructure: see src/server/transports/unixSocketAgent.ts
// for why named imports from 'ssh2' aren't safe under plain Node ESM.
import ssh2 from 'ssh2';
import { AgentServer } from '../src/server/agentServer.js';
import { connectAgent, loadKeyFromText } from '../src/browser/index.js';
import { startTestSshServer } from './helpers/testSshServer.js';

const { Client } = ssh2;

const fixtureDir = fileURLToPath(new URL('./fixtures/', import.meta.url));
const readFixture = (name: string) => readFileSync(fixtureDir + name, 'utf8');

/**
 * Full round trip through the Phase 1 design: a real ssh2.Server verifies
 * publickey auth signed by our browser-side Ed25519 signer, relayed through
 * WsRelayAgent + WsHub over an actual WebSocket — proving the whole chain
 * (pairing, key decrypt, sign relay, ssh2 BaseAgent integration) produces a
 * signature real OpenSSH-compatible code accepts, not just internally
 * self-consistent bytes.
 */
describe('end-to-end: browser-held key authenticates a real ssh2.Client via AgentServer', () => {
  it('authenticates successfully when the correct key is loaded in the browser', async () => {
    const sshServer = await startTestSshServer(readFixture('id_ed25519_plain.pub'));

    const agentServer = new AgentServer();
    const { wsUrl } = await agentServer.listen(0, '127.0.0.1');
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

    const sshClient = new Client();
    await new Promise<void>((resolve, reject) => {
      sshClient
        .on('ready', () => resolve())
        .on('error', reject)
        .connect({
          host: '127.0.0.1',
          port: sshServer.port,
          username: 'testuser',
          agent: agentServer.agent(),
          agentForward: true,
        });
    });

    sshClient.end();
    connection.close();
    await agentServer.stop();
    await sshServer.close();
  });

  it('fails authentication when no key has been loaded in the browser', async () => {
    const sshServer = await startTestSshServer(readFixture('id_ed25519_plain.pub'));

    // Note: no browser session is ever paired with this AgentServer.
    const agentServer = new AgentServer();

    const sshClient = new Client();
    const failure = await new Promise<Error>((resolve) => {
      sshClient
        .on('ready', () => resolve(new Error('unexpectedly authenticated')))
        .on('error', (err) => resolve(err))
        .connect({
          host: '127.0.0.1',
          port: sshServer.port,
          username: 'testuser',
          agent: agentServer.agent(),
          agentForward: false,
        });
    });

    expect(failure).toBeInstanceOf(Error);

    await agentServer.stop();
    await sshServer.close();
  });
});
