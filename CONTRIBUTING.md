# Contributing

Thank you for improving systemd configuration editing. Report vulnerabilities through the private
channel in [SECURITY.md](SECURITY.md), not a public issue.

## Setup

Use Node.js 24 and the npm version pinned in `package.json`:

```sh
npm ci
npm run check:generated
npm run verify
```

To regenerate upstream language data, keep systemd, Podman, and mkosi checkouts next to this
repository or set `SYSTEMD_SOURCE`, `PODMAN_SOURCE`, and `MKOSI_SOURCE`.

## Engineering rules

- Keep `packages/language-core` independent of Node.js, the DOM, and VS Code.
- Preserve comments, order, quoting, continuations, template text, and source spans.
- Treat every configuration and workspace path as untrusted input.
- Do not add service-management commands or invoke `systemctl`, D-Bus, `sudo`, or `pkexec`.
- Installed validators must remain optional, non-shell, bounded, cancellable, restricted to saved
  local files, and disabled in untrusted workspaces.
- Generated data changes must include the pinned upstream revisions and focused tests.
- Do not copy code or prose from third-party extensions. Upstream projects are extraction and
  conformance inputs, not vendored runtime dependencies.
- Add an ignore to `.picketignore` only after a real scan finding has been reviewed and documented
  as a false positive.

Run the narrowest tests while iterating, then `npm run verify`. Do not commit generated bundles,
VSIX files, coverage output, downloaded VS Code builds, local upstream trees, credentials, or
`plan.md`.

Contributions are licensed under the repository's MIT License.
