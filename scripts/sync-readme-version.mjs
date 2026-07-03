#!/usr/bin/env node
// Keeps README.md/README.ja.md's pinned `unpkg` CDN version in sync with
// package.json's version, since a hardcoded
// `<script src="https://unpkg.com/bssh-agent@X.Y.Z/...">` has no other way
// to stay current. Two modes:
//   - default: rewrite the files in place (npm's `version` lifecycle runs
//     this automatically on `npm version <bump>`, before the release commit
//     is created — see package.json's "version" script).
//   - `--check`: verify without writing, exit non-zero on drift (CI safety
//     net for releases that bypass `npm version`).
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const checkOnly = process.argv.includes('--check');

const pattern = /(https:\/\/unpkg\.com\/bssh-agent@)([\d.]+)(\/dist\/widget\/index\.js)/;
const targetFiles = ['README.md', 'README.ja.md'];

let drifted = false;

for (const relPath of targetFiles) {
  const path = join(repoRoot, relPath);
  const text = readFileSync(path, 'utf8');
  const match = text.match(pattern);
  if (!match) {
    console.error(`sync-readme-version: could not find the pinned unpkg CDN URL in ${relPath}`);
    process.exit(1);
  }

  const [, , pinnedVersion] = match;
  if (pinnedVersion === pkg.version) {
    console.log(`sync-readme-version: ${relPath} already pinned to ${pkg.version}`);
    continue;
  }

  if (checkOnly) {
    console.error(
      `sync-readme-version: ${relPath} is pinned to ${pinnedVersion} but package.json is at ${pkg.version} ` +
        '(run "node scripts/sync-readme-version.mjs" to fix, or use "npm version" which does this automatically)'
    );
    drifted = true;
    continue;
  }

  writeFileSync(path, text.replace(pattern, `$1${pkg.version}$3`));
  console.log(`sync-readme-version: updated ${relPath}'s pinned CDN version to ${pkg.version}`);
}

if (drifted) process.exit(1);
