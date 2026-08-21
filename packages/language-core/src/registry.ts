import rawRegistry from "./generated/registry.json" with { type: "json" };
import rawStableDelta from "./generated/stable-delta.json" with { type: "json" };
import { documentAllowsSection, fixedDocumentSections } from "./document-kind.js";
import type {
  DialectId,
  DirectiveDefinition,
  DocumentKind,
  RegistryChannel,
  RegistryDialect,
  RegistryMetadata,
} from "./types.js";

interface RawRegistry extends RegistryMetadata {
  readonly directives: readonly DirectiveDefinition[];
}

interface RawRegistryDelta {
  readonly upstream: RegistryMetadata["upstream"];
  readonly remove: readonly string[];
  readonly directives: readonly DirectiveDefinition[];
}

const previewRegistry = rawRegistry as RawRegistry;
const stableRegistry = applyDelta(previewRegistry, rawStableDelta as RawRegistryDelta);
const registries: Readonly<Record<RegistryChannel, RawRegistry>> = {
  stable: stableRegistry,
  preview: previewRegistry,
};
let activeChannel: RegistryChannel = "stable";
let exact = new Map<string, DirectiveDefinition>();
let byDialect = new Map<RegistryDialect, readonly DirectiveDefinition[]>();
const networkSectionCache = new Map<DocumentKind, ReadonlySet<string>>();
const networkManualByKind: Readonly<Partial<Record<DocumentKind, string>>> = {
  "systemd-network:network": "systemd.network",
  "systemd-network:netdev": "systemd.netdev",
  "systemd-network:link": "systemd.link",
  "systemd-network:dnssd": "systemd.dnssd",
  "systemd-network:dns-delegate": "systemd.dns-delegate",
};
const configManualsByKind: Readonly<Partial<Record<DocumentKind, readonly string[]>>> = {
  "systemd-config:system": ["systemd-system.conf"],
  "systemd-config:user": ["systemd-system.conf"],
  "systemd-config:journald": ["journald.conf"],
  "systemd-config:logind": ["logind.conf"],
  "systemd-config:resolved": ["resolved.conf"],
  "systemd-config:timesyncd": ["timesyncd.conf"],
  "systemd-config:networkd": ["networkd.conf"],
  "systemd-config:coredump": ["coredump.conf"],
  "systemd-config:oomd": ["oomd.conf"],
  "systemd-config:homed": ["homed.conf"],
  "systemd-config:pstore": ["pstore.conf"],
  "systemd-config:sleep": ["systemd-sleep.conf"],
  "systemd-config:iocost": ["iocost.conf"],
  "systemd-config:journal-remote": ["journal-remote.conf"],
  "systemd-config:journal-upload": ["journal-upload.conf"],
  "systemd-config:udev": ["udev.conf"],
  "systemd-config:sysext": ["sysext.conf"],
  "systemd-config:confext": ["sysext.conf"],
  "systemd-config:ukify": [],
  "systemd-config:uki": [],
  "systemd-config:nspawn": ["systemd.nspawn"],
  "systemd-config:repart": ["repart.d"],
  "systemd-config:sysupdate": ["sysupdate.d"],
  "systemd-config:portable-profile": [],
};

const dynamicPatterns = previewRegistry.dynamicDirectivePatterns.map(
  (pattern) => new RegExp(pattern, "u"),
);

export let registryMetadata: RegistryMetadata;
export let directiveDefinitions: readonly DirectiveDefinition[];

configureRegistryChannel("stable");

export function configureRegistryChannel(channel: RegistryChannel): void {
  activeChannel = channel;
  const registry = registries[activeChannel];
  exact = new Map();
  byDialect = new Map();
  networkSectionCache.clear();
  for (const definition of registry.directives) {
    exact.set(key(definition.dialect, definition.section, definition.name), definition);
  }
  for (const dialect of [
    "systemd-unit",
    "systemd-network",
    "systemd-config",
    "podman-quadlet",
    "mkosi",
  ] as const) {
    byDialect.set(
      dialect,
      registry.directives.filter((definition) => definition.dialect === dialect),
    );
  }
  registryMetadata = {
    schemaVersion: registry.schemaVersion,
    generatedAt: registry.generatedAt,
    upstream: registry.upstream,
    quadletExtensions: registry.quadletExtensions,
    dynamicDirectivePatterns: registry.dynamicDirectivePatterns,
  };
  directiveDefinitions = registry.directives;
}

export function registryDialect(dialect: DialectId): RegistryDialect | undefined {
  switch (dialect) {
    case "systemd-unit":
    case "systemd-network":
    case "systemd-config":
    case "podman-quadlet":
    case "mkosi":
      return dialect;
    default:
      return undefined;
  }
}

export function definitionFor(
  dialect: DialectId,
  section: string | null,
  name: string,
  documentKind?: DocumentKind,
): DirectiveDefinition | undefined {
  const registryId = registryDialect(dialect);
  if (registryId === undefined) return undefined;
  const selectedSection = section ?? "*";
  if (
    documentKind !== undefined &&
    selectedSection !== "*" &&
    !sectionAllowedInDocument(documentKind, selectedSection)
  ) {
    return undefined;
  }
  const direct =
    exact.get(key(registryId, selectedSection, name)) ?? exact.get(key(registryId, "*", name));
  if (direct !== undefined && definitionAllowedInDocument(direct, documentKind)) return direct;
  const inherited = inheritedSystemdDefinition(registryId, selectedSection, name, documentKind);
  return inherited !== undefined && definitionAllowedInDocument(inherited, documentKind)
    ? inherited
    : undefined;
}

