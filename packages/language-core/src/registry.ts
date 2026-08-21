import rawRegistry from "./generated/registry.json" with { type: "json" };
import rawStableDelta from "./generated/stable-delta.json" with { type: "json" };
import type {
  DialectId,
  DirectiveDefinition,
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
): DirectiveDefinition | undefined {
  const registryId = registryDialect(dialect);
  if (registryId === undefined) return undefined;
  const selectedSection = section ?? "*";
  return (
    exact.get(key(registryId, selectedSection, name)) ??
    exact.get(key(registryId, "*", name)) ??
    inheritedSystemdDefinition(registryId, selectedSection, name)
  );
}

export function definitionsFor(
  dialect: DialectId,
  section?: string | null,
): readonly DirectiveDefinition[] {
  const registryId = registryDialect(dialect);
  if (registryId === undefined) return [];
  const definitions = byDialect.get(registryId) ?? [];
  if (section === undefined || section === null) return definitions;
  const unique = new Map<string, DirectiveDefinition>();
  for (const definition of definitions) {
    if (definition.section === section || definition.section === "*") {
      unique.set(definition.name, definition);
    }
  }
  if (registryId === "podman-quadlet") {
    for (const definition of byDialect.get("systemd-unit") ?? []) {
      if (
        definition.section === section ||
        definition.section === "*" ||
        ["Unit", "Service", "Install"].includes(section)
      ) {
        unique.set(definition.name, definition);
      }
    }
  }
  return [...unique.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function sectionsFor(dialect: DialectId): readonly string[] {
  const registryId = registryDialect(dialect);
  if (registryId === undefined) return [];
  const sections = new Set(
    (byDialect.get(registryId) ?? [])
      .map((definition) => definition.section)
      .filter((section) => section !== "*"),
  );
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
): DirectiveDefinition | undefined {
  if (dialect !== "podman-quadlet") return undefined;
  if (!["Unit", "Service", "Install"].includes(section)) return undefined;
  return exact.get(key("systemd-unit", section, name)) ?? exact.get(key("systemd-unit", "*", name));
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
