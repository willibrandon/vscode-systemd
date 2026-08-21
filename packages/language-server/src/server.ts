import {
  analyze,
  configurationIdentity,
  definitionFor,
  definitionsFor,
  detectDialect,
  extractReferences,
  findOrderingDependencyCycles,
  format,
  mergeConfigurations,
  parse,
  resolveConfigurationDocuments,
  resolveUnitConfigurations,
  renderEffectiveConfiguration,
  sectionsFor,
} from "@systemd/language-core";
import type {
  AssignmentNode,
  CoreDiagnostic,
  DialectId,
  DirectiveDefinition,
  OrderingDependencyCycle,
  ParsedDocument,
  SyntaxNode,
  TextSpan,
} from "@systemd/language-core";
import {
  CodeActionKind,
  CompletionItemKind,
  DiagnosticSeverity,
  DiagnosticTag,
  DocumentHighlightKind,
  FoldingRangeKind,
  InlayHintKind,
  MarkupKind,
  SemanticTokensBuilder,
  SymbolKind,
  TextDocumentSyncKind,
  TextDocuments,
} from "vscode-languageserver";
import type {
  CodeAction,
  CodeLens,
  CompletionItem,
  Connection,
  Diagnostic,
  DocumentHighlight,
  DocumentLink,
  DocumentSymbol,
  FoldingRange,
  Hover,
  InlayHint,
  InitializeParams,
  InitializeResult,
  Location,
  Position,
  Range,
  SelectionRange,
  SemanticTokens,
  SignatureHelp,
  SymbolInformation,
  TextEdit,
  WorkspaceEdit,
} from "vscode-languageserver";
import { TextDocument } from "vscode-languageserver-textdocument";
import {
  dependencyGraphRequest,
  detectDialectRequest,
  effectiveConfigurationRequest,
  indexedDocumentsNotification,
  refreshDiagnosticsNotification,
  workspaceSnapshotRequest,
} from "./protocol.js";
import type { WorkspaceSnapshot, WorkspaceSnapshotConfiguration } from "./protocol.js";

const languageIds = new Set<DialectId>([
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
]);
const tokenTypes = ["keyword", "string", "number", "comment", "parameter"] as const;
const tokenModifiers = ["deprecated"] as const;

export interface TimerHost {
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}

interface ServerSettings {
  readonly validation: Readonly<{ enable: boolean; maxProblems: number }>;
  readonly targetVersion: string;
}

const defaultSettings: ServerSettings = {
  validation: { enable: true, maxProblems: 200 },
  targetVersion: "latest",
};

