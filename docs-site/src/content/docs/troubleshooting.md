---
title: Troubleshooting
description: Fix recognition, completion, and validation.
---

## No highlighting

Check the status bar. A `.service` file should show `systemd Unit`; a `.container` file should show
`Podman Quadlet`.

For WSL, SSH, or Dev Containers, install the extension in that host. Each host has its own extension
list.

## No completion

Run **Show Language Server Output**, then **Restart Language Server**.

## Missing indexed files

Run **Refresh Configuration Index**. Host indexing needs a trusted Linux host and
`systemd.index.scope` set to `workspaceAndHost`.

## Installed validation fails

Save the file and install the tool on the current extension host.

[Report an issue](https://github.com/willibrandon/vscode-systemd/issues) with the version, host,
language mode, and sanitized output.
