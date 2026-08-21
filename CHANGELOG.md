# Changelog

Notable changes are listed here. Releases follow semantic versioning.

## [Unreleased]

## [0.2.0] - 2026-08-21

### Added

- Support for systemd units and configuration, networkd, udev, hwdb, line-based formats, public
  systemd JSON, all current Quadlet types, and mkosi.
- Highlighting, completion, hover, diagnostics, quick fixes, navigation, rename, symbols, semantic
  tokens, inlay hints, formatting, and snippets.
- A Systemd Explorer, merged unit views, dependency graphs, drop-in support, and safe creation of
  missing workspace files.
- Version-aware data generated from pinned systemd, Podman, and mkosi source.
- Optional validation with installed systemd, Quadlet, and mkosi tools.
- Desktop, browser, WSL, Dev Container, and Remote SSH support.
- Documentation with examples rendered by the packaged grammars.

### Safety

- No telemetry, runtime downloads, service control, D-Bus access, or root requests.
- Host configuration is read-only. Writes stay inside the workspace.
- External tools are off by default, require trust, run without a shell, and have time and output
  limits.

### Release

- Tests cover all 18 language modes, 100 recognized paths, upstream fixtures, desktop platforms,
  browser hosts, packaged installation, and Remote SSH.
- Release artifacts include a reproducible VSIX, SHA-256 checksum, CycloneDX SBOM, and build
  attestations.

[Unreleased]: https://github.com/willibrandon/vscode-systemd/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/willibrandon/vscode-systemd/releases/tag/v0.2.0
