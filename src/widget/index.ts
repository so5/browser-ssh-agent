import {
  type AgentConnection,
  type AgentConnectionStatus,
  type ConfirmSignInfo,
  KeyHandle,
  connectAgent,
  loadKeyFromText,
} from '../browser/index.js';

type WidgetState = 'idle' | 'connecting' | 'paired' | 'disconnected';

const WIDGET_CSS = `
:host {
  display: block;
  font: 14px/1.4 system-ui, sans-serif;
  max-width: 22rem;
  color: #1a1a1a;
}
.panel {
  border: 1px solid #d0d0d0;
  border-radius: 8px;
  padding: 1rem;
}
.field { margin-bottom: 0.75rem; }
label { display: block; margin-bottom: 0.25rem; font-weight: 600; }
input[type='file'], input[type='password'] {
  width: 100%;
  box-sizing: border-box;
  padding: 0.4rem;
  border: 1px solid #b0b0b0;
  border-radius: 4px;
}
button {
  padding: 0.45rem 0.9rem;
  border: 1px solid #333;
  border-radius: 4px;
  background: #1a1a1a;
  color: #fff;
  cursor: pointer;
}
button.secondary { background: #fff; color: #1a1a1a; }
button:disabled { opacity: 0.5; cursor: default; }
.status { margin-bottom: 0.75rem; font-weight: 600; }
.status.error { color: #b00020; }
.fingerprint { font-family: ui-monospace, monospace; font-size: 0.85em; word-break: break-all; }
.overlay {
  margin-top: 0.75rem;
  padding: 0.75rem;
  border: 1px solid #e0a000;
  border-radius: 6px;
  background: #fff8e6;
}
.actions { display: flex; gap: 0.5rem; margin-top: 0.5rem; }
`;

let sharedStyleSheet: CSSStyleSheet | null = null;
function getSharedStyleSheet(): CSSStyleSheet {
  if (!sharedStyleSheet) {
    sharedStyleSheet = new CSSStyleSheet();
    sharedStyleSheet.replaceSync(WIDGET_CSS);
  }
  return sharedStyleSheet;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Partial<HTMLElementTagNameMap[K]> & { text?: string; testId?: string }
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props?.text !== undefined) node.textContent = props.text;
  if (props?.testId !== undefined) node.setAttribute('data-testid', props.testId);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (key === 'text' || key === 'testId') continue;
      (node as Record<string, unknown>)[key] = value;
    }
  }
  return node;
}

/**
 * `<bssh-agent-pairing>` — drop-in pairing UI wrapping `loadKeyFromText` +
 * `connectAgent` from `bssh-agent/browser`. Reads the pairing token from
 * `location.hash` by default (matching the manual pattern documented in
 * README's browser usage example); `token`/`ws-url` attributes or the
 * `token`/`wsUrl` properties override that when the host page needs to
 * supply them explicitly (e.g. embedded in an iframe). Zeroizes the
 * *decrypted* key on disconnect by default — see README's security notes —
 * so there is no one-click reconnect after a drop that skips the
 * passphrase. It does, however, cache the still-*encrypted* key file text
 * in memory for the life of the page, so a disconnect (e.g. the OS
 * suspending the machine) only requires re-entering the passphrase, not
 * reselecting the file — see `cachedPem` below.
 */
export class BsshAgentPairingElement extends HTMLElement {
  static get observedAttributes(): string[] {
    return ['token', 'ws-url', 'auto-confirm'];
  }

  token?: string;
  wsUrl?: string;
  confirmSign?: (info: ConfirmSignInfo) => Promise<boolean> | boolean;

  private readonly root: ShadowRoot;
  private state: WidgetState = 'idle';
  private key: KeyHandle | null = null;
  private connection: AgentConnection | null = null;
  private lastError: string | null = null;
  private pendingConfirm: { resolve: (approved: boolean) => void } | null = null;
  /**
   * The still-encrypted key file text, kept across a disconnect so
   * reconnecting only needs the passphrase again. This is *not* sensitive
   * on its own — it's exactly what the passphrase protects — so caching it
   * costs nothing security-wise; only the passphrase (never cached) and the
   * decrypted seed (zeroized on every disconnect, see `zeroizeKey()`) are
   * treated as sensitive. Cleared by `reset()`/"Forget key" and "Use a
   * different file", never by a mere disconnect.
   */
  private cachedPem: { text: string; fileName: string } | null = null;

