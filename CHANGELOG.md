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
- Release-differential conformance for representative unit and networkd fixtures across systemd v250
  through v261, analyzed against each fixture's matching target release.
- Historical mkosi metadata with introduction and removal bounds, plus differential conformance
  against every maintained mkosi configuration found across releases v16 through v26.
- A dated acceptance ledger for all 36 predecessor-extension issues and the 19 upstream systemd,
  Podman, and mkosi issues that directly constrain parser, validator, and configuration behavior.
- Byte-reproducible VSIX, checksum, and CycloneDX SBOM release artifacts with canonical ZIP
  metadata.
- Bundled JSON schemas and source-aligned semantic diagnostics for PCR measurement components and
  systemd-resolved static DNS resource records.
- Field-aware completion, hover, and signature help for line-oriented formats, including tmpfiles,
  sysusers, systemd-boot, Boot Loader Specification entries, DNSSEC trust anchors, table files,
  kernel-install, os-release, machine-info, locale, and virtual-console configuration.
- Typed mkosi graph intelligence for comma-separated includes, profiles, subimage dependencies, and
  UKI profiles, with compatible completion, exact navigation and rename, and unresolved-reference
  diagnostics.
- Source-ordered mkosi effective configurations for includes, local overrides, lexical drop-ins,
  selected profiles, subimages, tools trees, and the default initrd, including generated setting
  remapping and inheritance semantics.

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
- Generated mkosi metadata now preserves collection reset behavior and main, inherited, universal,
  tools-tree, and initrd setting scopes from pinned `ConfigSetting` declarations, and links hover
  documentation to mkosi's official manual.
- mkosi effective configurations now evaluate settled Match/TriggerMatch and Assert/TriggerAssert
  branches, label host-dependent contributions instead of letting them override certain values, and
  keep the greatest `MinimumVersion=` exactly as mkosi does.
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
- Workspace indexing now follows arbitrary mkosi `Include=` files as mkosi configuration, recognizes
  `mkosi.initrd.conf`, and accepts only the regular `*.conf` subimage files supported by upstream.
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
- Packaged desktop and language-server bundles now select dependency ESM entry points and reject
  unresolved relative CommonJS imports before integration tests.
- Network parser-table ownership now controls directive and section applicability instead of an
  inferred documentation page, including legacy `[DHCP]` and shared `.network` match settings.
- Source-generated value intelligence now includes the complete pinned signal, Linux capability,
  syscall-group, and documented address-family catalogs, broader DocBook enum extraction, unit
  specifier completion, and common duration and size values.
- IPv4-embedded IPv6 addresses are accepted only in the final 32-bit position.
- Installed validation now requires explicit systemd generator/man-page disabling, rejects failed
  capability probes, uses non-paging mkosi summaries only for source-audited v16–v26 releases, and
  keeps navigation alive when an index provider returns a malformed URI escape.
- Deterministic property tests now exercise arbitrary and adversarial input across all 18 dialects,
  including exact CRLF continuation round trips, and a packaged-LSP gate enforces p95 latency for
  warm edits and completions over a large indexed project.
- udev rules now use the pinned parser's complete key, attribute, operator, quoting, option, and
  case-prefix model, understand lossless continued rules and forward labels, and offer contextual
  key/operator/value completion. Table intelligence now completes documented mount, crypttab,
  veritytab, integritytab, and clonetab options and validates systemd-specific fstab fields.
- Hardware database files now follow systemd's match/property record state machine, comment and
  separator behavior, typed shipped-property grammar, mouse-wheel dependencies, and exact TextMate
  scopes, with match and property intelligence generated from the pinned systemd source.
- Quadlet metadata now derives boolean and numeric types, repeated-assignment behavior, documented
  defaults, and conservative closed or extensible value choices from each pinned Podman source and
  manual. Hover labels availability as Podman rather than systemd, and conformance covers basic
  generator fixtures for every available type in every non-prerelease Podman release since 4.4.
- Path-valued settings now complete workspace-owned files and directories through a bounded VS Code
  filesystem bridge on desktop, remote, and browser hosts. Quadlet receives systemd specifier help,
  while mkosi completion and inlay hints use mkosi's own meanings instead of unit-file meanings.
- Generated directives now use a versioned tuple wire format that hydrates to the same typed runtime
  definitions, reducing the four packaged language bundles by about one megabyte without removing
  metadata or weakening the 5 MiB package ceiling.
- Documentation image popups now fit every included screenshot within compact laptop and
  split-screen viewports without internal or background-page scrolling.
- mkosi v16–v23 default assignments using `@Setting=` now parse, highlight, and merge correctly;
  historical section permissiveness, current wrong-section warnings, removed settings, and the
  complete upstream boolean spelling set are version-aware.
- LSP cancellation now propagates through nested workspace-filesystem completion requests, and
  bounded cross-workspace symbol, reference, rename, graph, effective-configuration, and explorer
  snapshot scans stop returning stale work after cancellation.
- Documentation code blocks are build-gated to the exact TextMate grammars contributed by the
  packaged extension.
- Bundle inspection now checks size and content from one immutable read, and Quadlet CSV parsing no
  longer probes one character beyond the input boundary while preserving trailing empty fields.

[Unreleased]: https://github.com/willibrandon/vscode-systemd/commits/main
