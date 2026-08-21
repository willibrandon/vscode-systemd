import type { WorkspaceSnapshotConfiguration } from "@systemd/language-server/protocol";

export interface ConfigurationCollection {
  readonly label: string;
  readonly template: boolean;
  readonly configurations: readonly WorkspaceSnapshotConfiguration[];
}

export function collectConfigurations(
  configurations: readonly WorkspaceSnapshotConfiguration[],
): readonly ConfigurationCollection[] {
  const collections = new Map<string, WorkspaceSnapshotConfiguration[]>();
  const templateLabels = new Set<string>();
  for (const configuration of configurations) {
    const template = templateIdentity(configuration.identity);
    const label = template ?? configuration.identity;
    collections.set(label, [...(collections.get(label) ?? []), configuration]);
    if (template !== undefined) templateLabels.add(label);
  }
  return [...collections.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([label, members]) => ({
      label,
      template: templateLabels.has(label),
      configurations: members.sort((left, right) => left.identity.localeCompare(right.identity)),
    }));
}

export function configurationTooltip(
  configuration: WorkspaceSnapshotConfiguration,
  outgoingReferences: number,
  incomingReferences: number,
): string {
  return [
    configuration.identity,
    "Language: " + configuration.languageId,
    "Status: " + (configuration.masked ? "masked" : "active"),
    "Source: " + configuration.sourceUri,
    "Base: " + (configuration.baseUri ?? "none"),
    "Drop-ins: " + String(configuration.dropInUris.length),
    "Other candidates: " + String(otherCandidateCount(configuration)),
    "References: " +
      String(outgoingReferences) +
      " outgoing, " +
      String(incomingReferences) +
      " incoming",
  ].join("\n");
}

function templateIdentity(identity: string): string | undefined {
  const at = identity.lastIndexOf("@");
  const extension = identity.lastIndexOf(".");
  if (at < 1 || extension <= at) return undefined;
  return identity.slice(0, at + 1) + identity.slice(extension);
}

function otherCandidateCount(configuration: WorkspaceSnapshotConfiguration): number {
  const applied = new Set([
    ...(configuration.baseUri === undefined ? [] : [configuration.baseUri]),
    ...configuration.dropInUris,
  ]);
  return configuration.documentUris.filter((uri) => !applied.has(uri)).length;
}
