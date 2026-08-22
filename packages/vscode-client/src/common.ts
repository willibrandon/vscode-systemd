import * as vscode from "vscode";
import type { BaseLanguageClient, LanguageClientOptions } from "vscode-languageclient";
import type { DialectId } from "@systemd/language-core";
import {
  dataChannelNotification,
  readDirectoryRequest,
  readFileRequest,
  refreshDiagnosticsNotification,
  statRequest,
} from "@systemd/language-server/protocol";
import { registerSystemdExplorer } from "./explorer.js";
import type { DropInTarget } from "./explorer.js";
import { exactDialectAssociationPattern, withDialectAssociation } from "./dialect-associations.js";
import { createWorkspaceIndexer, registerLanguageDetection } from "./indexer.js";
import type { HostIndexingOptions } from "./indexer.js";
import { registerVirtualDocuments } from "./virtual-documents.js";

export const systemdLanguageIds: readonly DialectId[] = [
  "systemd-unit",
  "systemd-network",
  "systemd-config",
  "systemd-tmpfiles",
  "systemd-sysusers",
  "systemd-udev-rules",
  "systemd-hwdb",
  "systemd-environment",
  "systemd-sysctl",
  "systemd-modules-load",
  "systemd-binfmt",
  "systemd-preset",
  "systemd-table",
  "systemd-boot",
  "systemd-dns-trust-anchor",
  "systemd-json",
  "podman-quadlet",
  "mkosi",
];

export interface ClientRuntime {
  readonly client: BaseLanguageClient;
  readonly output: vscode.LogOutputChannel;
}

export interface ClientInitializationOptions {
  readonly dataChannel?: "stable" | "preview";
  readonly workspaceRoots?: readonly string[];
  readonly detectedVersions?: Readonly<{
    readonly systemd?: string;
    readonly podman?: string;
    readonly mkosi?: string;
  }>;
}

export function clientOptions(
  output: vscode.LogOutputChannel,
  initializationOptions: ClientInitializationOptions = {},
): LanguageClientOptions {
  const dataChannel = vscode.workspace
    .getConfiguration("systemd")
    .get<"stable" | "preview">("dataChannel", "stable");
  const workspaceRoots = vscode.workspace.workspaceFolders?.map(({ uri }) => uri.toString()) ?? [];
  return {
    documentSelector: systemdLanguageIds.map((language) => ({ language })),
    outputChannel: output,
    markdown: { isTrusted: false },
    initializationOptions: { dataChannel, workspaceRoots, ...initializationOptions },
    synchronize: { configurationSection: "systemd" },
    middleware: {
      handleDiagnostics(uri, diagnostics, next): void {
        const supportedDocument = vscode.workspace.textDocuments.some(
          (document) =>
            document.uri.toString() === uri.toString() &&
            systemdLanguageIds.includes(document.languageId as DialectId),
        );
        next(uri, supportedDocument ? diagnostics : []);
      },
    },
  };
}

