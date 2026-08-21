import * as vscode from "vscode";
import type { BaseLanguageClient } from "vscode-languageclient";
import { workspaceSnapshotRequest } from "@systemd/language-server/protocol";
import type {
  WorkspaceSnapshot,
  WorkspaceSnapshotConfiguration,
} from "@systemd/language-server/protocol";
import {
  collectConfigurations,
  collectConfigurationScopes,
  configurationTooltip,
  indexedSourceUri,
} from "./explorer-model.js";

const viewId = "systemd.explorer";

export interface SystemdExplorer extends vscode.Disposable {
  refresh(): Promise<void>;
  sourceFor(element: unknown): vscode.Uri | undefined;
  dropInTargetFor(element: unknown): DropInTarget | undefined;
}

export interface DropInTarget {
  readonly source: vscode.Uri;
  readonly identity: string;
}

export function registerSystemdExplorer(
  context: vscode.ExtensionContext,
  client: BaseLanguageClient,
  output: vscode.LogOutputChannel,
): SystemdExplorer {
  const provider = new SystemdExplorerProvider(client, output);
  const view = vscode.window.createTreeView(viewId, {
    treeDataProvider: provider,
    showCollapseAll: true,
  });
  context.subscriptions.push(view, provider);
  return provider;
}

type ExplorerNode =
  ScopeNode | CategoryNode | ConfigurationNode | GroupNode | ActionNode | FileNode | ReferenceNode;

interface ScopeNode {
  readonly kind: "scope";
  readonly label: "Workspace" | "Host";
  readonly workspaceOwned: boolean;
  readonly configurations: readonly WorkspaceSnapshotConfiguration[];
}

interface CategoryNode {
  readonly kind: "category";
  readonly label: string;
  readonly configurations: readonly WorkspaceSnapshotConfiguration[];
}

interface ConfigurationNode {
  readonly kind: "configuration";
  readonly configuration: WorkspaceSnapshotConfiguration;
}

interface GroupNode {
  readonly kind: "group";
  readonly label: string;
  readonly children: readonly ExplorerNode[];
  readonly icon: string;
}

interface ActionNode {
  readonly kind: "action";
  readonly label: string;
  readonly command: string;
  readonly argument: string;
  readonly icon: string;
}

interface FileNode {
  readonly kind: "file";
  readonly uri: string;
  readonly label: string;
  readonly description?: string;
  readonly icon: string;
}

interface ReferenceNode {
  readonly kind: "reference";
  readonly target: string;
  readonly description?: string;
  readonly incoming: boolean;
  readonly uri: string | undefined;
}

class SystemdExplorerProvider implements vscode.TreeDataProvider<ExplorerNode>, SystemdExplorer {
  private readonly changed = new vscode.EventEmitter<ExplorerNode | undefined>();
  private snapshot: WorkspaceSnapshot = { documents: [], configurations: [] };
  private disposed = false;
  private readonly client: BaseLanguageClient;
  private readonly output: vscode.LogOutputChannel;

  public readonly onDidChangeTreeData = this.changed.event;

  public constructor(client: BaseLanguageClient, output: vscode.LogOutputChannel) {
    this.client = client;
    this.output = output;
  }

  public getTreeItem(element: ExplorerNode): vscode.TreeItem {
    switch (element.kind) {
      case "scope":
        return scopeItem(element);
      case "category":
        return categoryItem(element);
      case "configuration":
        return configurationItem(
          element.configuration,
          configurationTooltip(
            element.configuration,
            this.referencesFor(element.configuration).length,
            this.incomingFor(element.configuration).length,
          ),
        );
      case "group":
        return groupItem(element);
      case "action":
        return actionItem(element);
      case "file":
        return fileItem(element);
      case "reference":
        return referenceItem(element);
    }
  }

  public getChildren(element?: ExplorerNode): ExplorerNode[] {
    if (element === undefined) return this.scopes();
    switch (element.kind) {
      case "scope":
        return this.categories(element.configurations);
      case "category":
        return collectConfigurations(element.configurations).map((collection) => {
          const children: ConfigurationNode[] = collection.configurations.map((configuration) => ({
            kind: "configuration",
            configuration,
          }));
          return collection.template
            ? {
                kind: "group",
                label: collection.label + " template",
                icon: "symbol-array",
                children,
              }
            : (children[0] ?? {
                kind: "group",
                label: collection.label,
                icon: "files",
                children: [],
              });
        });
      case "configuration":
        return this.configurationChildren(element.configuration);
      case "group":
        return [...element.children];
      case "action":
      case "file":
      case "reference":
        return [];
    }
  }

  public async refresh(): Promise<void> {
    try {
      this.snapshot = await this.client.sendRequest(workspaceSnapshotRequest, {});
      if (this.disposed) return;
      this.changed.fire(undefined);
    } catch (error) {
      this.output.warn("Unable to refresh Systemd Explorer: " + safeMessage(error));
    }
  }

