---
title: Getting started
description: Build and install the test version.
---

Version 0.1.0 has not been released. Build it with Node.js 24:

```sh
git clone https://github.com/willibrandon/vscode-systemd.git
cd vscode-systemd
npm ci
npm run package
code --install-extension dist/systemd-0.1.0.vsix
```

Install it in the same host as the file. WSL, SSH, and Dev Containers each have their own
extensions.

Reload VS Code and open a `.service` file. The status bar should say `systemd Unit`.