export function registerCommonFeatures(
  context: vscode.ExtensionContext,
  runtime: ClientRuntime,
  hostIndexing?: HostIndexingOptions,
): { readonly refreshIndex: () => Promise<void> } {
  registerWorkspaceFileSystemBridge(context, runtime.client);
  const explorer = registerSystemdExplorer(context, runtime.client, runtime.output);
  const virtualDocuments = registerVirtualDocuments(context, runtime.client);
  const indexer = createWorkspaceIndexer(
    runtime.client,
    runtime.output,
    systemdLanguageIds,
    hostIndexing,
  );
  registerLanguageDetection(context, runtime.client, systemdLanguageIds);
  context.subscriptions.push(indexer);
  const refreshIndex = async (changedUris: readonly vscode.Uri[] = []): Promise<void> => {
    if (!(await indexer.refresh(changedUris))) return;
    await explorer.refresh();
    await virtualDocuments.refreshEffectiveDocuments();
  };
  context.subscriptions.push(
    vscode.commands.registerCommand("systemd.restartLanguageServer", async (): Promise<void> => {
      runtime.output.info("Restarting systemd language server.");
      await runtime.client.stop();
      await runtime.client.start();
      await refreshIndex();
      runtime.output.info("systemd language server restarted.");
    }),
    vscode.commands.registerCommand("systemd.showLanguageServerOutput", (): void => {
      runtime.output.show(true);
    }),
    vscode.commands.registerCommand("systemd.refreshIndex", async (): Promise<void> => {
      await refreshIndex();
      await vscode.window.showInformationMessage("systemd workspace index refreshed.");
    }),
    vscode.commands.registerCommand(
      "systemd.showEffectiveConfiguration",
      async (selected?: unknown): Promise<void> => {
        const source = explorer.sourceFor(selected) ?? activeSystemdUri(virtualDocuments);
        if (source === undefined) return;
        await virtualDocuments.showEffective(source);
      },
    ),
    vscode.commands.registerCommand(
      "systemd.showDependencyGraph",
      async (selected?: unknown): Promise<void> => {
        const source = explorer.sourceFor(selected) ?? activeSystemdUri(virtualDocuments, false);
        await virtualDocuments.showDependencyGraph(source);
      },
    ),
    vscode.commands.registerCommand(
      "systemd.createDropIn",
      async (selected?: unknown): Promise<void> => createDropIn(explorer.dropInTargetFor(selected)),
    ),
    vscode.commands.registerCommand(
      "systemd.createReferencedFile",
      async (candidate: unknown): Promise<void> => createReferencedFile(candidate),
    ),
    vscode.commands.registerCommand("systemd.selectDialect", async (): Promise<void> => {
      const document = vscode.window.activeTextEditor?.document;
      if (document === undefined) {
        await vscode.window.showInformationMessage("Open a configuration file first.");
        return;
      }
      const selection = await vscode.window.showQuickPick(
        systemdLanguageIds.map((id) => ({ label: id, id })),
        { title: "Select the configuration dialect" },
      );
      if (selection === undefined) return;
      await persistDialectAssociation(document, selection.id);
      const updated = await vscode.languages.setTextDocumentLanguage(document, selection.id);
      await runtime.client.sendNotification(refreshDiagnosticsNotification, {
        uri: updated.uri.toString(),
      });
    }),
    vscode.commands.registerCommand("systemd.openDocumentation", async (): Promise<void> => {
      await vscode.env.openExternal(
        documentationUri(vscode.window.activeTextEditor?.document.languageId),
      );
    }),
  );

  let watcher: vscode.FileSystemWatcher | undefined;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  const pendingIndexUris = new Map<string, vscode.Uri>();
  const scheduleRefresh = (uri?: vscode.Uri): void => {
    if (uri !== undefined) {
      if (!indexer.isCandidate(uri)) return;
      pendingIndexUris.set(uri.toString(), uri);
    }
    if (refreshTimer !== undefined) clearTimeout(refreshTimer);
    refreshTimer = setTimeout((): void => {
      refreshTimer = undefined;
      const changedUris = [...pendingIndexUris.values()];
      pendingIndexUris.clear();
      void refreshIndex(changedUris);
    }, 300);
  };
  const createWatcher = (): void => {
    watcher?.dispose();
    const current = vscode.workspace.createFileSystemWatcher("**/*");
    current.onDidCreate(scheduleRefresh);
    current.onDidChange(scheduleRefresh);
    current.onDidDelete(scheduleRefresh);
    watcher = current;
  };
  createWatcher();
  let virtualRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleVirtualRefresh = (): void => {
    if (virtualRefreshTimer !== undefined) clearTimeout(virtualRefreshTimer);
    virtualRefreshTimer = setTimeout((): void => {
      virtualRefreshTimer = undefined;
      void Promise.all([explorer.refresh(), virtualDocuments.refreshEffectiveDocuments()]);
    }, 150);
  };
  context.subscriptions.push(
    {
      dispose(): void {
        watcher?.dispose();
        watcher = undefined;
        pendingIndexUris.clear();
        if (refreshTimer !== undefined) clearTimeout(refreshTimer);
        if (virtualRefreshTimer !== undefined) clearTimeout(virtualRefreshTimer);
      },
    },
    vscode.workspace.onDidCreateFiles(({ files }): void => {
      for (const uri of files) scheduleRefresh(uri);
    }),
    vscode.workspace.onDidSaveTextDocument((document): void => {
      scheduleRefresh(document.uri);
    }),
    vscode.workspace.onDidRenameFiles(({ files }): void => {
      for (const { oldUri, newUri } of files) {
        scheduleRefresh(oldUri);
        scheduleRefresh(newUri);
      }
    }),
    vscode.workspace.onDidDeleteFiles(({ files }): void => {
      for (const uri of files) scheduleRefresh(uri);
    }),
    vscode.workspace.onDidCloseTextDocument((document): void => {
      const uri = document.uri;
      setTimeout((): void => {
        const stillSupported = vscode.workspace.textDocuments.some(
          (candidate) =>
            candidate.uri.toString() === uri.toString() &&
            systemdLanguageIds.includes(candidate.languageId as DialectId),
        );
        if (!stillSupported) runtime.client.diagnostics?.delete(uri);
      }, 0);
    }),
    vscode.workspace.onDidChangeWorkspaceFolders((): void => {
      createWatcher();
      scheduleRefresh();
    }),
    vscode.workspace.onDidChangeTextDocument(scheduleVirtualRefresh),
    vscode.workspace.onDidSaveTextDocument(scheduleVirtualRefresh),
    vscode.workspace.onDidChangeConfiguration((event): void => {
      if (event.affectsConfiguration("systemd.dataChannel")) {
        const channel = vscode.workspace
          .getConfiguration("systemd")
          .get<"stable" | "preview">("dataChannel", "stable");
        void (async (): Promise<void> => {
          await runtime.client.sendNotification(dataChannelNotification, { channel });
          await refreshIndex();
        })();
      }
      if (
        event.affectsConfiguration("systemd.index") ||
        event.affectsConfiguration("systemd.dialectAssociations") ||
        event.affectsConfiguration("systemd.templateSuffixes")
      ) {
        createWatcher();
        scheduleRefresh();
      }
    }),
  );
  return { refreshIndex };
}

