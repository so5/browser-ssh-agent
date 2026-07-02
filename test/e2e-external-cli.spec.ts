import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { AgentServer } from '../src/server/agentServer.js';
import { connectAgent, loadKeyFromText } from '../src/browser/index.js';
import { startTestSshServer } from './helpers/testSshServer.js';

const execFileAsync = promisify(execFile);

const fixtureDir = fileURLToPath(new URL('./fixtures/', import.meta.url));
const readFixture = (name: string) => readFileSync(fixtureDir + name, 'utf8');

/**
 * The real point of Phase 2: prove *actual* OpenSSH CLI binaries (not just
 * ssh2-based code) can use the relayed browser key via SSH_AUTH_SOCK. This
 * spawns the real `ssh-add` and `ssh` executables as child processes,
 * exactly like a host app spawning `git`/`rsync` would.
 */
describe('end-to-end: real OpenSSH CLI binaries via SSH_AUTH_SOCK', () => {
  it('ssh-add -l lists the browser-held identity', async () => {
    const agentServer = new AgentServer();
    const { wsUrl } = await agentServer.listen(0, '127.0.0.1');
    await agentServer.startUnixSocket();

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

    const { stdout } = await execFileAsync('ssh-add', ['-l'], {
      env: { ...process.env, ...agentServer.env() },
    });

    expect(stdout).toContain('test-plain@fixture');
    expect(stdout.toUpperCase()).toContain('ED25519');

    connection.close();
    await agentServer.stop();
  });

  it('a real ssh binary authenticates against a real sshd using the relayed key', async () => {
    const sshServer = await startTestSshServer(readFixture('id_ed25519_plain.pub'));

    const agentServer = new AgentServer();
    const { wsUrl } = await agentServer.listen(0, '127.0.0.1');
    await agentServer.startUnixSocket();

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

    await expect(
      execFileAsync(
        'ssh',
        [
          '-F',
          '/dev/null',
          '-o',
          'StrictHostKeyChecking=no',
          '-o',
          'UserKnownHostsFile=/dev/null',
          '-o',
          'BatchMode=yes',
          '-o',
          'PreferredAuthentications=publickey',
          '-p',
          String(sshServer.port),
          'testuser@127.0.0.1',
          'true',
        ],
        { env: { ...process.env, ...agentServer.env() }, timeout: 10_000 }
      )
    ).resolves.toBeTruthy();

    connection.close();
    await agentServer.stop();
    await sshServer.close();
  });

  it('a real ssh binary fails to authenticate when no browser key is paired', async () => {
    const sshServer = await startTestSshServer(readFixture('id_ed25519_plain.pub'));

    const agentServer = new AgentServer();
    await agentServer.listen(0, '127.0.0.1');
    await agentServer.startUnixSocket();
    // Note: no browser session is ever paired.

    await expect(
      execFileAsync(
        'ssh',
        [
          '-F',
          '/dev/null',
          '-o',
          'StrictHostKeyChecking=no',
          '-o',
          'UserKnownHostsFile=/dev/null',
          '-o',
          'BatchMode=yes',
          '-o',
          'PreferredAuthentications=publickey',
          '-p',
          String(sshServer.port),
          'testuser@127.0.0.1',
          'true',
        ],
        { env: { ...process.env, ...agentServer.env() }, timeout: 10_000 }
      )
    ).rejects.toThrow();

    await agentServer.stop();
    await sshServer.close();
  });
});
