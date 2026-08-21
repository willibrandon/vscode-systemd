import type {
  DocumentKind,
  LineFieldDefinition,
  LineFormatDefinition,
  LineKeywordDefinition,
  LineSettingDefinition,
} from "./types.js";

const systemdMan = "https://www.freedesktop.org/software/systemd/man/latest/";

const required = (
  name: string,
  summary: string,
  choices: readonly string[] = [],
): LineFieldDefinition => ({ name, summary, required: true, choices });

const optional = (
  name: string,
  summary: string,
  choices: readonly string[] = [],
): LineFieldDefinition => ({ name, summary, required: false, choices });

const keyword = (
  name: string,
  summary: string,
  choices: readonly string[] = [],
): LineKeywordDefinition => ({ name, summary, choices });

const setting = (
  name: string,
  summary: string,
  documentation: string,
  choices: readonly string[] = [],
): LineSettingDefinition => ({ name, summary, documentation, choices });

const tmpfiles: LineFormatDefinition = {
  name: "tmpfiles.d entry",
  summary: "Creates, removes, cleans, or adjusts a filesystem object.",
  documentation: systemdMan + "tmpfiles.d.html",
  fields: [
    required("Type", "Operation letter followed by optional modifiers.", [
      "f",
      "f+",
      "w",
      "d",
      "D",
      "e",
      "v",
      "q",
      "Q",
      "p",
      "L",
      "L+",
      "L?",
      "c",
      "b",
      "C",
      "x",
      "X",
      "r",
      "R",
      "z",
      "Z",
      "t",
      "T",
      "h",
      "H",
      "a",
      "A",
      "k",
      "K",
      "m",
    ]),
    required("Path", "Absolute path or glob, with systemd specifiers allowed."),
    optional("Mode", "Octal access mode, optionally prefixed by '~' or ':'."),
    optional("User", "User name or numeric UID."),
    optional("Group", "Group name or numeric GID."),
    optional("Age", "Cleanup age, optionally qualified by timestamp types."),
    optional("Argument", "The complete remainder of the line; meaning depends on Type."),
  ],
  keywords: [],
  repeatLastField: false,
};

const sysusers: LineFormatDefinition = {
  name: "sysusers.d entry",
  summary: "Creates a system user/group, adds a member, or defines an allocation range.",
  documentation: systemdMan + "sysusers.d.html",
  fields: [
    required("Type", "User/group operation.", ["u!", "u", "g", "m", "r"]),
    required("Name", "User/group name, or '-' for an allocation range."),
    optional("ID", "UID/GID, path, primary group, member group, or allocation range."),
    optional("GECOS", "Quoted user description."),
    optional("Home", "Absolute user home directory."),
    optional("Shell", "Absolute login shell path."),
  ],
  keywords: [],
  repeatLastField: false,
};

const preset: LineFormatDefinition = {
  name: "systemd preset directive",
  summary: "Defines the default enablement policy for matching units.",
  documentation: systemdMan + "systemd.preset.html",
  fields: [
    required("Action", "Preset policy action.", ["enable", "disable", "ignore"]),
    required("Unit", "Unit name or shell-style unit-name pattern."),
    optional("Instance", "Template instance to enable."),
  ],
  keywords: [],
  repeatLastField: true,
};

const modulesLoad: LineFormatDefinition = {
  name: "modules-load.d entry",
  summary: "Names one kernel module to load during early boot.",
  documentation: systemdMan + "modules-load.d.html",
  fields: [required("Module", "Kernel module name.")],
  keywords: [],
  repeatLastField: false,
};

const binfmt: LineFormatDefinition = {
  name: "binfmt_misc rule",
  summary: "Registers a miscellaneous executable format with the kernel.",
  documentation: systemdMan + "binfmt.d.html",
  fields: [
    required("Name", "Unique binary-format name."),
    required("Type", "M matches magic bytes; E matches a filename extension.", ["M", "E"]),
    optional("Offset", "Unsigned byte offset for a magic match."),
    required("Magic", "Magic byte sequence or filename extension."),
    optional("Mask", "Optional mask applied to magic bytes."),
    required("Interpreter", "Executable invoked for matching files."),
    optional("Flags", "Any non-repeated combination of P, O, C, and F.", ["", "P", "O", "C", "F"]),
  ],
  keywords: [],
  repeatLastField: false,
};