export function startLanguageServer(connection: Connection, timers: TimerHost): void {
  const documents = new TextDocuments(TextDocument);
  const indexed = new Map<string, ParsedDocument>();
  const pending = new Map<string, unknown>();
  const settingsCache = new Map<string, Promise<ServerSettings>>();
  let fallbackSettings = defaultSettings;
  let supportsConfiguration = false;
  let graphRevision = 0;
  let cycleCacheRevision = -1;
  let cycleCache: readonly OrderingDependencyCycle[] = [];

  const parsed = (document: TextDocument): ParsedDocument | undefined => {
    const dialect = dialectFor(document);
    return dialect === undefined ? undefined : parse(document.getText(), dialect, document.uri);
  };
  const settingsFor = (uri: string): Promise<ServerSettings> => {
    if (!supportsConfiguration) return Promise.resolve(fallbackSettings);
    const cached = settingsCache.get(uri);
    if (cached !== undefined) return cached;
    const request = connection.workspace
      .getConfiguration({ scopeUri: uri, section: "systemd" })
      .then(normalizeSettings, (): ServerSettings => defaultSettings);
    settingsCache.set(uri, request);
    return request;
  };
  const publish = async (document: TextDocument): Promise<void> => {
    const tree = parsed(document);
    const settings = await settingsFor(document.uri);
    if (documents.get(document.uri)?.version !== document.version) return;
    const diagnostics =
      tree === undefined || !settings.validation.enable
        ? []
        : [
            ...analyze(tree, {
              maxProblems: settings.validation.maxProblems,
              targetVersion: settings.targetVersion,
            }).map((item) => toDiagnostic(document, item)),
            ...orderingCycleDiagnostics(document, tree, orderingCycles(), allParsed(), documents),
          ].slice(0, settings.validation.maxProblems);
    void connection.sendDiagnostics({
      uri: document.uri,
      version: document.version,
      diagnostics,
    });
  };
  const schedule = (document: TextDocument, delay = 120): void => {
    const old = pending.get(document.uri);
    if (old !== undefined) timers.clearTimeout(old);
    const version = document.version;
    const handle = timers.setTimeout((): void => {
      pending.delete(document.uri);
      const current = documents.get(document.uri);
      if (current?.version === version) {
        void publish(current).catch((error: unknown): void => {
          connection.console.error("[diagnostics] " + safeMessage(error));
        });
      }
    }, delay);
    pending.set(document.uri, handle);
  };
  const allParsed = (): readonly ParsedDocument[] => {
    const result = new Map(indexed);
    for (const document of documents.all()) {
      const tree = parsed(document);
      if (tree !== undefined) result.set(document.uri, tree);
    }
    return [...result.values()];
  };
  const invalidateGraph = (): void => {
    graphRevision += 1;
  };
  const orderingCycles = (): readonly OrderingDependencyCycle[] => {
    if (cycleCacheRevision !== graphRevision) {
      cycleCache = findOrderingDependencyCycles(allParsed());
      cycleCacheRevision = graphRevision;
    }
    return cycleCache;
  };

  connection.onInitialize((params: InitializeParams): InitializeResult => {
    supportsConfiguration = params.capabilities.workspace?.configuration === true;
    return {
      capabilities: {
        textDocumentSync: TextDocumentSyncKind.Incremental,
        completionProvider: {
          triggerCharacters: ["[", "=", " ", ".", "/"],
          resolveProvider: true,
        },
        hoverProvider: true,
        signatureHelpProvider: { triggerCharacters: ["=", " "] },
        documentSymbolProvider: true,
        workspaceSymbolProvider: true,
        foldingRangeProvider: true,
        selectionRangeProvider: true,
        documentLinkProvider: { resolveProvider: false },
        definitionProvider: true,
        referencesProvider: true,
        documentHighlightProvider: true,
        documentFormattingProvider: true,
        documentRangeFormattingProvider: true,
        renameProvider: { prepareProvider: true },
        semanticTokensProvider: {
          legend: { tokenTypes: [...tokenTypes], tokenModifiers: [...tokenModifiers] },
          full: true,
        },
        codeActionProvider: { codeActionKinds: [CodeActionKind.QuickFix] },
        codeLensProvider: { resolveProvider: false },
        inlayHintProvider: true,
      },
    };
  });

  connection.onDidChangeConfiguration((event): void => {
    settingsCache.clear();
    if (!supportsConfiguration) {
      fallbackSettings = normalizeSettings(object(event.settings)?.["systemd"] ?? event.settings);
    }
    for (const document of documents.all()) schedule(document, 0);
  });
  connection.onCompletion((params): CompletionItem[] => {
    const document = documents.get(params.textDocument.uri);
    const tree = document === undefined ? undefined : parsed(document);
    if (document === undefined || tree === undefined) return [];
    const offset = document.offsetAt(params.position);
    const line = document.getText({
      start: { line: params.position.line, character: 0 },
      end: params.position,
    });
    if (/^\s*\[[^\]]*$/u.test(line)) {
      return sectionsFor(tree.dialect).map((section): CompletionItem => ({
        label: section,
        kind: CompletionItemKind.Module,
        insertText: section + "]",
        detail: "systemd section",
      }));
    }
    const assignment = assignmentAt(tree, offset);
    if (assignment !== undefined && offset >= assignment.valueSpan.start) {
      return valueCompletions(assignment, allParsed());
    }
    return definitionsFor(tree.dialect, sectionAt(tree, offset)).map(definitionCompletion);
  });
  connection.onCompletionResolve((item): CompletionItem => {
    const data = completionData(item.data);
    if (data === undefined) return item;
    const definition = definitionFor(data.dialect, data.section, data.name);
    return definition === undefined
      ? item
      : {
          ...item,
          detail: definition.name + "= · " + definition.valueKind,
          documentation: { kind: MarkupKind.Markdown, value: directiveMarkdown(definition) },
        };
  });
  connection.onHover((params): Hover | null => {
    const context = contextAt(documents, params.textDocument.uri, params.position, parsed);
    if (context === undefined) return null;
    if (context.node.kind === "section") {
      return {
        contents: { kind: MarkupKind.Markdown, value: "[" + context.node.name + "] section" },
      };
    }
    if (context.node.kind !== "assignment") return null;
    const definition =
      context.node.definition ??
      definitionFor(context.tree.dialect, context.node.section, context.node.name);
    if (definition === undefined) return null;
    return {
      contents: { kind: MarkupKind.Markdown, value: directiveMarkdown(definition) },
      range: toRange(context.document, context.node.nameSpan),
    };
  });
  connection.onSignatureHelp((params): SignatureHelp | null => {
    const context = contextAt(documents, params.textDocument.uri, params.position, parsed);
    if (context?.node.kind !== "assignment" || context.node.definition === undefined) return null;
    const definition = context.node.definition;
    return {
      signatures: [
        {
          label: definition.name + "=<" + definition.valueKind + ">",
          documentation: definition.summary,
          parameters: [{ label: "<" + definition.valueKind + ">" }],
        },
      ],
      activeSignature: 0,
      activeParameter: 0,
    };
  });
  connection.onDocumentSymbol((params): DocumentSymbol[] => {
    const document = documents.get(params.textDocument.uri);
    const tree = document === undefined ? undefined : parsed(document);
    return document === undefined || tree === undefined ? [] : documentSymbols(document, tree);
  });
  connection.onWorkspaceSymbol((params): SymbolInformation[] => {
    const query = params.query.toLowerCase();
    const result: SymbolInformation[] = [];
    for (const tree of allParsed()) {
      const document =
        documents.get(tree.uri) ?? TextDocument.create(tree.uri, tree.dialect, 0, tree.source);
      for (const node of tree.nodes) {
        const name =
          node.kind === "section"
            ? "[" + node.name + "]"
            : node.kind === "assignment"
              ? node.name
              : undefined;
        if (!name?.toLowerCase().includes(query)) continue;
        result.push({
          name,
          kind: node.kind === "section" ? SymbolKind.Namespace : SymbolKind.Property,
          location: { uri: tree.uri, range: toRange(document, node.span) },
        });
        if (result.length >= 500) return result;
      }
    }
    return result;
  });
  connection.onFoldingRanges((params): FoldingRange[] => {
    const document = documents.get(params.textDocument.uri);
    const tree = document === undefined ? undefined : parsed(document);
    if (document === undefined || tree === undefined) return [];
    const sections = tree.nodes.filter((node) => node.kind === "section");
    return sections
      .map((section, index): FoldingRange => ({
        startLine: section.line,
        endLine: Math.max(section.line, (sections[index + 1]?.line ?? document.lineCount) - 1),
        kind: FoldingRangeKind.Region,
      }))
      .filter((range) => range.endLine > range.startLine);
  });
  connection.onSelectionRanges((params): SelectionRange[] => {
    const document = documents.get(params.textDocument.uri);
    const tree = document === undefined ? undefined : parsed(document);
    if (document === undefined || tree === undefined) return [];
    return params.positions.map((position): SelectionRange => {
      const node = nodeAt(tree, document.offsetAt(position));
      const lineText = document
        .getText({
          start: { line: position.line, character: 0 },
          end: { line: position.line + 1, character: 0 },
        })
        .replace(/\r?\n$/u, "");
      const lineRange: Range = {
        start: { line: position.line, character: 0 },
        end: { line: position.line, character: lineText.length },
      };
      return node === undefined
        ? { range: lineRange }
        : { range: toRange(document, node.span), parent: { range: lineRange } };
    });
  });
  connection.onDocumentLinks((params): DocumentLink[] => {
    const document = documents.get(params.textDocument.uri);
    const tree = document === undefined ? undefined : parsed(document);
    if (document === undefined || tree === undefined) return [];
    return extractReferences(tree)
      .filter(
        (reference) =>
          (reference.kind === "path" || reference.kind === "documentation") &&
          /^(?:[a-z][a-z0-9+.-]*:|\/)/iu.test(reference.target),
      )
      .map((reference): DocumentLink => ({
        range: toRange(document, reference.span),
        target: /^[a-z][a-z0-9+.-]*:/iu.test(reference.target)
          ? reference.target
          : "file://" + reference.target,
      }));
  });

  connection.onDefinition((params): Location[] => {
    const context = contextAt(documents, params.textDocument.uri, params.position, parsed);
    if (context?.node.kind !== "assignment") return [];
    if (context.document.offsetAt(params.position) < context.node.valueSpan.start) return [];
    const target = wordAt(context.document, params.position);
    return target === "" ? [] : documentLocations(target, allParsed(), documents);
  });
  connection.onReferences((params): Location[] => {
    const document = documents.get(params.textDocument.uri);
    if (document === undefined) return [];
    const target = wordAt(document, params.position);
    if (target === "") return [];
    const result: Location[] = [];
    for (const tree of allParsed()) {
      const source =
        documents.get(tree.uri) ?? TextDocument.create(tree.uri, tree.dialect, 0, tree.source);
      for (const reference of extractReferences(tree)) {
        if (reference.target === target || basename(reference.target) === basename(target)) {
          result.push({ uri: tree.uri, range: toRange(source, reference.span) });
        }
      }
    }
    return result;
  });
  connection.onDocumentHighlight((params): DocumentHighlight[] => {
    const document = documents.get(params.textDocument.uri);
    const tree = document === undefined ? undefined : parsed(document);
    const context = contextAt(documents, params.textDocument.uri, params.position, parsed);
    if (document === undefined || tree === undefined || context?.node.kind !== "assignment") {
      return [];
    }
    const assignmentName = context.node.name;
    return tree.nodes
      .filter(
        (node): node is AssignmentNode =>
          node.kind === "assignment" && node.name === assignmentName,
      )
      .map((node): DocumentHighlight => ({
        range: toRange(document, node.nameSpan),
        kind: DocumentHighlightKind.Text,
      }));
  });
  connection.onDocumentFormatting((params): TextEdit[] =>
    formatDocument(documents.get(params.textDocument.uri), params.options),
  );
  connection.onDocumentRangeFormatting((params): TextEdit[] => {
    const document = documents.get(params.textDocument.uri);
    const range =
      document === undefined
        ? undefined
        : {
            start: document.offsetAt(params.range.start),
            end: document.offsetAt(params.range.end),
          };
    return formatDocument(document, params.options, range);
  });
  connection.languages.semanticTokens.on((params): SemanticTokens => {
    const document = documents.get(params.textDocument.uri);
    const tree = document === undefined ? undefined : parsed(document);
    const builder = new SemanticTokensBuilder();
    if (document !== undefined && tree !== undefined) {
      for (const node of tree.nodes) addSemanticTokens(builder, document, node);
    }
    return builder.build();
  });
  connection.languages.inlayHint.on((params): InlayHint[] => {
    const document = documents.get(params.textDocument.uri);
    const tree = document === undefined ? undefined : parsed(document);
    if (document === undefined || tree === undefined) return [];
    const rangeStart = document.offsetAt(params.range.start);
    const rangeEnd = document.offsetAt(params.range.end);
    const result: InlayHint[] = [];
    for (const node of tree.nodes) {
      if (
        node.kind !== "assignment" ||
        node.valueSpan.end < rangeStart ||
        node.span.start > rangeEnd
      )
        continue;
      for (const match of node.value.matchAll(/%(?<specifier>[%A-Za-z])/gu)) {
        const specifier = match.groups?.["specifier"] ?? "";
        const meaning = specifierMeaning(specifier);
        if (meaning === undefined) continue;
        const offset = node.valueSpan.start + match.index + 2;
        result.push({
          position: document.positionAt(offset),
          label: " = " + meaning,
          kind: InlayHintKind.Type,
          paddingLeft: true,
          tooltip: "systemd %" + specifier + " specifier",
        });
        if (result.length >= 100) return result;
      }
    }
    return result;
  });
  connection.onCodeLens((params): CodeLens[] => {
    const document = documents.get(params.textDocument.uri);
    const tree = document === undefined ? undefined : parsed(document);
    if (document === undefined || tree === undefined) return [];
    const range = toRange(document, { start: 0, end: Math.min(1, tree.source.length) });
    const result: CodeLens[] = [];
    if (["systemd-unit", "systemd-config", "podman-quadlet", "mkosi"].includes(tree.dialect)) {
      result.push({
        range,
        command: {
          title: "Show effective configuration",
          command: "systemd.showEffectiveConfiguration",
          arguments: [tree.uri],
        },
      });
    }
    if (tree.dialect === "systemd-unit" || tree.dialect === "podman-quadlet") {
      const identity = configurationIdentity(tree.uri);
      const incoming = allParsed().reduce(
        (count, candidate) =>
          count + extractReferences(candidate).filter(({ target }) => target === identity).length,
        0,
      );
      result.push({
        range,
        command: {
          title:
            String(incoming) +
            (incoming === 1 ? " incoming reference" : " incoming references") +
            " · Show dependency graph",
          command: "systemd.showDependencyGraph",
          arguments: [tree.uri],
        },
      });
    }
    return result;
  });
  connection.onCodeAction((params): CodeAction[] => {
    const document = documents.get(params.textDocument.uri);
    const tree = document === undefined ? undefined : parsed(document);
    if (document === undefined || tree === undefined) return [];
    const result: CodeAction[] = [];
    for (const diagnostic of params.context.diagnostics) {
      if (diagnostic.code !== "unknown-setting") continue;
      const node = assignmentAt(tree, document.offsetAt(diagnostic.range.start));
      if (node === undefined) continue;
      const replacement = closestDefinition(node.name, definitionsFor(tree.dialect, node.section));
      if (replacement === undefined) continue;
      result.push({
        title: "Change to " + replacement.name + "=",
        kind: CodeActionKind.QuickFix,
        diagnostics: [diagnostic],
        isPreferred: true,
        edit: {
          changes: {
            [document.uri]: [
              {
                range: toRange(document, node.nameSpan),
                newText: replacement.name,
              },
            ],
          },
        },
      });
    }
    return result;
  });
  connection.onPrepareRename((params): Range | null => {
    const context = contextAt(documents, params.textDocument.uri, params.position, parsed);
    if (context?.node.kind !== "assignment") return null;
    return context.document.offsetAt(params.position) >= context.node.valueSpan.start
      ? wordRangeAt(context.document, params.position)
      : null;
  });
  connection.onRenameRequest((params): WorkspaceEdit => {
    const document = documents.get(params.textDocument.uri);
    if (document === undefined) return { changes: {} };
    const oldName = wordAt(document, params.position);
    const changes: Record<string, TextEdit[]> = {};
    if (oldName === "" || !/^[A-Za-z0-9_.@:-]{1,255}$/u.test(params.newName)) {
      return { changes };
    }
    for (const tree of allParsed()) {
      const source =
        documents.get(tree.uri) ?? TextDocument.create(tree.uri, tree.dialect, 0, tree.source);
      const edits = extractReferences(tree)
        .filter((reference) => reference.target === oldName)
        .map((reference): TextEdit => ({
          range: toRange(source, reference.span),
          newText: params.newName,
        }));
      if (edits.length > 0) changes[tree.uri] = edits;
    }
    return { changes };
  });

  connection.onRequest(
    detectDialectRequest,
    ({ uri, source }): DialectId | null => detectDialect(uri, source) ?? null,
  );
  connection.onRequest(effectiveConfigurationRequest, ({ uri }): string => {
    const resolution = resolveConfigurationDocuments(uri, allParsed());
    const rendered = renderEffectiveConfiguration(mergeConfigurations(resolution.documents));
    return resolution.masked
      ? "# Unit is masked by " + (resolution.baseUri ?? "an empty unit file") + "\n" + rendered
      : rendered;
  });
  connection.onRequest(dependencyGraphRequest, ({ uri }) => {
    const available = allParsed();
    const selected =
      uri === undefined ? available : resolveConfigurationDocuments(uri, available).documents;
    const nodes = new Set(selected.map((tree) => basename(tree.uri)));
    const edges: { source: string; target: string; kind: string }[] = [];
    for (const tree of selected) {
      const source = basename(tree.uri);
      for (const reference of extractReferences(tree)) {
        if (!["unit", "quadlet", "mkosi"].includes(reference.kind)) continue;
        nodes.add(reference.target);
        edges.push({ source, target: reference.target, kind: reference.kind });
      }
    }
    return { nodes: [...nodes].sort(), edges };
  });
  connection.onRequest(workspaceSnapshotRequest, (): WorkspaceSnapshot => {
    const available = allParsed();
    const unitResolutions = new Map(
      resolveUnitConfigurations(available).map((resolution) => [resolution.identity, resolution]),
    );
    const documents = available.map((tree) => ({
      uri: tree.uri,
      languageId: tree.dialect,
      identity: configurationIdentity(tree.uri),
      references: extractReferences(tree).map(({ target, kind }) => ({ target, kind })),
    }));
    const groups = new Map<string, ParsedDocument[]>();
    for (const tree of available) {
      const identity = configurationIdentity(tree.uri);
      if (tree.dialect === "systemd-unit" && !isUnitIdentity(identity)) continue;
      const key = tree.dialect + "\0" + identity;
      groups.set(key, [...(groups.get(key) ?? []), tree]);
    }
    const configurations: WorkspaceSnapshotConfiguration[] = [];
    for (const group of groups.values()) {
      const first = group[0];
      if (first === undefined) continue;
      const identity = configurationIdentity(first.uri);
      const resolution =
        unitResolutions.get(identity) ?? resolveConfigurationDocuments(identity, available);
      configurations.push({
        identity,
        languageId: first.dialect,
        sourceUri: resolution.baseUri ?? first.uri,
        ...(resolution.baseUri === undefined ? {} : { baseUri: resolution.baseUri }),
        dropInUris: resolution.dropInUris,
        documentUris: group.map(({ uri }) => uri).sort(),
        masked: resolution.masked,
      });
    }
    return {
      documents: documents.sort((left, right) => left.uri.localeCompare(right.uri)),
      configurations: configurations.sort((left, right) =>
        left.identity.localeCompare(right.identity),
      ),
    };
  });
  connection.onNotification(
    indexedDocumentsNotification,
    ({ documents: candidates, replace }): void => {
      if (replace) indexed.clear();
      for (const candidate of candidates) {
        indexed.set(candidate.uri, parse(candidate.source, candidate.languageId, candidate.uri));
      }
      invalidateGraph();
      for (const document of documents.all()) schedule(document, 0);
    },
  );
  connection.onNotification(refreshDiagnosticsNotification, ({ uri }): void => {
    for (const document of documents.all()) {
      if (uri === undefined || document.uri === uri) schedule(document, 0);
    }
  });

  documents.onDidOpen(({ document }): void => {
    invalidateGraph();
    schedule(document, 0);
  });
  documents.onDidChangeContent(({ document }): void => {
    invalidateGraph();
    schedule(document);
  });
  documents.onDidClose(({ document }): void => {
    invalidateGraph();
    const handle = pending.get(document.uri);
    if (handle !== undefined) timers.clearTimeout(handle);
    pending.delete(document.uri);
    settingsCache.delete(document.uri);
    void connection.sendDiagnostics({ uri: document.uri, diagnostics: [] });
  });
  documents.listen(connection);
  connection.listen();
}