  public sourceFor(element: unknown): vscode.Uri | undefined {
    if (typeof element === "string") return vscode.Uri.parse(element);
    if (isUri(element)) return element;
    if (!isExplorerNode(element)) return undefined;
    switch (element.kind) {
      case "configuration":
        return vscode.Uri.parse(element.configuration.sourceUri);
      case "file":
        return vscode.Uri.parse(element.uri);
      case "action":
        return vscode.Uri.parse(element.argument);
      case "scope":
      case "category":
      case "group":
      case "reference":
        return undefined;
    }
  }

  public dropInTargetFor(element: unknown): DropInTarget | undefined {
    if (isExplorerNode(element) && element.kind === "configuration") {
      return {
        source: vscode.Uri.parse(element.configuration.sourceUri),
        identity: element.configuration.identity,
      };
    }
    const source = this.sourceFor(element);
    return source === undefined ? undefined : { source, identity: basename(source.toString()) };
  }

  public dispose(): void {
    this.disposed = true;
    this.changed.dispose();
  }

  private scopes(): ScopeNode[] {
    return collectConfigurationScopes(this.snapshot.configurations).map((scope) => ({
      kind: "scope",
      ...scope,
    }));
  }

  private categories(configurations: readonly WorkspaceSnapshotConfiguration[]): CategoryNode[] {
    const groups = new Map<string, WorkspaceSnapshotConfiguration[]>();
    for (const configuration of configurations) {
      const label = categoryLabel(configuration.languageId);
      groups.set(label, [...(groups.get(label) ?? []), configuration]);
    }
    return [...groups.entries()]
      .sort(([left], [right]) => categoryOrder(left) - categoryOrder(right))
      .map(([label, configurations]) => ({
        kind: "category",
        label,
        configurations: configurations.sort((left, right) =>
          left.identity.localeCompare(right.identity),
        ),
      }));
  }

  private configurationChildren(configuration: WorkspaceSnapshotConfiguration): ExplorerNode[] {
    const result: ExplorerNode[] = [
      {
        kind: "action",
        label: "Effective configuration",
        command: "systemd.showEffectiveConfiguration",
        argument: configuration.sourceUri,
        icon: "layers",
      },
    ];
    if (configuration.masked) {
      result.push({
        kind: "file",
        uri: configuration.baseUri ?? configuration.sourceUri,
        label: "Masked",
        description: basename(configuration.baseUri ?? configuration.sourceUri),
        icon: "circle-slash",
      });
    } else if (configuration.baseUri !== undefined) {
      result.push({
        kind: "file",
        uri: configuration.baseUri,
        label: "Base: " + basename(configuration.baseUri),
        description: "lowest precedence",
        icon: "file",
      });
    }
    if (configuration.dropInUris.length > 0) {
      result.push({
        kind: "group",
        label: "Drop-ins (in precedence order)",
        icon: "list-ordered",
        children: configuration.dropInUris.map((uri, index) => ({
          kind: "file",
          uri,
          label: basename(uri),
          description: String(index + 1) + " of " + String(configuration.dropInUris.length),
          icon: "file-code",
        })),
      });
    }
    const applied = new Set([
      ...(configuration.baseUri === undefined ? [] : [configuration.baseUri]),
      ...configuration.dropInUris,
    ]);
    const inactive = configuration.documentUris.filter((uri) => !applied.has(uri));
    if (inactive.length > 0) {
      result.push({
        kind: "group",
        label: "Other candidates",
        icon: "files",
        children: inactive.map((uri) => ({
          kind: "file",
          uri,
          label: basename(uri),
          description: "not applied",
          icon: "file-symlink-file",
        })),
      });
    }
    const references = this.referencesFor(configuration);
    if (references.length > 0) {
      result.push({ kind: "group", label: "References", icon: "references", children: references });
    }
    const incoming = this.incomingFor(configuration);
    if (incoming.length > 0) {
      result.push({
        kind: "group",
        label: "Referenced by",
        icon: "references",
        children: incoming,
      });
    }
    return result;
  }

  private referencesFor(configuration: WorkspaceSnapshotConfiguration): readonly ReferenceNode[] {
    const uris = new Set([
      ...configuration.documentUris,
      ...(configuration.baseUri === undefined ? [] : [configuration.baseUri]),
      ...configuration.dropInUris,
    ]);
    const targets = new Map<string, string>();
    for (const document of this.snapshot.documents) {
      if (!uris.has(document.uri)) continue;
      for (const reference of document.references) targets.set(reference.target, reference.kind);
    }
    return [...targets.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([target, kind]) => ({
        kind: "reference",
        target,
        description: kind,
        incoming: false,
        uri: indexedSourceUri(this.snapshot, target),
      }));
  }

  private incomingFor(configuration: WorkspaceSnapshotConfiguration): readonly ReferenceNode[] {
    const incoming = new Map<string, string>();
    for (const document of this.snapshot.documents) {
      const reference = document.references.find(({ target }) => target === configuration.identity);
      if (reference !== undefined) incoming.set(document.identity, reference.kind);
    }
    return [...incoming.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([target, kind]) => ({
        kind: "reference",
        target,
        description: kind,
        incoming: true,
        uri: indexedSourceUri(this.snapshot, target),
      }));
  }
}

