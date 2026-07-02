import { EventEmitter } from 'node:events';
import type { Server as HttpServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { TokenStore } from './pairing.js';
import { WsHub } from './wsHub.js';
import { WsRelayAgent } from './transports/inProcessAgent.js';
import { UnixSocketAgent, type UnixSocketAgentOptions } from './transports/unixSocketAgent.js';
import { DEFAULT_TOKEN_TTL_MS } from '../shared/constants.js';

export interface AgentServerOptions {
  requestTimeoutMs?: number;
  handshakeTimeoutMs?: number;
}

export interface PairingLink {
  /** Hand this URL to the user (QR code, printed link, ...) — never log it persistently. */
  url: string;
  sessionId: string;
  expiresAt: number;
}

export interface AgentServer {
  on(event: 'session-paired', listener: (sessionId: string) => void): this;
  on(event: 'session-disconnected', listener: (sessionId: string) => void): this;
  on(event: 'request-timeout', listener: (sessionId: string, id: string) => void): this;
}

const RELAYED_EVENTS = ['session-paired', 'session-disconnected', 'request-timeout'] as const;

/**
 * Public facade: owns pairing + the WebSocket hub, and exposes two
 * transports onto the same paired browser session — Phase 1's in-process
 * `BaseAgent` (`agent()`, for SSH connections `ssh2.Client` makes itself)
 * and Phase 2's real `SSH_AUTH_SOCK` Unix socket (`startUnixSocket()` +
 * `env()`, for spawning external `git`/`ssh`/`rsync`/`scp` CLI binaries).
 * Both can be active at once; both relay through the same `WsHub`.
 */
export class AgentServer extends EventEmitter {
  private readonly tokenStore = new TokenStore();
  private readonly hub: WsHub;
  private readonly relayAgent: WsRelayAgent;
  private wss: WebSocketServer | null = null;
  private unixSocketAgent: UnixSocketAgent | null = null;

  constructor(opts: AgentServerOptions = {}) {
    super();
    this.hub = new WsHub({
      tokenStore: this.tokenStore,
      requestTimeoutMs: opts.requestTimeoutMs,
      handshakeTimeoutMs: opts.handshakeTimeoutMs,
    });
    this.relayAgent = new WsRelayAgent(this.hub);

    for (const event of RELAYED_EVENTS) {
      this.hub.on(event, (...args: unknown[]) => this.emit(event, ...args));
    }
  }

  /** Standalone mode: start our own WebSocket server listening on `port`. */
  async listen(port: number, host?: string): Promise<{ wsUrl: string }> {
    if (this.wss) throw new Error('AgentServer is already listening/attached');
    const wss = new WebSocketServer({ port, host });
    this.wss = wss;
    wss.on('connection', (ws) => this.hub.handleConnection(ws));

    await new Promise<void>((resolve, reject) => {
      wss.once('listening', () => resolve());
      wss.once('error', reject);
    });

    const address = wss.address();
    const actualPort = typeof address === 'object' && address ? address.port : port;
    return { wsUrl: `ws://${host ?? 'localhost'}:${actualPort}` };
  }

  /** Embedded mode: hook WS upgrade handling into an existing HTTP(S) server instead of listening standalone. */
  attachTo(server: HttpServer, path?: string): void {
    if (this.wss) throw new Error('AgentServer is already listening/attached');
    const wss = new WebSocketServer({ noServer: true });
    this.wss = wss;
    server.on('upgrade', (req, socket, head) => {
      if (path && req.url !== path) return;
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    });
    wss.on('connection', (ws) => this.hub.handleConnection(ws));
  }

  async stop(): Promise<void> {
    this.hub.dispose();
    this.tokenStore.dispose();
    if (this.wss) {
      const wss = this.wss;
      this.wss = null;
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
    await this.stopUnixSocket();
  }

  /**
   * Phase 2: starts a real `SSH_AUTH_SOCK` Unix domain socket so spawned
   * external binaries (not just `ssh2.Client` calls made in-process) can use
   * the paired browser session as their agent. Returns the socket path;
   * use `env()` afterward to get the env var to spread into
   * `child_process.spawn(cmd, args, { env: { ...process.env, ...agentServer.env() } })`.
   */
  async startUnixSocket(opts: UnixSocketAgentOptions = {}): Promise<string> {
    if (this.unixSocketAgent) throw new Error('Unix socket transport is already started');
    const unixSocketAgent = new UnixSocketAgent(this.hub, opts);
    this.unixSocketAgent = unixSocketAgent;
    return unixSocketAgent.start();
  }

  async stopUnixSocket(): Promise<void> {
    const unixSocketAgent = this.unixSocketAgent;
    this.unixSocketAgent = null;
    if (unixSocketAgent) await unixSocketAgent.stop();
  }

  /** The `SSH_AUTH_SOCK` env var for spawned children — requires `startUnixSocket()` first. */
  env(): { SSH_AUTH_SOCK: string } {
    if (!this.unixSocketAgent) {
      throw new Error('Unix socket transport is not started — call startUnixSocket() first');
    }
    return { SSH_AUTH_SOCK: this.unixSocketAgent.socketPath };
  }

  /**
   * Mints a single-use pairing token bound to a fresh session, encoded into
   * `baseUrl`'s fragment (never sent to any server/proxy/log). Point
   * `baseUrl` at whatever page hosts `connectAgent()` from `bssh-agent/browser`.
   */
  createPairingLink(baseUrl: string, ttlMs: number = DEFAULT_TOKEN_TTL_MS): PairingLink {
    const { token, sessionId, expiresAt } = this.tokenStore.issue(ttlMs);
    const url = new URL(baseUrl);
    url.hash = `token=${token}`;
    return { url: url.toString(), sessionId, expiresAt };
  }

  /** The Phase 1 ssh2 `BaseAgent` — pass to `new ssh2.Client().connect({ agent, agentForward: true })`. */
  agent(): WsRelayAgent {
    return this.relayAgent;
  }

  get isPaired(): boolean {
    return this.hub.isPaired;
  }
}
