import type { DialectId, DocumentKind, MkosiDocumentType, SystemdConfigFamily } from "./types.js";

const configurationFamilies = new Set<SystemdConfigFamily>([
  "system",
  "user",
  "journald",
  "logind",
  "resolved",
  "timesyncd",
  "networkd",
  "coredump",
  "oomd",
  "homed",
  "pstore",
  "sleep",
  "iocost",
  "journal-remote",
  "journal-upload",
  "udev",
  "sysext",
  "confext",
  "ukify",
  "uki",
]);

export function classifyDocument(uri: string, dialect: DialectId): DocumentKind {
  const normalized = normalizedPath(uri);
  const name = normalized.slice(normalized.lastIndexOf("/") + 1);
  const ownerCandidate = /\/([^/]+)\.d\/[^/]+$/u.exec(normalized)?.[1];
  const owner =
    ownerCandidate !== undefined &&
    /(?:\.conf|\.(?:service|socket|timer|path|mount|automount|swap|target|device|slice|scope|network|netdev|link|dnssd|dns-delegate|nspawn|artifact|build|container|image|kube|pod|volume|pcrlock|rr))$/u.test(
      ownerCandidate,
    )
      ? ownerCandidate
      : undefined;
  const effective = stripCompoundSuffixes(owner ?? name);

  switch (dialect) {
    case "systemd-unit": {
      const type =
        /\.(service|socket|timer|path|mount|automount|swap|target|device|slice|scope)$/u.exec(
          effective,
        )?.[1];
      return type === undefined ? "systemd-unit:unknown" : (`systemd-unit:${type}` as DocumentKind);
    }
    case "systemd-network": {
      const type = /\.(network|netdev|link|dnssd|dns-delegate)$/u.exec(effective)?.[1];
      return type === undefined
        ? "systemd-network:unknown"
        : (`systemd-network:${type}` as DocumentKind);
    }
    case "systemd-config":
      return classifySystemdConfig(normalized, effective);
    case "systemd-tmpfiles":
      return "systemd-tmpfiles:tmpfiles";
    case "systemd-sysusers":
      return "systemd-sysusers:sysusers";
    case "systemd-udev-rules":
      return "systemd-udev-rules:rules";
    case "systemd-hwdb":
      return "systemd-hwdb:hwdb";
    case "systemd-environment":
      return classifyEnvironment(normalized, effective);
    case "systemd-sysctl":
      return "systemd-sysctl:sysctl";
    case "systemd-modules-load":
      return "systemd-modules-load:modules-load";
    case "systemd-binfmt":
      return "systemd-binfmt:binfmt";
    case "systemd-preset":
      return "systemd-preset:preset";
    case "systemd-table":
      return /^(?:fstab|crypttab|veritytab|integritytab|clonetab)$/u.test(effective)
        ? (`systemd-table:${effective}` as DocumentKind)
        : "systemd-table:unknown";
    case "systemd-boot":
      return classifyBoot(normalized, effective);
    case "systemd-dns-trust-anchor":
      return effective.endsWith(".positive")
        ? "systemd-dns-trust-anchor:positive"
        : effective.endsWith(".negative")
          ? "systemd-dns-trust-anchor:negative"
          : "systemd-dns-trust-anchor:unknown";
    case "systemd-json":
      return effective.endsWith(".pcrlock")
        ? "systemd-json:pcrlock"
        : effective.endsWith(".rr")
          ? "systemd-json:rr"
          : effective.endsWith(".user")
            ? "systemd-json:user"
            : effective.endsWith(".group")
              ? "systemd-json:group"
              : effective.endsWith(".membership")
                ? "systemd-json:membership"
                : "systemd-json:unknown";
    case "podman-quadlet": {
      const type = /\.(artifact|build|container|image|kube|network|pod|volume)$/u.exec(
        effective,
      )?.[1];
      return type === undefined
        ? "podman-quadlet:unknown"
        : (`podman-quadlet:${type}` as DocumentKind);
    }
    case "mkosi":
      return `mkosi:${classifyMkosi(normalized, effective)}`;
  }
}

export function fixedDocumentSections(kind: DocumentKind): readonly string[] | undefined {
  if (kind.endsWith(":unknown")) return undefined;
  if (kind.startsWith("systemd-unit:")) {
    const type = kind.slice("systemd-unit:".length);
    const own = /^[a-z]+$/u.test(type) ? type.slice(0, 1).toUpperCase() + type.slice(1) : undefined;
    return [
      "Unit",
      ...(own === undefined || ["Target", "Device", "Unknown"].includes(own) ? [] : [own]),
      "Install",
    ];
  }
  if (kind.startsWith("podman-quadlet:")) {
    const type = kind.slice("podman-quadlet:".length);
    const own = /^[a-z]+$/u.test(type) ? type.slice(0, 1).toUpperCase() + type.slice(1) : undefined;
    return [
      "Unit",
      "Service",
      "Install",
      "Quadlet",
      ...(own === undefined || own === "Unknown" ? [] : [own]),
    ];
  }
  if (kind === "mkosi:uki-profile") return ["UKIProfile"];
  if (kind === "mkosi:version") return [];
  if (kind.startsWith("systemd-config:")) return systemdConfigSections(kind);
  if (kind.startsWith("systemd-network:") || kind.startsWith("mkosi:")) return undefined;
  return [];
}

export function documentAllowsSection(kind: DocumentKind, section: string): boolean {
  if (section.startsWith("X-")) return true;
  if (kind === "systemd-config:ukify" && section.startsWith("PCRSignature:")) return true;
  const fixed = fixedDocumentSections(kind);
  return fixed === undefined || fixed.includes(section);
}

