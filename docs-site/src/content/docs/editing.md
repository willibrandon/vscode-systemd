---
title: Editing
description: Completion, diagnostics, navigation, and formatting.
---

## Completion and hover

Completion suggests valid sections, keys, values, paths, units, and resources. Hover shows a short
description and the official manual. Version checks follow the selected systemd, Podman, or mkosi
version.

## Snippets

In an empty file, try `service-unit`, `network-static`, `quadlet-container`, or `mkosi-image`.

## Problems and fixes

Diagnostics find syntax errors, invalid values, missing settings, missing references, and unit
cycles. Quick fixes handle close spelling mistakes, missing local files, and unit drop-ins.

![A directive diagnostic with quick fixes](../../assets/diagnostic.png)

## Navigation and formatting

Definitions, references, rename, and symbols work across indexed workspace files. Rename does not
change host files.

**Format Document** fixes spacing without changing comments, order, quoting, or templates.
