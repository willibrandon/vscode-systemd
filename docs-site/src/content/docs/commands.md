---
title: Commands
description: Find the systemd commands available in the Visual Studio Code Command Palette.
---

Open the Command Palette and type `systemd` to find commands available for the current workspace.

- **systemd: Validate with Installed Tool** runs an eligible optional host validator.
- **systemd: Show Effective Configuration** opens the read-only merged view for a unit.
- **systemd: Show Dependency Graph** opens relationships derived from indexed configuration.
- **systemd: Create Drop-in** creates or opens a workspace-owned `override.conf` for a local unit.
- **systemd: Select Configuration Dialect** assigns one of the extension's language modes to the
  active document.
- **systemd: Open Official Documentation** opens the official systemd, Podman Quadlet, or mkosi
  manual for the active dialect.
- **systemd: Refresh Configuration Index** resynchronizes workspace and eligible host files.
- **systemd: Restart Language Server** starts a fresh bundled server and refreshes the index.
- **systemd: Show Language Server Output** opens structured extension diagnostics without moving
  keyboard focus from the editor.

Commands that require a suitable file, local filesystem, workspace ownership, desktop process, or
workspace trust explain why they are unavailable instead of silently changing state.