function scopeItem(node: ScopeNode): vscode.TreeItem {
  const state = node.workspaceOwned
    ? vscode.TreeItemCollapsibleState.Expanded
    : vscode.TreeItemCollapsibleState.Collapsed;
  const item = new vscode.TreeItem(node.label, state);
  item.description = String(node.configurations.length);
  item.tooltip = node.workspaceOwned
    ? "Configurations in the current workspace"
    : "Read-only configurations indexed from this host";
  item.iconPath = new vscode.ThemeIcon(node.workspaceOwned ? "files" : "server");
  return item;
}

function categoryItem(node: CategoryNode): vscode.TreeItem {
  const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
  item.description = String(node.configurations.length);
  item.iconPath = new vscode.ThemeIcon("server-environment");
  return item;
}

function configurationItem(
  configuration: WorkspaceSnapshotConfiguration,
  tooltip: string,
): vscode.TreeItem {
  const item = new vscode.TreeItem(
    configuration.identity,
    vscode.TreeItemCollapsibleState.Collapsed,
  );
  item.description = configuration.masked ? "masked" : basename(configuration.sourceUri);
  item.tooltip = tooltip;
  item.contextValue =
    configuration.languageId === "systemd-unit" ? "systemdUnit" : "systemdConfiguration";
  item.resourceUri = vscode.Uri.parse(configuration.sourceUri);
  item.iconPath = new vscode.ThemeIcon(configuration.masked ? "circle-slash" : "symbol-file");
  item.command = {
    command: "vscode.open",
    title: "Open configuration",
    arguments: [vscode.Uri.parse(configuration.sourceUri)],
  };
  return item;
}

function groupItem(node: GroupNode): vscode.TreeItem {
  const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Collapsed);
  item.description = String(node.children.length);
  item.iconPath = new vscode.ThemeIcon(node.icon);
  return item;
}

function actionItem(node: ActionNode): vscode.TreeItem {
  const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
  item.iconPath = new vscode.ThemeIcon(node.icon);
  item.command = {
    command: node.command,
    title: node.label,
    arguments: [vscode.Uri.parse(node.argument)],
  };
  return item;
}

function fileItem(node: FileNode): vscode.TreeItem {
  const uri = vscode.Uri.parse(node.uri);
  const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
  if (node.description !== undefined) item.description = node.description;
  item.tooltip = node.uri;
  item.resourceUri = uri;
  item.iconPath = new vscode.ThemeIcon(node.icon);
  item.command = { command: "vscode.open", title: "Open file", arguments: [uri] };
  return item;
}

function referenceItem(node: ReferenceNode): vscode.TreeItem {
  const item = new vscode.TreeItem(node.target, vscode.TreeItemCollapsibleState.None);
  item.description = [node.description, node.uri === undefined ? "not indexed" : undefined]
    .filter((value): value is string => value !== undefined)
    .join(" · ");
  if (node.uri === undefined) {
    item.tooltip = node.target + " is referenced, but its source file is not indexed.";
    item.iconPath = new vscode.ThemeIcon("question");
    return item;
  }
  const uri = vscode.Uri.parse(node.uri);
  item.tooltip = node.uri;
  item.resourceUri = uri;
  item.iconPath = new vscode.ThemeIcon(node.incoming ? "arrow-left" : "arrow-right");
  item.command = { command: "vscode.open", title: "Open reference", arguments: [uri] };
  return item;
}

function categoryLabel(languageId: string): string {
  if (languageId === "systemd-unit") return "Units";
  if (languageId === "podman-quadlet") return "Quadlet resources";
  if (languageId === "mkosi") return "mkosi configurations";
  return "Other systemd files";
}

function categoryOrder(label: string): number {
  return ["Units", "Quadlet resources", "mkosi configurations", "Other systemd files"].indexOf(
    label,
  );
}

function basename(uri: string): string {
  const separator = uri.search(/[?#]/u);
  const path = separator < 0 ? uri : uri.slice(0, separator);
  const encoded = path.slice(path.lastIndexOf("/") + 1);
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n\0]+/gu, " ").slice(0, 500);
}

function isExplorerNode(value: unknown): value is ExplorerNode {
  if (typeof value !== "object" || value === null || !("kind" in value)) return false;
  const kind = Reflect.get(value, "kind");
  return ["scope", "category", "configuration", "group", "action", "file", "reference"].includes(
    String(kind),
  );
}

function isUri(value: unknown): value is vscode.Uri {
  return (
    typeof value === "object" &&
    value !== null &&
    "scheme" in value &&
    "path" in value &&
    "toString" in value &&
    typeof Reflect.get(value, "scheme") === "string" &&
    typeof Reflect.get(value, "path") === "string" &&
    typeof Reflect.get(value, "toString") === "function"
  );
}