  constructor() {
    super();
    this.root = this.attachShadow({ mode: 'open' });
    this.root.adoptedStyleSheets = [getSharedStyleSheet()];
  }

  connectedCallback(): void {
    this.render();
  }

  disconnectedCallback(): void {
    this.connection?.close();
  }

  private resolveToken(): string | null {
    return (
      this.token ??
      this.getAttribute('token') ??
      new URLSearchParams(location.hash.slice(1)).get('token')
    );
  }

  private resolveWsUrl(): string {
    return (
      this.wsUrl ??
      this.getAttribute('ws-url') ??
      `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`
    );
  }

  private emit(name: string, detail?: Record<string, unknown>): void {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
  }

  private zeroizeKey(): void {
    if (this.key && !this.key.isZeroized) {
      this.key.zeroize();
      this.emit('key-forgotten');
    }
  }

  /** Full reset — also discards the cached encrypted PEM, unlike a mere disconnect. */
  private reset(): void {
    this.connection?.close();
    this.connection = null;
    this.zeroizeKey();
    this.key = null;
    this.cachedPem = null;
    this.lastError = null;
    this.state = 'idle';
    this.render();
  }

  private useDifferentFile(): void {
    this.cachedPem = null;
    this.lastError = null;
    this.render();
  }

  private async handleLoadKeyClick(fileInput: HTMLInputElement, passphraseInput: HTMLInputElement): Promise<void> {
    const file = fileInput.files?.[0];
    if (!file) {
      this.lastError = 'Choose a private key file first.';
      this.render();
      return;
    }

    this.lastError = null;
    this.state = 'connecting';
    this.render();

    try {
      const pemText = await file.text();
      const key = await loadKeyFromText(pemText, passphraseInput.value);
      // Cache before connecting: a wrong passphrase still lets the retry
      // skip reselecting the file (see the passphrase-only branch of
      // renderKeyForm()).
      this.cachedPem = { text: pemText, fileName: file.name };
      await this.connectWithKey(key);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.state = 'idle';
      this.render();
    }
  }

  private async handleUnlockCachedKey(passphraseInput: HTMLInputElement): Promise<void> {
    if (!this.cachedPem) return;

    this.lastError = null;
    this.state = 'connecting';
    this.render();

    try {
      const key = await loadKeyFromText(this.cachedPem.text, passphraseInput.value);
      await this.connectWithKey(key);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.state = 'idle';
      this.render();
    }
  }

  private async connectWithKey(key: KeyHandle): Promise<void> {
    const token = this.resolveToken();
    if (!token) {
      this.lastError = 'No pairing token found (expected in the URL fragment, `token` attribute, or `token` property).';
      this.state = 'idle';
      this.render();
      return;
    }

    this.key = key;
    this.state = 'connecting';
    this.render();

    const connection = connectAgent({
      wsUrl: this.resolveWsUrl(),
      token,
      key,
      confirmSign: (info) => this.handleConfirmSign(info),
    });
    this.connection = connection;
    // Guard against stale events from a connection `reset()`/`forgetKey()`
    // has already superseded — `AgentConnection` has no `off()`, so a
    // just-closed connection can still fire its queued 'disconnected'
    // status asynchronously after `this.connection` already points
    // elsewhere (or nowhere).
    connection.on('status', (status) => {
      if (this.connection !== connection) return;
      this.handleStatusChange(status);
    });
    connection.on('error', (err) => {
      if (this.connection !== connection) return;
      this.lastError = err.message;
      this.emit('error', { message: err.message });
      this.render();
    });
  }

  private handleStatusChange(status: AgentConnectionStatus): void {
    this.emit('status-change', { status });
    if (status === 'paired') {
      this.state = 'paired';
      this.emit('paired');
    } else if (status === 'disconnected') {
      this.zeroizeKey();
      this.state = 'disconnected';
    }
    this.render();
  }

  private async handleConfirmSign(info: ConfirmSignInfo): Promise<boolean> {
    this.emit('sign-request', { comment: info.comment, fingerprint: info.fingerprint });

    if (this.confirmSign) return this.confirmSign(info);

    const autoConfirmAttr = this.getAttribute('auto-confirm');
    if (autoConfirmAttr !== null && autoConfirmAttr !== 'false') {
      console.warn('bssh-agent-pairing: auto-confirm is enabled — sign requests are approved without prompting.');
      return true;
    }

    return new Promise<boolean>((resolve) => {
      this.pendingConfirm = { resolve };
      this.renderSignOverlay(info);
    });
  }

