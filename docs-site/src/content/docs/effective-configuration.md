---
title: Index and merged units
description: Inspect unit sources, drop-ins, and dependencies.
---

The index powers cross-file completion, navigation, the Systemd Explorer, merged units, and
dependency graphs.

On trusted Linux hosts, it can also read standard systemd paths. Set `systemd.index.scope` to
`workspace` to skip them. Host files are read-only.

**Show Effective Configuration** applies drop-ins, precedence, resets, templates, aliases, and
masks. Each result links to its source.

![A merged unit and the Systemd Explorer](../../assets/effective-configuration.png)

**Show Dependency Graph** shows relationships found in files, not running services.
