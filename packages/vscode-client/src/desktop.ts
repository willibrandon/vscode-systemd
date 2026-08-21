import * as vscode from "vscode";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import process from "node:process";
import { LanguageClient, TransportKind } from "vscode-languageclient/node";
import type { ServerOptions } from "vscode-languageclient/node";
import { detectedVersionsNotification } from "@systemd/language-server/protocol";
import { clientOptions, registerCommonFeatures, systemdLanguageIds } from "./common.js";
import type { ExternalIndexRoot, HostIndexingOptions } from "./indexer.js";
import { runValidator, validationInvocation } from "./external-validator.js";
import type { ValidationResult } from "./external-validator.js";
import { detectInstalledVersions } from "./target-versions.js";
import type { VersionProbe } from "./target-versions.js";

let client: LanguageClient | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel("systemd Language Server", { log: true });
  const detectedVersions = vscode.workspace.isTrusted
    ? await detectInstalledVersions(configuredVersionProbes())
    : {};
  for (const [ecosystem, version] of Object.entries(detectedVersions)) {
    output.info("Detected " + ecosystem + " " + version + " for automatic version targeting.");
  }
  const module = vscode.Uri.joinPath(context.extensionUri, "dist", "nodeServer.cjs").fsPath;
  const serverOptions: ServerOptions = { module, transport: TransportKind.ipc };
  client = new LanguageClient(
    "systemd",
    "systemd Language Server",
    serverOptions,
    clientOptions(output, { detectedVersions }),
  );
  const languageClient = client;
  context.subscriptions.push(output, languageClient);
  await languageClient.start();
  const features = registerCommonFeatures(
    context,
    { client: languageClient, output },
    hostIndexingOptions(),
  );
  const diagnostics = vscode.languages.createDiagnosticCollection("systemd-installed");
  const active = new Map<string, AbortController>();
  context.subscriptions.push(diagnostics, {
    dispose(): void {
      for (const controller of active.values()) controller.abort();
      active.clear();
    },
  });

  const clearInstalledValidation = (document: vscode.TextDocument): void => {
    const key = document.uri.toString();
    active.get(key)?.abort();
    active.delete(key);
    diagnostics.delete(document.uri);
  };

  const validate = async (
    document: vscode.TextDocument | undefined,
    explicit: boolean,
  ): Promise<void> => {
    const reason = validationUnavailable(document);
    if (reason !== undefined) {
      if (document !== undefined) clearInstalledValidation(document);
      if (explicit) await vscode.window.showInformationMessage(reason);
      return;
    }
    if (document === undefined) return;
    const configuration = vscode.workspace.getConfiguration("systemd", document.uri);
    const invocation = validationInvocation(document.languageId, document.uri.fsPath, {
      systemdAnalyze: configuration.get("externalValidation.systemdAnalyzePath", "systemd-analyze"),
      quadletGenerator: configuration.get(
        "externalValidation.quadletGeneratorPath",
        "/usr/libexec/podman/quadlet",
      ),
      mkosi: configuration.get("externalValidation.mkosiPath", "mkosi"),
    });
    if (invocation === undefined) {
      clearInstalledValidation(document);
      if (explicit) {
        await vscode.window.showInformationMessage(
          "This dialect has no safe installed validator; internal validation is already active.",
        );
      }
      return;
    }
    const key = document.uri.toString();
    active.get(key)?.abort();
    const controller = new AbortController();
    active.set(key, controller);
    try {
      output.info("Running " + invocation.label + " for " + document.uri.fsPath + ".");
      const result = await runValidator(
        invocation,
        controller.signal,
        () => vscode.workspace.isTrusted,
      );
      if (result.cancelled) return;
      diagnostics.set(document.uri, diagnosticsFromResult(document, result));
      if (explicit) {
        if (result.exitCode === 0 && !result.timedOut && !result.truncated) {
          await vscode.window.showInformationMessage(invocation.label + " completed successfully.");
        } else {
          await vscode.window.showWarningMessage(validationSummary(result));
        }
      }
    } catch (error) {
      diagnostics.delete(document.uri);
      if (explicit && !controller.signal.aborted) {
        await vscode.window.showErrorMessage("Installed validation failed: " + safeMessage(error));
      }
    } finally {
      if (active.get(key) === controller) active.delete(key);
    }
  };

  const updateContext = async (): Promise<void> => {
    await vscode.commands.executeCommand(
      "setContext",
      "systemd.externalValidationAvailable",
      validationUnavailable(vscode.window.activeTextEditor?.document) === undefined,
    );
  };
  const refreshDetectedVersions = async (): Promise<void> => {
    const versions = vscode.workspace.isTrusted
      ? await detectInstalledVersions(configuredVersionProbes())
      : {};
    await languageClient.sendNotification(detectedVersionsNotification, versions);
  };
  context.subscriptions.push(
    vscode.commands.registerCommand("systemd.validateWithInstalledTools", async (): Promise<void> =>
      validate(vscode.window.activeTextEditor?.document, true),
    ),
    vscode.workspace.onDidSaveTextDocument(async (document): Promise<void> => {
      await updateContext();
      const mode = vscode.workspace
        .getConfiguration("systemd", document.uri)
        .get<string>("externalValidation.mode", "off");
      if (mode === "onSave") await validate(document, false);
    }),
    vscode.workspace.onDidCloseTextDocument((document): void => {
      clearInstalledValidation(document);
    }),
    vscode.workspace.onDidChangeTextDocument(({ document }): void => {
      clearInstalledValidation(document);
      void updateContext();
    }),
    vscode.window.onDidChangeActiveTextEditor(updateContext),
    vscode.workspace.onDidGrantWorkspaceTrust((): void => {
      void Promise.all([updateContext(), refreshDetectedVersions()]);
    }),
    vscode.workspace.onDidChangeConfiguration((event): void => {
      if (
        event.affectsConfiguration("systemd.target") ||
        event.affectsConfiguration("systemd.externalValidation.systemdAnalyzePath") ||
        event.affectsConfiguration("systemd.externalValidation.mkosiPath")
      ) {
        void refreshDetectedVersions();
      }
      if (event.affectsConfiguration("systemd.externalValidation")) {
        for (const controller of active.values()) controller.abort();
        active.clear();
        diagnostics.clear();
        void updateContext();
      }
    }),
  );

  await features.refreshIndex();
  await updateContext();
  output.info("systemd language server started.");
}

