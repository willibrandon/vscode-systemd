#!/usr/bin/env bash

set -euo pipefail

test "$(node --version)" = "v24.19.0"
test "$(npm --version)" = "12.0.2"
test "$(node -p 'process.platform')" = "linux"
command -v git >/dev/null
command -v jq >/dev/null

npm run verify
npm run package
