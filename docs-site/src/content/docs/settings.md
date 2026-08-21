---
title: Settings
description: Configure validation, target metadata, indexing, file detection, and tracing.
---

Settings are available in the Visual Studio Code Settings editor and workspace JSON. Settings that
can name an executable or host path are restricted in untrusted workspaces.

## Built-in analysis

| Setting                          | Default  | Meaning                                                     |
| -------------------------------- | -------- | ----------------------------------------------------------- |
| `systemd.validation.enable`      | `true`   | Enable built-in diagnostics.                                |
| `systemd.validation.maxProblems` | `200`    | Limit diagnostics for one document, from 1 through 2000.    |
| `systemd.target.systemdVersion`  | `latest` | Select latest, auto-detected, or explicit systemd metadata. |
| `systemd.target.podmanVersion`   | `latest` | Select the target Podman version for Quadlet.               |
| `systemd.target.mkosiVersion`    | `latest` | Select the target mkosi version.                            |
| `systemd.dataChannel`            | `stable` | Select stable or preview bundled metadata.                  |

## Indexing and detection

| Setting                       | Default            | Meaning                                                 |
| ----------------------------- | ------------------ | ------------------------------------------------------- |
| `systemd.index.scope`         | `workspaceAndHost` | Index only the workspace or include trusted host paths. |
| `systemd.index.extraPaths`    | `[]`               | Add trusted configuration roots.                        |
| `systemd.dialectAssociations` | `{}`               | Map globs to a configuration dialect.                   |
| `systemd.templateSuffixes`    | built-in suffixes  | Add project-specific compound filename suffixes.        |

## Installed validation

| Setting                                           | Default                       | Meaning                                         |
| ------------------------------------------------- | ----------------------------- | ----------------------------------------------- |
| `systemd.externalValidation.mode`                 | `off`                         | Disable installed validation or run it on save. |
| `systemd.externalValidation.systemdAnalyzePath`   | `systemd-analyze`             | Select the unit validator executable.           |
| `systemd.externalValidation.quadletGeneratorPath` | `/usr/libexec/podman/quadlet` | Select the Quadlet generator.                   |
| `systemd.externalValidation.mkosiPath`            | `mkosi`                       | Select the mkosi executable.                    |

## Protocol tracing

`systemd.trace.server` accepts `off`, `messages`, or `verbose`. Protocol traces can include document
text, so leave tracing off except during a short troubleshooting session.
