import * as vscode from "vscode";
import type { BaseLanguageClient } from "vscode-languageclient";
import { minimatch } from "minimatch";
import { extractReferences, mkosiIncludePath, parse } from "@systemd/language-core";
import type { DialectId } from "@systemd/language-core";
import {
  detectDialectRequest,
  indexedDocumentsNotification,
} from "@systemd/language-server/protocol";
import type { IndexedDocument } from "@systemd/language-server/protocol";
import { configurationWorkspaceGlobs } from "./index-patterns.js";

const maximumFiles = 20_000;
const maximumFileBytes = 2 * 1024 * 1024;
const defaultTemplateSuffixes = [
  ".in",
  ".erb",
  ".j2",
  ".jinja",
  ".tmpl",
  ".template",
  ".backup",
  ".ignore",
];

export interface ExternalIndexRoot {
  readonly uri: vscode.Uri;
  readonly maximumDepth: number;
}

export interface HostIndexingOptions {
  readonly supported: boolean;
  readonly standardRoots: readonly ExternalIndexRoot[];
  resolveExtraPath(path: string): vscode.Uri | undefined;
  canonicalUri(uri: vscode.Uri): Promise<vscode.Uri | undefined>;
}

export interface WorkspaceIndexer extends vscode.Disposable {
  refresh(changedUris?: readonly vscode.Uri[]): Promise<boolean>;
  workspaceGlobs(): readonly string[];
  isCandidate(uri: vscode.Uri): boolean;
}

export function createWorkspaceIndexer(
  client: BaseLanguageClient,
  output: vscode.LogOutputChannel,
  languageIds: readonly DialectId[],
  host: HostIndexingOptions | undefined,
): WorkspaceIndexer {
  return new SystemdWorkspaceIndexer(client, output, new Set(languageIds), host);
}

export function registerLanguageDetection(
  context: vscode.ExtensionContext,
  client: BaseLanguageClient,
  languageIds: readonly DialectId[],
): void {
  const supported = new Set(languageIds);
  const generations = new Map<string, number>();
  const detect = async (document: vscode.TextDocument): Promise<void> => {
    if (document.languageId !== "plaintext" || document.getText().length > maximumFileBytes) return;
    const key = document.uri.toString();
    const current = (generations.get(key) ?? 0) + 1;
    generations.set(key, current);
    const configuration = configurationFor(document.uri, supported);
    const associated = configuredDialect(document.uri, configuration.associations);
    if (
      associated === undefined &&
      !potentialConfiguration(document.uri.path, configuration.suffixes)
    ) {
      return;
    }
    const dialect =
      associated ??
      (await client.sendRequest(detectDialectRequest, {
        uri: detectionUri(document.uri, configuration.suffixes).toString(),
        source: document.getText(),
      }));
    if (
      dialect !== null &&
      current === generations.get(key) &&
      vscode.workspace.textDocuments.includes(document) &&
      isPlainText(document)
    ) {
      await vscode.languages.setTextDocumentLanguage(document, dialect);
    }
  };
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((document): void => {
      void detect(document);
    }),
    vscode.workspace.onDidChangeConfiguration((event): void => {
      if (
        !event.affectsConfiguration("systemd.dialectAssociations") &&
        !event.affectsConfiguration("systemd.templateSuffixes")
      ) {
        return;
      }
      for (const document of vscode.workspace.textDocuments) void detect(document);
    }),
  );
  for (const document of vscode.workspace.textDocuments) void detect(document);
}

class SystemdWorkspaceIndexer implements WorkspaceIndexer {
  private active: AbortController | undefined;
  private disposed = false;
  private readonly client: BaseLanguageClient;
  private readonly output: vscode.LogOutputChannel;
  private readonly languageIds: ReadonlySet<DialectId>;
  private readonly host: HostIndexingOptions | undefined;

  public constructor(
    client: BaseLanguageClient,
    output: vscode.LogOutputChannel,
    languageIds: ReadonlySet<DialectId>,
    host: HostIndexingOptions | undefined,
  ) {
    this.client = client;
    this.output = output;
    this.languageIds = languageIds;
    this.host = host;
  }

  public workspaceGlobs(): readonly string[] {
    return [
      ...configurationWorkspaceGlobs(configuredSuffixes()),
      ...configuredAssociationPatterns(this.languageIds),
    ];
  }

