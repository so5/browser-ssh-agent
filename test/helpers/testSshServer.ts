import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
// Default-import + destructure: named imports of `utils`/`Server` from
// 'ssh2' break under plain Node ESM (see src/server/transports/unixSocketAgent.ts).
import ssh2 from 'ssh2';
import type { Server as SshServer } from 'ssh2';

const { Server, utils } = ssh2;

const fixtureDir = fileURLToPath(new URL('../fixtures/', import.meta.url));
const hostKey = readFileSync(fixtureDir + 'host_key');

export interface TestSshServer {
  server: SshServer;
  port: number;
  close(): Promise<void>;
}

/**
 * A minimal real `ssh2.Server` accepting publickey auth only for the given
 * allowed public key (verifying the signature, not just the key blob), with
 * a no-op `exec` handler so real `ssh <cmd>` invocations complete cleanly.
 * Shared by the in-process (`ssh2.Client`) and external-CLI (`ssh` binary) e2e tests.
 */
export async function startTestSshServer(allowedPubKeyPem: string): Promise<TestSshServer> {
  const allowedPubKey = utils.parseKey(allowedPubKeyPem);
  if (allowedPubKey instanceof Error) throw allowedPubKey;

  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    client
      .on('authentication', (ctx) => {
        if (ctx.method !== 'publickey') return ctx.reject(['publickey']);
        if (
          ctx.key.algo !== allowedPubKey.type ||
          !ctx.key.data.equals(allowedPubKey.getPublicSSH()) ||
          (ctx.signature && allowedPubKey.verify(ctx.blob!, ctx.signature, ctx.hashAlgo) !== true)
        ) {
          return ctx.reject();
        }
        ctx.accept();
      })
      .on('ready', () => {
        client.on('session', (accept) => {
          const session = accept();
          session.on('exec', (acceptExec) => {
            const stream = acceptExec();
            stream.exit(0);
            stream.end();
          });
        });
      });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    server,
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
