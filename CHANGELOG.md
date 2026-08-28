# Changelog

Notable changes are listed here. Releases follow semantic versioning.

## [Unreleased]

## [0.4.2] - 2026-08-28

### Added

- Added a default-on `systemd.index.useIgnoreFiles` setting so developers can opt out of
  `.gitignore`-aware workspace discovery when needed.

### Changed

- Made ambient workspace indexing honor `files.exclude`, nested `.gitignore` rules, and common
  generated-output directories while keeping explicitly opened and imported files available.
- Updated the generated mkosi setting registry for the stable mkosi 27 release.

### Fixed

- Normalized Windows workspace URIs before applying ignore rules so drive-letter casing cannot leak
  excluded units into the index.
- Refreshed the index when ignore settings or ignore files change.

## [0.4.1] - 2026-08-21

### Fixed

- Kept the generated Explorer commands under the lowercase `systemd` category used by every other
  command.
- Indexed the exact URI from workspace file events so new references do not depend on file-search
  cache timing.
- Cleared language server diagnostics as soon as a document leaves a supported language.
- Made documentation image popups use the largest natural image size that fits the current viewport
  instead of a fixed laptop-sized cap.

## [0.4.0] - 2026-08-21

### Added

- Added concise descriptions from official systemd documentation to setting hovers, including
  value-specific explanations such as `Type=oneshot`.

## [0.2.1] - 2026-08-21

### Fixed

- Moved the systemd Explorer into its own stable Activity Bar container so opening or closing it
  does not create a duplicate folder icon or reorder other icons.
- Split Explorer results into an expanded Workspace section and a collapsed Host section so project
  files are not buried by system units on Linux and WSL.
- Refreshes the index when workspace folders are added or removed so early Explorer activation does
  not leave a host-only index.
- Stopped unresolved Explorer references from opening a dead link. Sources that are unavailable on
  the current host are labeled `not indexed` instead.

## [0.2.0] - 2026-08-21

### Added

- Support for systemd units and configuration, networkd, udev, hwdb, line-based formats, public
  systemd JSON, all current Quadlet types, and mkosi.
- Highlighting, completion, hover, diagnostics, quick fixes, navigation, rename, symbols, semantic
  tokens, inlay hints, formatting, and snippets.
- A systemd Explorer, merged unit views, dependency graphs, drop-in support, and safe creation of
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

[Unreleased]: https://github.com/willibrandon/vscode-systemd/compare/v0.4.2...HEAD
[0.4.2]: https://github.com/willibrandon/vscode-systemd/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/willibrandon/vscode-systemd/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/willibrandon/vscode-systemd/compare/v0.2.1...v0.4.0
[0.2.1]: https://github.com/willibrandon/vscode-systemd/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/willibrandon/vscode-systemd/releases/tag/v0.2.0