function configuredVersionProbes(): readonly VersionProbe[] {
  const scopes = [undefined, ...(vscode.workspace.workspaceFolders?.map(({ uri }) => uri) ?? [])];
  const result: VersionProbe[] = [];
  for (const scope of scopes) {
    const configuration = vscode.workspace.getConfiguration("systemd", scope);
    if (configuration.get<string>("target.systemdVersion", "latest") === "auto") {
      result.push({
        ecosystem: "systemd",
        executable: configuration.get("externalValidation.systemdAnalyzePath", "systemd-analyze"),
      });
    }
    if (configuration.get<string>("target.podmanVersion", "latest") === "auto") {
      result.push({ ecosystem: "podman", executable: "podman" });
    }
    if (configuration.get<string>("target.mkosiVersion", "latest") === "auto") {
      result.push({
        ecosystem: "mkosi",
        executable: configuration.get("externalValidation.mkosiPath", "mkosi"),
      });
    }
  }
  return result;
}

export async function deactivate(): Promise<void> {
  await client?.stop();
  client = undefined;
}

function validationUnavailable(document: vscode.TextDocument | undefined): string | undefined {
  if (document === undefined) return "Open a recognized systemd configuration file first.";
  if (!vscode.workspace.isTrusted) return "Trust this workspace before running an installed tool.";
  if (document.uri.scheme !== "file") return "Installed validation requires a local file.";
  if (document.isUntitled || document.isDirty) return "Save the file before installed validation.";
  if (!systemdLanguageIds.includes(document.languageId as never)) {
    return "Open a recognized systemd configuration file first.";
  }
  return undefined;
}

