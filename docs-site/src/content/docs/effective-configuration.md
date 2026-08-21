---
title: Effective configuration and indexing
description: Understand workspace and host indexing, drop-in precedence, and dependency graphs.
---

The extension indexes recognized workspace files and, on a trusted Linux desktop or remote host,
standard system and user configuration paths. This powers indexed-reference completion, navigation,
the Systemd Explorer, effective-configuration documents, and dependency graphs.

The Systemd Explorer groups a template and all known instances under one template node. Hover a
configuration to inspect its selected source, base fragment, mask status, applied drop-ins, shadowed
candidates, and incoming and outgoing reference counts without opening every file.

## Workspace and host scope

`systemd.index.scope` defaults to `workspaceAndHost`. Choose `workspace` when a project should not
read host configuration. Host indexing is disabled in Restricted Mode and in virtual or browser
workspaces.

Trusted desktop workspaces can add roots with `systemd.index.extraPaths`. The index is read-only:
the extension does not alter files under `/etc`, `/run`, `/usr`, or `/lib`.

## Effective unit configuration

Run **systemd: Show Effective Configuration** from a unit, its CodeLens, or the Systemd Explorer.
The read-only virtual document resolves unit templates and drop-ins using systemd precedence and
lexical ordering. Repeated assignments follow the corresponding systemd parser: scalar directives
use the last value, cumulative directives retain their entries, and empty assignments apply the
correct reset or no-op behavior, including resets shared by condition, timer, socket, and path
lists. Source annotations retain the file and line that contributed each effective entry.

On desktop and remote extension hosts, indexed symbolic links retain their real target. Opening an
alias therefore uses the canonical unit fragment and combines drop-ins attached to the canonical or
alias name. A unit symlinked to `/dev/null` remains a mask. Browser workspaces still index the
symlink contents exposed by their file-system provider, but providers do not expose a portable
realpath API for alias grouping.

![An effective unit configuration with line-level source provenance and the Systemd Explorer](../../assets/effective-configuration.png)

Run **systemd: Show Dependency Graph** to view known relationships between indexed units. The graph
is derived from configuration; it does not query the live service manager and is not a statement
about current runtime state.

## Refreshing

Workspace watchers refresh indexed results as recognized files change. Use **systemd: Refresh
Configuration Index** after changing files outside Visual Studio Code or modifying an external
configuration root. Indexing and cross-workspace language-server scans are bounded and cancellable,
including workspace filesystem requests made on behalf of path completion.
