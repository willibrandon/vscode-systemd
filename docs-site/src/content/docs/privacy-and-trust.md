---
title: Privacy and trust
description: Learn what the extension reads, runs, records, and sends.
---

The extension has no telemetry and makes no runtime network requests. Normal language features
analyze open documents and indexed configuration through Visual Studio Code. Documentation links
open only after an explicit command or link action.

## Built-in analysis

The language server and generated registry are bundled with the extension. Built-in analysis does
not start an external program, call D-Bus, or contact a running service manager. It remains
available in Restricted Mode and in browser or virtual workspaces, subject to the filesystem
capabilities provided by Visual Studio Code.

## Filesystem access

Workspace indexing reads recognized project files. Trusted Linux desktop and remote workspaces can
also read standard systemd configuration locations and paths explicitly listed in
`systemd.index.extraPaths`. Restricted, browser, and virtual workspaces do not perform host
indexing.

The **Create Drop-in** command writes only inside the current workspace. Host configuration remains
read-only.

## External processes

Installed validation is off by default, desktop-only, and trust-gated. Configured executable and
extra-path settings are restricted in untrusted workspaces. Processes use argument arrays rather
than a shell command, operate on bounded temporary copies of related configuration, and receive a
minimal environment with private home, cache, configuration, data, and temporary paths. They are
bounded by cancellation, time, output, and process-tree limits.

## Logs and traces

The systemd Language Server output channel records operational events and failures. Default logs do
not include document contents. Verbose Language Server Protocol tracing can include document text;
keep `systemd.trace.server` off unless a trace is specifically needed and inspect it before sharing.
