import { readFileSync } from 'node:fs';
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';

export interface PairingHttpServerOptions {
  /** Path to the built `bssh-agent/widget` bundle (`dist/widget/index.js`). */
  widgetJsPath: string;
}

const PAIRING_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>bssh-agent pairing</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
</head>
<body>
<script type="module" src="/widget.js"></script>
<bssh-agent-pairing></bssh-agent-pairing>
</body>
</html>
`;

function handleRequest(widgetJs: string, req: IncomingMessage, res: ServerResponse): void {
  res.setHeader('Content-Security-Policy', "script-src 'self'");

  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAIRING_PAGE_HTML);
    return;
  }

  if (req.url === '/widget.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
    res.end(widgetJs);
    return;
  }

  res.writeHead(404);
  res.end('not found');
}

/**
 * Serves the CLI's own minimal pairing page: `createPairingLink()`'s
 * `baseUrl` normally points at a *host app's* page, but a standalone CLI has
 * no host app, so it serves the drop-in `<bssh-agent-pairing>` widget
 * itself. Wire this into `AgentServer.attachTo(httpServer, '/ws')` — the
 * widget's zero-attribute default derives its WS URL from `location.host`
 * plus `/ws`, so that path is a fixed convention between this file and
 * `src/widget/index.ts`, not something the protocol enforces.
 */
export function createPairingHttpServer(opts: PairingHttpServerOptions) {
  const widgetJs = readFileSync(opts.widgetJsPath, 'utf8');
  return createServer((req, res) => handleRequest(widgetJs, req, res));
}
