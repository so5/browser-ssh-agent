# browser-ssh-agent

*[日本語](./README.ja.md)*

SSH agent forwarding over WebSocket: the private key lives in a browser tab,
signing is relayed to a Node.js SSH client. A reimplementation of `ssh -A`
where the "agent" is a paired browser session instead of a local socket.

## Status: Phase 1 + Phase 2

Two server-side transports relay through the same paired browser session:

- **Phase 1 — in-process `BaseAgent`** (`agentServer.agent()`): for SSH
  connections your Node.js app makes itself through `ssh2`'s own `Client` API
  (`exec`/`sftp`/`forwardOut`, agent-forwarded hops to further remote hosts).
- **Phase 2 — real `SSH_AUTH_SOCK` Unix socket** (`agentServer.startUnixSocket()`
  + `agentServer.env()`): for spawning external `ssh`/`git`/`rsync`/`scp` CLI
  binaries as child processes, which only understand a real agent-protocol
  socket, not an in-process object.

Both can be active at once against one paired browser session.

Two more pieces build on top of that:

- **`bssh-agent` CLI** — a standalone daemon, `ssh-agent`-style, for the case
  Phase 2's `agentServer.env()` doesn't cover: a human typing `ssh`/`git`/`rsync`
  directly into their *own* interactive shell rather than a child process your
  Node app spawns. See [CLI: `SSH_AUTH_SOCK` for your terminal](#cli-ssh_auth_sock-for-your-terminal).
- **`<bssh-agent-pairing>` widget** (`bssh-agent/widget`) — a drop-in Web
  Component wrapping the browser-side primitives below, so a host page needs
  only a `<script>` tag and a custom element instead of hand-writing a key
  form and confirm-sign dialog. See [Browser, using the drop-in widget](#browser-using-the-drop-in-widget).

v1 supports Ed25519 keys only. RSA/ECDSA can be added by implementing the
`Signer` interface (`src/browser/signers/`) — no protocol change required.

**Known upstream issue worked around:** `ssh2`'s `AgentProtocol` (server mode,
used by Phase 2) mishandles the `SSH_AGENTC_EXTENSION` probe modern OpenSSH
clients (8.9+) send before listing identities — it replies correctly but
fails to skip the message's payload, desyncing the wire framing for
everything after and silently wedging the whole agent connection. `UnixSocketAgent`
filters and answers these probes itself before handing other messages to
`AgentProtocol`; see the comment above `pipeFilteringUnsupportedRequests` in
`src/server/transports/unixSocketAgent.ts` for details. Confirmed present
through `ssh2@1.17.0` (latest as of writing).

## Installation

```sh
npm install bssh-agent
```

ESM-only. Publishes four subpath exports: `bssh-agent/server` (Node.js),
`bssh-agent/browser`, `bssh-agent/widget` (the drop-in `<bssh-agent-pairing>`
Web Component, built on top of `bssh-agent/browser`), and `bssh-agent/shared`
(protocol types shared by all of them). Also installs a `bssh-agent` CLI
binary (`npx bssh-agent` or, with the package installed, just `bssh-agent`).

## Usage

Server:

```ts
import { AgentServer } from 'bssh-agent/server';
import { Client } from 'ssh2';

const agentServer = new AgentServer();
const { wsUrl } = await agentServer.listen(8787);

// Hand this URL to the user (QR code, printed link, ...). Never log it
// persistently — the pairing token lives in the fragment on purpose.
const { url } = agentServer.createPairingLink('https://your-app.example/pair');

agentServer.on('session-paired', async () => {
  const client = new Client();
  client.on('ready', () => { /* ... */ }).connect({
    host: 'target-host',
    username: 'you',
    agent: agentServer.agent(),
    agentForward: true, // forwards further if target-host hops onward
  });
});
```

Server, Phase 2 (spawning external CLI binaries):

```ts
import { spawn } from 'node:child_process';
import { AgentServer } from 'bssh-agent/server';

const agentServer = new AgentServer();
await agentServer.listen(8787);
await agentServer.startUnixSocket();
const { url } = agentServer.createPairingLink('https://your-app.example/pair');

agentServer.on('session-paired', () => {
  spawn('git', ['clone', 'git@github.com:you/repo.git'], {
    env: { ...process.env, ...agentServer.env() },
    stdio: 'inherit',
  });
});
```

Browser (served from the page `createPairingLink`'s `baseUrl` points at):

```ts
import { loadKeyFromFile, connectAgent } from 'bssh-agent/browser';

const token = new URLSearchParams(location.hash.slice(1)).get('token')!;
const key = await loadKeyFromFile(fileInput.files[0], passphraseInput.value);

const connection = connectAgent({
  wsUrl: 'wss://your-app.example:8787',
  token,
  key,
  confirmSign: async ({ comment, fingerprint }) =>
    confirm(`Sign with ${comment} (${fingerprint})?`),
});
```

### Browser, using the drop-in widget

`<bssh-agent-pairing>` wraps `loadKeyFromFile` + `connectAgent` above into a
single custom element with its own key-loading form and confirm-sign UI —
add a `<script>` tag and the tag itself, no hand-written form or dialog
required:

```html
<script type="module" src="/path/to/bssh-agent/dist/widget/index.js"></script>
<bssh-agent-pairing ws-url="wss://your-app.example:8787"></bssh-agent-pairing>
```

By default it reads the pairing token from `location.hash` (matching
`createPairingLink()`'s output) and derives `ws-url` from
`${location.protocol}://${location.host}/ws` if the attribute is omitted —
set the `token`/`wsUrl` properties from JS instead of attributes if your host
page needs to supply them programmatically (e.g. from an iframe parent).

It emits `status-change`, `paired`, `error`, `sign-request`, and
`key-forgotten` `CustomEvent`s so a host page can observe activity without
touching `bssh-agent/browser` directly:

```js
document.querySelector('bssh-agent-pairing').addEventListener('paired', () => {
  console.log('key paired and ready');
});
```

It zeroizes the loaded key automatically on disconnect (and via its built-in
"Forget key" button) — see [Security notes](#security-notes) — so there is
intentionally no one-click reconnect after a drop; the user re-enters their
passphrase. Set `auto-confirm="true"` to skip the built-in approve/deny
prompt entirely (logs a console warning when used — see security notes
below), or set the `confirmSign` property to supply your own UI instead of
the built-in one.

## CLI: `SSH_AUTH_SOCK` for your terminal

`agentServer.env()` only helps `child_process.spawn()` calls your own Node
process makes. It does nothing for a human typing `ssh`/`git`/`rsync`
directly into their own already-running shell — Unix has no way to inject an
env var into a sibling process after the fact. The `bssh-agent` CLI solves
this the same way real `ssh-agent` does:

```sh
eval "$(bssh-agent)"
```

This starts a background daemon, prints a pairing URL to stderr (and tries to
open it in your default browser, unless `--no-browser` or a remote/SSH
session is detected), and `eval`s `SSH_AUTH_SOCK`/`SSH_AGENT_PID` into your
current shell. Once you've paired a key via the opened page (using the
`<bssh-agent-pairing>` widget above), every subsequent `ssh`/`git`/`rsync` in
that shell picks up `SSH_AUTH_SOCK` for free — no code changes in any host
app required. If a command runs before you finish pairing, it just fails
auth cleanly and can be retried, the same way it would against a locked
GUI keychain agent.

```sh
bssh-agent -k    # stop the daemon and unset the env vars: eval "$(bssh-agent -k)"
```

Other flags: `-D`/`--foreground` (don't daemonize, useful for debugging),
`--name <name>` (run more than one instance), `--force` (replace an
already-running same-named instance), `--port <n>` (fixed pairing port
instead of an ephemeral one), `--runtime-dir <dir>` (override where state
files live, default `$XDG_RUNTIME_DIR/bssh-agent` or a tmpdir).

Unlike real `ssh-agent`, `bssh-agent -k` must be able to find a running
daemon from a *different* shell session than the one that started it, so it
keeps a small state file (pid, socket path, port) under its runtime
directory rather than relying solely on `SSH_AGENT_PID`.

## Security notes

- **Key material lives in the browser tab's JS heap** for the session. This
  is the fundamental trade-off of the design (avoiding the server holding the
  key) and is not fully eliminable — mitigate with a minimal, dependency-light
  pairing page, a strict CSP (`script-src 'self'`, no inline/eval), a
  dedicated tab rather than an iframe, and call `KeyHandle.zeroize()` on
  disconnect/idle.
- **Use `wss://` off-loopback.** Plain `ws://` is only acceptable to
  `127.0.0.1`.
- **`confirmSign` should be supplied and default to requiring approval** —
  without it, anything relaying through the paired server can silently
  authenticate as the user. Note the agent protocol never reveals *which
  remote host* a challenge is for, only the key fingerprint.
- **Pairing tokens are single-use and go in the URL fragment**, never a query
  parameter (proxies commonly log those) and never a persistent log file.
- **The Phase 2 Unix socket file is a local privilege boundary**: anything on
  the machine that can connect to it gets full "sign arbitrary challenges
  with the loaded key" power, equivalent in trust to real agent forwarding.
  It's created at a per-run unguessable path with `0600` permissions. No
  Windows named-pipe support — Unix domain socket only.
- **The CLI's self-served pairing page binds `127.0.0.1` only**, never
  `0.0.0.0`, by default. Using it over SSH into a remote box requires you to
  `ssh -L` the pairing port yourself — the CLI skips auto-opening a browser
  when `SSH_CONNECTION`/`SSH_TTY` suggest a remote/headless session.
- **The widget's `auto-confirm="true"` attribute is a documented, dangerous
  escape hatch** (it logs a console warning when used): it approves every
  sign request with no prompt at all, equivalent to running without
  `confirmSign`. Only use it where the host page implements its own
  equivalent safeguard.

## Development

```sh
npm install
npm run typecheck
npm test
npm run build
npm run test:cli   # builds, then exercises the real bssh-agent binary end-to-end
```