  public isCandidate(uri: vscode.Uri): boolean {
    const configuration = configurationFor(uri, this.languageIds);
    return (
      configuredDialect(uri, configuration.associations) !== undefined ||
      potentialConfiguration(uri.path, configuration.suffixes)
    );
  }

  public async refresh(changedUris: readonly vscode.Uri[] = []): Promise<boolean> {
    this.active?.abort();
    const controller = new AbortController();
    this.active = controller;
    const exclude = "**/{.git,node_modules,dist,out,coverage}/**";
    const workspaceGroups = await Promise.all(
      this.workspaceGlobs().map(async (pattern) => {
        try {
          return await vscode.workspace.findFiles(pattern, exclude, maximumFiles);
        } catch (error) {
          this.output.warn("Unable to use index glob " + pattern + ": " + safeMessage(error));
          return [];
        }
      }),
    );
    const workspaceUris = [
      ...new Map(
        [
          ...workspaceGroups.flat(),
          ...changedUris.filter(
            (uri) =>
              vscode.workspace.getWorkspaceFolder(uri) !== undefined && this.isCandidate(uri),
          ),
        ].map((uri) => [uri.toString(), uri]),
      ).values(),
    ].slice(0, maximumFiles);
    if (this.isCancelled(controller)) return false;
    const externalUris = await this.externalUris(controller.signal);
    if (this.isCancelled(controller)) return false;
    const uris = [
      ...new Map([...workspaceUris, ...externalUris].map((uri) => [uri.toString(), uri])).values(),
    ].slice(0, maximumFiles);
    const initiallyIndexed = await this.indexDocuments(uris, controller.signal);
    const documents = await this.expandMkosiIncludes(initiallyIndexed, controller.signal);
    if (this.isCancelled(controller)) return false;
    await this.client.sendNotification(indexedDocumentsNotification, {
      documents,
      replace: true,
    });
    if (this.isCancelled(controller)) return false;
    this.output.info(
      "Indexed " +
        String(documents.length) +
        " systemd configuration files (" +
        String(workspaceUris.length) +
        " workspace candidates, " +
        String(externalUris.length) +
        " host candidates).",
    );
    return true;
  }

  public dispose(): void {
    this.disposed = true;
    this.active?.abort();
    this.active = undefined;
  }

  private isCancelled(controller: AbortController): boolean {
    return controller.signal.aborted || this.disposed || this.active !== controller;
  }

  private async externalUris(signal: AbortSignal): Promise<readonly vscode.Uri[]> {
    if (!this.hostIndexingEnabled()) return [];
    const settings = vscode.workspace.getConfiguration("systemd");
    const extras = settings.get<readonly string[]>("index.extraPaths", []);
    const extraRoots = extras.flatMap((path): ExternalIndexRoot[] => {
      const uri = this.host?.resolveExtraPath(path);
      return uri === undefined ? [] : [{ uri, maximumDepth: 12 }];
    });
    const roots = [...(this.host?.standardRoots ?? []), ...extraRoots];
    const result: vscode.Uri[] = [];
    const seen = new Set<string>();
    const suffixes = configuredSuffixes();
    for (const root of roots) {
      if (signal.aborted || result.length >= maximumFiles) break;
      await this.collectRoot(root, result, seen, suffixes, signal);
    }
    return result;
  }

  private hostIndexingEnabled(): boolean {
    if (this.host?.supported !== true || !vscode.workspace.isTrusted) return false;
    if (
      vscode.workspace
        .getConfiguration("systemd")
        .get<string>("index.scope", "workspaceAndHost") !== "workspaceAndHost"
    ) {
      return false;
    }
    return (vscode.workspace.workspaceFolders ?? []).every(({ uri }) => uri.scheme === "file");
  }