function dialectFor(document: TextDocument): DialectId | undefined {
  return languageIds.has(document.languageId as DialectId)
    ? (document.languageId as DialectId)
    : detectDialect(document.uri, document.getText());
}

function normalizeSettings(candidate: unknown): ServerSettings {
  const value = object(candidate);
  const validation = object(value?.["validation"]);
  const target = object(value?.["target"]);
  return {
    validation: {
      enable: typeof validation?.["enable"] === "boolean" ? validation["enable"] : true,
      maxProblems: boundedInteger(validation?.["maxProblems"], 200, 1, 10_000),
    },
    targetVersion:
      typeof target?.["systemdVersion"] === "string"
        ? target["systemdVersion"]
        : typeof value?.["targetVersion"] === "string"
          ? value["targetVersion"]
          : "latest",
  };
}

function object(candidate: unknown): Record<string, unknown> | undefined {
  return candidate !== null && typeof candidate === "object"
    ? (candidate as Record<string, unknown>)
    : undefined;
}

function boundedInteger(
  candidate: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return typeof candidate === "number" && Number.isInteger(candidate)
    ? Math.max(minimum, Math.min(maximum, candidate))
    : fallback;
}

function toDiagnostic(document: TextDocument, diagnostic: CoreDiagnostic): Diagnostic {
  return {
    range: toRange(document, diagnostic.span),
    message: diagnostic.message,
    severity: diagnosticSeverity(diagnostic.severity),
    source: "systemd",
    code: diagnostic.code,
    ...(diagnostic.code === "deprecated-setting" ? { tags: [DiagnosticTag.Deprecated] } : {}),
    ...(diagnostic.documentation === undefined
      ? {}
      : { codeDescription: { href: diagnostic.documentation } }),
  };
}