  private resolveConfirm(approved: boolean): void {
    this.pendingConfirm?.resolve(approved);
    this.pendingConfirm = null;
    this.render();
  }

  private forgetKey(): void {
    this.reset();
  }

  private render(): void {
    this.root.replaceChildren();
    const panel = el('div', { className: 'panel' });

    if (this.state === 'idle') panel.append(...this.renderIdle());
    else if (this.state === 'connecting') panel.append(...this.renderConnecting());
    else if (this.state === 'paired') panel.append(...this.renderPaired());
    else panel.append(...this.renderDisconnected());

    this.root.append(panel);
  }

  /**
   * Shared by `renderIdle()` and `renderDisconnected()`: shows the full
   * file+passphrase form normally, or — if `cachedPem` is set (i.e. we've
   * successfully read a file before, even if pairing later dropped) — a
   * lighter passphrase-only form that reuses the cached encrypted text
   * instead of asking the user to reselect the file.
   */
  private renderKeyForm(): HTMLElement[] {
    const nodes: HTMLElement[] = [];

    if (!this.resolveToken()) {
      nodes.push(el('div', { className: 'status error', text: 'No pairing token found yet.' }));
    }
    if (this.lastError) {
      nodes.push(el('div', { className: 'status error', text: this.lastError }));
    }

    const passField = el('div', { className: 'field' });
    const passLabel = el('label', { text: 'Passphrase' });
    const passInput = el('input', { type: 'password', testId: 'passphrase-input' });
    passField.append(passLabel, passInput);

    if (this.cachedPem) {
      nodes.push(el('div', { text: `Using previously loaded key file: ${this.cachedPem.fileName}` }));
      nodes.push(passField);

      const unlockButton = el('button', { text: 'Unlock & reconnect', testId: 'load-button' });
      unlockButton.addEventListener('click', () => {
        void this.handleUnlockCachedKey(passInput);
      });
      nodes.push(unlockButton);

      const differentFileButton = el('button', {
        className: 'secondary',
        text: 'Use a different file',
        testId: 'use-different-file-button',
      });
      differentFileButton.addEventListener('click', () => this.useDifferentFile());
      nodes.push(differentFileButton);
    } else {
      const fileField = el('div', { className: 'field' });
      const fileLabel = el('label', { text: 'Private key file' });
      const fileInput = el('input', { type: 'file', testId: 'file-input' });
      fileField.append(fileLabel, fileInput);
      nodes.push(fileField, passField);

      const loadButton = el('button', { text: 'Load key & pair', testId: 'load-button' });
      loadButton.addEventListener('click', () => {
        void this.handleLoadKeyClick(fileInput, passInput);
      });
      nodes.push(loadButton);
    }

    return nodes;
  }

  private renderIdle(): HTMLElement[] {
    return this.renderKeyForm();
  }

  private renderConnecting(): HTMLElement[] {
    return [el('div', { className: 'status', text: 'Connecting…' })];
  }

  private renderPaired(): HTMLElement[] {
    const status = el('div', { className: 'status', text: 'Paired' });
    const comment = el('div', { text: this.key?.comment ?? '' });
    const forgetButton = el('button', { className: 'secondary', text: 'Forget key', testId: 'forget-button' });
    forgetButton.addEventListener('click', () => this.forgetKey());
    return [status, comment, forgetButton];
  }

  private renderDisconnected(): HTMLElement[] {
    const status = el('div', { className: 'status error', text: 'Disconnected' });
    return [status, ...this.renderKeyForm()];
  }

  private renderSignOverlay(info: ConfirmSignInfo): void {
    const overlay = el('div', { className: 'overlay' });
    overlay.append(
      el('div', { text: `Sign request for ${info.comment}` }),
      el('div', { className: 'fingerprint', text: info.fingerprint })
    );

    const actions = el('div', { className: 'actions' });
    const approve = el('button', { text: 'Approve', testId: 'approve-button' });
    approve.addEventListener('click', () => this.resolveConfirm(true));
    const deny = el('button', { className: 'secondary', text: 'Deny', testId: 'deny-button' });
    deny.addEventListener('click', () => this.resolveConfirm(false));
    actions.append(approve, deny);
    overlay.append(actions);

    this.root.querySelector('.panel')?.append(overlay);
  }
}

if (!customElements.get('bssh-agent-pairing')) {
  customElements.define('bssh-agent-pairing', BsshAgentPairingElement);
}
