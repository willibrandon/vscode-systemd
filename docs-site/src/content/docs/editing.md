---
title: Editing
description: Use completion, hover, diagnostics, navigation, semantic features, and formatting.
---

Syntax highlighting is theme-neutral and works before extension activation. The language server is
error tolerant, so editing help remains available while a file is incomplete.

## Language help

Completion suggests sections, directives, values, specifiers, and indexed unit or resource names
that are valid at the cursor. For settings whose upstream declaration gives a closed list of values,
such as service type or network link activation policy, completion offers those exact values and
validation rejects values outside the list. Open-ended settings still provide useful suggestions
without rejecting valid custom forms. Hover describes the selected directive and links to its
official manual. Signature help presents the expected value shape. Document and workspace symbols,
folding, selection ranges, semantic tokens, and specifier inlay hints use the parsed configuration
rather than text-only guesses.

The bundled registry is generated from pinned systemd, Podman, and mkosi source revisions. Normal
language help does not require a network request or a host executable.

## File skeletons

At the start of an empty file, type a snippet prefix such as `service-unit`, `network-static`,
`config-nspawn`, `quadlet-container`, or `mkosi-image`. The extension includes complete starting
points for every unit type that systemd allows developers to configure in a file; common networkd,
DNS-SD, DNS delegation, daemon, container, repart, and sysupdate configurations; every current
Quadlet type; and common mkosi outputs. Placeholder choices cover details such as service type,
network policy, user or system installation target, image format, and bootloader.

There is intentionally no `.scope` file skeleton: systemd creates scope units programmatically and
does not load them from unit configuration files. Existing scope units remain recognized for
navigation and inspection.

## Diagnostics and quick fixes

Built-in diagnostics cover unknown and misplaced sections or directives, malformed values, missing
required sections and settings, version availability, deprecations, and unit ordering cycles. For
Quadlet, this includes the inputs required by Podman's converter, such as `Image=`, `Yaml=`,
`Artifact=`, and build tags and contexts. Related locations connect a cycle or cross-file reference
to the other indexed configuration involved. Close directive misspellings offer conservative quick
fixes.

![An unknown systemd directive diagnostic with quick-fix actions](../../assets/diagnostic.png)

## Navigation and rename

Go to definition, references, document highlights, and rename operate on parsed unit and resource
references. Rename is intentionally textual and limited to references the language server can
identify safely; it never renames a host unit or writes outside the workspace.

## Formatting

Run **Format Document** from the Command Palette or editor menu. Formatting normalizes safe spacing
and indentation while preserving comments, directive order, quoting, and template expressions.