const fstab = tableFormat("fstab entry", "fstab", [
  required("Source", "Block device, filesystem label/UUID, or remote resource."),
  required("Mount point", "Filesystem mount point, 'none', or 'swap'."),
  required("Type", "Filesystem type or 'auto'."),
  required("Options", "Comma-separated mount options."),
  optional("Dump", "dump(8) backup frequency, normally 0."),
  optional("Pass", "fsck ordering value, normally 0, 1, or 2."),
]);

const crypttab = tableFormat("crypttab entry", "crypttab", [
  required("Name", "Resulting encrypted volume name."),
  required("Device", "Encrypted block device specification."),
  optional("Key file", "Key path, socket, AF_UNIX source, or '-'."),
  optional("Options", "Comma-separated cryptsetup options."),
]);

const veritytab = tableFormat("veritytab entry", "veritytab", [
  required("Name", "Resulting verity volume name."),
  required("Data device", "Block device containing protected data."),
  required("Hash device", "Block device containing the hash tree."),
  required("Root hash", "Hexadecimal root hash, path, or '-'."),
  optional("Options", "Comma-separated verity options."),
]);

const integritytab = tableFormat("integritytab entry", "integritytab", [
  required("Name", "Resulting integrity volume name."),
  required("Device", "Underlying block device."),
  optional("Key file", "Integrity key file or '-'."),
  optional("Options", "Comma-separated integrity options."),
]);

const clonetab = tableFormat("clonetab entry", "clonetab", [
  required("Name", "Resulting dm-clone device name."),
  required("Source", "Read-only source block device."),
  required("Destination", "Writable destination block device."),
  required("Metadata", "Metadata block device."),
  optional("Options", "Comma-separated dm-clone options."),
]);

const positiveTrustAnchor: LineFormatDefinition = {
  name: "positive DNSSEC trust anchor",
  summary: "Defines one DS or DNSKEY record used as a DNSSEC trust anchor.",
  documentation: systemdMan + "dnssec-trust-anchors.d.html#Positive%20Trust%20Anchors",
  fields: [
    required("Domain", "DNS owner name."),
    required("Class", "DNS resource-record class.", ["IN"]),
    required("Type", "Trust-anchor resource-record type.", ["DS", "DNSKEY"]),
    required("Key tag / flags", "DS key tag or DNSKEY flags."),
    required("Algorithm / protocol", "DS algorithm or DNSKEY protocol 3."),
    required("Digest / algorithm", "DS digest type or DNSKEY algorithm."),
    required("Digest / key", "Hex DS digest or Base64 DNSKEY data."),
  ],
  keywords: [],
  repeatLastField: false,
};

const negativeTrustAnchor: LineFormatDefinition = {
  name: "negative DNSSEC trust anchor",
  summary: "Disables DNSSEC validation below one DNS domain.",
  documentation: systemdMan + "dnssec-trust-anchors.d.html#Negative%20Trust%20Anchors",
  fields: [required("Domain", "Root of a DNS subtree where validation is disabled.")],
  keywords: [],
  repeatLastField: false,
};

const loader = keywordFormat(
  "systemd-boot loader option",
  "Configures the systemd-boot menu and firmware integration.",
  "loader.conf.html",
  [
    keyword("timeout", "Boot-menu timeout in seconds or a menu mode.", [
      "menu-disabled",
      "menu-hidden",
      "menu-force",
    ]),
    keyword("default", "Glob selecting the default boot entry.", ["@saved"]),
    keyword("preferred", "Glob selecting a preferred boot entry.", ["@saved"]),
    ...[
      "editor",
      "auto-entries",
      "auto-firmware",
      "auto-poweroff",
      "auto-reboot",
      "beep",
      "reboot-for-bitlocker",
    ].map((name) => keyword(name, "Boolean systemd-boot option.", ["yes", "no"])),
    keyword("reboot-on-error", "Controls reboot after an error.", ["auto", "yes", "no"]),
    keyword("secure-boot-enroll", "Secure Boot key enrollment policy.", [
      "off",
      "manual",
      "if-safe",
      "force",
    ]),
    keyword("secure-boot-enroll-action", "Action after enrolling Secure Boot keys.", [
      "reboot",
      "shutdown",
    ]),
    keyword("secure-boot-enroll-timeout-sec", "Enrollment timeout in seconds.", ["hidden"]),
    keyword("console-mode", "Console video mode.", ["auto", "max", "keep"]),
    keyword("log-level", "Boot-loader log level.", [
      "emerg",
      "alert",
      "crit",
      "err",
      "warning",
      "notice",
      "info",
      "debug",
    ]),
  ],
);

