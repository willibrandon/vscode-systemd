---
title: Editing
description: Use completion, hover, diagnostics, navigation, semantic features, and formatting.
---

Syntax highlighting is theme-neutral and works before extension activation. The language server is
error tolerant, so editing help remains available while a file is incomplete.

## Language help

Completion suggests sections, directives, values, specifiers, and indexed unit or resource names
that are valid at the cursor. Hover describes the selected directive and links to its official
manual. Signature help presents the expected value shape. Document and workspace symbols, folding,
selection ranges, semantic tokens, and specifier inlay hints use the parsed configuration rather
than text-only guesses.

The bundled registry is generated from pinned systemd, Podman, and mkosi source revisions. Normal
language help does not require a network request or a host executable.

## Diagnostics and quick fixes

Built-in diagnostics cover unknown and misplaced sections or directives, malformed values, missing
required sections, version availability, deprecations, and unit ordering cycles. Related locations
connect a cycle or cross-file reference to the other indexed configuration involved. Close directive
misspellings offer conservative quick fixes.

![An unknown systemd directive diagnostic with quick-fix actions](../../assets/diagnostic.png)

## Navigation and rename

Go to definition, references, document highlights, and rename operate on parsed unit and resource
references. Rename is intentionally textual and limited to references the language server can
identify safely; it never renames a host unit or writes outside the workspace.

## Formatting

Run **Format Document** from the Command Palette or editor menu. Formatting normalizes safe spacing
and indentation while preserving comments, directive order, quoting, and template expressions.
