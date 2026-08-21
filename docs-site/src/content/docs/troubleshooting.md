---
title: Troubleshooting
description: Resolve file recognition, indexing, language-server, and installed-validation problems.
---

## File recognition

If a configuration opens as plain text or as the wrong dialect, check the language mode in the
status bar. Use `files.associations` for a project-specific name and `systemd.dialectAssociations`
for path-sensitive ambiguity. Add a compound suffix to `systemd.templateSuffixes` when a project
uses one outside the built-in set.

## Language server

If highlighting works but diagnostics or completion do not, run **systemd: Show Language Server
Output** and confirm that the document opened under one of the extension's language IDs. Then run
**systemd: Restart Language Server** if the extension host or remote filesystem changed.

## Index and effective configuration

Run **systemd: Refresh Configuration Index** after files change outside Visual Studio Code. If host
units are missing, confirm that the workspace is trusted, the extension is running in a Linux
desktop or remote extension host, and `systemd.index.scope` is `workspaceAndHost`. Browser and
virtual workspaces intentionally index only their accessible workspace.

## Installed validation

Save the file and confirm that it uses a local `file` URI in a trusted desktop workspace. The
configured executable must be installed on the machine running the extension host—which can be a
remote SSH host rather than the local client. Built-in validation continues if the executable is
missing or unsupported for that dialect.

## Reporting a problem

Include the extension version, Visual Studio Code version, host type, active language mode, relevant
settings, and sanitized Language Server output in a
[GitHub issue](https://github.com/willibrandon/vscode-systemd/issues). Inspect verbose protocol
traces before attaching them because they can contain document text.