function registerWorkspaceFileSystemBridge(
  context: vscode.ExtensionContext,
  client: BaseLanguageClient,
): void {
  const workspaceUri = (value: string): vscode.Uri => {
    const uri = vscode.Uri.parse(value, true);
    if (vscode.workspace.getWorkspaceFolder(uri) === undefined) {
      throw new Error("Filesystem requests are restricted to workspace-owned paths.");
    }
    return uri;
  };
  const fileType = (type: vscode.FileType): "file" | "directory" | "other" =>
    (type & vscode.FileType.Directory) !== 0
      ? "directory"
      : (type & vscode.FileType.File) !== 0
        ? "file"
        : "other";
  context.subscriptions.push(
    client.onRequest(readDirectoryRequest, async ({ uri }) => {
      const entries = await vscode.workspace.fs.readDirectory(workspaceUri(uri));
      return entries
        .slice(0, 500)
        .map(([name, type]) => ({ name, type: fileType(type) }))
        .sort((left, right) => left.name.localeCompare(right.name));
    }),
    client.onRequest(readFileRequest, async ({ uri }) => {
      const target = workspaceUri(uri);
      const metadata = await vscode.workspace.fs.stat(target);
      if (metadata.size > 2 * 1024 * 1024) {
        throw new Error("Filesystem reads are limited to 2 MiB.");
      }
      return new TextDecoder().decode(await vscode.workspace.fs.readFile(target));
    }),
    client.onRequest(statRequest, async ({ uri }) => {
      const metadata = await vscode.workspace.fs.stat(workspaceUri(uri));
      return { type: fileType(metadata.type), size: metadata.size, mtime: metadata.mtime };
    }),
  );
}

async function persistDialectAssociation(
  document: vscode.TextDocument,
  dialect: DialectId,
): Promise<void> {
  if (document.isUntitled) return;
  const folder = vscode.workspace.getWorkspaceFolder(document.uri);
  const configuration = vscode.workspace.getConfiguration("systemd", document.uri);
  const target =
    folder !== undefined
      ? vscode.ConfigurationTarget.WorkspaceFolder
      : vscode.workspace.workspaceFile !== undefined
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
  const inspection = configuration.inspect<Readonly<Record<string, string>>>("dialectAssociations");
  const current =
    target === vscode.ConfigurationTarget.WorkspaceFolder
      ? inspection?.workspaceFolderValue
      : target === vscode.ConfigurationTarget.Workspace
        ? inspection?.workspaceValue
        : inspection?.globalValue;
  const pattern = exactDialectAssociationPattern(document.uri.path, folder?.uri.path);
  await configuration.update(
    "dialectAssociations",
    withDialectAssociation(current, pattern, dialect),
    target,
  );
}

function activeSystemdDocument(showMessage = true): vscode.TextDocument | undefined {
  const document = vscode.window.activeTextEditor?.document;
  if (document === undefined || !systemdLanguageIds.includes(document.languageId as DialectId)) {
    if (showMessage) {
      void vscode.window.showInformationMessage(
        "Open a recognized systemd configuration file first.",
      );
    }
    return undefined;
  }
  return document;
}

function activeSystemdUri(
  virtualDocuments: ReturnType<typeof registerVirtualDocuments>,
  showMessage = true,
): vscode.Uri | undefined {
  const active = vscode.window.activeTextEditor?.document;
  if (active !== undefined) {
    const source = virtualDocuments.sourceFor(active.uri);
    if (source !== undefined) return source;
  }
  return activeSystemdDocument(showMessage)?.uri;
}