function orderingCycleDiagnostics(
  document: TextDocument,
  tree: ParsedDocument,
  cycles: readonly OrderingDependencyCycle[],
  trees: readonly ParsedDocument[],
  openDocuments: TextDocuments<TextDocument>,
): Diagnostic[] {
  const byUri = new Map(trees.map((candidate) => [candidate.uri, candidate]));
  const result: Diagnostic[] = [];
  const seen = new Set<string>();
  for (const cycle of cycles) {
    const message = "Ordering dependency cycle involving " + cycle.nodes.join(", ") + ".";
    for (const edge of cycle.edges) {
      if (edge.sourceUri !== tree.uri) continue;
      const key = edge.sourceUri + ":" + String(edge.span.start) + ":" + message;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({
        range: toRange(document, edge.span),
        message,
        severity: DiagnosticSeverity.Warning,
        source: "systemd",
        code: "ordering-cycle",
        relatedInformation: cycle.edges
          .filter((candidate) => candidate !== edge)
          .map((candidate) => {
            const candidateTree = byUri.get(candidate.sourceUri);
            const candidateDocument =
              openDocuments.get(candidate.sourceUri) ??
              TextDocument.create(
                candidate.sourceUri,
                candidateTree?.dialect ?? "systemd-unit",
                0,
                candidateTree?.source ?? "",
              );
            return {
              location: {
                uri: candidate.sourceUri,
                range: toRange(candidateDocument, candidate.span),
              },
              message: candidate.from + " is ordered before " + candidate.to + ".",
            };
          }),
      });
    }
  }
  return result;
}

