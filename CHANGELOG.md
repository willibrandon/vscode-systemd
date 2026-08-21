# Changelog

All notable changes to this project will be documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases use semantic versioning.

## [Unreleased]

### Added

- Initial language support for the complete developer-facing systemd text-configuration surface, all
  current Podman Quadlet file types, and mkosi.
- Generated language metadata pinned to systemd, Podman, and mkosi upstream revisions.
- Desktop and browser language servers with validation, completion resolution, hover, symbols,
  formatting, semantic tokens, inlay hints, CodeLens, navigation, references, rename, and quick
  fixes.
- Workspace indexing, a static Systemd Explorer, exact unit/drop-in precedence, read-only virtual
  effective configurations and dependency graphs, ordering-cycle diagnostics, and safe drop-in
  creation.
- Trusted Linux host indexing, extra index roots, custom dialect associations, and configurable
  compound template suffixes.
- Optional, workspace-trust-gated validation through `systemd-analyze verify`, the Quadlet
  generator's `-dryrun` mode, and `mkosi summary`.
- TextMate grammars, snippets, tests, packaging checks, secret scanning, and release workflows for
  both the Visual Studio Marketplace and Open VSX.
- Exact-VSIX smoke tests plus minimum/stable VS Code coverage on Linux, macOS, Windows, browser
  workers, Dev Containers, and Remote SSH hosts.
- A searchable GitHub Pages documentation site with screenshots captured from the packaged
  extension.

### Fixed

- Effective-configuration provenance now reports one-based source line numbers instead of byte
  offsets.

[Unreleased]: https://github.com/willibrandon/vscode-systemd/commits/main
