# Changelog

All notable changes to this project will be documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases use semantic versioning.

## [Unreleased]

### Added

- Initial language support for the complete developer-facing systemd text-configuration surface, all
  current Podman Quadlet file types, and mkosi.
- Generated language metadata pinned to systemd, Podman, and mkosi upstream revisions.
- Desktop and browser language servers with validation, completion, hover, symbols, formatting,
  semantic tokens, navigation, references, rename, and quick fixes.
- Workspace indexing, effective drop-in configuration, dependency graphs, and drop-in creation.
- Optional, workspace-trust-gated validation through `systemd-analyze verify`, the Quadlet
  generator's `-dryrun` mode, and `mkosi summary`.
- TextMate grammars, snippets, tests, packaging checks, secret scanning, and release workflows for
  both the Visual Studio Marketplace and Open VSX.

[Unreleased]: https://github.com/willibrandon/vscode-systemd/commits/main
