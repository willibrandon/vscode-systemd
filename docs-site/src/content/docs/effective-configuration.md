---
title: Index and merged units
description: Inspect unit sources, drop-ins, and dependencies.
---

The index powers cross-file completion, navigation, the Systemd Explorer, merged units, and
dependency graphs.

Select the **Systemd** server icon in the Activity Bar to open the Explorer. Workspace files are
shown first. Indexed Linux or WSL files are grouped under **Host**.

On trusted Linux hosts, it can also read standard systemd paths. Set `systemd.index.scope` to
`workspace` to skip them. Host files are read-only.

References without a local or indexed host file are labeled `not indexed`.

**Show Effective Configuration** applies drop-ins, precedence, resets, templates, aliases, and
masks. Each result links to its source.

![A merged unit and the Systemd Explorer](../../assets/effective-configuration.png)

**Show Dependency Graph** shows relationships found in files, not running services.
