---
title: systemd Unit Files for Visual Studio Code
description:
  Edit systemd, Podman Quadlet, and mkosi configuration with a self-contained language server.
---

systemd Unit Files provides one self-contained editing environment for systemd units and
configuration, systemd-networkd, udev, tmpfiles, sysusers, Podman Quadlet, and mkosi. Syntax
highlighting starts immediately; diagnostics, completion, hover, navigation, effective
configuration, dependency graphs, and formatting follow when the bundled language server starts.

No other extension or host-installed language server is required. The same internal analysis runs in
desktop, Remote Development, virtual, and browser extension hosts.

## Try a unit

```systemd
[Unit]
Description=Example API
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
ExecStart=/usr/local/bin/example-api
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

Move the cursor over a directive for upstream documentation, trigger completion in a section, or
open the Systemd Explorer to inspect indexed units and references.

![Directive completion from the packaged extension in Visual Studio Code](../../assets/completion.png)

## Safe by design

The extension never starts, stops, enables, disables, or reloads a service. It does not call
`systemctl`, connect to D-Bus, request root access, or change the running system. Optional installed
validation is off by default and requires a saved local file in a trusted desktop workspace.

[Start with a development build](./getting-started/) or review the
[recognized configuration](./recognized-files/).