function diagnosticSeverity(severity: CoreDiagnostic["severity"]): DiagnosticSeverity {
  switch (severity) {
    case "error":
      return DiagnosticSeverity.Error;
    case "warning":
      return DiagnosticSeverity.Warning;
    case "information":
      return DiagnosticSeverity.Information;
    case "hint":
      return DiagnosticSeverity.Hint;
  }
}

function toRange(document: TextDocument, span: TextSpan): Range {
  return { start: document.positionAt(span.start), end: document.positionAt(span.end) };
}

function nodeAt(tree: ParsedDocument, offset: number): SyntaxNode | undefined {
  return tree.nodes.find((node) => node.span.start <= offset && offset <= node.span.end);
}

function assignmentAt(tree: ParsedDocument, offset: number): AssignmentNode | undefined {
  const node = nodeAt(tree, offset);
  return node?.kind === "assignment" ? node : undefined;
}

function sectionAt(tree: ParsedDocument, offset: number): string | null {
  let section: string | null = null;
  for (const node of tree.nodes) {
    if (node.span.start > offset) break;
    if (node.kind === "section") section = node.name;
  }
  return section;
}

interface DocumentContext {
  readonly document: TextDocument;
  readonly tree: ParsedDocument;
  readonly node: SyntaxNode;
}

