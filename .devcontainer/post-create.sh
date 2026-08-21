#!/usr/bin/env bash

set -euo pipefail

readonly workspace_root="$(pwd -P)"
readonly owner="$(id -u):$(id -g)"
readonly isolated_directories=(
  "$workspace_root/node_modules"
  "$workspace_root/dist"
  "$workspace_root/coverage"
  "/home/vscode/.npm"
)

for directory in "${isolated_directories[@]}"; do
  sudo chown "$owner" "$directory"
done

npm ci
node --version
npm --version