function diagnosticsFromResult(
  document: vscode.TextDocument,
  result: ValidationResult,
): vscode.Diagnostic[] {
  if (result.exitCode === 0 && !result.timedOut && !result.truncated) return [];
  const output = (result.stderr + "\n" + result.stdout).trim();
  const lines = output
    .split(/\r\n|\n|\r/u)
    .filter(Boolean)
    .slice(0, 200);
  const diagnostics = lines.map((line): vscode.Diagnostic => {
    const location = /(?::|\[)(\d+)(?::(\d+))?(?:\]|:)/u.exec(line);
    const lineIndex = Math.max(0, Math.min(document.lineCount - 1, Number(location?.[1] ?? 1) - 1));
    const character = Math.max(0, Number(location?.[2] ?? 1) - 1);
    const diagnostic = new vscode.Diagnostic(
      new vscode.Range(lineIndex, character, lineIndex, character + 1),
      safeMessage(line),
      /warning/iu.test(line) ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error,
    );
    diagnostic.source = result.label;
    diagnostic.code = "HOST";
    return diagnostic;
  });
  if (diagnostics.length > 0) return diagnostics;
  const diagnostic = new vscode.Diagnostic(
    new vscode.Range(0, 0, 0, Math.max(1, document.lineAt(0).text.length)),
    validationSummary(result),
    vscode.DiagnosticSeverity.Warning,
  );
  diagnostic.source = result.label;
  diagnostic.code = "HOST";
  return [diagnostic];
}

function validationSummary(result: ValidationResult): string {
  if (result.timedOut) return result.label + " timed out.";
  if (result.truncated) return result.label + " exceeded the output limit.";
  const output = (result.stderr + "\n" + result.stdout).trim();
  return output === ""
    ? result.label + " exited with code " + String(result.exitCode ?? "unknown") + "."
    : safeMessage(output.split(/\r\n|\n|\r/u)[0] ?? output);
}

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n\0]+/gu, " ").slice(0, 500);
}

function hostIndexingOptions(): HostIndexingOptions {
  const roots: ExternalIndexRoot[] = [];
  const add = (path: string, maximumDepth: number): void => {
    roots.push({ uri: vscode.Uri.file(path), maximumDepth });
  };
  for (const root of [
    "/etc/systemd",
    "/run/systemd",
    "/usr/local/lib/systemd",
    "/usr/local/share/systemd",
    "/usr/lib/systemd",
    "/usr/share/systemd",
    "/lib/systemd",
  ]) {
    add(root, 3);
  }
  for (const prefix of ["/etc", "/run", "/usr/local/lib", "/usr/lib", "/lib"]) {
    for (const directory of [
      "tmpfiles.d",
      "sysusers.d",
      "sysctl.d",
      "modules-load.d",
      "binfmt.d",
      "udev/rules.d",
      "udev/hwdb.d",
    ]) {
      add(join(prefix, directory), 1);
    }
  }
  for (const root of [
    "/etc/containers/systemd",
    "/run/containers/systemd",
    "/usr/share/containers/systemd",
    "/etc/kernel",
    "/usr/lib/kernel",
  ]) {
    add(root, 4);
  }
  const configHome = process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config");
  add(join(configHome, "systemd/user"), 4);
  add(join(configHome, "containers/systemd"), 4);
  const runtimeDirectory = process.env["XDG_RUNTIME_DIR"];
  if (runtimeDirectory !== undefined && isAbsolute(runtimeDirectory)) {
    add(join(runtimeDirectory, "systemd/user"), 4);
    add(join(runtimeDirectory, "containers/systemd"), 4);
  }
  const unique = new Map(roots.map((root) => [root.uri.toString(), root]));
  return {
    supported: process.platform === "linux",
    standardRoots: [...unique.values()],
    resolveExtraPath(path): vscode.Uri | undefined {
      return isAbsolute(path) ? vscode.Uri.file(path) : undefined;
    },
    async canonicalUri(uri): Promise<vscode.Uri | undefined> {
      if (uri.scheme !== "file") return undefined;
      try {
        const canonical = await realpath(uri.fsPath);
        return canonical === uri.fsPath ? undefined : vscode.Uri.file(canonical);
      } catch {
        return undefined;
      }
    },
  };
}