function contextAt(
  documents: TextDocuments<TextDocument>,
  uri: string,
  position: Position,
  parser: (document: TextDocument) => ParsedDocument | undefined,
): DocumentContext | undefined {
  const document = documents.get(uri);
  const tree = document === undefined ? undefined : parser(document);
  const node =
    document === undefined || tree === undefined
      ? undefined
      : nodeAt(tree, document.offsetAt(position));
  return document === undefined || tree === undefined || node === undefined
    ? undefined
    : { document, tree, node };
}

function definitionCompletion(definition: DirectiveDefinition): CompletionItem {
  return {
    label: definition.name,
    kind: CompletionItemKind.Property,
    detail: definition.name + "= · " + definition.valueKind,
    insertText: definition.name + "=",
    data: {
      kind: "directive",
      dialect: definition.dialect,
      section: definition.section,
      name: definition.name,
    },
    ...(definition.deprecated ? { tags: [1] } : {}),
  };
}

function valueCompletions(
  assignment: AssignmentNode,
  documents: readonly ParsedDocument[],
): CompletionItem[] {
  const definition = assignment.definition;
  if (definition === undefined) return [];
  const values =
    definition.choices.length > 0
      ? definition.choices
      : definition.valueKind === "boolean"
        ? ["yes", "no"]
        : unitReferenceSettings.has(assignment.name)
          ? documents
              .map(({ uri }) => configurationIdentity(uri))
              .filter((identity) => isUnitIdentity(identity))
          : quadletReferenceSettings.has(assignment.name)
            ? documents
                .filter(({ dialect }) => dialect === "podman-quadlet")
                .map(({ uri }) => configurationIdentity(uri))
            : [];
  const unique = values.filter(
    (value, index, candidates) => value !== "" && candidates.indexOf(value) === index,
  );
  if (definition.choices.length === 0 && definition.valueKind !== "boolean") unique.sort();
  return unique.map((value): CompletionItem => ({
    label: value,
    kind: CompletionItemKind.Value,
    detail: definition.name + "= value",
  }));
}