function classifySystemdConfig(normalized: string, effective: string): DocumentKind {
  if (effective.endsWith(".nspawn")) return "systemd-config:nspawn";
  if (effective.endsWith(".oomrule")) return "systemd-config:oom-rule";
  if (normalized.includes("/mkosi.repart/") || normalized.includes("/repart.d/")) {
    return "systemd-config:repart";
  }
  if (normalized.includes("/sysupdate.d/")) return "systemd-config:sysupdate";
  if (normalized.includes("/portable/profile/")) return "systemd-config:portable-profile";
  const configured =
    /^(journald)(?:@[^/]+)?\.conf$/u.exec(effective)?.[1] ?? /^(.*)\.conf$/u.exec(effective)?.[1];
  if (configured === "systemd-sleep") return "systemd-config:sleep";
  return configured !== undefined && configurationFamilies.has(configured as SystemdConfigFamily)
    ? (`systemd-config:${configured}` as DocumentKind)
    : "systemd-config:generic";
}

function systemdConfigSections(kind: DocumentKind): readonly string[] | undefined {
  switch (kind) {
    case "systemd-config:system":
    case "systemd-config:user":
      return ["Manager"];
    case "systemd-config:journald":
      return ["Journal"];
    case "systemd-config:logind":
      return ["Login"];
    case "systemd-config:resolved":
      return ["Resolve"];
    case "systemd-config:timesyncd":
      return ["Time"];
    case "systemd-config:networkd":
      return ["Network", "DHCP", "DHCPv4", "DHCPv6", "DHCPServer", "DHCPRelay", "IPv6AcceptRA"];
    case "systemd-config:coredump":
      return ["Coredump"];
    case "systemd-config:oomd":
      return ["OOM"];
    case "systemd-config:oom-rule":
      return ["Rule"];
    case "systemd-config:homed":
      return ["Home"];
    case "systemd-config:pstore":
      return ["PStore"];
    case "systemd-config:sleep":
      return ["Sleep"];
    case "systemd-config:iocost":
      return ["IOCost"];
    case "systemd-config:journal-remote":
      return ["Remote"];
    case "systemd-config:journal-upload":
      return ["Upload"];
    case "systemd-config:udev":
      return ["Udev"];
    case "systemd-config:sysext":
      return ["SysExt"];
    case "systemd-config:confext":
      return ["ConfExt"];
    case "systemd-config:ukify":
    case "systemd-config:uki":
      return ["UKI"];
    case "systemd-config:nspawn":
      return ["Exec", "Files", "Network"];
    case "systemd-config:repart":
      return ["Partition"];
    case "systemd-config:sysupdate":
      return ["Transfer", "Source", "Target", "Feature", "Component"];
    case "systemd-config:portable-profile":
      return ["Service"];
    case "systemd-config:generic":
    case "systemd-config:unknown":
      return undefined;
    default:
      return undefined;
  }
}

function classifyEnvironment(normalized: string, effective: string): DocumentKind {
  if (/^(?:os-release|initrd-release)$/u.test(effective)) return "systemd-environment:os-release";
  if (effective === "hostname") return "systemd-environment:hostname";
  if (effective === "machine-info") return "systemd-environment:machine-info";
  if (effective === "locale.conf") return "systemd-environment:locale";
  if (effective === "vconsole.conf") return "systemd-environment:vconsole";
  return normalized.includes("/environment.d/") || normalized.includes("/extension-release.d/")
    ? "systemd-environment:environment"
    : "systemd-environment:unknown";
}

function classifyBoot(normalized: string, effective: string): DocumentKind {
  if (normalized.includes("/loader/entries/")) return "systemd-boot:entry";
  if (effective === "loader.conf") return "systemd-boot:loader";
  if (effective === "cmdline") return "systemd-boot:kernel-command-line";
  if (effective === "entry-token") return "systemd-boot:entry-token";
  if (effective === "install.conf" || normalized.includes("/kernel/install.conf.d/")) {
    return "systemd-boot:kernel-install";
  }
  return "systemd-boot:unknown";
}

function classifyMkosi(normalized: string, effective: string): MkosiDocumentType {
  if (effective === "mkosi.version") return "version";
  if (normalized.includes("/mkosi.uki-profiles/")) return "uki-profile";
  if (normalized.includes("/mkosi.initrd.conf/") || effective === "mkosi.initrd.conf") {
    return "initrd";
  }
  if (normalized.includes("/mkosi.tools.conf/") || effective === "mkosi.tools.conf") return "tools";
  if (normalized.includes("/mkosi.local/") || effective === "mkosi.local.conf") return "local";
  if (normalized.includes("/mkosi.presets/")) return "preset";
  if (normalized.includes("/mkosi.profiles/")) return "profile";
  if (normalized.includes("/mkosi.images/")) return "subimage";
  if (normalized.includes("/mkosi.conf.d/")) return "drop-in";
  if (effective === "mkosi.conf") return "main";
  return "generic";
}

function normalizedPath(uri: string): string {
  let decoded = uri;
  try {
    decoded = decodeURIComponent(uri);
  } catch {
    // Preserve malformed escapes so classification remains total for editor-provided URIs.
  }
  return (decoded.split(/[?#]/u)[0] ?? decoded).replaceAll("\\", "/").toLowerCase();
}

function stripCompoundSuffixes(name: string): string {
  let result = name;
  const suffixes = [".ignore", ".backup", ".template", ".tmpl", ".jinja", ".j2", ".erb", ".in"];
  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of suffixes) {
      if (!result.endsWith(suffix)) continue;
      result = result.slice(0, -suffix.length);
      changed = true;
    }
  }
  return result;
}
