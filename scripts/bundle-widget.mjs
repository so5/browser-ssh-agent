import { build } from 'esbuild';

// `bssh-agent/widget` is the one build artifact promised to load via a bare
// `<script type="module">` tag with no bundler in the loop (see the README's
// unpkg example and the CLI's self-served pairing page,
// src/server/cli/pairingPage.ts). Everything else under dist/ is left as
// plain tsc output — relative imports across those files are fine because
// the only consumers are Node itself or a host app's own bundler, both of
// which resolve bare specifiers (e.g. `bcrypt-pbkdf`) from node_modules the
// way the widget's raw script-tag load path cannot.
await build({
  entryPoints: ['src/widget/index.ts'],
  outfile: 'dist/widget/index.js',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  allowOverwrite: true,
  sourcemap: true,
});
