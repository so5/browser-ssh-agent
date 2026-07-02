import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, unlinkSync } from 'node:fs';
import { type Server as NetServer, type Socket, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Named imports of `utils`/`Server` from 'ssh2' are unsafe under plain Node
// ESM: its CJS export object has a `utils: { ...require('./keygen.js') }`
// spread that trips up Node's static cjs-module-lexer interop detection
// (confirmed via `node -e "import('ssh2').then(m => console.log(Object.keys(m)))"`
// — `utils` and `Server` don't show up, even though `AgentProtocol`/`BaseAgent`/
// `Client`/`createAgent` do). The default-import + destructure pattern below
// always works because Node's interop always provides `default: module.exports`.
import ssh2 from 'ssh2';
import type { AgentInboundRequest, AgentProtocol as AgentProtocolType, ParsedKey } from 'ssh2';
import { decodeBase64, encodeBase64 } from '../../shared/base64.js';
import type { WsHub } from '../wsHub.js';

const { AgentProtocol, utils } = ssh2;

export interface UnixSocketAgentOptions {
  /** Defaults to a per-run unguessable path under `os.tmpdir()`. */
  socketPath?: string;
}

function randomSocketPath(): string {
  return join(tmpdir(), `bssh-agent-${randomBytes(8).toString('hex')}.sock`);
}

// Modern OpenSSH clients (8.9+) probe every agent connection with an
// SSH_AGENTC_EXTENSION (27) "session-bind@openssh.com" request before
// listing identities. ssh2's AgentProtocol server mode falls back to a
// `default:` case for message types it doesn't recognize that calls
// `failureReply()` (correct) but never advances its internal read offset
// past that message's payload (bug, present through at least ssh2@1.17.0 —
// confirmed by reading node_modules/ssh2/lib/agent.js: `SSH_AGENTC_EXTENSION`
// is defined only in a comment and never handled). The unconsumed payload
// bytes are then misread as the start of the *next* message, desyncing the
// framing for the rest of the connection — which is why a real `ssh`/`git`
// CLI would get its whole agent connection silently wedged after the very
// first probe, even though ssh2's own client-mode AgentProtocol (which never
// sends this probe) and `ssh-add` (older behavior) work fine.
//
// Workaround: intercept the raw inbound byte stream ourselves, answer
// SSH_AGENTC_EXTENSION with a correctly-framed SSH_AGENT_FAILURE (5)
// directly, and only forward every other message type to `AgentProtocol`
// untouched.
const SSH_AGENTC_EXTENSION = 27;
const SSH_AGENT_FAILURE_FRAME = Buffer.from([0, 0, 0, 1, 5]);

function pipeFilteringUnsupportedRequests(socket: Socket, protocol: AgentProtocolType): void {
  let buffered = Buffer.alloc(0);

  socket.on('data', (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);

    // Frame: uint32 length (of type byte + payload) + byte type + payload.
    while (buffered.length >= 5) {
      const msgLen = buffered.readUInt32BE(0);
      const totalLen = 4 + msgLen;
      if (buffered.length < totalLen) break;

      const message = buffered.subarray(0, totalLen);
      const msgType = message[4];

      if (msgType === SSH_AGENTC_EXTENSION) {
        socket.write(SSH_AGENT_FAILURE_FRAME);
      } else {
        protocol.write(message);
      }

      buffered = buffered.subarray(totalLen);
    }
  });

  socket.on('end', () => protocol.end());
}

/**
 * Phase 2 transport: a real `SSH_AUTH_SOCK` Unix domain socket speaking the
 * actual OpenSSH agent wire protocol via `ssh2`'s `AgentProtocol` in server
 * mode, so spawned external binaries (`git`, `ssh`, `rsync`, `scp` CLIs) can
 * use it transparently — unlike Phase 1's in-process `BaseAgent`, which is
 * only visible to SSH connections `ssh2`'s own `Client` makes in-process.
 * Relays `identities`/`sign` requests into the same `WsHub` Phase 1 uses, so
 * both transports can be active against one paired browser session at once.
 *
 * This file is the only thing that is invisible to a real ssh-agent-wire-protocol
 * inspection — everything else (pairing, browser key handling, signing) is
 * shared, unchanged code.
 */
export class UnixSocketAgent {
  readonly socketPath: string;
  private server: NetServer | null = null;
  private readonly sockets = new Set<Socket>();

  constructor(
    private readonly hub: WsHub,
    opts: UnixSocketAgentOptions = {}
  ) {
    this.socketPath = opts.socketPath ?? randomSocketPath();
  }

  async start(): Promise<string> {
    if (this.server) throw new Error('UnixSocketAgent is already started');

    if (existsSync(this.socketPath)) {
      unlinkSync(this.socketPath);
    }

    const server = createServer((socket) => this.handleConnection(socket));
    this.server = server;

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      server.once('error', onError);
      server.listen(this.socketPath, () => {
        server.removeListener('error', onError);
        resolve();
      });
    });

    // This socket file *is* the local privilege boundary: anything that can
    // connect gets full "sign arbitrary challenges with the loaded key"
    // power, equivalent in trust to real ssh-agent forwarding.
    chmodSync(this.socketPath, 0o600);

    return this.socketPath;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;

    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();

    await new Promise<void>((resolve) => server.close(() => resolve()));

    if (existsSync(this.socketPath)) {
      try {
        unlinkSync(this.socketPath);
      } catch {
        // Best-effort cleanup — nothing more useful to do if this fails.
      }
    }
  }

  private handleConnection(socket: Socket): void {
    this.sockets.add(socket);

    const protocol = new AgentProtocol(false);
    protocol.pipe(socket);
    pipeFilteringUnsupportedRequests(socket, protocol);

    protocol.on('identities', (req: AgentInboundRequest) => {
      this.hub
        .sendListIdentities()
        .then((result) => {
          const keys: ParsedKey[] = [];
          for (const identity of result.identities) {
            const parsed = utils.parseKey(Buffer.from(decodeBase64(identity.keyBlob)));
            if (parsed instanceof Error) continue;
            parsed.comment = identity.comment;
            keys.push(parsed);
          }
          protocol.getIdentitiesReply(req, keys);
        })
        .catch(() => protocol.failureReply(req));
    });

    protocol.on('sign', (req: AgentInboundRequest, pubKey: ParsedKey, data: Buffer) => {
      const keyBlobB64 = encodeBase64(new Uint8Array(pubKey.getPublicSSH()));
      const dataB64 = encodeBase64(new Uint8Array(data));

      this.hub
        .sendSign(keyBlobB64, dataB64, 0)
        .then((result) => {
          protocol.signReply(req, Buffer.from(decodeBase64(result.signature)));
        })
        .catch(() => protocol.failureReply(req));
    });

    const cleanup = () => {
      this.sockets.delete(socket);
      protocol.destroy();
    };
    socket.on('close', cleanup);
    socket.on('error', cleanup);
    protocol.on('error', cleanup);
  }
}