export function definitionsFor(
  dialect: DialectId,
  section?: string | null,
  documentKind?: DocumentKind,
): readonly DirectiveDefinition[] {
  const registryId = registryDialect(dialect);
  if (registryId === undefined) return [];
  const definitions = byDialect.get(registryId) ?? [];
  if (section === undefined || section === null) {
    return definitions.filter((definition) =>
      definitionAllowedInDocument(definition, documentKind),
    );
  }
  if (documentKind !== undefined && !sectionAllowedInDocument(documentKind, section)) return [];
  const unique = new Map<string, DirectiveDefinition>();
  for (const definition of definitions) {
    if (
      (definition.section === section || definition.section === "*") &&
      definitionAllowedInDocument(definition, documentKind)
    ) {
      unique.set(definition.name, definition);
    }
  }
  if (registryId === "podman-quadlet") {
    for (const definition of byDialect.get("systemd-unit") ?? []) {
      if (definition.section === section || definition.section === "*") {
        unique.set(definition.name, definition);
      }
    }
  }
  if (documentKind === "systemd-config:portable-profile" && section === "Service") {
    for (const definition of byDialect.get("systemd-unit") ?? []) {
      if (["Service", "*"].includes(definition.section)) unique.set(definition.name, definition);
    }
  }
  return [...unique.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function sectionsFor(dialect: DialectId, documentKind?: DocumentKind): readonly string[] {
  const registryId = registryDialect(dialect);
  if (registryId === undefined) return [];
  const definitions = byDialect.get(registryId) ?? [];
  const fixed = documentKind === undefined ? undefined : fixedDocumentSections(documentKind);
  const available = definitions
    .filter((definition) => definitionAllowedInDocument(definition, documentKind))
    .map((definition) => definition.section)
    .filter((section) => section !== "*");
  const sections = new Set<string>(fixed ?? available);
  if (registryId === "podman-quadlet") {
    sections.add("Unit");
    sections.add("Service");
    sections.add("Install");
  }
  return [...sections].sort();
}

export function isDynamicDirective(name: string): boolean {
  return dynamicPatterns.some((pattern) => pattern.test(name));
}

function inheritedSystemdDefinition(
  dialect: RegistryDialect,
  section: string,
  name: string,
  documentKind?: DocumentKind,
): DirectiveDefinition | undefined {
  if (dialect !== "podman-quadlet" && documentKind !== "systemd-config:portable-profile") {
    return undefined;
  }
  if (!["Unit", "Service", "Install"].includes(section)) return undefined;
  return exact.get(key("systemd-unit", section, name)) ?? exact.get(key("systemd-unit", "*", name));
}

function definitionAllowedInDocument(
  definition: DirectiveDefinition,
  documentKind: DocumentKind | undefined,
): boolean {
  if (documentKind === undefined) return true;
  if (definition.section !== "*" && !sectionAllowedInDocument(documentKind, definition.section)) {
    return false;
  }
  const networkPage = networkManualFor(documentKind);
  if (networkPage !== undefined) {
    if (definition.documentation.includes("/" + networkPage + ".html")) return true;
    if (!definition.documentation.includes("/systemd.directives.html")) return false;
    return networkSections(documentKind).has(definition.section);
  }
  if (documentKind.startsWith("systemd-config:") && definition.dialect === "systemd-config") {
    if (documentKind === "systemd-config:portable-profile") return false;
    if (definition.section !== "*") return true;
    const pages = configManualsFor(documentKind);
    return (
      pages === undefined ||
      pages.some((page) => definition.documentation.includes("/" + page + ".html"))
    );
  }
  return true;
}

function sectionAllowedInDocument(documentKind: DocumentKind, section: string): boolean {
  if (!documentAllowsSection(documentKind, section)) return false;
  if (section.startsWith("X-")) return true;
  const networkPage = networkManualFor(documentKind);
  return networkPage === undefined || networkSections(documentKind).has(section);
}

function networkSections(documentKind: DocumentKind): ReadonlySet<string> {
  const cached = networkSectionCache.get(documentKind);
  if (cached !== undefined) return cached;
  const page = networkManualFor(documentKind);
  if (page === undefined) return new Set();
  const sections = new Set(
    (byDialect.get("systemd-network") ?? [])
      .filter((definition) => definition.documentation.includes("/" + page + ".html"))
      .map(({ section }) => section),
  );
  networkSectionCache.set(documentKind, sections);
  return sections;
}

function networkManualFor(documentKind: DocumentKind): string | undefined {
  return networkManualByKind[documentKind];
}

function configManualsFor(documentKind: DocumentKind): readonly string[] | undefined {
  return configManualsByKind[documentKind];
}

function key(dialect: RegistryDialect, section: string, name: string): string {
  return [dialect, section, name].join("\0");
}

function applyDelta(preview: RawRegistry, delta: RawRegistryDelta): RawRegistry {
  const directives = new Map(
    preview.directives.map((definition) => [
      key(definition.dialect, definition.section, definition.name),
      definition,
    ]),
  );
  for (const removed of delta.remove) directives.delete(removed);
  for (const definition of delta.directives) {
    directives.set(key(definition.dialect, definition.section, definition.name), definition);
  }
  return {
    ...preview,
    upstream: delta.upstream,
    directives: [...directives.values()].sort((left, right) =>
      key(left.dialect, left.section, left.name).localeCompare(
        key(right.dialect, right.section, right.name),
      ),
    ),
  };
}
