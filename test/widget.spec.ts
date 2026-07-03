// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
// Default-import + destructure: see src/server/transports/unixSocketAgent.ts
// for why named imports from 'ssh2' aren't safe under plain Node ESM.
import ssh2 from 'ssh2';
import { AgentServer } from '../src/server/agentServer.js';
import type { BsshAgentPairingElement } from '../src/widget/index.js';

const { utils } = ssh2;

// happy-dom replaces the global `URL` with its own implementation, which
// mishandles `new URL('./fixtures/', import.meta.url)`'s relative
// resolution — resolve the fixture dir with node:path instead.
const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const readFixture = (name: string) => readFileSync(join(fixtureDir, name), 'utf8');

function setFiles(input: HTMLInputElement, files: File[]): void {
  Object.defineProperty(input, 'files', {
    value: files,
    configurable: true,
  });
}

function query(el: HTMLElement, testId: string): HTMLElement {
  const found = el.shadowRoot?.querySelector(`[data-testid="${testId}"]`);
  if (!found) throw new Error(`no element with data-testid="${testId}"`);
  return found as HTMLElement;
}

function waitForEvent(target: EventTarget, name: string): Promise<CustomEvent> {
  return new Promise((resolve) => {
    target.addEventListener(name, (ev) => resolve(ev as CustomEvent), { once: true });
  });
}

// `ws`'s WebSocketServer.close() waits for existing clients to close
// gracefully rather than terminating them, so calling agentServer.stop()
// with a still-open client would hang forever — closing the widget's own
// underlying connection directly is both what actually simulates a dropped
// connection (server stays up, exactly like a network blip/PC sleep) and
// avoids that hang. `connection` is TS-private but a real runtime property.
function simulateDisconnect(el: HTMLElement): void {
  (el as unknown as { connection: { close(): void } | null }).connection?.close();
}