  private async collectRoot(
    root: ExternalIndexRoot,
    result: vscode.Uri[],
    seen: Set<string>,
    suffixes: readonly string[],
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const stat = await vscode.workspace.fs.stat(root.uri);
      if ((stat.type & vscode.FileType.Directory) === 0) {
        if (!seen.has(root.uri.toString())) {
          seen.add(root.uri.toString());
          result.push(root.uri);
        }
        return;
      }
    } catch {
      return;
    }
    const pending: { uri: vscode.Uri; depth: number }[] = [{ uri: root.uri, depth: 0 }];
    while (pending.length > 0 && !signal.aborted && result.length < maximumFiles) {
      const directory = pending.shift();
      if (directory === undefined) break;
      let entries: readonly [string, vscode.FileType][];
      try {
        entries = await vscode.workspace.fs.readDirectory(directory.uri);
      } catch {
        continue;
      }
      entries = [...entries].sort(([left], [right]) => left.localeCompare(right));
      for (const [name, type] of entries) {
        if (isAborted(signal) || result.length >= maximumFiles) break;
        if (name === "inaccessible" || name === "propagate") continue;
        const uri = vscode.Uri.joinPath(directory.uri, name);
        const symbolic = (type & vscode.FileType.SymbolicLink) !== 0;
        if ((type & vscode.FileType.Directory) !== 0 && !symbolic) {
          if (directory.depth < root.maximumDepth) {
            pending.push({ uri, depth: directory.depth + 1 });
          }
        } else if (
          ((type & vscode.FileType.File) !== 0 || symbolic) &&
          potentialConfiguration(uri.path, suffixes) &&
          !seen.has(uri.toString())
        ) {
          seen.add(uri.toString());
          result.push(uri);
        }
      }
    }
  }

  private async indexDocuments(
    uris: readonly vscode.Uri[],
    signal: AbortSignal,
  ): Promise<readonly IndexedDocument[]> {
    const result: IndexedDocument[] = [];
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (!signal.aborted) {
        const index = cursor;
        cursor += 1;
        const uri = uris[index];
        if (uri === undefined) return;
        const document = await this.indexDocument(uri, signal);
        if (document !== undefined) result.push(document);
      }
    };
    await Promise.all(Array.from({ length: Math.min(16, uris.length) }, worker));
    return result.sort((left, right) => left.uri.localeCompare(right.uri));
  }

  private async expandMkosiIncludes(
    initiallyIndexed: readonly IndexedDocument[],
    signal: AbortSignal,
  ): Promise<readonly IndexedDocument[]> {
    const documents = new Map(initiallyIndexed.map((document) => [document.uri, document]));
    const pending = initiallyIndexed
      .filter(({ languageId }) => languageId === "mkosi")
      .filter((document) => parse(document.source, "mkosi", document.uri).kind !== "mkosi:generic")
      .map((document) => ({
        document,
        workingDirectory:
          document.mkosiWorkingDirectory ?? mkosiIncludePath(document.uri, ".") ?? "/",
      }));
    const analyzed = new Set<string>();
    const resolvedTargets = new Set<string>();

    while (!isAborted(signal) && pending.length > 0 && documents.size < maximumFiles) {
      const queued = pending.shift();
      const analysisKey =
        queued === undefined ? undefined : queued.document.uri + "\0" + queued.workingDirectory;
      if (queued === undefined || analysisKey === undefined || analyzed.has(analysisKey)) continue;
      const indexed = queued.document;
      analyzed.add(analysisKey);
      const parsed = {
        ...parse(indexed.source, "mkosi", indexed.uri),
        mkosiWorkingDirectory: queued.workingDirectory,
      };
      const sourceUri = vscode.Uri.parse(indexed.uri);
      for (const reference of extractReferences(parsed)) {
        if (reference.kind !== "mkosi-include") continue;
        const path = mkosiIncludePath(indexed.uri, reference.target, queued.workingDirectory);
        if (path === undefined) continue;
        const target = sourceUri.with({ path, query: "", fragment: "" });
        if (!this.mayReadInclude(target)) continue;
        const canonical = (await this.host?.canonicalUri(target)) ?? target;
        const targetKey = canonical.toString();
        if (resolvedTargets.has(targetKey)) continue;
        resolvedTargets.add(targetKey);

        const selection = await this.mkosiIncludeCandidates(
          target,
          queued.workingDirectory,
          signal,
        );
        for (const candidate of selection.uris) {
          if (isAborted(signal) || documents.size >= maximumFiles) break;
          const existing = documents.get(candidate.toString());
          if (existing?.languageId === "mkosi") {
            const withContext: IndexedDocument = {
              ...existing,
              mkosiWorkingDirectory: selection.workingDirectory,
            };
            documents.set(existing.uri, withContext);
            pending.push({
              document: withContext,
              workingDirectory: selection.workingDirectory,
            });
            continue;
          }
          const document = await this.indexDocument(
            candidate,
            signal,
            "mkosi",
            selection.workingDirectory,
          );
          if (document === undefined) continue;
          documents.set(document.uri, document);
          pending.push({ document, workingDirectory: selection.workingDirectory });
        }
      }
    }

    return [...documents.values()].sort((left, right) => left.uri.localeCompare(right.uri));
  }

  private mayReadInclude(uri: vscode.Uri): boolean {
    return vscode.workspace.getWorkspaceFolder(uri) !== undefined || this.hostIndexingEnabled();
  }

  private async mkosiIncludeCandidates(
    target: vscode.Uri,
    callerWorkingDirectory: string,
    signal: AbortSignal,
  ): Promise<{ readonly uris: readonly vscode.Uri[]; readonly workingDirectory: string }> {
    let stat: vscode.FileStat;
    try {
      stat = await vscode.workspace.fs.stat(target);
    } catch {
      return { uris: [], workingDirectory: callerWorkingDirectory };
    }
    if ((stat.type & vscode.FileType.Directory) === 0) {
      return { uris: [target], workingDirectory: callerWorkingDirectory };
    }

    type DirectoryMode = "root" | "drop-ins" | "profiles";
    const pending: {
      readonly uri: vscode.Uri;
      readonly mode: DirectoryMode;
      readonly depth: number;
    }[] = [{ uri: target, mode: "root", depth: 0 }];
    const result: vscode.Uri[] = [];
    const seen = new Set<string>();
    while (pending.length > 0 && !isAborted(signal) && result.length < maximumFiles) {
      const current = pending.shift();
      if (current === undefined || current.depth > 12) continue;
      let entries: readonly [string, vscode.FileType][];
      try {
        entries = await vscode.workspace.fs.readDirectory(current.uri);
      } catch {
        continue;
      }
      for (const [name, type] of [...entries].sort(([left], [right]) =>
        left.localeCompare(right),
      )) {
        if (isAborted(signal) || result.length >= maximumFiles) break;
        const uri = vscode.Uri.joinPath(current.uri, name);
        const directory = (type & vscode.FileType.Directory) !== 0;
        if (directory) {
          if (current.mode === "root" && name === "mkosi.conf.d") {
            pending.push({ uri, mode: "drop-ins", depth: current.depth + 1 });
          } else if (
            current.mode === "root" &&
            (name === "mkosi.presets" || name === "mkosi.profiles")
          ) {
            pending.push({ uri, mode: "profiles", depth: current.depth + 1 });
          } else if (current.mode !== "root") {
            pending.push({ uri, mode: "root", depth: current.depth + 1 });
          }
          continue;
        }
        const accepted =
          (current.mode === "root" && name === "mkosi.conf") ||
          (current.mode === "drop-ins" && name.endsWith(".conf")) ||
          current.mode === "profiles";
        if (!accepted || seen.has(uri.toString())) continue;
        seen.add(uri.toString());
        result.push(uri);
      }
    }
    return { uris: result, workingDirectory: target.path };
  }

  private async indexDocument(
    uri: vscode.Uri,
    signal: AbortSignal,
    forcedLanguageId?: DialectId,
    mkosiWorkingDirectory?: string,
  ): Promise<IndexedDocument | undefined> {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      if (signal.aborted || bytes.byteLength > maximumFileBytes) return undefined;
      const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const open = vscode.workspace.textDocuments.find(
        (candidate) => candidate.uri.toString() === uri.toString(),
      );
      const configuration = configurationFor(uri, this.languageIds);
      const configured = configuredDialect(uri, configuration.associations);
      const languageId =
        forcedLanguageId ??
        configured ??
        (this.languageIds.has(open?.languageId as DialectId)
          ? (open?.languageId as DialectId)
          : await this.client.sendRequest(detectDialectRequest, {
              uri: detectionUri(uri, configuration.suffixes).toString(),
              source,
            }));
      if (languageId === null || isAborted(signal)) return undefined;
      const stat = await vscode.workspace.fs.stat(uri);
      const canonicalUri = await this.host?.canonicalUri(uri);
      return {
        uri: uri.toString(),
        ...(canonicalUri === undefined || canonicalUri.toString() === uri.toString()
          ? {}
          : { canonicalUri: canonicalUri.toString() }),
        ...(mkosiWorkingDirectory === undefined ? {} : { mkosiWorkingDirectory }),
        languageId,
        source,
        mtime: stat.mtime,
        workspaceOwned: vscode.workspace.getWorkspaceFolder(uri) !== undefined,
      };
    } catch (error) {
      this.output.debug("Unable to index " + uri.toString() + ": " + safeMessage(error));
      return undefined;
    }
  }
}

