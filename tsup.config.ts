import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: { 'server/index': 'src/server/index.ts' },
    platform: 'node',
    format: ['esm'],
    dts: true,
    sourcemap: true,
    clean: true,
  },
  {
    entry: { 'browser/index': 'src/browser/index.ts' },
    platform: 'browser',
    format: ['esm'],
    dts: true,
    sourcemap: true,
  },
  {
    entry: { 'shared/index': 'src/shared/index.ts' },
    platform: 'neutral',
    format: ['esm'],
    dts: true,
    sourcemap: true,
  },
  {
    entry: { 'widget/index': 'src/widget/index.ts' },
    platform: 'browser',
    format: ['esm'],
    dts: true,
    sourcemap: true,
  },
  {
    entry: { 'bin/bssh-agent': 'src/bin/bssh-agent.ts' },
    platform: 'node',
    format: ['esm'],
    dts: false,
    sourcemap: true,
  },
]);
