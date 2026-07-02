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

ESM-only. Publishes three subpath exports: `bssh-agent/server` (Node.js),
`bssh-agent/browser`, and `bssh-agent/shared` (protocol types shared by
both).

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

## Development

```sh
npm install
npm run typecheck
npm test
npm run build
```
