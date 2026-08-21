# systemd Unit Files for Visual Studio Code

Complete, self-contained language support for systemd unit files and configuration,
systemd-networkd, udev, tmpfiles, sysusers, Podman Quadlet, and mkosi.

The extension does not depend on another extension or a language server installed on the host. Its
language data is generated from pinned local checkouts of systemd, Podman, and mkosi and is bundled
into the desktop and browser extension.

> This repository is under active development. Version 0.1.0 is not a stable release.

## What works

- TextMate highlighting before the extension activates.
- Built-in, error-tolerant parsing and validation for 18 configuration dialects.
- Section, directive, indexed-reference, and value completion from 2,699 stable and 2,748 preview
  generated upstream records, with lazily resolved official documentation.
- Offline stable and preview metadata channels, with stable-release defaults and a compact bundled
  default-branch delta.
- Hover documentation with direct links to official manuals.
- Document and workspace symbols, folding, selection ranges, semantic tokens, and formatting.
- Unknown-section, unknown-directive, value-type, required-section, version, and deprecation
  diagnostics.
- Valid file-skeleton snippets for every author-configurable unit type, major systemd network and
  configuration families, all eight Quadlet types, and common mkosi image formats.
- Required-setting diagnostics for the inputs Podman's Quadlet converter needs to generate a unit.
- Quick fixes for likely directive misspellings.
- Go to definition, references, highlights, and safe textual rename for unit and resource
  references.
- Workspace indexing, a static Systemd Explorer, read-only effective-configuration documents, and
  dependency graphs.
- Exact unit/template/drop-in precedence and systemd-aware scalar, list, command, and reset merging,
  plus ordering-cycle diagnostics with related locations, specifier inlay hints, and CodeLens entry
  points.
- Canonical unit-symlink and alias resolution, including drop-ins attached to either name and
  `/dev/null` masks.
- Unit drop-in creation.
- Identical language analysis on desktop, Remote Development hosts, virtual workspaces, and
  vscode.dev-compatible browser hosts.
- Optional, trust-gated validation with `systemd-analyze verify`, the Podman Quadlet generator's
  `-dryrun` mode, or `mkosi summary`.

The extension never starts, stops, enables, disables, reloads, or otherwise changes a service. It
does not invoke `systemctl`, connect to D-Bus, require root, or use `pkexec`.

Read the complete [extension documentation](https://willibrandon.github.io/vscode-systemd/) for file
recognition, editor features, effective configuration, settings, validation, privacy, and
troubleshooting.

## Recognized configuration

The extension has dedicated language IDs for:

- system and user units: `.service`, `.socket`, `.timer`, `.path`, `.mount`, `.automount`, `.swap`,
  `.target`, `.device`, `.slice`, and `.scope`;
- networkd files: `.network`, `.netdev`, `.link`, `.dnssd`, and `.dns-delegate`;
- systemd daemon configuration and `.nspawn` files;
- `tmpfiles.d`, `sysusers.d`, `sysctl.d`, `modules-load.d`, `binfmt.d`, presets, boot configuration,
  and fstab-family tables;
- udev `.rules` and hardware database `.hwdb` files;
- environment, release, locale, machine-info, and vconsole files;
- DNS trust anchors, PCR lock files, and DNS resource-record JSON;
- all current Quadlet types: artifact, build, container, image, kube, network, pod, and volume;
- mkosi main, drop-in, profile, image, local, and UKI-profile configuration.

Compound template and backup suffixes such as `.service.in`, `.network.j2`, and `.container.ignore`
are recognized without treating template expressions as systemd syntax errors.

For unusual project paths, use VS Code's standard association setting:

```json
{
  "files.associations": {
    "deploy/my-unit": "systemd-unit",
    "images/production": "mkosi"
  }
}
```

## Commands

- **systemd: Validate with Installed Tool**
- **systemd: Show Effective Configuration**
- **systemd: Show Dependency Graph**
- **systemd: Create Drop-in**
- **systemd: Select Configuration Dialect**
- **systemd: Open Official Documentation**
- **systemd: Refresh Configuration Index**
- **systemd: Restart Language Server**
- **systemd: Show Language Server Output**

## Configuration

| Setting                                           | Default                       | Purpose                                           |
| ------------------------------------------------- | ----------------------------- | ------------------------------------------------- |
| `systemd.validation.enable`                       | `true`                        | Enable built-in diagnostics.                      |
| `systemd.validation.maxProblems`                  | `200`                         | Limit diagnostics per document.                   |
| `systemd.target.systemdVersion`                   | `latest`                      | Target latest, auto, or a systemd release number. |
| `systemd.target.podmanVersion`                    | `latest`                      | Target Podman language data.                      |
| `systemd.target.mkosiVersion`                     | `latest`                      | Target mkosi language data.                       |
| `systemd.index.scope`                             | `workspaceAndHost`            | Select workspace-only or host-aware indexing.     |
| `systemd.index.extraPaths`                        | `[]`                          | Add trusted local configuration roots.            |
| `systemd.dialectAssociations`                     | `{}`                          | Override ambiguous path-to-dialect detection.     |
| `systemd.templateSuffixes`                        | `[]`                          | Add project-specific compound suffixes.           |
| `systemd.externalValidation.mode`                 | `off`                         | Run a safe installed validator on save.           |
| `systemd.externalValidation.systemdAnalyzePath`   | `systemd-analyze`             | systemd unit validator.                           |
| `systemd.externalValidation.quadletGeneratorPath` | `/usr/libexec/podman/quadlet` | Quadlet generator.                                |
| `systemd.externalValidation.mkosiPath`            | `mkosi`                       | mkosi executable.                                 |
| `systemd.trace.server`                            | `off`                         | LSP protocol tracing.                             |

Internal validation is always the primary language service. Installed validation is optional, off by
default, and available only for saved local files in a trusted desktop workspace. Processes are
launched without a shell against bounded temporary copies of related configuration, with a minimal
environment, bounded time and output, and process-tree termination when validation is cancelled.

## Upstream data

`npm run generate` extracts directive metadata from local upstream trees. The bundled registry
currently pins:

- systemd `58b0764a206fc6cc67aa1a1c60f9f766a366edf8`;
- Podman `f19c577355dd5fab3411aee8d12b47da61f2237b`;
- mkosi `9b7d87a1707e39a42cfb54dce5cf745ef7b99a7e`.

The generated registry contains independently implemented metadata and links to official manuals;
upstream source trees are not distributed in the extension.

CI also parses a pinned, successful corpus from each upstream project's own tests and bundled
configurations. This covers all author-configurable unit families, representative networkd files,
every current Quadlet type, Quadlet continuation syntax, and mkosi's real multiline configurations.

## Development

Requires Node.js 24 and the npm version pinned by `packageManager`.

```sh
npm ci
npm run generate
npm run verify
```

The generator defaults to sibling checkouts at `../systemd`, `../podman`, and `../mkosi`. Override
these with `SYSTEMD_SOURCE`, `PODMAN_SOURCE`, and `MKOSI_SOURCE`.

Useful focused commands:

```sh
npm run test:core
npm run check:upstream:corpus
npm run typecheck
npm run build
npm run package
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution contract,
[the predecessor issue acceptance ledger](docs/issue-acceptance.md) for the complete 36-issue audit,
and [SECURITY.md](SECURITY.md) for the trust and process-execution model.

## License

MIT. See [LICENSE](LICENSE).
