# Architecture

The extension has three private workspace packages and two host bundles.

## Packages

| Package                    | Responsibility                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------- |
| `packages/language-core`   | File recognition, parsing, generated directive data, diagnostics, formatting, and workspace indexing    |
| `packages/language-server` | Language Server Protocol handlers for core features                                                     |
| `packages/vscode-client`   | VS Code activation, commands, the systemd Explorer, virtual documents, and optional external validation |

`language-core` has no Node.js, DOM, or VS Code dependency. The node and browser language servers
use the same core implementation.

## Bundles

`npm run build` creates:

- `dist/extension.cjs` and `dist/nodeServer.cjs` for desktop and remote extension hosts
- `dist/browser.js` and `dist/browserServer.js` for vscode.dev and other browser hosts

The package allowlist in `scripts/package-files.json` defines every file permitted in the VSIX.
`npm run check:package` rejects missing or unexpected files.

## Request flow

1. The manifest assigns a language from the filename or path.
2. The parser identifies sections, assignments, comments, continuations, and source spans.
3. The registry selects generated definitions for the dialect and target version.
4. The language server returns completion, hover, diagnostics, navigation, symbols, edits, and
   semantic data.
5. The VS Code client adds workspace views, commands, drop-in creation, and optional installed-tool
   checks.

Workspace indexing resolves unit aliases, templates, masks, source precedence, drop-ins, and static
references. The same model supplies the Explorer, merged configuration view, dependency graph, and
cross-file language features.

## Boundaries

- Browser code cannot use Node.js APIs or start external tools.
- External validators run only on trusted desktop hosts and saved local files.
- Child processes use argument arrays without a shell and have time and output limits.
- Host configuration is read-only. Edits and created files stay inside the workspace.
- The extension does not call `systemctl`, D-Bus, `sudo`, or `pkexec`.

See [privacy and trust](https://willibrandon.github.io/vscode-systemd/privacy-and-trust/) for the
user-facing behavior.
