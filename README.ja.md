# browser-ssh-agent

*[English](./README.md)*

WebSocket 経由で SSH エージェントフォワーディングを実現するライブラリです。秘密鍵はブラウザタブの中だけに存在し、署名リクエストは WebSocket 経由で Node.js 側の SSH クライアントへ中継されます。`ssh -A` の「エージェント」役を、ローカルのソケットではなく **ペアリングされたブラウザセッション** が担う、と考えると分かりやすいです。

サーバー（Node.js）が秘密鍵そのものを保持することは一切なく、鍵はユーザーがブラウザ上でファイル選択とパスフレーズ入力を行った時点でのみ復号され、そのタブのメモリ上にのみ存在します。署名が必要になるたびに、その場でブラウザ側が署名し、結果だけが WebSocket 経由でサーバーに返されます。

## できること

サーバー側には 2 つのトランスポート（鍵リクエストの受け口）があり、どちらも同じペアリング済みブラウザセッションに対して中継されます。同時に両方を使うこともできます。

- **Phase 1 — インプロセス `BaseAgent`**（`agentServer.agent()`）
  Node.js アプリ自身が `ssh2` の `Client` API（`exec` / `sftp` / `forwardOut`、さらに接続先ホストからのエージェントフォワーディングなど）で SSH 接続する場合に使います。Unix ソケットを一切作らず、`ssh2.Client` にオブジェクトとして直接渡すだけです。
- **Phase 2 — 本物の `SSH_AUTH_SOCK` Unix ソケット**（`agentServer.startUnixSocket()` + `agentServer.env()`）
  `ssh` / `git` / `rsync` / `scp` など、外部の CLI バイナリを子プロセスとして起動する場合に使います。これらのコマンドは本物の ssh-agent ワイヤープロトコルを喋る Unix ドメインソケットしか理解できないため、Phase 1 のインプロセスオブジェクトでは対応できません。

v1 では **Ed25519 鍵のみ** サポートしています。RSA / ECDSA は `Signer` インターフェース（`src/browser/signers/`）を実装することで追加できる設計になっており、その際に通信プロトコルの変更は不要です。

## インストール

```sh
npm install bssh-agent
```

サブパスエクスポートとして `bssh-agent/server`（Node.js 用）、`bssh-agent/browser`（ブラウザ用）、`bssh-agent/shared`（両方から使う型・プロトコル定義）の 3 つを公開しています。ESM 専用パッケージです（`"type": "module"`）。

## 全体の流れ

1. サーバーが `AgentServer` を起動し、WebSocket サーバーを立ち上げる。
2. `agentServer.createPairingLink(baseUrl)` でペアリング用のワンタイムトークン付き URL を発行する。このトークンは URL の **フラグメント**（`#token=...`）に埋め込まれるため、サーバーやプロキシのアクセスログに残りません。
3. ユーザーがこの URL をブラウザで開き、秘密鍵ファイルとパスフレーズを入力する（`loadKeyFromFile`）。
4. ブラウザが WebSocket 接続を開き、`hello` メッセージとしてトークンを送信してペアリングを完了させる（`connectAgent`）。
5. サーバー側で `ssh2.Client` の接続や、`git` / `ssh` などの外部プロセス起動が行われると、鍵の一覧取得・署名リクエストが WebSocket 経由でブラウザへ中継される。
6. ブラウザ側は保持している鍵で署名し、結果を返す。必要であれば `confirmSign` コールバックでユーザーに確認ダイアログを出せる（`ssh-add -c` 相当）。

## 使い方

### サーバー側（Phase 1: `ssh2.Client` を直接使う場合）

```ts
import { AgentServer } from 'bssh-agent/server';
import { Client } from 'ssh2';

const agentServer = new AgentServer();
const { wsUrl } = await agentServer.listen(8787);

// このURLをユーザーに渡す（QRコード表示、リンク表示など）。
// トークンをフラグメントに載せているので、永続的なログファイルには残さないこと。
const { url } = agentServer.createPairingLink('https://your-app.example/pair');

agentServer.on('session-paired', async () => {
  const client = new Client();
  client.on('ready', () => { /* ... */ }).connect({
    host: 'target-host',
    username: 'you',
    agent: agentServer.agent(),
    agentForward: true, // target-host がさらに別ホストへ接続する場合も転送される
  });
});
```

