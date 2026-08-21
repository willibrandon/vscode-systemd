---
title: Getting started
description: Build the current extension candidate and explore a systemd unit.
---

No public release is published while version 0.1.0 is being tested. To install the current source
candidate, use Node.js 24 and the npm version declared by the repository:

```sh
git clone https://github.com/willibrandon/vscode-systemd.git
cd vscode-systemd
npm ci
npm run package
code --install-extension dist/systemd-0.1.0.vsix
```

This installs the exact packaged artifact rather than running loose build output. Reload Visual
Studio Code, then open a recognized configuration file.

## Explore the editor support

Create `example.service` and enter `service-unit` to insert a complete service skeleton, or use the
example on the home page. Trigger suggestions under `[Unit]` or `[Service]`, hover over `ExecStart`,
and introduce a close misspelling such as `Restar=` to see a diagnostic and quick fix.

Use **Format Document** to normalize spacing without reordering directives. Open the Systemd
Explorer to inspect the unit and its references. The editor title and status bar show `systemd Unit`
when file recognition succeeds.

## Quadlet and mkosi

A `.container` file activates the Podman Quadlet dialect:

```quadlet
[Container]
Image=quay.io/podman/hello
PublishPort=8080:80
```

An `mkosi.conf` file activates the mkosi dialect:

```mkosi
[Distribution]
Distribution=fedora

[Output]
Format=disk
```

Normal editing does not require systemd, Podman, or mkosi to be installed.
