---
title: Recognized files
description: See every supported configuration family and configure unusual project names.
---

The extension uses separate language modes so completion, validation, and formatting match the
actual configuration grammar.

## systemd

- Units: `.service`, `.socket`, `.timer`, `.path`, `.mount`, `.automount`, `.swap`, `.target`,
  `.device`, `.slice`, and `.scope`, including unit drop-ins.
- Network configuration: `.network`, `.netdev`, `.link`, `.dnssd`, and `.dns-delegate`, including
  drop-ins.
- Daemon configuration: recognized systemd `*.conf` names, their `*.conf.d` drop-ins, `.nspawn`,
  repart, sysupdate, and portable-service profiles.
- Line-oriented formats: `tmpfiles.d`, `sysusers.d`, `sysctl.d`, `modules-load.d`, `binfmt.d`,
  presets, udev rules, hwdb, environment files, boot configuration, and fstab-family tables.
- Specialized data: DNSSEC trust anchors, plus schema-backed PCR lock files and DNS resource-record
  JSON with source-aligned semantic diagnostics.

## Podman Quadlet and mkosi

Quadlet recognizes `.artifact`, `.build`, `.container`, `.image`, `.kube`, `.network`, `.pod`, and
`.volume`, plus their drop-ins. A `.network` file is treated as Quadlet when it is under a
recognized `containers/systemd` or Quadlet path; ordinary `.network` files remain systemd-networkd
files.

mkosi recognizes `mkosi.conf`, local, tools, initrd, version, drop-in, historical `mkosi.presets/`,
profile, image, and UKI-profile configuration paths.

## Templates and unusual paths

Built-in compound suffixes include `.in`, `.erb`, `.j2`, `.jinja`, `.tmpl`, `.template`, `.backup`,
and `.ignore`. Template expressions remain visually distinct and are not reported as systemd syntax
errors.

Use Visual Studio Code's standard file association for a project-specific name:

```json
{
  "files.associations": {
    "deploy/my-unit": "systemd-unit",
    "images/production": "mkosi"
  }
}
```

For path-sensitive ambiguity, `systemd.dialectAssociations` accepts glob-to-language mappings. Use
`systemd.templateSuffixes` to add a compound suffix used by the project.