### サーバー側（Phase 2: 外部 CLI バイナリを起動する場合）

```ts
import { spawn } from 'node:child_process';
import { AgentServer } from 'bssh-agent/server';

const agentServer = new AgentServer();
await agentServer.listen(8787);
await agentServer.startUnixSocket();
const { url } = agentServer.createPairingLink('https://your-app.example/pair');

agentServer.on('session-paired', () => {
  spawn('git', ['clone', 'git@github.com:you/repo.git'], {
    env: { ...process.env, ...agentServer.env() }, // SSH_AUTH_SOCK を子プロセスにだけ渡す
    stdio: 'inherit',
  });
});
```

### ブラウザ側

`createPairingLink` の `baseUrl` が指すページに、以下のようなコードを配置します。

```ts
import { loadKeyFromFile, connectAgent } from 'bssh-agent/browser';

const token = new URLSearchParams(location.hash.slice(1)).get('token')!;
const key = await loadKeyFromFile(fileInput.files[0], passphraseInput.value);

const connection = connectAgent({
  wsUrl: 'wss://your-app.example:8787',
  token,
  key,
  confirmSign: async ({ comment, fingerprint }) =>
    confirm(`${comment}（${fingerprint}）で署名しますか？`),
});

connection.on('status', (status) => {
  // 'connecting' | 'paired' | 'disconnected'
});
connection.on('error', (err) => {
  console.error(err);
});
```

不要になったら `connection.close()` を呼んで切断し、`key.zeroize()` を呼ぶことで鍵素材をメモリ上から（ベストエフォートで）消去できます。

## API リファレンス

### `bssh-agent/server`

- **`new AgentServer(options?)`**
  - `options.requestTimeoutMs`（既定 30 秒）: 個々の鍵一覧取得・署名リクエストのタイムアウト
  - `options.handshakeTimeoutMs`（既定 5 秒）: WebSocket 接続後、`hello` メッセージを待つ時間
- **`agentServer.listen(port, host?)`**: 単体で WebSocket サーバーを起動し、`{ wsUrl }` を返す
- **`agentServer.attachTo(httpServer, path?)`**: 既存の HTTP(S) サーバーの `upgrade` イベントに相乗りする（単体起動の代替）
- **`agentServer.createPairingLink(baseUrl, ttlMs?)`**: ワンタイムトークン付き URL を発行し、`{ url, sessionId, expiresAt }` を返す（既定の有効期限は 5 分）
- **`agentServer.agent()`**: Phase 1 用の `ssh2.BaseAgent` インスタンスを返す
- **`agentServer.startUnixSocket(options?)`** / **`stopUnixSocket()`**: Phase 2 用の Unix ソケットを起動・停止する
- **`agentServer.env()`**: `{ SSH_AUTH_SOCK: string }` を返す（`startUnixSocket()` 実行後のみ）
- **`agentServer.stop()`**: WebSocket サーバー・Unix ソケットの両方を停止する
- **`agentServer.isPaired`**: 現在ペアリング済みかどうか
- イベント: `session-paired` / `session-disconnected` / `request-timeout`（いずれも `sessionId` を伴う）

### `bssh-agent/browser`

- **`loadKeyFromFile(file: File, passphrase: string): Promise<KeyHandle>`**: `<input type="file">` から鍵を読み込み・復号する
- **`loadKeyFromText(pem: string, passphrase: string): Promise<KeyHandle>`**: PEM テキストから直接読み込む場合
- **`connectAgent(options): AgentConnection`**
  - `options.wsUrl` / `options.token` / `options.key`
  - `options.confirmSign?(info): boolean | Promise<boolean>`: 署名前にユーザー確認を挟む（`info.comment`, `info.fingerprint`）
