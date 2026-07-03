import {
  type AgentConnection,
  type AgentConnectionStatus,
  type ConfirmSignInfo,
  KeyHandle,
  connectAgent,
  loadKeyFromFile,
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
 * `<bssh-agent-pairing>` — drop-in pairing UI wrapping `loadKeyFromFile` +
 * `connectAgent` from `bssh-agent/browser`. Reads the pairing token from
 * `location.hash` by default (matching the manual pattern documented in
 * README's browser usage example); `token`/`ws-url` attributes or the
 * `token`/`wsUrl` properties override that when the host page needs to
 * supply them explicitly (e.g. embedded in an iframe). Zeroizes the loaded
 * key on disconnect by default — see README's security notes — so there is
 * intentionally no one-click reconnect after a drop; the user re-enters
 * their passphrase.
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

  private reset(): void {
    this.connection?.close();
    this.connection = null;
    this.zeroizeKey();
    this.key = null;
    this.lastError = null;
    this.state = 'idle';
    this.render();
  }

  private async handleLoadKeyClick(fileInput: HTMLInputElement, passphraseInput: HTMLInputElement): Promise<void> {
    const token = this.resolveToken();
    if (!token) {
      this.lastError = 'No pairing token found (expected in the URL fragment, `token` attribute, or `token` property).';
      this.render();
      return;
    }
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
      this.key = await loadKeyFromFile(file, passphraseInput.value);
      const connection = connectAgent({
        wsUrl: this.resolveWsUrl(),
        token,
        key: this.key,
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
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.state = 'idle';
      this.render();
    }
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

  private renderIdle(): HTMLElement[] {
    const nodes: HTMLElement[] = [];

    if (!this.resolveToken()) {
      nodes.push(el('div', { className: 'status error', text: 'No pairing token found yet.' }));
    }
    if (this.lastError) {
      nodes.push(el('div', { className: 'status error', text: this.lastError }));
    }

    const fileField = el('div', { className: 'field' });
    const fileLabel = el('label', { text: 'Private key file' });
    const fileInput = el('input', { type: 'file', testId: 'file-input' });
    fileField.append(fileLabel, fileInput);

    const passField = el('div', { className: 'field' });
    const passLabel = el('label', { text: 'Passphrase' });
    const passInput = el('input', { type: 'password', testId: 'passphrase-input' });
    passField.append(passLabel, passInput);

    const loadButton = el('button', { text: 'Load key & pair', testId: 'load-button' });
    loadButton.addEventListener('click', () => {
      void this.handleLoadKeyClick(fileInput, passInput);
    });

    nodes.push(fileField, passField, loadButton);
    return nodes;
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
    const message = this.lastError ? el('div', { text: this.lastError }) : null;
    const retryButton = el('button', { text: 'Start over', testId: 'start-over-button' });
    retryButton.addEventListener('click', () => this.reset());
    return [status, ...(message ? [message] : []), retryButton];
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