const bootEntry = keywordFormat(
  "Boot Loader Specification Type #1 field",
  "Describes one bootable operating-system entry.",
  "systemd-boot.html",
  [
    keyword("title", "Human-readable entry title."),
    keyword("sort-key", "Primary sorting key."),
    keyword("version", "Entry version."),
    keyword("machine-id", "Machine ID associated with the entry."),
    keyword("architecture", "CPU architecture required by the entry."),
    keyword("options", "Kernel command line; may be repeated."),
    keyword("linux", "Linux kernel image path."),
    keyword("efi", "EFI executable path."),
    keyword("uki", "Unified kernel image path."),
    keyword("uki-url", "URL of a unified kernel image."),
    keyword("profile", "Numeric UKI profile."),
    keyword("initrd", "Initial RAM filesystem path; may be repeated."),
    keyword("devicetree", "Device-tree path."),
    keyword("devicetree-overlay", "Device-tree overlay path; may be repeated."),
    keyword("extra", "Additional boot entry resource."),
  ],
);

const hostname: LineFormatDefinition = {
  name: "static hostname",
  summary: "Defines the system's static host name.",
  documentation: systemdMan + "hostname.html",
  fields: [required("Hostname", "Single valid DNS-style host name.")],
  keywords: [],
  repeatLastField: false,
};

const kernelCommandLine: LineFormatDefinition = {
  name: "kernel command line",
  summary: "Defines parameters passed to the installed kernel.",
  documentation: systemdMan + "kernel-command-line.html",
  fields: [required("Parameter", "Kernel parameter or key=value assignment.")],
  keywords: [],
  repeatLastField: true,
};

const udevRule: LineFormatDefinition = {
  name: "udev rule",
  summary: "Matches a device event and applies assignments.",
  documentation: systemdMan + "udev.html#Rules%20Files",
  fields: [required("Expression", "Match or assignment expression separated by commas.")],
  keywords: [],
  repeatLastField: true,
};

const kernelInstallSettings = [
  setting(
    "MACHINE_ID",
    "Machine ID used when naming boot entries.",
    systemdMan + "kernel-install.html",
  ),
  setting(
    "BOOT_ROOT",
    "Root directory containing boot resources.",
    systemdMan + "kernel-install.html",
  ),
  setting("layout", "Boot-entry layout.", systemdMan + "kernel-install.html", [
    "auto",
    "bls",
    "uki",
    "other",
  ]),
  setting(
    "initrd_generator",
    "Initial RAM filesystem generator.",
    systemdMan + "kernel-install.html",
    ["auto", "none"],
  ),
  setting("uki_generator", "Unified kernel image generator.", systemdMan + "kernel-install.html", [
    "auto",
    "ukify",
    "none",
  ]),
  setting("entry_name_format", "Boot-entry naming format.", systemdMan + "kernel-install.html", [
    "auto",
    "machine-id",
    "os-id",
    "os-image-id",
  ]),
];

const osReleaseSettings = [
  "NAME",
  "ID",
  "ID_LIKE",
  "PRETTY_NAME",
  "ANSI_COLOR",
  "CPE_NAME",
  "HOME_URL",
  "DOCUMENTATION_URL",
  "SUPPORT_URL",
  "BUG_REPORT_URL",
  "PRIVACY_POLICY_URL",
  "SUPPORT_END",
  "VERSION",
  "VERSION_ID",
  "VERSION_CODENAME",
  "BUILD_ID",
  "IMAGE_ID",
  "IMAGE_VERSION",
  "VARIANT",
  "VARIANT_ID",
  "LOGO",
  "DEFAULT_HOSTNAME",
  "SYSEXT_LEVEL",
  "CONFEXT_LEVEL",
  "SYSEXT_SCOPE",
  "CONFEXT_SCOPE",
  "PORTABLE_PREFIXES",
  "ARCHITECTURE",
  "RELEASE_TYPE",
].map((name) => setting(name, "Standard os-release field.", systemdMan + "os-release.html"));

