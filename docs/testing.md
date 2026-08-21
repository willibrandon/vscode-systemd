# Testing

Use Node.js 24 and the npm version pinned in `package.json`.

## Main gate

```sh
npm ci
npm run verify
```

`verify` checks generated data, language coverage, formatting, lint, types, unit and property tests,
coverage, performance, bundles, licenses, packaged files, dependency vulnerabilities, and registry
signatures. It does not launch VS Code.

## Focused commands

| Command                    | Scope                                                          |
| -------------------------- | -------------------------------------------------------------- |
| `npm run test:core`        | Parser, registry, analysis, formatting, and workspace behavior |
| `npm run test:client`      | Client models, indexing, version selection, and validators     |
| `npm run test:grammar`     | TextMate tokenization, snippets, and themes                    |
| `npm run test:package`     | Public manifest and package contract                           |
| `npm run test:docs`        | Docs build, packaged grammar examples, and image popup sizing  |
| `npm run test:integration` | Desktop VS Code extension host                                 |
| `npm run test:web`         | Browser worker extension host                                  |
| `npm run test:vsix`        | Build, install, and activate the exact VSIX                    |
| `npm run test:remote`      | Install and activate the exact VSIX through Remote SSH         |

The integration, web, VSIX, and remote commands download or start test hosts. Use the focused Vitest
suites while editing and run the host tests before release.

## Hosted matrix

CI tests the minimum supported and current stable VS Code releases on Linux, macOS, and Windows. It
also tests browser activation, a packaged VSIX, Remote SSH, pinned upstream fixtures, and VS Code
Insiders as a non-blocking early warning.

The Dev Container workflow builds the published container configuration and runs the extension
inside it. CodeQL, dependency review, Picket, license checks, npm audit, package allowlists, and
artifact reproduction cover security and release integrity.

Generated bundles, coverage, VSIX files, downloaded hosts, and test profiles belong in ignored
output directories and must not be committed.
