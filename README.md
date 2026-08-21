# systemd for Visual Studio Code

VS Code support for systemd, systemd-networkd, Podman Quadlet, and mkosi.

## Install

Search for **systemd Unit Files** in the Extensions view or run:

```sh
code --install-extension willibrandon.systemd
```

[Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=willibrandon.systemd)
and [Open VSX](https://open-vsx.org/extension/willibrandon/systemd) publish the same extension.

## Features

- Syntax highlighting
- Completion, hover, diagnostics, and quick fixes
- Navigation, rename, symbols, and formatting
- Unit drop-ins, merged configuration, and dependency graphs
- Desktop, remote, and browser support
- Optional validation with installed tools

No other extension is required. The extension does not manage services or request root access.

[Documentation](https://willibrandon.github.io/vscode-systemd/) · [Changelog](CHANGELOG.md) ·
[Issues](https://github.com/willibrandon/vscode-systemd/issues)

## Supported files

Supported formats include unit files, networkd, daemon configuration, udev, hwdb, tmpfiles,
sysusers, sysctl, boot files, systemd JSON, all current Quadlet types, and mkosi configuration.

See the [recognized files](https://willibrandon.github.io/vscode-systemd/recognized-files/) page for
names and suffixes.

## Development

Requires Node.js 24.

```sh
npm ci
npm run generate
npm run verify
npm run package
```

The generator reads sibling checkouts at `../systemd`, `../podman`, and `../mkosi`.

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## License

MIT. See [LICENSE](LICENSE).
