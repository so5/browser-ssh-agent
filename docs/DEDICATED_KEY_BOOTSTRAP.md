# Bootstrapping a dedicated keypair for unattended access

*[日本語](./DEDICATED_KEY_BOOTSTRAP.ja.md)*

Steps for giving an app server its own long-term SSH access to a remote
host, for automation that runs with no human present (see the
[README's Advanced section](../README.md#unattended-access-no-human-present)).

This key does not get `bssh-agent`'s "never touches disk" guarantee — it's a
plain, long-lived private key stored on the app server's disk like any other
service credential. `bssh-agent` is only used in step 2, to install the
public key without also putting your own personal key on the app server.

## 1. Generate the keypair, on the app server

```sh
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_to_remote-host -C "app-server-automation" -N ""
```

- Use a filename that identifies the remote host/purpose, not the generic
  `id_ed25519`.
- `-N ""` sets an empty passphrase, required for unattended use. To keep a
  passphrase instead, see [step 3, option B](#3-load-the-key-for-unattended-use).
- Confirm permissions:
  `chmod 700 ~/.ssh && chmod 600 ~/.ssh/id_ed25519_to_remote-host`.

## 2. Install the public key on the remote host

**Option 1 — from your Node.js app, via `child_process.spawn()`:**

```ts
import { spawn } from 'node:child_process';

spawn('ssh-copy-id', ['-i', '/path/to/id_ed25519_to_remote-host.pub', 'youruser@remote-host'], {
  env: { ...process.env, ...agentServer.env() },
  stdio: 'inherit',
});
```

or, without `ssh-copy-id`:

```ts
spawn('sh', ['-c',
  'cat /path/to/id_ed25519_to_remote-host.pub | ssh youruser@remote-host "umask 077; mkdir -p ~/.ssh; cat >> ~/.ssh/authorized_keys"',
], {
  env: { ...process.env, ...agentServer.env() },
  stdio: 'inherit',
});
```

**Option 2 — from your own terminal, via the `bssh-agent` CLI:**

From a shell where you've run `eval "$(bssh-agent)"` and paired your own key
(see the [CLI section](../README.md#cli-ssh_auth_sock-for-your-terminal)):

```sh
ssh-copy-id -i ~/.ssh/id_ed25519_to_remote-host.pub youruser@remote-host
```

or:

```sh
cat ~/.ssh/id_ed25519_to_remote-host.pub | ssh youruser@remote-host \
  'umask 077; mkdir -p ~/.ssh; cat >> ~/.ssh/authorized_keys'
```

## 3. Load the key for unattended use

**Option A — reference it directly, no agent:**

```
# ~/.ssh/config on the app server
Host remote-host
  HostName remote-host.example.com
  User youruser
  IdentityFile ~/.ssh/id_ed25519_to_remote-host
  IdentitiesOnly yes
```

**Option B — load into a persistent `ssh-agent` at boot:**

Systemd user service running `ssh-agent`, exporting `SSH_AUTH_SOCK` for the
service account, with `ssh-add ~/.ssh/id_ed25519_to_remote-host` run once
after boot. Use this if you kept a passphrase in step 1.

## Optional: keypair rotation and revocation

- **Rotate:** generate a new keypair (step 1), add its public key to
  `authorized_keys` with the same restrictions as before, switch the app
  server to it, confirm it works, then delete the old `authorized_keys` line
  and the old private key file.
- **Revoke:** delete the key's line from `~/.ssh/authorized_keys` on the
  remote host first, then delete the private key file from the app server.

## Optional: restrict the installed key in `authorized_keys`

On the remote host, edit the line added in `~/.ssh/authorized_keys`, adding
restriction options before the key type:

```
command="/opt/app-server/scripts/run-backup.sh",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty,from="203.0.113.10" ssh-ed25519 AAAA... app-server-automation
```

- `command="..."` — forces this exact command, ignoring whatever the client
  requests. Use `$SSH_ORIGINAL_COMMAND` inside a wrapper script if the
  command needs to vary.
- `from="203.0.113.10"` (IP/hostname/CIDR) — rejects connections from any
  other source at the `sshd` level.
- `no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty` —
  disable capabilities the automation doesn't need. Drop `no-pty` if an
  interactive shell is required.

Full syntax: `man 8 sshd` → "AUTHORIZED_KEYS FILE FORMAT".
