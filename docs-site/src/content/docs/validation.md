---
title: Validation
description: Check files with bundled data or installed tools.
---

Checks included with the extension work on every host. No systemd, Podman, or mkosi install is
needed.

**Validate with Installed Tool** can run:

- `systemd-analyze verify`
- the Quadlet generator in `-dryrun` mode
- `mkosi summary`

Installed validation is off by default. It requires a saved file and trusted desktop host. Tools run
without a shell and have time and output limits.
