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
- Capability-probed installed validation against bounded temporary configuration copies with an
  isolated environment and private path remapping.
- Semantically validated file-skeleton snippets for every author-configurable unit type, all current
  Quadlet types, major systemd network and configuration families, and common mkosi image formats.
- Pinned-corpus conformance against successful configuration fixtures maintained by systemd, Podman,
  and mkosi themselves.
- Byte-reproducible VSIX, checksum, and CycloneDX SBOM release artifacts with canonical ZIP
  metadata.
- Bundled JSON schemas and source-aligned semantic diagnostics for PCR measurement components and
  systemd-resolved static DNS resource records.
- Field-aware completion, hover, and signature help for line-oriented formats, including tmpfiles,
  sysusers, systemd-boot, Boot Loader Specification entries, DNSSEC trust anchors, table files,
  kernel-install, os-release, machine-info, locale, and virtual-console configuration.

### Fixed

- Effective-configuration provenance now reports one-based source line numbers instead of byte
  offsets.
- Effective unit configurations now follow each systemd parser's repeated-assignment behavior:
  scalar values replace, lists and commands append and reset, dependency lists ignore empty
  assignments, and shared condition, timer, socket, and path lists reset as a group.
- Installed-validator diagnostics are cleared immediately when the document or validator settings
  change.
- Podman and mkosi target versions now use generated per-release availability data, semantic version
  comparison, version-filtered completion, and trusted installed-tool auto-detection rather than
  silently using the systemd target.
- The stable and preview data channels now select distinct, pinned upstream registries through a
  compact generated delta and reparse open and indexed files immediately when switched.
- Indexed unit symlinks now retain their canonical targets so aliases use the canonical fragment,
  combine canonical and alias drop-ins, and preserve `/dev/null` mask behavior.
- Incomplete Quadlet files now report the required converter inputs for artifact, build, container,
  image, and Kubernetes units before installed-tool validation runs.
- Generated systemd metadata now distinguishes declared directives from names mentioned in manual
  prose and supplies conservative enum completion and validation from explicit upstream value lists.
- TextMate continuation handling now preserves complete multiline assignments, keeps template
  islands scoped inside values, and explicitly avoids shell-language injection into command values.
- The Systemd Explorer now groups templates with their instances and exposes source precedence,
  masking, candidate, drop-in, and reference details in configuration hover text.
- mkosi indented multiline values, inline comments, and conditional Match, TriggerMatch, Assert, and
  TriggerAssert sections now parse and validate according to mkosi's own configuration parser.
- Workspace indexing now discovers unit and resource drop-ins, directory-based systemd formats,
  namespaced journal configuration, kernel-install configuration, and nested mkosi profiles,
  subimages, local overrides, tools trees, UKI profiles, and repart definitions.
- Section, directive, completion, and quick-fix lookup is now constrained by the concrete unit,
  network, systemd configuration, Quadlet, or mkosi file kind; `mkosi.version` is parsed as a
  version record, and the `.link` snippet now uses link-file settings only.
- Line-oriented formats now use their actual upstream grammars: tmpfiles preserves the complete
  Argument column, sysusers understands `u!`, binfmt uses exactly seven fields, each fstab-family
  table enforces its own layout, and DNSSEC trust anchors and boot-loader records receive
  format-specific validation.
- Quadlet references now follow Podman's field-specific conversion rules, including structured
  network, volume, and CSV mount values; unresolved local resources are diagnosed, completion and
  navigation use only compatible Quadlet types, rename preserves the resource suffix, and effective
  configurations apply Podman's main-file and drop-in precedence.

[Unreleased]: https://github.com/willibrandon/vscode-systemd/commits/main