interface IndexConfiguration {
  readonly suffixes: readonly string[];
  readonly associations: Readonly<Record<string, string>>;
}

function configurationFor(
  uri: vscode.Uri,
  languageIds: ReadonlySet<DialectId>,
): IndexConfiguration {
  const settings = vscode.workspace.getConfiguration("systemd", uri);
  return {
    suffixes: normalizeSuffixes(settings.get<readonly string[]>("templateSuffixes", [])),
    associations: normalizeAssociations(settings.get("dialectAssociations"), languageIds),
  };
}

function configuredSuffixes(): readonly string[] {
  const suffixes = new Set(defaultTemplateSuffixes);
  const folders = vscode.workspace.workspaceFolders ?? [];
  for (const uri of [undefined, ...folders.map(({ uri }) => uri)]) {
    const settings = vscode.workspace.getConfiguration("systemd", uri);
    for (const suffix of normalizeSuffixes(
      settings.get<readonly string[]>("templateSuffixes", []),
    )) {
      suffixes.add(suffix);
    }
  }
  return [...suffixes];
}

function configuredAssociationPatterns(languageIds: ReadonlySet<DialectId>): readonly string[] {
  const patterns = new Set<string>();
  const folders = vscode.workspace.workspaceFolders ?? [];
  for (const uri of [undefined, ...folders.map(({ uri }) => uri)]) {
    const candidate = vscode.workspace.getConfiguration("systemd", uri).get("dialectAssociations");
    for (const pattern of Object.keys(normalizeAssociations(candidate, languageIds))) {
      if (pattern !== "") patterns.add(pattern);
    }
  }
  return [...patterns];
}