const machineInfoSettings = [
  "PRETTY_HOSTNAME",
  "ICON_NAME",
  "CHASSIS",
  "DEPLOYMENT",
  "LOCATION",
  "HARDWARE_VENDOR",
  "HARDWARE_MODEL",
  "HARDWARE_SERIAL",
  "FIRMWARE_VERSION",
  "FIRMWARE_VENDOR",
  "FIRMWARE_DATE",
].map((name) => setting(name, "Standard machine-info field.", systemdMan + "machine-info.html"));

const localeSettings = [
  "LANG",
  "LANGUAGE",
  "LC_CTYPE",
  "LC_NUMERIC",
  "LC_TIME",
  "LC_COLLATE",
  "LC_MONETARY",
  "LC_MESSAGES",
  "LC_PAPER",
  "LC_NAME",
  "LC_ADDRESS",
  "LC_TELEPHONE",
  "LC_MEASUREMENT",
  "LC_IDENTIFICATION",
].map((name) => setting(name, "System locale setting.", systemdMan + "locale.conf.html"));

const vconsoleSettings = [
  "KEYMAP",
  "KEYMAP_TOGGLE",
  "FONT",
  "FONT_MAP",
  "FONT_UNIMAP",
  "XKBMODEL",
  "XKBLAYOUT",
  "XKBVARIANT",
  "XKBOPTIONS",
].map((name) => setting(name, "Virtual-console setting.", systemdMan + "vconsole.conf.html"));

export function recordFormatFor(kind: DocumentKind): LineFormatDefinition | undefined {
  switch (kind) {
    case "systemd-tmpfiles:tmpfiles":
      return tmpfiles;
    case "systemd-sysusers:sysusers":
      return sysusers;
    case "systemd-udev-rules:rules":
      return udevRule;
    case "systemd-modules-load:modules-load":
      return modulesLoad;
    case "systemd-binfmt:binfmt":
      return binfmt;
    case "systemd-preset:preset":
      return preset;
    case "systemd-table:fstab":
      return fstab;
    case "systemd-table:crypttab":
      return crypttab;
    case "systemd-table:veritytab":
      return veritytab;
    case "systemd-table:integritytab":
      return integritytab;
    case "systemd-table:clonetab":
      return clonetab;
    case "systemd-dns-trust-anchor:positive":
      return positiveTrustAnchor;
    case "systemd-dns-trust-anchor:negative":
      return negativeTrustAnchor;
    case "systemd-boot:loader":
      return loader;
    case "systemd-boot:entry":
      return bootEntry;
    case "systemd-boot:kernel-command-line":
      return kernelCommandLine;
    case "systemd-environment:hostname":
      return hostname;
    default:
      return undefined;
  }
}

export function lineSettingsFor(kind: DocumentKind): readonly LineSettingDefinition[] {
  switch (kind) {
    case "systemd-boot:kernel-install":
      return kernelInstallSettings;
    case "systemd-environment:os-release":
      return osReleaseSettings;
    case "systemd-environment:machine-info":
      return machineInfoSettings;
    case "systemd-environment:locale":
      return localeSettings;
    case "systemd-environment:vconsole":
      return vconsoleSettings;
    default:
      return [];
  }
}

function tableFormat(
  name: string,
  manual: string,
  fields: readonly LineFieldDefinition[],
): LineFormatDefinition {
  return {
    name,
    summary: "Defines one " + name + ".",
    documentation: systemdMan + manual + ".html",
    fields,
    keywords: [],
    repeatLastField: false,
  };
}

function keywordFormat(
  name: string,
  summary: string,
  manual: string,
  keywords: readonly LineKeywordDefinition[],
): LineFormatDefinition {
  return {
    name,
    summary,
    documentation: systemdMan + manual,
    fields: [required("Option", "Configuration option."), required("Value", "Option value.")],
    keywords,
    repeatLastField: false,
  };
}
