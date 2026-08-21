# Security Policy

## Supported versions

Before the first stable release, security fixes are made on `main`. This table will be updated when
supported release lines exist.

| Version           | Supported   |
| ----------------- | ----------- |
| `main`            | Yes         |
| Unreleased builds | Best effort |

## Reporting a vulnerability

Do not open a public issue. Use GitHub private vulnerability reporting at
<https://github.com/willibrandon/vscode-systemd/security/advisories/new>. Include the affected
revision, impact, minimal reproduction, and suggested mitigation. Redact real configuration,
credentials, user names, and private paths.

## Security model

- Configuration text, templates, workspace paths, and generated data are untrusted input.
- The built-in parser and browser worker do not execute configuration content.
- The extension never starts or changes a service and does not invoke `systemctl`, D-Bus, `sudo`, or
  `pkexec`.
- Installed validation is off by default. It requires a trusted desktop workspace and a saved local
  file, stages bounded related configuration under a private temporary root, uses an argument vector
  without a shell and a minimal environment, limits runtime and output, and cancels prior work.
- Browser and virtual workspaces retain internal language features without local process execution.
- Workspace indexing limits files and bytes and does not transmit source off the machine.
- The extension has no telemetry and makes no background network requests.
- Dependencies are locked. CI scans secrets, checks package contents and licenses, and builds
  release artifacts from a verified source revision.

Protocol tracing may contain document text and should be enabled only for local troubleshooting.
