#!/bin/sh
set -e
mkdir -p /run/bssh-agent
exec bssh-agent -D --host 0.0.0.0 --port 8787 --no-browser > /run/bssh-agent/env.sh
