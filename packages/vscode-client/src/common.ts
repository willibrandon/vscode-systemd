import * as vscode from "vscode";
import type { BaseLanguageClient, LanguageClientOptions } from "vscode-languageclient";
import type { DialectId } from "@systemd/language-core";
import {
  detectDialectRequest,
  indexedDocumentsNotification,
  refreshDiagnosticsNotification,
} from "@systemd/language-server/protocol";
import { registerSystemdExplorer } from "./explorer.js";
import type { DropInTarget } from "./explorer.js";
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

export function clientOptions(output: vscode.LogOutputChannel): LanguageClientOptions {
  return {
    documentSelector: systemdLanguageIds.map((language) => ({ language })),
    outputChannel: output,
    markdown: { isTrusted: false },
    synchronize: { configurationSection: "systemd" },
  };
}

export function registerCommonFeatures(
  context: vscode.ExtensionContext,
  runtime: ClientRuntime,
): { readonly refreshIndex: () => Promise<void> } {
  const explorer = registerSystemdExplorer(context, runtime.client, runtime.output);
  const virtualDocuments = registerVirtualDocuments(context, runtime.client);
  const indexWorkspace = createWorkspaceIndexer(runtime);
  const refreshIndex = async (): Promise<void> => {
    await indexWorkspace();
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
      "systemd.openExplorerReference",
      async (target: string): Promise<void> => explorer.openReference(target),
    ),
    vscode.commands.registerCommand(
      "systemd.createDropIn",
      async (selected?: unknown): Promise<void> => createDropIn(explorer.dropInTargetFor(selected)),
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

  const watcher = vscode.workspace.createFileSystemWatcher(systemdWorkspaceGlob());
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleRefresh = (): void => {
    if (refreshTimer !== undefined) clearTimeout(refreshTimer);
    refreshTimer = setTimeout((): void => {
      refreshTimer = undefined;
      void refreshIndex();
    }, 300);
  };
  watcher.onDidCreate(scheduleRefresh);
  watcher.onDidChange(scheduleRefresh);
  watcher.onDidDelete(scheduleRefresh);
  let virtualRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleVirtualRefresh = (): void => {
    if (virtualRefreshTimer !== undefined) clearTimeout(virtualRefreshTimer);
    virtualRefreshTimer = setTimeout((): void => {
      virtualRefreshTimer = undefined;
      void Promise.all([explorer.refresh(), virtualDocuments.refreshEffectiveDocuments()]);
    }, 150);
  };
  context.subscriptions.push(
    watcher,
    {
      dispose(): void {
        if (refreshTimer !== undefined) clearTimeout(refreshTimer);
        if (virtualRefreshTimer !== undefined) clearTimeout(virtualRefreshTimer);
      },
    },
    vscode.workspace.onDidChangeTextDocument(scheduleVirtualRefresh),
  );
  return { refreshIndex };
}

function createWorkspaceIndexer(runtime: ClientRuntime): () => Promise<void> {
  return async (): Promise<void> => {
    const uris = await vscode.workspace.findFiles(
      systemdWorkspaceGlob(),
      "**/{.git,node_modules,dist,out,coverage}/**",
      20_000,
    );
    const documents = [];
    for (const uri of uris) {
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        if (bytes.byteLength > 2 * 1024 * 1024) continue;
        const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        const open = vscode.workspace.textDocuments.find(
          (candidate) => candidate.uri.toString() === uri.toString(),
        );
        const associated = open?.languageId;
        const languageId = systemdLanguageIds.includes(associated as DialectId)
          ? (associated as DialectId)
          : await runtime.client.sendRequest(detectDialectRequest, {
              uri: uri.toString(),
              source,
            });
        if (languageId === null) continue;
        const stat = await vscode.workspace.fs.stat(uri);
        documents.push({ uri: uri.toString(), languageId, source, mtime: stat.mtime });
      } catch (error) {
        runtime.output.warn("Unable to index " + uri.toString() + ": " + safeMessage(error));
      }
    }
    await runtime.client.sendNotification(indexedDocumentsNotification, {
      documents,
      replace: true,
    });
    runtime.output.info("Indexed " + String(documents.length) + " systemd configuration files.");
  };
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

function systemdWorkspaceGlob(): string {
  return (
    "**/{*.service,*.socket,*.timer,*.path,*.mount,*.automount,*.swap,*.target," +
    "*.device,*.slice,*.scope,*.network,*.netdev,*.link,*.nspawn,*.dnssd," +
    "*.dns-delegate,*.container,*.volume,*.pod,*.kube,*.image,*.build,*.artifact," +
    "*.rules,*.hwdb,*.preset,*.pcrlock,*.rr,mkosi.conf,mkosi.conf.d/*.conf," +
    "mkosi.default.d/*.conf,mkosi.extra.d/*.conf,*.positive,*.negative," +
    "fstab,crypttab,veritytab,integritytab,clonetab,loader.conf,install.conf," +
    "os-release,initrd-release,machine-info,locale.conf,vconsole.conf}"
  );
}

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n\0]+/gu, " ").slice(0, 500);
}
