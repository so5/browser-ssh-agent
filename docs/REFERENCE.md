# API Reference

Exhaustive reference for `bssh-agent`'s public API. For a narrative
getting-started guide, see [README.md](../README.md).

- [`bssh-agent/server`](#bssh-agentserver)
- [`bssh-agent/browser`](#bssh-agentbrowser)
- [`bssh-agent/widget`](#bssh-agentwidget)
- [`bssh-agent/shared`](#bssh-agentshared)
- [`bssh-agent` CLI](#bssh-agent-cli)

## `bssh-agent/server`

### `class AgentServer`

Owns pairing and the WebSocket hub, and exposes the Unix socket transport
(`SSH_AUTH_SOCK`) that external `ssh`/`git`/`rsync`/`scp` CLI binaries use,
plus a lower-level `ssh2`-compatible agent object for apps that make SSH
connections themselves — see [Advanced](../README.md#advanced) in the
README.

```ts
new AgentServer(options?: AgentServerOptions)
```

| Option | Type | Default | Meaning |
|---|---|---|---|
| `requestTimeoutMs` | `number` | `30000` | How long a single `list-identities`/`sign` request waits for the browser's reply before failing. |
| `handshakeTimeoutMs` | `number` | `5000` | How long a freshly-opened WebSocket has to send a valid `hello` before being dropped. |

#### Methods

- **`attachTo(server: http.Server, path?: string): void`** — hook WebSocket
  upgrade handling into an existing HTTP(S) server (the normal way to wire
  up `AgentServer` — see the README's Usage section). `path` defaults to
  matching any path; pass `'/ws'` to match the `<bssh-agent-pairing>`
  widget's zero-config default WS URL derivation.
- **`listen(port: number, host?: string): Promise<{ wsUrl: string }>`** —
  alternative to `attachTo()`: starts a standalone WebSocket server instead
  of attaching to an app's existing HTTP server. Useful for a minimal
  script or a dedicated pairing-only process.
- **`startUnixSocket(options?: UnixSocketAgentOptions): Promise<string>`** —
  starts the real `SSH_AUTH_SOCK` Unix domain socket, returns its path.
  `options.socketPath` overrides the default per-run unguessable path under
  `os.tmpdir()`.
- **`stopUnixSocket(): Promise<void>`**
- **`env(): { SSH_AUTH_SOCK: string }`** — throws if `startUnixSocket()`
  hasn't been called yet. Spread into `child_process.spawn(cmd, args, { env: { ...process.env, ...agentServer.env() } })`.
- **`createPairingLink(baseUrl: string, ttlMs?: number): PairingLink`** —
  mints a single-use pairing token bound to a fresh session, encoded into
  `baseUrl`'s URL fragment (`#token=...`). `ttlMs` defaults to 5 minutes.
  Returns `{ url, sessionId, expiresAt }`.
- **`agent(): WsRelayAgent`** — a `ssh2`-compatible `BaseAgent` for apps
  that make SSH connections themselves via `ssh2`'s own `Client` API,
  instead of spawning external CLI tools. See
  [Advanced](../README.md#advanced) in the README.
- **`stop(): Promise<void>`** — closes the WebSocket server/hub, disposes
  the token store, and stops the Unix socket if started.
- **`isPaired: boolean`** (getter) — whether a browser session is currently paired.

#### Events (`AgentServer extends EventEmitter`)

| Event | Payload | When |
|---|---|---|
| `session-paired` | `(sessionId: string)` | A browser session completes the pairing handshake. |
| `session-disconnected` | `(sessionId: string)` | A paired browser session's WebSocket closes. |
| `request-timeout` | `(sessionId: string, id: string)` | A `list-identities`/`sign` request wasn't answered within `requestTimeoutMs`. |

### `formatAgentStartScript(vars: AgentStartVars): string`

Formats `SSH_AUTH_SOCK`/`SSH_AGENT_PID` as Bourne-shell `export` statements,
matching real `ssh-agent`'s own output format (`eval`-able). Used internally
by the `bssh-agent` CLI; exported so a host app's own CLI/daemon tooling can
reuse the same formatting without adopting the bundled CLI's shape.

```ts
interface AgentStartVars { sshAuthSock: string; agentPid: number }
```

### `formatAgentKillScript(agentPid: number): string`

Formats the `unset`-statement counterpart, matching `ssh-agent -k`'s output.

### Lower-level building blocks

Most apps only need `AgentServer` above. These are exported for advanced
composition (e.g. a host app that wants its own transport wiring):

- **`TokenStore`** — issues/validates the single-use pairing tokens `AgentServer` uses internally.
- **`WsHub`** — the session registry and request/response correlation layer both transports (`WsRelayAgent`, `UnixSocketAgent`) relay through.
- **`WsRelayAgent`** — the `ssh2.BaseAgent` implementation returned by `agentServer.agent()`.
- **`UnixSocketAgent`** — the Unix-socket transport `agentServer.startUnixSocket()` starts.

## `bssh-agent/browser`

### `loadKeyFromFile(file: File, passphrase: string): Promise<KeyHandle>`

Parses and decrypts an OpenSSH `id_ed25519`-style private key file, holding
the result in memory as a `KeyHandle`.

### `loadKeyFromText(pem: string, passphrase: string): Promise<KeyHandle>`

Same as `loadKeyFromFile`, but from raw PEM text instead of a `File` object
— e.g. for reusing previously-read text without re-prompting for a file
(this is what `<bssh-agent-pairing>` uses internally to support reconnecting
with only the passphrase; see the README's widget section).

### `class KeyHandle`

Holds decrypted key material for the lifetime of a paired session. The
private seed is never exposed via a public getter.

- **`keyType: string`** (readonly) — currently always `'ssh-ed25519'`.
- **`comment: string`** (readonly) — the key file's comment field.
- **`publicKeyBlob: Uint8Array`** (getter) — SSH wire-format public key blob.
- **`publicKeyBlobBase64: string`** (getter)
- **`isZeroized: boolean`** (getter)
- **`zeroize(): void`** — discards the decrypted seed; `isZeroized` becomes `true` and any later signing attempt throws. Call this on disconnect/idle/explicit "forget key" (the widget already does this for you — see the README).

### `connectAgent(options: ConnectAgentOptions): AgentConnection`

Opens the WebSocket to the paired server, performs the `hello`/`hello-ack`
handshake, answers `list-identities` automatically, and gates each `sign`
request behind `confirmSign` if supplied.

```ts
interface ConnectAgentOptions {
  wsUrl: string;
  /** Single-use pairing token, e.g. read from `location.hash`. */
  token: string;
  key: KeyHandle;
  /** Gate each sign request behind explicit approval, mirroring `ssh-add -c`.
   *  Strongly recommended — see the README's security notes. Defaults to
   *  auto-approving if omitted. */
  confirmSign?: (info: ConfirmSignInfo) => Promise<boolean> | boolean;
}

interface ConfirmSignInfo { comment: string; fingerprint: string }

type AgentConnectionStatus = 'connecting' | 'paired' | 'disconnected';

interface AgentConnection {
  readonly status: AgentConnectionStatus;
  close(): void;
  on(event: 'status', handler: (status: AgentConnectionStatus) => void): void;
  on(event: 'error', handler: (err: Error) => void): void;
}
```

### `getSigner(keyType: string): Signer | undefined`

Looks up the signer registered for a given SSH key-type string. Adding a
new key type (RSA/ECDSA) is a new file implementing `Signer` plus a
registration in `src/browser/signers/index.ts` — no protocol change.

```ts
interface Signer {
  keyType: string;
  sign(handle: KeyHandle, data: Uint8Array): Promise<Uint8Array> | Uint8Array;
}
```

## `bssh-agent/widget`

### `<bssh-agent-pairing>` (`class BsshAgentPairingElement`)

Drop-in Web Component wrapping `loadKeyFromText` + `connectAgent` above
into a single custom element with its own key-loading form and confirm-sign
UI. Importing `bssh-agent/widget` registers the element as a side effect.

#### Attributes / properties

| Attribute | Property | Type | Default |
|---|---|---|---|
| `token` | `token` | `string` | Read from `location.hash`'s `token` param if unset. |
| `ws-url` | `wsUrl` | `string` | `${location.protocol==='https:'?'wss':'ws'}://${location.host}/ws` if unset. |
| `auto-confirm` | — | `"true"` / absent | Skips the built-in confirm-sign prompt entirely. Dangerous — see the README's security notes. |
| — | `confirmSign` | `(info: ConfirmSignInfo) => Promise<boolean> \| boolean` | Supply your own confirm-sign UI instead of the built-in prompt. |

Properties are resolved lazily (at the moment a sign-in/reconnect action is
taken), so a host page can set them any time after inserting the element.

#### Events

All are `CustomEvent`s with `{ bubbles: true, composed: true }`.

| Event | `detail` | When |
|---|---|---|
| `status-change` | `{ status: AgentConnectionStatus }` | Mirrors every underlying `AgentConnection` status change. |
| `paired` | — | Fired once, on the transition to `'paired'`. |
| `error` | `{ message: string }` | Mirrors the underlying `AgentConnection`'s `'error'` event. |
| `sign-request` | `{ comment: string; fingerprint: string }` | Fired whenever a sign request arrives, even if a host-supplied `confirmSign` handles it. |
| `key-forgotten` | — | Fired whenever the decrypted key is zeroized (disconnect, "Forget key", or "Use a different file"). |

#### Behavior notes

- Zeroizes the *decrypted* key on every disconnect. The passphrase is
  always required again afterward.
- Caches the still-*encrypted* key file text in memory across a disconnect,
  so reconnecting shows a passphrase-only form instead of the full file
  picker — see the README's widget section for the full rationale. "Forget
  key" and "Use a different file" both discard this cache; a page reload
  discards it too (it isn't persisted anywhere).
- Reconnecting always needs a fresh pairing token — there is no session
  resumption.

## `bssh-agent/shared`

Protocol types and constants shared by the server and browser sides.
Mostly relevant if you're integrating at the WebSocket-protocol level
directly rather than through `AgentServer`/`connectAgent`.

| Export | Value/Type | Meaning |
|---|---|---|
| `PROTOCOL_VERSION` | `1` | Wire-protocol version tag on every message. |
| `DEFAULT_TOKEN_TTL_MS` | `300000` (5 min) | Default pairing token lifetime. |
| `DEFAULT_HANDSHAKE_TIMEOUT_MS` | `5000` | Default time a WS connection has to send `hello`. |
| `DEFAULT_REQUEST_TIMEOUT_MS` | `30000` | Default per-request (`list-identities`/`sign`) timeout. |
| `SSH_ED25519` | `'ssh-ed25519'` | SSH key-type string constant. |

Also exports the full `ServerToBrowserMessage`/`BrowserToServerMessage`
union types (`hello`, `hello-ack`, `list-identities`, `sign`, `error`,
`close`, ...) and small wire-format helpers (`encodeBase64`/`decodeBase64`,
SSH string/uint32 encoding). See `src/shared/protocol.ts` in the repository
for the exhaustive message shapes.

## `bssh-agent` CLI

```
usage: bssh-agent [options]
       bssh-agent -k
```

Starts a daemon and prints shell export commands for `SSH_AUTH_SOCK`,
mirroring real `ssh-agent`'s own UX — see the README's CLI section for the
full walkthrough (`eval "$(bssh-agent)"`).

| Flag | Meaning |
|---|---|
| `-D`, `--foreground` | Run in the foreground instead of daemonizing. |
| `-k`, `--kill` | Kill the running agent (by `--name`) and print `unset` statements for its env vars. |
| `--name <name>` | Agent instance name, for running more than one concurrently. Default: `"default"`. |
| `--force` | Replace an already-running agent with the same `--name`. |
| `--no-browser` | Don't try to open the pairing URL in a browser. |
| `--port <n>` | Pairing HTTP/WS port. Default: `0` (an ephemeral port). |
| `--runtime-dir <dir>` | Where state files (pid, socket path, port) live. Default: `$XDG_RUNTIME_DIR/bssh-agent` or a tmpdir. |
| `-h`, `--help` | Show usage. |

The launcher's stdout is reserved exclusively for the `eval`-able export
script — the pairing URL and all other output go to stderr.
