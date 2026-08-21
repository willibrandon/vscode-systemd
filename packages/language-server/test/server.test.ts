import { PassThrough } from "node:stream";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node";
import type { MessageConnection } from "vscode-jsonrpc/node";
import { createConnection } from "vscode-languageserver/node";
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
  InitializeResult,
  Location,
  SelectionRange,
  SemanticTokens,
  SignatureHelp,
  SymbolInformation,
  TextEdit,
  WorkspaceEdit,
} from "vscode-languageserver";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startLanguageServer } from "../src/server.js";

const uri = "file:///workspace/demo.service";
const source = [
  "[Unit]",
  "Description = Demo",
  "Wants=other.service",
  "Documentation=file:/etc/demo.conf https://example.test/help",
  "",
  "[Service]",
  "ExecStart=/bin/echo %n %x %% %i",
  "DynamicUser=",
  "Restar=yes",
  "",
].join("\n");

describe("language server JSON-RPC contract", () => {
  let client: MessageConnection;
  let clientInput: PassThrough;
  let server: Connection;
  let serverInput: PassThrough;

  beforeEach(async () => {
    clientInput = new PassThrough();
    serverInput = new PassThrough();
    server = createConnection(
      new StreamMessageReader(serverInput),
      new StreamMessageWriter(clientInput),
    );
    startLanguageServer(server, {
      setTimeout(callback, milliseconds): ReturnType<typeof setTimeout> {
        return setTimeout(callback, milliseconds);
      },
      clearTimeout(handle): void {
        clearTimeout(handle as ReturnType<typeof setTimeout>);
      },
    });
    client = createMessageConnection(
      new StreamMessageReader(clientInput),
      new StreamMessageWriter(serverInput),
    );
    client.listen();
    const initialization = await client.sendRequest<InitializeResult>("initialize", {
      processId: null,
      rootUri: "file:///workspace",
      capabilities: {},
      clientInfo: { name: "contract test" },
    });
    expect(initialization.capabilities.completionProvider).toMatchObject({
      resolveProvider: true,
    });
    expect(initialization.capabilities.hoverProvider).toBe(true);
    expect(initialization.capabilities.renameProvider).toEqual({ prepareProvider: true });
    expect(initialization.capabilities.codeLensProvider).toEqual({ resolveProvider: false });
    expect(initialization.capabilities.inlayHintProvider).toBe(true);
    await client.sendNotification("initialized", {});
    await client.sendNotification("systemd/index/documents", {
      replace: true,
      documents: [
        {
          uri: "file:///workspace/other.service",
          languageId: "systemd-unit",
          source: "[Unit]\nDescription=Other\n[Service]\nExecStart=/bin/true\n",
          mtime: 1,
        },
      ],
    });
  });

  afterEach(async () => {
    await client.sendNotification("textDocument/didClose", { textDocument: { uri } });
    await client.sendRequest("shutdown");
    server.dispose();
    client.dispose();
    clientInput.destroy();
    serverInput.destroy();
  });

  it("serves diagnostics and editing features", async () => {
    const diagnosticsPromise = nextDiagnostics(client);
    await client.sendNotification("textDocument/didOpen", {
      textDocument: { uri, languageId: "systemd-unit", version: 1, text: source },
    });
    const diagnostics = await diagnosticsPromise;
    expect(diagnostics.map((item) => item.code)).toContain("unknown-setting");

    const completion = await request<CompletionItem[]>(client, "textDocument/completion", {
      textDocument: { uri },
      position: { line: 9, character: 0 },
    });
    expect(completion.some((item) => item.label === "Restart")).toBe(true);
    const restart = completion.find((item) => item.label === "Restart");
    expect(restart?.documentation).toBeUndefined();
    const resolvedRestart = await request<CompletionItem>(
      client,
      "completionItem/resolve",
      restart,
    );
    expect(JSON.stringify(resolvedRestart.documentation)).toContain("Official documentation");
    await expect(
      request<CompletionItem>(client, "completionItem/resolve", { label: "unresolved" }),
    ).resolves.toEqual({ label: "unresolved" });
    const missingResolution = await request<CompletionItem>(client, "completionItem/resolve", {
      label: "Missing",
      data: {
        kind: "directive",
        dialect: "systemd-unit",
        section: "Service",
        name: "DefinitelyMissing",
      },
    });
    expect(missingResolution.documentation).toBeUndefined();

    const sectionCompletion = await request<CompletionItem[]>(client, "textDocument/completion", {
      textDocument: { uri },
      position: { line: 0, character: 3 },
    });
    expect(sectionCompletion.some((item) => item.label === "Unit")).toBe(true);

    const valueCompletion = await request<CompletionItem[]>(client, "textDocument/completion", {
      textDocument: { uri },
      position: { line: 7, character: 12 },
    });
    expect(valueCompletion.map(({ label }) => label)).toEqual(["yes", "no"]);

    const referenceCompletion = await request<CompletionItem[]>(client, "textDocument/completion", {
      textDocument: { uri },
      position: { line: 2, character: 6 },
    });
    expect(referenceCompletion.map(({ label }) => label)).toContain("other.service");

    const mkosiUri = "file:///workspace/mkosi.conf";
    await client.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri: mkosiUri,
        languageId: "mkosi",
        version: 1,
        text: "[Distribution]\nDistribution=\n",
      },
    });
    const mkosiValues = await request<CompletionItem[]>(client, "textDocument/completion", {
      textDocument: { uri: mkosiUri },
      position: { line: 1, character: 13 },
    });
    expect(mkosiValues.map(({ label }) => label)).toEqual(
      expect.arrayContaining(["fedora", "debian", "arch", "rhel-ubi"]),
    );
    expect(mkosiValues.some(({ label }) => label === "")).toBe(false);
    const mkosiLenses = await request<CodeLens[]>(client, "textDocument/codeLens", {
      textDocument: { uri: mkosiUri },
    });
    expect(mkosiLenses.map(({ command }) => command?.command)).toEqual([
      "systemd.showEffectiveConfiguration",
    ]);
    await client.sendNotification("textDocument/didClose", { textDocument: { uri: mkosiUri } });

    const hover = await request<Hover | null>(client, "textDocument/hover", {
      textDocument: { uri },
      position: { line: 1, character: 3 },
    });
    expect(JSON.stringify(hover)).toContain("Description");

    const sectionHover = await request<Hover | null>(client, "textDocument/hover", {
      textDocument: { uri },
      position: { line: 0, character: 2 },
    });
    expect(JSON.stringify(sectionHover)).toContain("[Unit] section");

    const signature = await request<SignatureHelp | null>(client, "textDocument/signatureHelp", {
      textDocument: { uri },
      position: { line: 1, character: 15 },
    });
    expect(signature?.signatures[0]?.label).toContain("Description");

    const symbols = await request<DocumentSymbol[]>(client, "textDocument/documentSymbol", {
      textDocument: { uri },
    });
    expect(symbols.map((symbol) => symbol.name)).toEqual(["[Unit]", "[Service]"]);

    const workspaceSymbols = await request<SymbolInformation[]>(client, "workspace/symbol", {
      query: "exec",
    });
    expect(workspaceSymbols.some((symbol) => symbol.name === "ExecStart")).toBe(true);

    const folds = await request<FoldingRange[]>(client, "textDocument/foldingRange", {
      textDocument: { uri },
    });
    expect(folds).toHaveLength(2);

    const selections = await request<SelectionRange[]>(client, "textDocument/selectionRange", {
      textDocument: { uri },
      positions: [{ line: 1, character: 3 }],
    });
    expect(selections[0]?.parent).toBeDefined();

    const links = await request<DocumentLink[]>(client, "textDocument/documentLink", {
      textDocument: { uri },
    });
    expect(links.map(({ target }) => target)).toEqual([
      "file:/etc/demo.conf",
      "https://example.test/help",
    ]);

    const highlights = await request<DocumentHighlight[]>(
      client,
      "textDocument/documentHighlight",
      {
        textDocument: { uri },
        position: { line: 1, character: 3 },
      },
    );
    expect(highlights).toHaveLength(1);

    const formatting = await request<TextEdit[]>(client, "textDocument/formatting", {
      textDocument: { uri },
      options: { insertSpaces: true, tabSize: 2 },
    });
    expect(formatting.some((edit) => edit.newText === "Description=Demo")).toBe(true);

    const rangeFormatting = await request<TextEdit[]>(client, "textDocument/rangeFormatting", {
      textDocument: { uri },
      range: {
        start: { line: 0, character: 0 },
        end: { line: 2, character: 0 },
      },
      options: { insertSpaces: true, tabSize: 2 },
    });
    expect(rangeFormatting.length).toBeGreaterThan(0);

    const tokens = await request<SemanticTokens>(client, "textDocument/semanticTokens/full", {
      textDocument: { uri },
    });
    expect(tokens.data.length).toBeGreaterThan(0);

    const hints = await request<InlayHint[]>(client, "textDocument/inlayHint", {
      textDocument: { uri },
      range: {
        start: { line: 0, character: 0 },
        end: { line: 9, character: 0 },
      },
    });
    expect(hints.map(({ label }) => label)).toEqual([
      " = full unit name",
      " = literal %",
      " = instance name",
    ]);
    expect(
      await request<InlayHint[]>(client, "textDocument/inlayHint", {
        textDocument: { uri: "file:///workspace/missing.service" },
        range: {
          start: { line: 0, character: 0 },
          end: { line: 1, character: 0 },
        },
      }),
    ).toEqual([]);
    expect(
      await request<InlayHint[]>(client, "textDocument/inlayHint", {
        textDocument: { uri },
        range: {
          start: { line: 0, character: 0 },
          end: { line: 1, character: 0 },
        },
      }),
    ).toEqual([]);

    const lenses = await request<CodeLens[]>(client, "textDocument/codeLens", {
      textDocument: { uri },
    });
    expect(lenses.map(({ command }) => command?.command)).toEqual([
      "systemd.showEffectiveConfiguration",
      "systemd.showDependencyGraph",
    ]);

    const otherUri = "file:///workspace/other.service";
    await client.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri: otherUri,
        languageId: "systemd-unit",
        version: 1,
        text: "[Unit]\nDescription=Other\n[Service]\nExecStart=/bin/true\n",
      },
    });
    const otherLenses = await request<CodeLens[]>(client, "textDocument/codeLens", {
      textDocument: { uri: otherUri },
    });
    expect(otherLenses[1]?.command?.title).toContain("1 incoming reference");
    await client.sendNotification("textDocument/didClose", { textDocument: { uri: otherUri } });

    const tmpfilesUri = "file:///workspace/tmpfiles.d/demo.conf";
    await client.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri: tmpfilesUri,
        languageId: "systemd-tmpfiles",
        version: 1,
        text: "d /run/demo 0755 root root -\n",
      },
    });
    expect(
      await request<CodeLens[]>(client, "textDocument/codeLens", {
        textDocument: { uri: tmpfilesUri },
      }),
    ).toEqual([]);
    await client.sendNotification("textDocument/didClose", {
      textDocument: { uri: tmpfilesUri },
    });

    const quickFixes = await request<CodeAction[]>(client, "textDocument/codeAction", {
      textDocument: { uri },
      range: diagnostics.find((item) => item.code === "unknown-setting")?.range,
      context: { diagnostics },
    });
    expect(quickFixes.length).toBeGreaterThan(0);

    const missing = { textDocument: { uri: "file:///workspace/missing.service" } };
    expect(
      await request(client, "textDocument/completion", {
        ...missing,
        position: { line: 0, character: 0 },
      }),
    ).toEqual([]);
    expect(
      await request(client, "textDocument/hover", {
        ...missing,
        position: { line: 0, character: 0 },
      }),
    ).toBeNull();
    expect(
      await request(client, "textDocument/signatureHelp", {
        ...missing,
        position: { line: 0, character: 0 },
      }),
    ).toBeNull();
    expect(await request(client, "textDocument/documentSymbol", missing)).toEqual([]);
    expect(await request(client, "textDocument/foldingRange", missing)).toEqual([]);
    expect(
      await request(client, "textDocument/selectionRange", { ...missing, positions: [] }),
    ).toEqual([]);
    expect(await request(client, "textDocument/documentLink", missing)).toEqual([]);
    expect(
      await request(client, "textDocument/definition", {
        ...missing,
        position: { line: 0, character: 0 },
      }),
    ).toEqual([]);
    expect(
      await request(client, "textDocument/references", {
        ...missing,
        position: { line: 0, character: 0 },
        context: { includeDeclaration: true },
      }),
    ).toEqual([]);
    expect(
      await request(client, "textDocument/documentHighlight", {
        ...missing,
        position: { line: 0, character: 0 },
      }),
    ).toEqual([]);
    expect(
      await request(client, "textDocument/formatting", {
        ...missing,
        options: { insertSpaces: true, tabSize: 2 },
      }),
    ).toEqual([]);
    expect(
      (await request<SemanticTokens>(client, "textDocument/semanticTokens/full", missing)).data,
    ).toEqual([]);
    expect(
      await request(client, "textDocument/codeAction", {
        ...missing,
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        context: { diagnostics: [] },
      }),
    ).toEqual([]);
    expect(
      await request(client, "textDocument/prepareRename", {
        ...missing,
        position: { line: 0, character: 0 },
      }),
    ).toBeNull();
    expect(
      await request(client, "textDocument/rename", {
        ...missing,
        position: { line: 0, character: 0 },
        newName: "new.service",
      }),
    ).toEqual({ changes: {} });
  });

  it("serves cross-file navigation and custom analysis", async () => {
    const diagnosticsPromise = nextDiagnostics(client);
    await client.sendNotification("textDocument/didOpen", {
      textDocument: { uri, languageId: "systemd-unit", version: 1, text: source },
    });
    await diagnosticsPromise;

    const definitions = await request<Location[]>(client, "textDocument/definition", {
      textDocument: { uri },
      position: { line: 2, character: 10 },
    });
    expect(definitions[0]?.uri).toBe("file:///workspace/other.service");

    const references = await request<Location[]>(client, "textDocument/references", {
      textDocument: { uri },
      position: { line: 2, character: 10 },
      context: { includeDeclaration: true },
    });
    expect(references.some((location) => location.uri === uri)).toBe(true);

    const prepare = await request(client, "textDocument/prepareRename", {
      textDocument: { uri },
      position: { line: 2, character: 10 },
    });
    expect(prepare).not.toBeNull();

    const rename = await request<WorkspaceEdit>(client, "textDocument/rename", {
      textDocument: { uri },
      position: { line: 2, character: 10 },
      newName: "replacement.service",
    });
    expect(rename.changes?.[uri]?.[0]?.newText).toBe("replacement.service");

    const invalidRename = await request<WorkspaceEdit>(client, "textDocument/rename", {
      textDocument: { uri },
      position: { line: 2, character: 10 },
      newName: "invalid name",
    });
    expect(invalidRename).toEqual({ changes: {} });

    expect(
      await request(client, "textDocument/definition", {
        textDocument: { uri },
        position: { line: 2, character: 2 },
      }),
    ).toEqual([]);
    expect(
      await request(client, "textDocument/prepareRename", {
        textDocument: { uri },
        position: { line: 2, character: 2 },
      }),
    ).toBeNull();

    const detected = await request(client, "systemd/detectDialect", {
      uri: "file:///workspace/example.container",
      source: "[Container]\nImage=alpine\n",
    });
    expect(detected).toBe("podman-quadlet");
    expect(
      await request(client, "systemd/detectDialect", {
        uri: "untitled:unknown",
        source: "plain text",
      }),
    ).toBeNull();

    const effective = await request<string>(client, "systemd/effectiveConfiguration", {
      uri,
    });
    expect(effective).toContain("Description=Demo");

    const graph = await request<{
      readonly nodes: readonly string[];
      readonly edges: readonly { readonly target: string }[];
    }>(client, "systemd/dependencyGraph", { uri });
    expect(graph.edges.some((edge) => edge.target === "other.service")).toBe(true);
    const allGraph = await request<{
      readonly nodes: readonly string[];
      readonly edges: readonly { readonly target: string }[];
    }>(client, "systemd/dependencyGraph", {});
    expect(allGraph.nodes).toContain("other.service");
    expect(allGraph.edges.some((edge) => edge.target.includes("example.test"))).toBe(false);

    const indexedDiagnostics = nextDiagnostics(client);
    await client.sendNotification("systemd/index/documents", {
      replace: false,
      documents: [
        {
          uri: "file:///workspace/third.service",
          languageId: "systemd-unit",
          source: "[Unit]\nDescription=Third\n",
          mtime: 2,
        },
      ],
    });
    expect(
      (
        await request<SymbolInformation[]>(client, "workspace/symbol", { query: "description" })
      ).some(({ location }) => location.uri === "file:///workspace/third.service"),
    ).toBe(true);
    expect((await indexedDiagnostics).map(({ code }) => code)).toContain("unknown-setting");

    const clearedPromise = nextDiagnostics(client);
    await client.sendNotification("workspace/didChangeConfiguration", {
      settings: { systemd: { validation: { enable: false, maxProblems: 20 } } },
    });
    await client.sendNotification("systemd/diagnostics/refresh", { uri });
    expect(await clearedPromise).toEqual([]);

    const changedPromise = nextDiagnostics(client);
    await client.sendNotification("textDocument/didChange", {
      textDocument: { uri, version: 2 },
      contentChanges: [{ text: source.replace("Restar=yes", "Restart=yes") }],
    });
    await client.sendNotification("systemd/diagnostics/refresh", {});
    expect(await changedPromise).toEqual([]);
  });

  it("reports the indexed workspace and resolves effective source precedence", async () => {
    await client.sendNotification("systemd/index/documents", {
      replace: true,
      documents: [
        {
          uri: "file:///usr/lib/systemd/system/worker@.service",
          languageId: "systemd-unit",
          source: "[Unit]\nDescription=Vendor\n[Service]\nEnvironment=BASE=1\n",
          mtime: 1,
        },
        {
          uri: "file:///etc/systemd/system/service.d/10-default.conf",
          languageId: "systemd-unit",
          source: "[Service]\nEnvironment=DEFAULT=1\n",
          mtime: 2,
        },
        {
          uri: "file:///etc/systemd/system/worker@blue.service.d/20-local.conf",
          languageId: "systemd-unit",
          source: "[Unit]\nWants=database.service\n[Service]\nEnvironment=LOCAL=1\n",
          mtime: 3,
        },
        {
          uri: "file:///workspace/orphan.service.d/override.conf",
          languageId: "systemd-unit",
          source: "[Service]\nEnvironment=ORPHAN=1\n",
          mtime: 4,
        },
        {
          uri: "file:///etc/systemd/system/masked.service",
          languageId: "systemd-unit",
          source: "",
          mtime: 5,
        },
      ],
    });

    const effective = await request<string>(client, "systemd/effectiveConfiguration", {
      uri: "file:///workspace/worker@blue.service",
    });
    expect(effective).toContain("Description=Vendor");
    expect(effective).toContain("Environment=DEFAULT=1");
    expect(effective).toContain("Environment=LOCAL=1");
    expect(effective.indexOf("10-default.conf")).toBeLessThan(effective.indexOf("20-local.conf"));

    const snapshot = await request<{
      readonly configurations: readonly {
        readonly identity: string;
        readonly baseUri?: string;
        readonly dropInUris: readonly string[];
      }[];
      readonly documents: readonly {
        readonly uri: string;
        readonly references: readonly { readonly target: string }[];
      }[];
    }>(client, "systemd/workspaceSnapshot", {});
    const configuration = snapshot.configurations.find(
      ({ identity }) => identity === "worker@blue.service",
    );
    expect(configuration?.baseUri).toBe("file:///usr/lib/systemd/system/worker@.service");
    expect(configuration?.dropInUris).toEqual([
      "file:///etc/systemd/system/service.d/10-default.conf",
      "file:///etc/systemd/system/worker@blue.service.d/20-local.conf",
    ]);
    expect(
      snapshot.documents
        .find(({ uri }) => uri.endsWith("20-local.conf"))
        ?.references.map(({ target }) => target),
    ).toContain("database.service");
    const orphan = snapshot.configurations.find(({ identity }) => identity === "orphan.service");
    expect(orphan?.baseUri).toBeUndefined();
    expect(orphan).toMatchObject({
      dropInUris: [
        "file:///etc/systemd/system/service.d/10-default.conf",
        "file:///workspace/orphan.service.d/override.conf",
      ],
    });

    const masked = await request<string>(client, "systemd/effectiveConfiguration", {
      uri: "file:///workspace/masked.service",
    });
    expect(masked).toContain("Unit is masked by file:///etc/systemd/system/masked.service");
  });

  it("publishes and clears cross-file ordering-cycle diagnostics", async () => {
    await client.sendNotification("systemd/index/documents", {
      replace: true,
      documents: [
        {
          uri: "file:///workspace/other.service",
          languageId: "systemd-unit",
          source: "[Unit]\nAfter=demo.service\n[Service]\nExecStart=/bin/true\n",
          mtime: 1,
        },
      ],
    });
    const cycleDiagnostics = nextDiagnostics(client);
    await client.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId: "systemd-unit",
        version: 1,
        text: "[Unit]\nAfter=other.service\n[Service]\nExecStart=/bin/true\n",
      },
    });
    const diagnostics = await cycleDiagnostics;
    const cycle = diagnostics.find(({ code }) => code === "ordering-cycle");
    expect(cycle?.message).toContain("demo.service, other.service");
    expect(cycle?.relatedInformation?.[0]?.location.uri).toBe("file:///workspace/other.service");

    const clearedDiagnostics = nextDiagnostics(client);
    await client.sendNotification("textDocument/didChange", {
      textDocument: { uri, version: 2 },
      contentChanges: [{ text: "[Unit]\nDescription=No cycle\n[Service]\nExecStart=/bin/true\n" }],
    });
    expect((await clearedDiagnostics).map(({ code }) => code)).not.toContain("ordering-cycle");
  });
});

async function request<T = unknown>(
  client: MessageConnection,
  method: string,
  params: unknown,
): Promise<T> {
  return client.sendRequest<T>(method, params);
}

function nextDiagnostics(client: MessageConnection): Promise<Diagnostic[]> {
  return new Promise((resolve) => {
    const disposable = client.onNotification(
      "textDocument/publishDiagnostics",
      (params: { readonly uri: string; readonly diagnostics: Diagnostic[] }): void => {
        if (params.uri !== uri) return;
        disposable.dispose();
        resolve(params.diagnostics);
      },
    );
  });
}
