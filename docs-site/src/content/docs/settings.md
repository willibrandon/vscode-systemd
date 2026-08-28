---
title: Settings
description: Main extension settings.
---

Use the VS Code Settings editor to change these options.

- **Versions:** `systemd.target.systemdVersion`, `podmanVersion`, and `mkosiVersion`
- **Language data:** `systemd.dataChannel`
- **Indexing:** `systemd.index.scope`, `systemd.index.useIgnoreFiles`, and
  `systemd.index.extraPaths`
- **File names:** `systemd.dialectAssociations` and `systemd.templateSuffixes`
- **Installed tools:** `systemd.externalValidation.*`
- **Protocol logs:** `systemd.trace.server`

Diagnostics are enabled by default. Installed tools and protocol logs are off by default.

Executable and host path settings are blocked in untrusted workspaces. Protocol logs can contain
document text.