- **`KeyHandle`**: 復号済み鍵のハンドル。`publicKeyBlobBase64` / `comment` / `zeroize()` / `isZeroized` を持つ。秘密鍵素材そのものへの public な getter はありません
- **`getSigner(keyType)`** / **`Signer`**: 鍵種別ごとの署名実装を登録するレジストリ（RSA/ECDSA 追加時の拡張ポイント）

### `bssh-agent/shared`

サーバー・ブラウザ間の WebSocket メッセージ型（`ServerToBrowserMessage` / `BrowserToServerMessage` など）や、SSH ワイヤーフォーマットのエンコード／デコード補助関数（`sshWire.ts`）を公開しています。独自の確認 UI やロギングを作る際に型として利用できます。

## セキュリティに関する注意

- **鍵素材はブラウザタブの JS ヒープ上に存在します。** これはサーバー側に鍵を保持させないという設計上の本質的なトレードオフであり、完全には排除できません。緩和策として、依存の少ない最小限のペアリング専用ページを用意する、厳格な CSP（`script-src 'self'`、インライン/eval 禁止）を設定する、iframe ではなく専用タブで開く、切断時やアイドル時に `KeyHandle.zeroize()` を呼ぶ、などを推奨します。
- **ループバック以外では必ず `wss://` を使ってください。** 平文の `ws://` はローカルホスト（`127.0.0.1`）宛てのみ許容されます。
- **`confirmSign` は必ず指定し、既定で承認を要求するようにしてください。** 指定しない場合、中継経路上の何者でもユーザーとしてサイレントに認証を成立させられてしまいます。なお ssh-agent プロトコルの仕様上、どのリモートホストへの認証かはエージェント側からは分からず、鍵のフィンガープリントしか判別できない点に注意してください。
- **ペアリングトークンはワンタイムであり、URL のフラグメントに埋め込まれます。** クエリパラメータには絶対に載せないでください（プロキシのログに残ることが多いため）。また、発行した URL 全体を永続的なログファイルに残さないでください。
- **Phase 2 の Unix ソケットファイルは、ローカルの権限境界そのものです。** このソケットに接続できるものは誰でも「読み込み済みの鍵で任意のチャレンジに署名させる」権限を持ちます。これは実際のエージェントフォワーディングと同等の信頼レベルです。ソケットは実行毎にランダムなパスに `0600` 権限で作成されます。Windows の名前付きパイプには対応しておらず、Unix ドメインソケットのみサポートしています。

## 既知の問題（回避済み）

`ssh2` パッケージの `AgentProtocol`（サーバーモード、Phase 2 で使用）には、モダンな OpenSSH クライアント（8.9 以降）が鍵一覧取得の前に送る `SSH_AGENTC_EXTENSION`（`session-bind@openssh.com` の確認用プローブ）の扱いに不具合があります。失敗応答自体は返すものの、そのメッセージのペイロード分だけ読み取り位置を進め忘れるため、以降の通信のフレーム境界がずれてしまい、エージェント接続全体が事実上使えなくなります。この不具合は `ssh2@1.17.0`（本ライブラリ作成時点の最新版）でも確認済みです。

`UnixSocketAgent` はこの種のメッセージを `AgentProtocol` に渡す前に自前でフィルタし、正しくフレーミングした失敗応答を直接返すことでこの問題を回避しています（`src/server/transports/unixSocketAgent.ts` の `pipeFilteringUnsupportedRequests` を参照）。この不具合は ssh2 のモック（インプロセス）テストでは再現せず、実際の `ssh` バイナリを使ったテストで初めて発覚しました。

## 制限事項（v1 時点）

- 対応鍵種別は Ed25519 のみ
- ペアリングトークンは 1 回きり — 接続が切れた場合、再ペアリングには新しいリンクの発行が必要（自動再接続はしない）
- 永続的な監査ログの仕組みは持たない（`AgentServer` が発行するイベントを利用してホスト側で実装してください）
- Windows の名前付きパイプ（named pipe）には非対応

## 開発

```sh
npm install
npm run typecheck
npm test
npm run build
```