async function createDropIn(selected?: DropInTarget): Promise<void> {
  const document = selected === undefined ? activeSystemdDocument() : undefined;
  const source = selected?.source ?? document?.uri;
  const identity = selected?.identity ?? basename(source?.path ?? "");
  if (source === undefined) return;
  const languageId =
    document?.languageId ?? (await vscode.workspace.openTextDocument(source)).languageId;
  if (source.scheme !== "file" || languageId !== "systemd-unit") {
    await vscode.window.showInformationMessage("Drop-ins require a saved local systemd unit file.");
    return;
  }
  if (vscode.workspace.getWorkspaceFolder(source) === undefined) {
    await vscode.window.showInformationMessage(
      "Drop-ins are only created for workspace-owned unit files. Host unit paths remain read-only.",
    );
    return;
  }
  const directory = vscode.Uri.joinPath(source, "..", identity + ".d");
  const target = vscode.Uri.joinPath(directory, "override.conf");
  try {
    await vscode.workspace.fs.createDirectory(directory);
    try {
      await vscode.workspace.fs.stat(target);
    } catch {
      await vscode.workspace.fs.writeFile(
        target,
        new TextEncoder().encode("[" + defaultDropInSection(identity) + "]\n"),
      );
    }
    const dropIn = await vscode.workspace.openTextDocument(target);
    await vscode.window.showTextDocument(dropIn, { preview: false });
  } catch (error) {
    await vscode.window.showErrorMessage("Unable to create drop-in: " + safeMessage(error));
  }
}

interface ReferencedFileCreation {
  readonly sourceUri: string;
  readonly targetUri: string;
  readonly languageId: DialectId;
  readonly contents: string;
  readonly label: string;
}

async function createReferencedFile(candidate: unknown): Promise<void> {
  const creation = referencedFileCreation(candidate);
  if (creation === undefined) {
    await vscode.window.showErrorMessage("The referenced-file action was not valid.");
    return;
  }
  const source = vscode.Uri.parse(creation.sourceUri, true);
  const target = vscode.Uri.parse(creation.targetUri, true);
  const sourceFolder = vscode.workspace.getWorkspaceFolder(source);
  const targetFolder = vscode.workspace.getWorkspaceFolder(target);
  if (
    sourceFolder === undefined ||
    targetFolder?.uri.toString() !== sourceFolder.uri.toString() ||
    source.scheme !== target.scheme ||
    target.query !== "" ||
    target.fragment !== ""
  ) {
    await vscode.window.showErrorMessage(
      "Referenced files can only be created inside the source workspace folder.",
    );
    return;
  }
  try {
    let exists = false;
    try {
      const metadata = await vscode.workspace.fs.stat(target);
      if ((metadata.type & vscode.FileType.Directory) !== 0) {
        throw new Error("The referenced target is an existing directory.");
      }
      exists = true;
    } catch (error) {
      if (!isFileNotFound(error)) throw error;
    }
    if (!exists) {
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(target, ".."));
      await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(creation.contents));
    }
    const opened = await vscode.workspace.openTextDocument(target);
    const document =
      opened.languageId === creation.languageId
        ? opened
        : await vscode.languages.setTextDocumentLanguage(opened, creation.languageId);
    await vscode.window.showTextDocument(document, { preview: false });
  } catch (error) {
    await vscode.window.showErrorMessage(
      "Unable to create " + creation.label + ": " + safeMessage(error),
    );
  }
}

function referencedFileCreation(candidate: unknown): ReferencedFileCreation | undefined {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    return undefined;
  }
  const value = candidate as Readonly<Record<string, unknown>>;
  if (
    typeof value["sourceUri"] !== "string" ||
    typeof value["targetUri"] !== "string" ||
    typeof value["languageId"] !== "string" ||
    !systemdLanguageIds.includes(value["languageId"] as DialectId) ||
    typeof value["contents"] !== "string" ||
    value["contents"].length > 4096 ||
    typeof value["label"] !== "string" ||
    value["label"].length > 255
  ) {
    return undefined;
  }
  return {
    sourceUri: value["sourceUri"],
    targetUri: value["targetUri"],
    languageId: value["languageId"] as DialectId,
    contents: value["contents"],
    label: value["label"],
  };
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof vscode.FileSystemError && error.code === "FileNotFound";
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function defaultDropInSection(path: string): string {
  const suffix = /\.(service|socket|timer|path|mount|automount|swap)$/u.exec(path)?.[1];
  return suffix === undefined ? "Unit" : (suffix[0]?.toUpperCase() ?? "") + suffix.slice(1);
}

function documentationUri(languageId: string | undefined): vscode.Uri {
  if (languageId === "podman-quadlet") {
    return vscode.Uri.parse("https://docs.podman.io/en/latest/markdown/podman-systemd.unit.5.html");
  }
  if (languageId === "mkosi") {
    return vscode.Uri.parse("https://www.freedesktop.org/software/mkosi/man/mkosi.html");
  }
  return vscode.Uri.parse(
    "https://www.freedesktop.org/software/systemd/man/latest/systemd.directives.html",
  );
}

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n\0]+/gu, " ").slice(0, 500);
}