describe('<bssh-agent-pairing>', () => {
  beforeAll(async () => {
    await import('../src/widget/index.js');
  });

  it('registers the custom element', () => {
    expect(customElements.get('bssh-agent-pairing')).toBeDefined();
  });

  it('pairs a real AgentServer, approves a sign request, and zeroizes on forget', async () => {
    const agentServer = new AgentServer();
    const { wsUrl } = await agentServer.listen(0, '127.0.0.1');
    const pairing = agentServer.createPairingLink('https://example.invalid/pair');
    const token = new URL(pairing.url).hash.replace('#token=', '');

    const el = document.createElement('bssh-agent-pairing') as BsshAgentPairingElement;
    el.token = token;
    el.wsUrl = wsUrl;
    document.body.append(el);

    const fileInput = query(el, 'file-input') as HTMLInputElement;
    const passphraseInput = query(el, 'passphrase-input') as HTMLInputElement;
    const loadButton = query(el, 'load-button') as HTMLButtonElement;

    const keyFile = new File([readFixture('id_ed25519_plain')], 'id_ed25519_plain');
    setFiles(fileInput, [keyFile]);
    passphraseInput.value = '';

    const pairedEvent = waitForEvent(el, 'paired');
    loadButton.click();
    await pairedEvent;

    expect(query(el, 'forget-button')).toBeTruthy();
    expect(el.shadowRoot?.textContent).toContain('test-plain@fixture');

    // Trigger a real sign request from the server side (Phase 1 in-process agent).
    const pubKey = utils.parseKey(readFixture('id_ed25519_plain.pub'));
    if (pubKey instanceof Error) throw pubKey;

    const signRequest = waitForEvent(el, 'sign-request');
    const signResultPromise = new Promise<Buffer>((resolve, reject) => {
      agentServer.agent().sign(pubKey.getPublicSSH(), Buffer.from('challenge'), {}, (err, sig) => {
        if (err || !sig) reject(err ?? new Error('no signature'));
        else resolve(sig);
      });
    });
    await signRequest;

    const approveButton = query(el, 'approve-button') as HTMLButtonElement;
    approveButton.click();

    const signature = await signResultPromise;
    expect(pubKey.verify(Buffer.from('challenge'), signature)).toBe(true);

    const forgottenEvent = waitForEvent(el, 'key-forgotten');
    const forgetButton = query(el, 'forget-button') as HTMLButtonElement;
    forgetButton.click();
    await forgottenEvent;

    expect(el.shadowRoot?.querySelector('[data-testid="file-input"]')).toBeTruthy();

    await agentServer.stop();
  });

  it('reconnects with only the passphrase (no file re-selection) after a disconnect', async () => {
    const agentServer = new AgentServer();
    const { wsUrl } = await agentServer.listen(0, '127.0.0.1');
    const pairing1 = agentServer.createPairingLink('https://example.invalid/pair');
    const token1 = new URL(pairing1.url).hash.replace('#token=', '');

    const el = document.createElement('bssh-agent-pairing') as BsshAgentPairingElement;
    el.token = token1;
    el.wsUrl = wsUrl;
    document.body.append(el);

    const fileInput = query(el, 'file-input') as HTMLInputElement;
    let passphraseInput = query(el, 'passphrase-input') as HTMLInputElement;
    let loadButton = query(el, 'load-button') as HTMLButtonElement;

    const keyFile = new File([readFixture('id_ed25519_enc')], 'id_ed25519_enc');
    setFiles(fileInput, [keyFile]);
    passphraseInput.value = 'correct horse battery staple';

    const firstPaired = waitForEvent(el, 'paired');
    loadButton.click();
    await firstPaired;

    // Simulate a dropped connection (e.g. the OS suspending the machine)
    // with the server still running — the cached PEM should survive this.
    const disconnected = waitForEvent(el, 'status-change');
    simulateDisconnect(el);
    await disconnected;

    expect(el.shadowRoot?.querySelector('[data-testid="file-input"]')).toBeNull();
    expect(el.shadowRoot?.textContent).toContain('id_ed25519_enc');

    // Reconnecting still needs a fresh pairing token — tokens are
    // single-use and there's no session resumption — but not the file.
    const pairing2 = agentServer.createPairingLink('https://example.invalid/pair');
    const token2 = new URL(pairing2.url).hash.replace('#token=', '');
    el.token = token2;

    passphraseInput = query(el, 'passphrase-input') as HTMLInputElement;
    loadButton = query(el, 'load-button') as HTMLButtonElement;
    passphraseInput.value = 'correct horse battery staple';

    const secondPaired = waitForEvent(el, 'paired');
    loadButton.click();
    await secondPaired;

    expect(el.shadowRoot?.textContent).toContain('test-encrypted@fixture');

    simulateDisconnect(el);
    await agentServer.stop();
  });

  it('"Use a different file" discards the cached PEM and shows the file picker again', async () => {
    const agentServer = new AgentServer();
    const { wsUrl } = await agentServer.listen(0, '127.0.0.1');
    const pairing = agentServer.createPairingLink('https://example.invalid/pair');
    const token = new URL(pairing.url).hash.replace('#token=', '');

    const el = document.createElement('bssh-agent-pairing') as BsshAgentPairingElement;
    el.token = token;
    el.wsUrl = wsUrl;
    document.body.append(el);

    const fileInput = query(el, 'file-input') as HTMLInputElement;
    const passphraseInput = query(el, 'passphrase-input') as HTMLInputElement;
    const loadButton = query(el, 'load-button') as HTMLButtonElement;

    const keyFile = new File([readFixture('id_ed25519_plain')], 'id_ed25519_plain');
    setFiles(fileInput, [keyFile]);
    passphraseInput.value = '';

    const paired = waitForEvent(el, 'paired');
    loadButton.click();
    await paired;

    const disconnected = waitForEvent(el, 'status-change');
    simulateDisconnect(el);
    await disconnected;

    expect(el.shadowRoot?.querySelector('[data-testid="file-input"]')).toBeNull();

    const useDifferentFileButton = query(el, 'use-different-file-button') as HTMLButtonElement;
    useDifferentFileButton.click();

    expect(el.shadowRoot?.querySelector('[data-testid="file-input"]')).toBeTruthy();

    await agentServer.stop();
  });
});