function normalizeSuffixes(configured: readonly string[]): readonly string[] {
  const result = new Set(defaultTemplateSuffixes);
  for (const suffix of configured) {
    const normalized = suffix.startsWith(".") ? suffix : "." + suffix;
    if (/^\.[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/u.test(normalized)) result.add(normalized);
  }
  return [...result].sort((left, right) => right.length - left.length);
}

function normalizeAssociations(
  candidate: unknown,
  languageIds: ReadonlySet<DialectId>,
): Readonly<Record<string, string>> {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) return {};
  const result: Record<string, string> = {};
  for (const [pattern, dialect] of Object.entries(candidate)) {
    if (pattern !== "" && typeof dialect === "string" && languageIds.has(dialect as DialectId)) {
      result[pattern] = dialect;
    }
  }
  return result;
}

function configuredDialect(
  uri: vscode.Uri,
  associations: Readonly<Record<string, string>>,
): DialectId | undefined {
  const relative = vscode.workspace.asRelativePath(uri, false).replaceAll("\\", "/");
  const absolute = uri.path.replace(/^\//u, "");
  let selected: DialectId | undefined;
  for (const [pattern, dialect] of Object.entries(associations)) {
    if (matchesPattern(relative, pattern) || matchesPattern(absolute, pattern)) {
      selected = dialect as DialectId;
    }
  }
  return selected;
}

function isPlainText(document: vscode.TextDocument): boolean {
  return document.languageId === "plaintext";
}

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

function matchesPattern(path: string, pattern: string): boolean {
  try {
    return minimatch(path, pattern, { dot: true, matchBase: true });
  } catch {
    return false;
  }
}

function detectionUri(uri: vscode.Uri, suffixes: readonly string[]): vscode.Uri {
  let path = uri.path;
  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of suffixes) {
      if (!path.endsWith(suffix)) continue;
      path = path.slice(0, -suffix.length);
      changed = true;
      break;
    }
  }
  return path === uri.path ? uri : uri.with({ path });
}

function potentialConfiguration(path: string, suffixes: readonly string[]): boolean {
  const normalized = detectionUri(vscode.Uri.from({ scheme: "file", path }), suffixes).path;
  const name = normalized.slice(normalized.lastIndexOf("/") + 1);
  if (
    /\.(?:service|socket|timer|path|mount|automount|swap|target|device|slice|scope|network|netdev|link|dnssd|dns-delegate|nspawn|container|volume|pod|kube|image|build|artifact|rules|hwdb|preset|pcrlock|rr|positive|negative)$/u.test(
      name,
    )
  ) {
    return true;
  }
  if (name.endsWith(".conf")) return true;
  return /^(?:fstab|crypttab|veritytab|integritytab|clonetab|loader\.conf|install\.conf|os-release|initrd-release|machine-info|locale\.conf|vconsole\.conf|mkosi\.version|cmdline|entry-token)$/u.test(
    name,
  );
}

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n\0]+/gu, " ").slice(0, 500);
}
