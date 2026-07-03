# 専用キーペアによる無人アクセスのブートストラップ

*[English](./DEDICATED_KEY_BOOTSTRAP.md)*

人間が立ち会わずに動作する自動化のために、アプリサーバーにリモートホストへの長期的なSSHアクセスを持たせる手順です（[READMEの「高度な使い方」セクション](../README.ja.md#無人運用人間が立ち会わないケース)を参照）。

この鍵には `bssh-agent` の「ディスクに触れない」という保証は適用されません — 他のサービス用認証情報と同様に、アプリサーバーのディスク上に存在し続ける通常の長期有効な秘密鍵です。`bssh-agent` を使うのは手順2のみで、公開鍵を設置する際に自分の個人鍵をアプリサーバーに置かずに済ませるためです。

## 1. アプリサーバー上でキーペアを生成する

```sh
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_to_remote-host -C "app-server-automation" -N ""
```

- ファイル名は汎用の `id_ed25519` ではなく、接続先や用途が分かる名前にしてください。
- `-N ""` は空のパスフレーズを設定します。無人利用には必須です。パスフレーズを残したい場合は[手順3のオプションB](#3-無人利用のために鍵を読み込む)を参照してください。
- パーミッションを確認してください:
  `chmod 700 ~/.ssh && chmod 600 ~/.ssh/id_ed25519_to_remote-host`

## 2. リモートホストに公開鍵を設置する

**オプション1 — アプリのNode.jsコードから、`child_process.spawn()` 経由で:**

```ts
import { spawn } from 'node:child_process';

spawn('ssh-copy-id', ['-i', '/path/to/id_ed25519_to_remote-host.pub', 'youruser@remote-host'], {
  env: { ...process.env, ...agentServer.env() },
  stdio: 'inherit',
});
```

または、`ssh-copy-id` を使わない場合:

```ts
spawn('sh', ['-c',
  'cat /path/to/id_ed25519_to_remote-host.pub | ssh youruser@remote-host "umask 077; mkdir -p ~/.ssh; cat >> ~/.ssh/authorized_keys"',
], {
  env: { ...process.env, ...agentServer.env() },
  stdio: 'inherit',
});
```

**オプション2 — 自分の端末から、`bssh-agent` CLI経由で:**

すでに `eval "$(bssh-agent)"` を実行し、自分の鍵をペアリング済みのシェルから（[CLIセクション](../README.ja.md#cli-ターミナル用の-ssh_auth_sock)を参照）:

```sh
ssh-copy-id -i ~/.ssh/id_ed25519_to_remote-host.pub youruser@remote-host
```

または:

```sh
cat ~/.ssh/id_ed25519_to_remote-host.pub | ssh youruser@remote-host \
  'umask 077; mkdir -p ~/.ssh; cat >> ~/.ssh/authorized_keys'
```

## 3. 無人利用のために鍵を読み込む

**オプションA — エージェントを使わず直接参照する:**

```
# アプリサーバー上の ~/.ssh/config
Host remote-host
  HostName remote-host.example.com
  User youruser
  IdentityFile ~/.ssh/id_ed25519_to_remote-host
  IdentitiesOnly yes
```

**オプションB — 起動時に永続的な `ssh-agent` へ読み込む:**

`ssh-agent` を起動してサービスアカウント用に `SSH_AUTH_SOCK` をエクスポートするsystemdユーザーサービスを用意し、起動後に一度 `ssh-add ~/.ssh/id_ed25519_to_remote-host` を実行します。手順1でパスフレーズを残した場合はこちらを使ってください。

## オプション: キーペアのローテーションと失効

- **ローテーション:** 新しいキーペアを生成し（手順1）、同じ制限オプションを付けてその公開鍵を `authorized_keys` に追記し、アプリサーバー側を切り替えて動作を確認します。その後、古い `authorized_keys` の行と古い秘密鍵ファイルを削除してください。
- **失効:** まずリモートホスト側の `~/.ssh/authorized_keys` から該当する行を削除し、その後にアプリサーバー側の秘密鍵ファイルを削除してください。

## オプション: `authorized_keys` で設置した鍵を制限する

リモートホスト側の `~/.ssh/authorized_keys` に追加された行を編集し、鍵の種類の前に制限オプションを追加してください。

```
command="/opt/app-server/scripts/run-backup.sh",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty,from="203.0.113.10" ssh-ed25519 AAAA... app-server-automation
```

- `command="..."` — 接続側が何を要求してきたかに関わらず、必ずこのコマンドを実行させます。実行するコマンドを変える必要がある場合は、ラッパースクリプト内で `$SSH_ORIGINAL_COMMAND` を使ってください。
- `from="203.0.113.10"`（IP/ホスト名/CIDR）— それ以外のアドレスからの接続を `sshd` レベルで拒否します。
- `no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty` — 自動化に不要な機能を無効化します。インタラクティブなシェルが必要な場合は `no-pty` を外してください。

完全な構文は `man 8 sshd` の「AUTHORIZED_KEYS FILE FORMAT」を参照してください。
