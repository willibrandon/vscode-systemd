---
title: Privacy and trust
description: Files, programs, and logs used by the extension.
---

The extension has no telemetry and makes no runtime network requests.

It reads recognized workspace files. Trusted Linux hosts may also read systemd paths and
`systemd.index.extraPaths`. Host files are read-only.

Path completion and file creation stay inside the workspace.

Installed validation is off by default. Validators run without a shell and have time and output
limits.

Normal logs omit document text. Protocol traces may include it.