const unitReferenceSettings = new Set([
  "After",
  "Before",
  "BindsTo",
  "Conflicts",
  "OnFailure",
  "OnSuccess",
  "PartOf",
  "PropagatesReloadTo",
  "PropagatesStopTo",
  "ReloadPropagatedFrom",
  "Requires",
  "Requisite",
  "Upholds",
  "Wants",
]);

const quadletReferenceSettings = new Set([
  "Artifact",
  "Build",
  "Image",
  "ImageVolume",
  "Network",
  "Pod",
  "Volume",
]);

interface CompletionData {
  readonly kind: "directive";
  readonly dialect: DialectId;
  readonly section: string;
  readonly name: string;
}

function completionData(value: unknown): CompletionData | undefined {
  const candidate = object(value);
  const dialect = candidate?.["dialect"];
  return candidate?.["kind"] === "directive" &&
    typeof dialect === "string" &&
    languageIds.has(dialect as DialectId) &&
    typeof candidate["section"] === "string" &&
    typeof candidate["name"] === "string"
    ? {
        kind: "directive",
        dialect: dialect as DialectId,
        section: candidate["section"],
        name: candidate["name"],
      }
    : undefined;
}

function specifierMeaning(specifier: string): string | undefined {
  return {
    "%": "literal %",
    f: "unescaped instance filename",
    i: "instance name",
    I: "unescaped instance name",
    j: "final name component",
    J: "unescaped final name component",
    n: "full unit name",
    N: "unit name without suffix",
    p: "unit name prefix",
    P: "unescaped unit name prefix",
  }[specifier];
}

function directiveMarkdown(definition: DirectiveDefinition): string {
  const availability =
    definition.since === null ? "" : "\n\nAvailable since systemd " + definition.since + ".";
  const deprecated = definition.deprecated ? "\n\n**Deprecated.**" : "";
  return (
    "**" +
    definition.name +
    "=<" +
    definition.valueKind +
    ">**\n\n" +
    definition.summary +
    availability +
    deprecated +
    "\n\n[Official documentation](" +
    definition.documentation +
    ")"
  );
}

