# [1.0.0](https://github.com/so5/browser-ssh-agent/compare/v0.2.0...v1.0.0) (2026-08-02)


* feat!: add Docker demo, --host CLI flag, and widget drag-and-drop ([d6335c7](https://github.com/so5/browser-ssh-agent/commit/d6335c7a72f9e3ece99b50bafd1e1da7f0e2bd95))


### Bug Fixes

* replace defunct Code Climate coverage reporting with Coveralls ([d012e05](https://github.com/so5/browser-ssh-agent/commit/d012e056cda246d00b32cd27509da41b64714b1c))


### BREAKING CHANGES

* the widget's `auto-confirm="true"` attribute and the
CLI's `--auto-confirm` flag are replaced by `require-confirm="true"` /
`--require-confirm`, with inverted default semantics. Sign requests
are now auto-approved by default (previously the widget showed a
blocking approve/deny prompt unless auto-confirm was set), matching
real ssh-agent's own default posture (`ssh -A` doesn't prompt
per-signature either). Hosts that relied on the previous default must
now pass `require-confirm="true"` (or `--require-confirm`) explicitly.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>

# [0.2.0](https://github.com/so5/browser-ssh-agent/compare/v0.1.0...v0.2.0) (2026-07-20)


### Bug Fixes

* replace defunct Code Climate coverage reporting with Coveralls ([f865265](https://github.com/so5/browser-ssh-agent/commit/f8652653852a9bb9536f86471af6ae0ec4426a64))


### Features

* add semantic-release/OIDC publishing and bot PR auto-merge ([4d859fa](https://github.com/so5/browser-ssh-agent/commit/4d859faa47ae88a25c89143d214fb8ca04d7a8b3))
