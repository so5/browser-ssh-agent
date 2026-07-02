import { WebSocket as NodeWebSocket } from 'ws';

// Node only ships a global `WebSocket` (used by src/browser/wsClient.ts,
// which our e2e tests exercise directly in Node rather than a real browser)
// starting with Node 22 — it's absent on Node 20, which the package's
// `engines.node` range (">=20") and CI matrix still cover. `ws` (already a
// direct dependency) implements the same standard WebSocket surface
// (addEventListener/send/close/readyState), so it's a safe drop-in for the
// test environment. Real browsers always have a native WebSocket already.
if (typeof globalThis.WebSocket === 'undefined') {
  // @ts-expect-error -- ws's WebSocket is API-compatible but not identically typed to lib.dom's.
  globalThis.WebSocket = NodeWebSocket;
}