function documentSymbols(document: TextDocument, tree: ParsedDocument): DocumentSymbol[] {
  const roots: DocumentSymbol[] = [];
  let current: DocumentSymbol | undefined;
  for (const node of tree.nodes) {
    if (node.kind === "section") {
      current = {
        name: "[" + node.name + "]",
        kind: SymbolKind.Namespace,
        range: toRange(document, node.span),
        selectionRange: toRange(document, node.nameSpan),
        children: [],
      };
      roots.push(current);
    } else if (node.kind === "assignment") {
      const symbol: DocumentSymbol = {
        name: node.name,
        detail: node.value,
        kind: SymbolKind.Property,
        range: toRange(document, node.span),
        selectionRange: toRange(document, node.nameSpan),
      };
      if (current?.children !== undefined) current.children.push(symbol);
      else roots.push(symbol);
    }
  }
  return roots;
}

function documentLocations(
  target: string,
  trees: readonly ParsedDocument[],
  documents: TextDocuments<TextDocument>,
): Location[] {
  return trees
    .filter((tree) => basename(tree.uri) === basename(target))
    .map((tree): Location => {
      const document =
        documents.get(tree.uri) ?? TextDocument.create(tree.uri, tree.dialect, 0, tree.source);
      return {
        uri: tree.uri,
        range: toRange(document, { start: 0, end: Math.min(1, tree.source.length) }),
      };
    });
}

function formatDocument(
  document: TextDocument | undefined,
  options: { insertSpaces: boolean; tabSize: number },
  range?: TextSpan,
): TextEdit[] {
  if (document === undefined) return [];
  const dialect = dialectFor(document);
  if (dialect === undefined) return [];
  return format(parse(document.getText(), dialect, document.uri), {
    insertSpaces: options.insertSpaces,
    tabSize: options.tabSize,
    trimTrailingWhitespace: true,
    ...(range === undefined ? {} : { range }),
  }).map((edit): TextEdit => ({
    range: toRange(document, edit.span),
    newText: edit.newText,
  }));
}

function addSemanticTokens(
  builder: SemanticTokensBuilder,
  document: TextDocument,
  node: SyntaxNode,
): void {
  if (node.kind === "comment") {
    pushToken(builder, document, node.span, 3, 0);
  } else if (node.kind === "section") {
    pushToken(builder, document, node.nameSpan, 0, 0);
  } else if (node.kind === "assignment") {
    pushToken(builder, document, node.nameSpan, 0, node.definition?.deprecated === true ? 1 : 0);
    const type = ["number", "duration", "size"].includes(node.definition?.valueKind ?? "") ? 2 : 1;
    pushToken(builder, document, node.valueSpan, type, 0);
  } else if (node.kind === "record") {
    for (const span of node.fieldSpans) pushToken(builder, document, span, 4, 0);
  }
}

function pushToken(
  builder: SemanticTokensBuilder,
  document: TextDocument,
  span: TextSpan,
  tokenType: number,
  tokenModifiers: number,
): void {
  const start = document.positionAt(span.start);
  const end = document.positionAt(span.end);
  if (start.line === end.line && end.character > start.character) {
    builder.push(
      start.line,
      start.character,
      end.character - start.character,
      tokenType,
      tokenModifiers,
    );
  }
}

function closestDefinition(
  name: string,
  definitions: readonly DirectiveDefinition[],
): DirectiveDefinition | undefined {
  let best: { definition: DirectiveDefinition; distance: number } | undefined;
  for (const definition of definitions) {
    const distance = editDistance(name.toLowerCase(), definition.name.toLowerCase());
    if (best === undefined || distance < best.distance) best = { definition, distance };
  }
  return best !== undefined && best.distance <= Math.max(2, Math.floor(name.length / 3))
    ? best.definition
    : undefined;
}

function editDistance(left: string, right: string): number {
  let previous = [...Array(right.length + 1).keys()];
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) {
      current[column] = Math.min(
        (current[column - 1] ?? 0) + 1,
        (previous[column] ?? 0) + 1,
        (previous[column - 1] ?? 0) + (left[row - 1] === right[column - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length] ?? right.length;
}

function wordRangeAt(document: TextDocument, position: Position): Range | null {
  const source = document.getText();
  const offset = document.offsetAt(position);
  let start = offset;
  let end = offset;
  while (start > 0 && /[A-Za-z0-9_.@:-]/u.test(source[start - 1] ?? "")) start -= 1;
  while (end < source.length && /[A-Za-z0-9_.@:-]/u.test(source[end] ?? "")) end += 1;
  return start === end ? null : toRange(document, { start, end });
}

function wordAt(document: TextDocument, position: Position): string {
  const range = wordRangeAt(document, position);
  return range === null ? "" : document.getText(range);
}

function basename(uri: string): string {
  const normalized = decodeURIComponent(uri).replaceAll("\\", "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

function isUnitIdentity(identity: string): boolean {
  return /\.(?:service|socket|timer|path|mount|automount|swap|target|device|slice|scope)$/u.test(
    identity,
  );
}

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n\0]+/gu, " ").slice(0, 2000);
}
