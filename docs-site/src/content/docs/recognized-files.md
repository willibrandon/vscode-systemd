---
title: Recognized files
description: Supported names, paths, and suffixes.
---

## systemd

- Units: `.service`, `.socket`, `.timer`, `.path`, `.mount`, `.automount`, `.swap`, `.target`,
  `.device`, `.slice`, and `.scope`
- Networkd: `.network`, `.netdev`, `.link`, `.dnssd`, and `.dns-delegate`
- Daemon configuration, `.nspawn`, `.oomrule`, repart, sysupdate, and drop-ins
- udev, hwdb, tmpfiles, sysusers, sysctl, modules-load, binfmt, presets, boot files, and systemd
  tables
- PCR lock, DNS record, and public userdb JSON

## Quadlet and mkosi

Quadlet supports `.artifact`, `.build`, `.container`, `.image`, `.kube`, `.network`, `.pod`, and
`.volume`.

mkosi supports its main file, drop-ins, presets, profiles, images, local files, tools, initrd,
version, and UKI profiles.

## Custom names

```json
{
  "files.associations": {
    "deploy/my-unit": "systemd-unit"
  }
}
```

Use `systemd.dialectAssociations` for path-based choices and `systemd.templateSuffixes` for custom
compound suffixes.
