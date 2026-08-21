---
title: Validation
description: Distinguish built-in diagnostics from optional validation by installed tools.
---

Built-in validation is the normal editor analysis. It uses bundled metadata and works without
systemd, Podman, or mkosi installed. It remains available in browser, virtual, remote, and
Restricted Mode workspaces.

## Installed validation

Installed validation is an optional second opinion from the current extension host. Run **systemd:
Validate with Installed Tool** or set `systemd.externalValidation.mode` to `onSave`.

Depending on the active dialect, the desktop extension invokes:

- generator- and man-page-disabled `systemd-analyze verify` for a systemd unit;
- the Quadlet generator in `-dryrun` mode for Quadlet configuration; or
- a non-paging `mkosi summary` for source-audited mkosi versions 16 through 26.

The command is available only for a saved local file in a trusted desktop workspace. Related
configuration is copied into a private, bounded temporary directory first. The extension probes the
installed tool for the required safe interface and does not run it when that interface is absent,
its capability probe fails, or its mkosi version is outside the audited range. Browser, virtual,
untrusted, dirty, and unsupported configurations keep built-in diagnostics and skip the executable.

## Process limits and host differences

Executables are started without a shell and receive a minimal environment with isolated home,
configuration, cache, data, and temporary paths. Validation has a ten-second timeout, a 256 KiB
combined output limit, cancellation, and process-tree termination. Temporary paths in findings are
mapped back to the source configuration. Findings are labeled with the tool that reported them and
are cleared as soon as the source or validator settings change.

Installed results can differ from built-in diagnostics because installed versions, build options,
filesystem paths, users, and groups belong to that host. An installed finding is not automatically
treated as a portable configuration error.
