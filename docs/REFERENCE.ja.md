# API リファレンス

*[English](./REFERENCE.md)*

`bssh-agent` の公開APIの網羅的なリファレンスです。はじめて使う場合のガイドは [README.ja.md](../README.ja.md) を参照してください。

- [`bssh-agent/server`](#bssh-agentserver)
- [`bssh-agent/browser`](#bssh-agentbrowser)
- [`bssh-agent/widget`](#bssh-agentwidget)
- [`bssh-agent/shared`](#bssh-agentshared)
- [`bssh-agent` CLI](#bssh-agent-cli)

## `bssh-agent/server`

### `class AgentServer`

ペアリングと WebSocket ハブを管理し、外部の `ssh` / `git` / `rsync` / `scp` CLI バイナリが使う Unix ソケットトランスポート（`SSH_AUTH_SOCK`）と、自前で SSH 接続を行うアプリ向けの低レベルな `ssh2` 互換エージェントオブジェクトの両方を提供します — 詳しくは README の[高度な使い方](../README.ja.md#高度な使い方)を参照してください。

```ts
new AgentServer(options?: AgentServerOptions)
```

| オプション | 型 | 既定値 | 意味 |
|---|---|---|---|
| `requestTimeoutMs` | `number` | `30000` | 個々の `list-identities` / `sign` リクエストがブラウザからの応答を待つ時間。 |
| `handshakeTimeoutMs` | `number` | `5000` | WebSocket 接続直後、有効な `hello` を待つ時間。これを過ぎると切断される。 |

#### メソッド

- **`attachTo(server: http.Server, path?: string): void`** — 既存の HTTP(S) サーバーの WebSocket アップグレード処理にフックする（`AgentServer` を組み込む標準的な方法 — README の使い方セクションを参照）。`path` を省略するとすべてのパスにマッチする。`<bssh-agent-pairing>` ウィジェットのゼロコンフィグ既定値に合わせる場合は `'/ws'` を渡す。
- **`listen(port: number, host?: string): Promise<{ wsUrl: string }>`** — `attachTo()` の代替。既存の HTTP サーバーにアタッチする代わりに、単体の WebSocket サーバーを起動する。最小限のスクリプトやペアリング専用プロセス向け。
- **`startUnixSocket(options?: UnixSocketAgentOptions): Promise<string>`** — 本物の `SSH_AUTH_SOCK` Unix ドメインソケットを起動し、そのパスを返す。`options.socketPath` を指定すると、`os.tmpdir()` 配下の既定の実行毎ランダムパスを上書きできる。
- **`stopUnixSocket(): Promise<void>`**
- **`env(): { SSH_AUTH_SOCK: string }`** — `startUnixSocket()` を呼んでいない場合は例外を投げる。`child_process.spawn(cmd, args, { env: { ...process.env, ...agentServer.env() } })` のように展開して使う。
- **`createPairingLink(baseUrl: string, ttlMs?: number): PairingLink`** — 新しいセッションに紐づくワンタイムペアリングトークンを発行し、`baseUrl` の URL フラグメント（`#token=...`）に埋め込む。`ttlMs` の既定値は5分。`{ url, sessionId, expiresAt }` を返す。
- **`agent(): WsRelayAgent`** — 外部 CLI ツールを起動する代わりに、`ssh2` 自身の `Client` API で SSH 接続を自前で行うアプリ向けの `ssh2` 互換 `BaseAgent`。詳しくは README の[高度な使い方](../README.ja.md#高度な使い方)を参照。
- **`stop(): Promise<void>`** — WebSocket サーバー/ハブを閉じ、トークンストアを破棄し、Unix ソケットが起動していれば停止する。
- **`isPaired: boolean`**（getter） — 現在ブラウザセッションがペアリング済みかどうか。

#### イベント（`AgentServer extends EventEmitter`）

| イベント | ペイロード | 発生タイミング |
|---|---|---|
| `session-paired` | `(sessionId: string)` | ブラウザセッションがペアリングハンドシェイクを完了したとき。 |
| `session-disconnected` | `(sessionId: string)` | ペアリング済みブラウザセッションの WebSocket が閉じたとき。 |
| `request-timeout` | `(sessionId: string, id: string)` | `list-identities` / `sign` リクエストが `requestTimeoutMs` 以内に応答されなかったとき。 |

### `formatAgentStartScript(vars: AgentStartVars): string`

`SSH_AUTH_SOCK` / `SSH_AGENT_PID` を、本物の `ssh-agent` 自身の出力形式と一致する Bourne シェルの `export` 文として整形する（`eval` 可能）。`bssh-agent` CLI の内部で使われているが、ホストアプリ独自の CLI/デーモンツールが同じ整形処理を、バンドル済み CLI の構造を採用せずに再利用できるようエクスポートされている。

```ts
interface AgentStartVars { sshAuthSock: string; agentPid: number }
```

### `formatAgentKillScript(agentPid: number): string`

`ssh-agent -k` の出力に対応する `unset` 文を整形する。

### より低レベルな構成要素

ほとんどのアプリは上記の `AgentServer` だけで十分です。以下は、独自のトランスポート実装など、より高度な組み合わせ方をしたいホストアプリ向けにエクスポートされています。

- **`TokenStore`** — `AgentServer` が内部で使うワンタイムペアリングトークンの発行・検証を行う。
- **`WsHub`** — 2つのトランスポート（`WsRelayAgent`、`UnixSocketAgent`）がいずれも経由する、セッションレジストリとリクエスト/レスポンスの対応付けレイヤー。
- **`WsRelayAgent`** — `agentServer.agent()` が返す `ssh2.BaseAgent` の実装。
- **`UnixSocketAgent`** — `agentServer.startUnixSocket()` が起動する Unix ソケットトランスポート。

## `bssh-agent/browser`

### `loadKeyFromFile(file: File, passphrase: string): Promise<KeyHandle>`

OpenSSH の `id_ed25519` 形式の秘密鍵ファイルをパース・復号し、結果をメモリ上の `KeyHandle` として保持する。

### `loadKeyFromText(pem: string, passphrase: string): Promise<KeyHandle>`

`loadKeyFromFile` と同様だが、`File` オブジェクトではなく生の PEM テキストから読み込む — 例えば、ファイルを再度選択させずに以前読み込んだテキストを再利用する場合に使う（これは `<bssh-agent-pairing>` がパスフレーズのみでの再接続をサポートするために内部で使っている方法。README のウィジェットの節を参照）。

### `class KeyHandle`

ペアリングセッションが続く間、復号済みの鍵素材を保持する。秘密鍵のシード自体は public な getter では一切公開されない。

- **`keyType: string`**（読み取り専用） — 現状は常に `'ssh-ed25519'`。
- **`comment: string`**（読み取り専用） — 鍵ファイルのコメントフィールド。
- **`publicKeyBlob: Uint8Array`**（getter） — SSH ワイヤーフォーマットの公開鍵ブロブ。
- **`publicKeyBlobBase64: string`**（getter）
- **`isZeroized: boolean`**（getter）
- **`zeroize(): void`** — 復号済みシードを破棄する。呼び出すと `isZeroized` が `true` になり、以降の署名試行は例外を投げる。切断時・アイドル時・明示的な「鍵を忘れる」操作の際に呼ぶこと（ウィジェットは既にこれを自動的に行っている — README を参照）。

### `connectAgent(options: ConnectAgentOptions): AgentConnection`

ペアリング先サーバーへ WebSocket を開き、`hello` / `hello-ack` ハンドシェイクを行い、`list-identities` には自動的に応答し、`confirmSign` が指定されていれば各 `sign` リクエストをそのゲートで確認させる。

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

指定した SSH 鍵種別文字列に登録された署名実装を検索する。新しい鍵種別（RSA/ECDSA）を追加するには、`Signer` を実装した新しいファイルを作成し、`src/browser/signers/index.ts` に登録すればよい — プロトコルの変更は不要。

```ts
interface Signer {
  keyType: string;
  sign(handle: KeyHandle, data: Uint8Array): Promise<Uint8Array> | Uint8Array;
}
```

## `bssh-agent/widget`

### `<bssh-agent-pairing>`（`class BsshAgentPairingElement`）

上記の `loadKeyFromText` + `connectAgent` を、鍵読み込みフォームと署名確認 UI を備えた単一のカスタムエレメントにラップしたドロップイン Web Component。`bssh-agent/widget` を import すると、副作用としてこのエレメントが登録される。

#### 属性 / プロパティ

| 属性 | プロパティ | 型 | 既定値 |
|---|---|---|---|
| `token` | `token` | `string` | 未指定の場合、`location.hash` の `token` パラメータから読み取る。 |
| `ws-url` | `wsUrl` | `string` | 未指定の場合、`${location.protocol==='https:'?'wss':'ws'}://${location.host}/ws`。 |
| `auto-confirm` | — | `"true"` / 未指定 | 組み込みの署名確認プロンプトを完全にスキップする。危険 — README のセキュリティに関する注意を参照。 |
| — | `confirmSign` | `(info: ConfirmSignInfo) => Promise<boolean> \| boolean` | 組み込みのプロンプトの代わりに独自の署名確認 UI を指定する。 |

プロパティは遅延解決される（再接続などのアクションが実際に行われる瞬間に読み取られる）ため、ホストページはエレメントを挿入した後いつでもこれらを設定できる。

#### イベント

いずれも `{ bubbles: true, composed: true }` の `CustomEvent`。

| イベント | `detail` | 発生タイミング |
|---|---|---|
| `status-change` | `{ status: AgentConnectionStatus }` | 内部の `AgentConnection` のステータス変化すべてを反映する。 |
| `paired` | — | `'paired'` へ遷移したときに一度だけ発火する。 |
| `error` | `{ message: string }` | 内部の `AgentConnection` の `'error'` イベントを反映する。 |
| `sign-request` | `{ comment: string; fingerprint: string }` | ホスト側が指定した `confirmSign` が処理する場合でも、署名リクエストが届くたびに発火する。 |
| `key-forgotten` | — | 復号済みの鍵がゼロ化されるたびに発火する（切断時、「Forget key」、「Use a different file」のいずれか）。 |

#### 動作に関する補足

- 切断のたびに*復号済みの*鍵をゼロ化する。切断後は必ずパスフレーズの再入力が必要になる。
- 切断をまたいで、暗号化されたままのキーファイルのテキストをメモリ上にキャッシュするため、再接続時にはファイル選択全体ではなくパスフレーズのみの入力フォームが表示される — 詳しい理由は README のウィジェットの節を参照。「Forget key」と「Use a different file」はいずれもこのキャッシュを破棄する。ページのリロードでも破棄される（どこにも永続化されていないため）。
- 再接続には常に新しいペアリングトークンが必要 — セッションの再開機構はない。

## `bssh-agent/shared`

サーバー側とブラウザ側で共有されるプロトコル型定義・定数。`AgentServer` / `connectAgent` を介さず、WebSocket プロトコルレベルで直接統合する場合に主に関係する。

| エクスポート | 値/型 | 意味 |
|---|---|---|
| `PROTOCOL_VERSION` | `1` | すべてのメッセージに付与されるワイヤープロトコルのバージョンタグ。 |
| `DEFAULT_TOKEN_TTL_MS` | `300000`（5分） | ペアリングトークンの既定の有効期限。 |
| `DEFAULT_HANDSHAKE_TIMEOUT_MS` | `5000` | WebSocket 接続が `hello` を送るまでの既定の待機時間。 |
| `DEFAULT_REQUEST_TIMEOUT_MS` | `30000` | `list-identities` / `sign` リクエスト1件あたりの既定のタイムアウト。 |
| `SSH_ED25519` | `'ssh-ed25519'` | SSH 鍵種別を表す文字列定数。 |

`ServerToBrowserMessage` / `BrowserToServerMessage` のユニオン型一式（`hello`、`hello-ack`、`list-identities`、`sign`、`error`、`close` など）や、小さなワイヤーフォーマット用ヘルパー（`encodeBase64` / `decodeBase64`、SSH 文字列/uint32 エンコーディング）もエクスポートしている。網羅的なメッセージ形状についてはリポジトリ内の `src/shared/protocol.ts` を参照。

## `bssh-agent` CLI

```
usage: bssh-agent [options]
       bssh-agent -k
```

デーモンを起動し、本物の `ssh-agent` 自身の UX を模倣した `SSH_AUTH_SOCK` 用のシェル export コマンドを出力する — 完全な手順は README の CLI の節（`eval "$(bssh-agent)"`）を参照。

| フラグ | 意味 |
|---|---|
| `-D`, `--foreground` | デーモン化せず、フォアグラウンドで実行する。 |
| `-k`, `--kill` | （`--name` で指定した）動いているエージェントを終了し、その環境変数の `unset` 文を出力する。 |
| `--name <name>` | 複数インスタンスを同時に動かす場合の、エージェントインスタンス名。既定値: `"default"`。 |
| `--force` | 同じ `--name` で既に動いているエージェントを置き換える。 |
| `--no-browser` | ペアリング URL をブラウザで開こうとしない。 |
| `--port <n>` | ペアリング用 HTTP/WS ポート。既定値: `0`（空きポートを自動選択）。 |
| `--runtime-dir <dir>` | 状態ファイル（pid、ソケットパス、ポート）の保存先。既定値: `$XDG_RUNTIME_DIR/bssh-agent` または一時ディレクトリ。 |
| `-h`, `--help` | 使い方を表示する。 |

ランチャーの標準出力は、`eval` 可能な export スクリプトの出力専用です — ペアリング URL やその他すべての出力は標準エラー出力へ送られます。
