import { PassThrough } from "node:stream";
import {
  CancellationTokenSource,
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node";
import type { CancellationToken, MessageConnection } from "vscode-jsonrpc/node";
import { createConnection } from "vscode-languageserver/node";
import { CompletionItemKind, SymbolKind } from "vscode-languageserver";
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
  Range,
  SelectionRange,
  SemanticTokens,
  SignatureHelp,
  SymbolInformation,
  TextEdit,
  WorkspaceEdit,
} from "vscode-languageserver";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startLanguageServer } from "../src/server.js";
import { readDirectoryRequest } from "../src/protocol.js";

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
  let workspaceDirectories: Map<
    string,
    readonly { readonly name: string; readonly type: "file" | "directory" | "other" }[]
  >;
  let directoryRequests: string[];
  let directoryResponder: (
    uri: string,
    token: CancellationToken,
  ) =>
    | readonly { readonly name: string; readonly type: "file" | "directory" | "other" }[]
    | Promise<readonly { readonly name: string; readonly type: "file" | "directory" | "other" }[]>;

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
    workspaceDirectories = new Map();
    directoryRequests = [];
    directoryResponder = (requestedUri) => workspaceDirectories.get(requestedUri) ?? [];
    client.onRequest(readDirectoryRequest, ({ uri: requestedUri }, token) => {
      directoryRequests.push(requestedUri);
      return directoryResponder(requestedUri, token);
    });
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
          workspaceOwned: true,
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
    expect(sectionCompletion.some((item) => item.label === "Service")).toBe(true);
    expect(sectionCompletion.some((item) => item.label === "Socket")).toBe(false);

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
    expect(
      quickFixes.some(
        ({ title, kind, command }) =>
          title === "Create workspace unit drop-in" &&
          kind === "refactor.rewrite" &&
          command?.command === "systemd.createDropIn",
      ),
    ).toBe(true);
    expect(
      quickFixes.some(({ title, kind }) => title === "Change to Restart=" && kind === "quickfix"),
    ).toBe(true);

    const virtualUri = "systemd-effective://workspace/demo/demo.service";
    await client.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri: virtualUri,
        languageId: "systemd-unit",
        version: 1,
        text: "[Unit]\nDescription=Stale virtual output\n",
      },
    });
    const effectiveSource = await request<string>(client, "systemd/effectiveConfiguration", {
      uri,
    });
    expect(effectiveSource).toContain("Description=Demo");
    expect(effectiveSource).not.toContain("Stale virtual output");
    expect(
      await request(client, "textDocument/completion", {
        textDocument: { uri: virtualUri },
        position: { line: 1, character: 0 },
      }),
    ).toEqual([]);
    await client.sendNotification("textDocument/didClose", { textDocument: { uri: virtualUri } });

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

  it("serves source-backed completions, hover, and signatures for systemd JSON", async () => {
    const jsonUri = "file:///workspace/demo.user";
    await client.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri: jsonUri,
        languageId: "systemd-json",
        version: 1,
        text: "{\n  \n}\n",
      },
    });

    const properties = await request<CompletionItem[]>(client, "textDocument/completion", {
      textDocument: { uri: jsonUri },
      position: { line: 1, character: 2 },
    });
    expect(properties.length).toBeGreaterThan(90);
    expect(properties.find(({ label }) => label === "userName")).toMatchObject({
      insertText: '"userName": "${1}"',
      kind: CompletionItemKind.Property,
    });
    expect(properties.map(({ label }) => label)).not.toContain("secret");

    const userSource = '{"disposition": "dyn"}';
    await client.sendNotification("textDocument/didChange", {
      textDocument: { uri: jsonUri, version: 2 },
      contentChanges: [{ text: userSource }],
    });
    const values = await request<CompletionItem[]>(client, "textDocument/completion", {
      textDocument: { uri: jsonUri },
      position: { line: 0, character: 20 },
    });
    expect(values.map(({ label }) => label)).toEqual(
      expect.arrayContaining(["dynamic", "regular", "system"]),
    );
    expect(values.find(({ label }) => label === "dynamic")?.textEdit).toEqual({
      range: {
        start: { line: 0, character: 17 },
        end: { line: 0, character: 20 },
      },
      newText: "dynamic",
    });

    const hover = await request<Hover | null>(client, "textDocument/hover", {
      textDocument: { uri: jsonUri },
      position: { line: 0, character: 5 },
    });
    expect(JSON.stringify(hover)).toContain("disposition");
    expect(JSON.stringify(hover)).toContain("Official documentation");
    const signature = await request<SignatureHelp | null>(client, "textDocument/signatureHelp", {
      textDocument: { uri: jsonUri },
      position: { line: 0, character: 20 },
    });
    expect(signature?.signatures[0]?.label).toBe('"disposition": <string>');

    const typedUserSource = '{"userName":"demo","uid":1000,"locked":true,"rebalanceWeight":null}';
    await client.sendNotification("textDocument/didChange", {
      textDocument: { uri: jsonUri, version: 3 },
      contentChanges: [{ text: typedUserSource }],
    });
    const typedSymbols = await request<DocumentSymbol[]>(client, "textDocument/documentSymbol", {
      textDocument: { uri: jsonUri },
    });
    expect(typedSymbols.map(({ name, kind }) => [name, kind])).toEqual([
      ["userName", SymbolKind.String],
      ["uid", SymbolKind.Number],
      ["locked", SymbolKind.Boolean],
      ["rebalanceWeight", SymbolKind.Null],
    ]);
    const typedSemantics = await request<SemanticTokens>(
      client,
      "textDocument/semanticTokens/full",
      { textDocument: { uri: jsonUri } },
    );
    expect(typedSemantics.data.length).toBeGreaterThan(typedSymbols.length * 5);

    const booleanSource = '{"locked": }';
    await client.sendNotification("textDocument/didChange", {
      textDocument: { uri: jsonUri, version: 4 },
      contentChanges: [{ text: booleanSource }],
    });
    const booleanValues = await request<CompletionItem[]>(client, "textDocument/completion", {
      textDocument: { uri: jsonUri },
      position: { line: 0, character: booleanSource.indexOf("}") },
    });
    expect(booleanValues.map(({ label }) => label)).toEqual(["true", "false"]);

    const membershipUri = "file:///workspace/demo.membership";
    await client.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri: membershipUri,
        languageId: "systemd-json",
        version: 1,
        text: "{\n  \n}",
      },
    });
    await expect(
      request<CompletionItem[]>(client, "textDocument/completion", {
        textDocument: { uri: membershipUri },
        position: { line: 1, character: 2 },
      }),
    ).resolves.toEqual([]);
    await expect(
      request<Hover | null>(client, "textDocument/hover", {
        textDocument: { uri: membershipUri },
        position: { line: 0, character: 0 },
      }),
    ).resolves.toBeNull();

    const pcrlockUri = "file:///workspace/demo.pcrlock";
    const pcrlockSource = '[{"digests": [{\n  \n}]}]';
    await client.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri: pcrlockUri,
        languageId: "systemd-json",
        version: 1,
        text: pcrlockSource,
      },
    });
    const digestFields = await request<CompletionItem[]>(client, "textDocument/completion", {
      textDocument: { uri: pcrlockUri },
      position: { line: 1, character: 2 },
    });
    expect(digestFields.map(({ label }) => label)).toEqual(["hashAlg", "digest"]);
    const jsonSymbols = await request<DocumentSymbol[]>(client, "textDocument/documentSymbol", {
      textDocument: { uri: pcrlockUri },
    });
    expect(jsonSymbols[0]).toMatchObject({
      name: "[0]",
      children: [{ name: "digests", children: [{ name: "[0]" }] }],
    });
    const jsonWorkspaceSymbols = await request<SymbolInformation[]>(client, "workspace/symbol", {
      query: "digest",
    });
    const digestSymbol = jsonWorkspaceSymbols.find(({ name }) => name === "digests");
    expect(digestSymbol).toMatchObject({ name: "digests" });
    expect(digestSymbol?.location.uri).toBe(pcrlockUri);
    const jsonFolds = await request<FoldingRange[]>(client, "textDocument/foldingRange", {
      textDocument: { uri: pcrlockUri },
    });
    expect(jsonFolds.length).toBeGreaterThan(0);
    const jsonSelections = await request<SelectionRange[]>(client, "textDocument/selectionRange", {
      textDocument: { uri: pcrlockUri },
      positions: [{ line: 1, character: 1 }],
    });
    expect(jsonSelections[0]?.parent?.parent).toBeDefined();
    const jsonSemantics = await request<SemanticTokens>(
      client,
      "textDocument/semanticTokens/full",
      { textDocument: { uri: pcrlockUri } },
    );
    expect(jsonSemantics.data.length).toBeGreaterThan(0);
    const jsonFormatting = await request<TextEdit[]>(client, "textDocument/formatting", {
      textDocument: { uri: pcrlockUri },
      options: { insertSpaces: true, tabSize: 2 },
    });
    expect(jsonFormatting.length).toBeGreaterThan(0);

    const rrUri = "file:///workspace/demo.rr";
    await client.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri: rrUri,
        languageId: "systemd-json",
        version: 1,
        text: '{"key": {"type": }}',
      },
    });
    const recordTypes = await request<CompletionItem[]>(client, "textDocument/completion", {
      textDocument: { uri: rrUri },
      position: { line: 0, character: 17 },
    });
    expect(recordTypes.map(({ label }) => label)).toEqual(["1", "2", "5", "12", "28", "39"]);

    await client.sendNotification("textDocument/didClose", { textDocument: { uri: jsonUri } });
    await client.sendNotification("textDocument/didClose", {
      textDocument: { uri: membershipUri },
    });
    await client.sendNotification("textDocument/didClose", { textDocument: { uri: pcrlockUri } });
    await client.sendNotification("textDocument/didClose", { textDocument: { uri: rrUri } });
  });

  it("serves field-aware intelligence for line-oriented formats", async () => {
    const tmpfilesUri = "file:///workspace/tmpfiles.d/demo.conf";
    await client.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri: tmpfilesUri,
        languageId: "systemd-tmpfiles",
        version: 1,
        text: "d /run/demo 0755 root root -\n",
      },
    });
    const tmpfileTypes = await request<CompletionItem[]>(client, "textDocument/completion", {
      textDocument: { uri: tmpfilesUri },
      position: { line: 1, character: 0 },
    });
    expect(tmpfileTypes.map(({ label }) => label)).toEqual(
      expect.arrayContaining(["f+", "d", "L?", "K"]),
    );
    const tmpfilesHover = await request<Hover | null>(client, "textDocument/hover", {
      textDocument: { uri: tmpfilesUri },
      position: { line: 0, character: 4 },
    });
    expect(JSON.stringify(tmpfilesHover)).toContain("Absolute path or glob");
    const tmpfilesSignature = await request<SignatureHelp | null>(
      client,
      "textDocument/signatureHelp",
      {
        textDocument: { uri: tmpfilesUri },
        position: { line: 0, character: 23 },
      },
    );
    expect(tmpfilesSignature?.signatures[0]?.label).toBe(
      "Type Path [Mode] [User] [Group] [Age] [Argument]",
    );

    const loaderUri = "file:///workspace/boot/loader/loader.conf";
    await client.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri: loaderUri,
        languageId: "systemd-boot",
        version: 1,
        text: "editor \n",
      },
    });
    const loaderValues = await request<CompletionItem[]>(client, "textDocument/completion", {
      textDocument: { uri: loaderUri },
      position: { line: 0, character: 7 },
    });
    expect(loaderValues.map(({ label }) => label)).toEqual(["yes", "no"]);
    const loaderOptions = await request<CompletionItem[]>(client, "textDocument/completion", {
      textDocument: { uri: loaderUri },
      position: { line: 1, character: 0 },
    });
    expect(loaderOptions.map(({ label }) => label)).toEqual(
      expect.arrayContaining(["timeout", "editor", "secure-boot-enroll", "console-mode"]),
    );

    const installUri = "file:///workspace/etc/kernel/install.conf";
    await client.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri: installUri,
        languageId: "systemd-boot",
        version: 1,
        text: "layout=\n",
      },
    });
    const installValues = await request<CompletionItem[]>(client, "textDocument/completion", {
      textDocument: { uri: installUri },
      position: { line: 0, character: 7 },
    });
    expect(installValues.map(({ label }) => label)).toEqual(["auto", "bls", "uki", "other"]);
    const installSettings = await request<CompletionItem[]>(client, "textDocument/completion", {
      textDocument: { uri: installUri },
      position: { line: 1, character: 0 },
    });
    expect(installSettings.map(({ label }) => label)).toEqual(
      expect.arrayContaining(["MACHINE_ID", "BOOT_ROOT", "layout", "uki_generator"]),
    );
    const installHover = await request<Hover | null>(client, "textDocument/hover", {
      textDocument: { uri: installUri },
      position: { line: 0, character: 2 },
    });
    expect(JSON.stringify(installHover)).toContain("Boot-entry layout");
    for (const openUri of [tmpfilesUri, loaderUri, installUri]) {
      await client.sendNotification("textDocument/didClose", { textDocument: { uri: openUri } });
    }
  });

  it("completes source-generated systemd value catalogs and all unit specifiers", async () => {
    const catalogUri = "file:///workspace/catalog.service";
    const catalogSource = [
      "[Service]",
      "ExecStart=/bin/echo %",
      "KillSignal=",
      "CapabilityBoundingSet=",
      "SystemCallFilter=",
      "RestrictAddressFamilies=",
      "TimeoutStopSec=",
      "MemoryMax=",
      "",
    ].join("\n");
    await client.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri: catalogUri,
        languageId: "systemd-unit",
        version: 1,
        text: catalogSource,
      },
    });

    const completionLabels = async (line: number, character: number): Promise<string[]> =>
      (
        await request<CompletionItem[]>(client, "textDocument/completion", {
          textDocument: { uri: catalogUri },
          position: { line, character },
        })
      ).map(({ label }) => label);

    const specifiers = await request<CompletionItem[]>(client, "textDocument/completion", {
      textDocument: { uri: catalogUri },
      position: { line: 1, character: 21 },
    });
    expect(specifiers.map(({ label }) => label)).toEqual(
      expect.arrayContaining(["%a", "%A", "%d", "%n", "%y", "%Y", "%%"]),
    );
    expect(specifiers.find(({ label }) => label === "%n")?.insertText).toBe("n");
    expect(await completionLabels(2, 11)).toEqual(
      expect.arrayContaining(["SIGTERM", "SIGKILL", "SIGRTMIN"]),
    );
    expect(await completionLabels(3, 22)).toEqual(
      expect.arrayContaining(["CAP_CHOWN", "CAP_SYS_ADMIN", "CAP_BPF"]),
    );
    expect(await completionLabels(4, 17)).toEqual(
      expect.arrayContaining(["@default", "@system-service", "@known"]),
    );
    expect(await completionLabels(5, 24)).toEqual(
      expect.arrayContaining(["AF_UNIX", "AF_INET", "AF_INET6"]),
    );
    expect(await completionLabels(6, 15)).toEqual(
      expect.arrayContaining(["1s", "30s", "5min", "infinity"]),
    );
    expect(await completionLabels(7, 10)).toEqual(
      expect.arrayContaining(["1K", "1M", "1G", "10%"]),
    );

    await client.sendNotification("textDocument/didClose", {
      textDocument: { uri: catalogUri },
    });
  });

  it("navigates and renames structured Quadlet references without treating OCI names as files", async () => {
    const quadletDocuments = [
      ["base.image", "[Image]\nImage=quay.io/example/base:latest\n"],
      ["builder.build", "[Build]\nImageTag=localhost/builder:latest\nFile=Containerfile\n"],
      ["backend.network", "[Network]\nNetworkName=backend\n"],
      ["data.volume", "[Volume]\nVolumeName=data\n"],
      ["application.pod", "[Pod]\nPodName=application\n"],
    ] as const;
    await client.sendNotification("systemd/index/documents", {
      replace: false,
      documents: quadletDocuments.map(([name, text], index) => ({
        uri: "file:///workspace/" + name,
        languageId: "podman-quadlet",
        source: text,
        mtime: index + 1,
        workspaceOwned: true,
      })),
    });

    const containerUri = "file:///workspace/application.container";
    const containerSource = [
      "[Container]",
      "Image=quay.io/example/application:latest",
      "Network=backend.network:interface_name=eth0",
      "Volume=data.volume:/var/lib/data:Z",
      "Pod=application.pod",
      "",
    ].join("\n");
    await client.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri: containerUri,
        languageId: "podman-quadlet",
        version: 1,
        text: containerSource,
      },
    });

    await client.sendNotification("textDocument/didChange", {
      textDocument: { uri: containerUri, version: 2 },
      contentChanges: [{ text: containerSource.replace("quay.io/example/application:latest", "") }],
    });
    const images = await request<CompletionItem[]>(client, "textDocument/completion", {
      textDocument: { uri: containerUri },
      position: { line: 1, character: 6 },
    });
    expect(images.map(({ label }) => label).sort()).toEqual(["base.image", "builder.build"]);

    await client.sendNotification("textDocument/didChange", {
      textDocument: { uri: containerUri, version: 3 },
      contentChanges: [{ text: containerSource }],
    });
    const definitions = await request<Location[]>(client, "textDocument/definition", {
      textDocument: { uri: containerUri },
      position: { line: 2, character: 15 },
    });
    expect(definitions.map(({ uri: target }) => target)).toEqual([
      "file:///workspace/backend.network",
    ]);
    const prepare = await request<Range>(client, "textDocument/prepareRename", {
      textDocument: { uri: containerUri },
      position: { line: 2, character: 15 },
    });
    expect(prepare).toEqual({
      start: { line: 2, character: 8 },
      end: { line: 2, character: 23 },
    });
    const rename = await request<WorkspaceEdit>(client, "textDocument/rename", {
      textDocument: { uri: containerUri },
      position: { line: 2, character: 15 },
      newName: "renamed.network",
    });
    expect(rename.changes?.[containerUri]?.[0]).toMatchObject({
      newText: "renamed.network",
      range: prepare,
    });
    expect(
      await request<WorkspaceEdit>(client, "textDocument/rename", {
        textDocument: { uri: containerUri },
        position: { line: 2, character: 15 },
        newName: "renamed.volume",
      }),
    ).toEqual({ changes: {} });
    expect(
      await request(client, "textDocument/prepareRename", {
        textDocument: { uri: containerUri },
        position: { line: 1, character: 15 },
      }),
    ).toBeNull();
    await client.sendNotification("textDocument/didClose", { textDocument: { uri: containerUri } });
  });

  it("refreshes referring diagnostics when open Quadlet targets appear and disappear", async () => {
    const containerUri = "file:///workspace/refresh.container";
    const networkUri = "file:///workspace/refresh.network";
    const missing = nextDiagnostics(client, containerUri);
    await client.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri: containerUri,
        languageId: "podman-quadlet",
        version: 1,
        text: "[Container]\nImage=quay.io/example/app:latest\nNetwork=refresh.network\n",
      },
    });
    const missingDiagnostics = await missing;
    expect(missingDiagnostics.map(({ code }) => code)).toContain("missing-quadlet-reference");
    const referenceDiagnostic = missingDiagnostics.find(
      ({ code }) => code === "missing-quadlet-reference",
    );
    if (referenceDiagnostic === undefined) throw new Error("Expected a missing reference.");
    const actions = await request<CodeAction[]>(client, "textDocument/codeAction", {
      textDocument: { uri: containerUri },
      range: referenceDiagnostic.range,
      context: {
        diagnostics: [
          referenceDiagnostic,
          referenceDiagnostic,
          {
            ...referenceDiagnostic,
            code: "missing-without-reference",
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 0 },
            },
          },
        ],
      },
    });
    expect(actions.filter(({ title }) => title === "Create refresh.network")).toHaveLength(1);
    const createNetwork = actions.find(({ title }) => title === "Create refresh.network");
    expect(createNetwork?.kind).toBe("quickfix");
    expect(createNetwork?.command).toEqual({
      title: "Create refresh.network",
      command: "systemd.createReferencedFile",
      arguments: [
        {
          sourceUri: containerUri,
          targetUri: networkUri,
          languageId: "podman-quadlet",
          contents: "[Network]\nDisableDNS=false\n",
          label: "refresh.network",
        },
      ],
    });

    const resolved = nextDiagnostics(client, containerUri);
    await client.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri: networkUri,
        languageId: "podman-quadlet",
        version: 1,
        text: "[Network]\nNetworkName=refresh\n",
      },
    });
    expect((await resolved).map(({ code }) => code)).not.toContain("missing-quadlet-reference");

    const missingAgain = nextDiagnostics(client, containerUri);
    await client.sendNotification("textDocument/didClose", { textDocument: { uri: networkUri } });
    expect((await missingAgain).map(({ code }) => code)).toContain("missing-quadlet-reference");
    await client.sendNotification("textDocument/didClose", { textDocument: { uri: containerUri } });

    const volumeContainerUri = "file:///workspace/refresh-volume.container";
    const volumeDiagnostics = nextDiagnostics(client, volumeContainerUri);
    await client.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri: volumeContainerUri,
        languageId: "podman-quadlet",
        version: 1,
        text: "[Container]\nImage=quay.io/example/app:latest\nVolume=refresh.volume:/data\n",
      },
    });
    const missingVolume = (await volumeDiagnostics).find(
      ({ code }) => code === "missing-quadlet-reference",
    );
    if (missingVolume === undefined) throw new Error("Expected a missing volume diagnostic.");
    const volumeActions = await request<CodeAction[]>(client, "textDocument/codeAction", {
      textDocument: { uri: volumeContainerUri },
      range: missingVolume.range,
      context: { diagnostics: [missingVolume] },
    });
    expect(volumeActions.find(({ title }) => title === "Create refresh.volume")?.command).toEqual(
      expect.objectContaining({
        arguments: [expect.objectContaining({ contents: "[Volume]\n" })],
      }),
    );
    await client.sendNotification("textDocument/didClose", {
      textDocument: { uri: volumeContainerUri },
    });

    const outsideUri = "file:///outside/unsafe.container";
    const outsideDiagnostics = nextDiagnostics(client, outsideUri);
    await client.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri: outsideUri,
        languageId: "podman-quadlet",
        version: 1,
        text: "[Container]\nImage=quay.io/example/app:latest\nNetwork=unsafe.network\n",
      },
    });
    const outsideMissing = (await outsideDiagnostics).find(
      ({ code }) => code === "missing-quadlet-reference",
    );
    if (outsideMissing === undefined) throw new Error("Expected an outside-workspace diagnostic.");
    const outsideActions = await request<CodeAction[]>(client, "textDocument/codeAction", {
      textDocument: { uri: outsideUri },
      range: outsideMissing.range,
      context: { diagnostics: [outsideMissing] },
    });
    expect(
      outsideActions.some(({ command }) => command?.command === "systemd.createReferencedFile"),
    ).toBe(false);
    await client.sendNotification("textDocument/didClose", { textDocument: { uri: outsideUri } });
  });

  it("provides type-aware mkosi graph completion, navigation, and rename", async () => {
    const mkosiUri = "file:///workspace/mkosi.conf";
    const indexed = [
      [
        "config/common.conf",
        "[Include]\nInclude=nested.conf\n[Distribution]\nDistribution=fedora\n",
      ],
      ["nested.conf", "[Content]\nPackages=nested\n"],
      ["mkosi.profiles/development.conf", "[Content]\nPackages=debugger\n"],
      ["mkosi.profiles/release/mkosi.conf", "[Output]\nFormat=disk\n"],
      ["mkosi.images/base.conf", "[Distribution]\nDistribution=fedora\n"],
      ["mkosi.presets/server.conf", "[Preset]\nDependencies=base\n"],
      ["mkosi.presets/base/mkosi.conf", "[Content]\nPackages=base-package\n"],
      ["mkosi.uki-profiles/secure.conf", "[UKIProfile]\nProfile=ID=secure\n"],
    ] as const;
    await client.sendNotification("systemd/index/documents", {
      replace: false,
      documents: indexed.map(([name, text], index) => ({
        uri: "file:///workspace/" + name,
        languageId: "mkosi",
        source: text,
        mtime: index + 1,
        workspaceOwned: true,
        ...(name === "config/common.conf" ? { mkosiWorkingDirectory: "/workspace" } : {}),
      })),
    });
    const emptySource = [
      "[Include]",
      "Include=",
      "[Config]",
      "Profiles=",
      "Dependencies=",
      "[Content]",
      "UnifiedKernelImageProfiles=",
      "[Preset]",
      "Presets=",
      "Dependencies=",
      "",
    ].join("\n");
    await client.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri: mkosiUri,
        languageId: "mkosi",
        version: 1,
        text: emptySource,
      },
    });

    const profiles = await request<CompletionItem[]>(client, "textDocument/completion", {
      textDocument: { uri: mkosiUri },
      position: { line: 3, character: 9 },
    });
    expect(profiles.map(({ label }) => label).sort()).toEqual(["development", "release"]);
    const images = await request<CompletionItem[]>(client, "textDocument/completion", {
      textDocument: { uri: mkosiUri },
      position: { line: 4, character: 13 },
    });
    expect(images.map(({ label }) => label)).toEqual(["base"]);
    const presets = await request<CompletionItem[]>(client, "textDocument/completion", {
      textDocument: { uri: mkosiUri },
      position: { line: 8, character: "Presets=".length },
    });
    expect(presets.map(({ label }) => label).sort()).toEqual(["base", "server"]);
    const includes = await request<CompletionItem[]>(client, "textDocument/completion", {
      textDocument: { uri: mkosiUri },
      position: { line: 1, character: 8 },
    });
    expect(includes.map(({ label }) => label)).toEqual(
      expect.arrayContaining(["config/common.conf", "mkosi-tools"]),
    );
    const ukiProfiles = await request<CompletionItem[]>(client, "textDocument/completion", {
      textDocument: { uri: mkosiUri },
      position: { line: 6, character: "UnifiedKernelImageProfiles=".length },
    });
    expect(ukiProfiles.map(({ label }) => label)).toEqual(["mkosi.uki-profiles/secure.conf"]);

    const source = emptySource
      .replace("Include=", "Include=config/common.conf")
      .replace("Profiles=", "Profiles=development,release")
      .replace("Dependencies=", "Dependencies=base")
      .replace("Presets=", "Presets=server")
      .replace(
        "UnifiedKernelImageProfiles=",
        "UnifiedKernelImageProfiles=mkosi.uki-profiles/secure.conf",
      );
    await client.sendNotification("textDocument/didChange", {
      textDocument: { uri: mkosiUri, version: 2 },
      contentChanges: [{ text: source }],
    });
    expect(
      await request<Location[]>(client, "textDocument/definition", {
        textDocument: { uri: mkosiUri },
        position: { line: 1, character: 15 },
      }),
    ).toEqual([expect.objectContaining({ uri: "file:///workspace/config/common.conf" })]);
    await client.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri: "file:///workspace/config/common.conf",
        languageId: "mkosi",
        version: 1,
        text: indexed[0][1],
      },
    });
    expect(
      await request<Location[]>(client, "textDocument/definition", {
        textDocument: { uri: "file:///workspace/config/common.conf" },
        position: { line: 1, character: 12 },
      }),
    ).toEqual([expect.objectContaining({ uri: "file:///workspace/nested.conf" })]);
    expect(
      await request<Location[]>(client, "textDocument/definition", {
        textDocument: { uri: mkosiUri },
        position: { line: 3, character: 14 },
      }),
    ).toEqual([
      expect.objectContaining({ uri: "file:///workspace/mkosi.profiles/development.conf" }),
    ]);
    expect(
      await request<Location[]>(client, "textDocument/definition", {
        textDocument: { uri: mkosiUri },
        position: { line: 8, character: "Presets=ser".length },
      }),
    ).toEqual([expect.objectContaining({ uri: "file:///workspace/mkosi.presets/server.conf" })]);
    const prepare = await request<Range>(client, "textDocument/prepareRename", {
      textDocument: { uri: mkosiUri },
      position: { line: 3, character: 14 },
    });
    expect(prepare).toEqual({
      start: { line: 3, character: 9 },
      end: { line: 3, character: 20 },
    });
    const rename = await request<WorkspaceEdit>(client, "textDocument/rename", {
      textDocument: { uri: mkosiUri },
      position: { line: 3, character: 14 },
      newName: "staging",
    });
    expect(rename.changes?.[mkosiUri]).toEqual([
      expect.objectContaining({ range: prepare, newText: "staging" }),
    ]);
    const effective = await request<string>(client, "systemd/effectiveConfiguration", {
      uri: mkosiUri,
    });
    expect(effective).toContain("Distribution=fedora");
    expect(effective).toContain("Packages=nested");
    expect(effective).toContain("Packages=debugger");
    expect(effective).toContain("Format=disk");
    const missingPresetUri = "file:///workspace/missing-preset.conf";
    const missingPresetDiagnostics = nextDiagnostics(client, missingPresetUri);
    await client.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri: missingPresetUri,
        languageId: "mkosi",
        version: 1,
        text:
          "[Preset]\nDependencies=unavailable\n" +
          "[Config]\nProfiles=missing-profile\n" +
          "[Content]\nUnifiedKernelImageProfiles=missing-uki.conf\n",
      },
    });
    const missingGraphDiagnostics = await missingPresetDiagnostics;
    const presetDiagnostic = missingGraphDiagnostics.find(
      ({ code }) => code === "missing-mkosi-preset",
    );
    if (presetDiagnostic === undefined) throw new Error("Expected a missing preset diagnostic.");
    const presetActions = await request<CodeAction[]>(client, "textDocument/codeAction", {
      textDocument: { uri: missingPresetUri },
      range: presetDiagnostic.range,
      context: { diagnostics: missingGraphDiagnostics },
    });
    const createPreset = presetActions.find(({ title }) => title === "Create unavailable");
    expect(createPreset?.command?.command).toBe("systemd.createReferencedFile");
    expect(createPreset?.command?.arguments?.[0]).toEqual(
      expect.objectContaining({
        targetUri: "file:///workspace/mkosi.presets/unavailable.conf",
        languageId: "mkosi",
        contents: "[Preset]\n",
      }),
    );
    expect(presetActions.find(({ title }) => title === "Create missing-profile")?.command).toEqual(
      expect.objectContaining({
        arguments: [
          expect.objectContaining({
            targetUri: "file:///workspace/mkosi.profiles/missing-profile.conf",
            contents: "[Distribution]\n",
          }),
        ],
      }),
    );
    expect(presetActions.find(({ title }) => title === "Create missing-uki.conf")?.command).toEqual(
      expect.objectContaining({
        arguments: [
          expect.objectContaining({
            targetUri: "file:///workspace/missing-uki.conf",
            contents: "[UKIProfile]\n",
          }),
        ],
      }),
    );
    await client.sendNotification("textDocument/didClose", {
      textDocument: { uri: missingPresetUri },
    });
    await client.sendNotification("textDocument/didClose", {
      textDocument: { uri: "file:///workspace/config/common.conf" },
    });
    await client.sendNotification("textDocument/didClose", { textDocument: { uri: mkosiUri } });
  });

  it("completes systemd enum values from generated upstream metadata", async () => {
    const networkUri = "file:///workspace/example.network";
    const text = "[Link]\nActivationPolicy=\n\n[Network]\nIPMasquerade=both\n";
    const diagnosticsPromise = nextDiagnostics(client, networkUri);
    await client.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri: networkUri,
        languageId: "systemd-network",
        version: 1,
        text,
      },
    });
    const diagnostics = await diagnosticsPromise;
    expect(diagnostics.map(({ code }) => code)).not.toContain("invalid-value");

    const completions = await request<CompletionItem[]>(client, "textDocument/completion", {
      textDocument: { uri: networkUri },
      position: { line: 1, character: "ActivationPolicy=".length },
    });
    expect(completions.map(({ label }) => label)).toEqual([
      "up",
      "always-up",
      "manual",
      "always-down",
      "down",
      "bound",
    ]);
    await client.sendNotification("textDocument/didClose", {
      textDocument: { uri: networkUri },
    });
  });

  it("completes generated Quadlet values and exposes source-derived constraints", async () => {
    const quadletUri = "file:///workspace/workload.kube";
    const text = "[Kube]\nYaml=demo.yaml\nExitCodePropagation=\nAutoUpdate=\n";
    const diagnosticsPromise = nextDiagnostics(client, quadletUri);
    await client.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri: quadletUri,
        languageId: "podman-quadlet",
        version: 1,
        text,
      },
    });
    expect((await diagnosticsPromise).map(({ code }) => code)).not.toContain("invalid-value");

    const exitCodeValues = await request<CompletionItem[]>(client, "textDocument/completion", {
      textDocument: { uri: quadletUri },
      position: { line: 2, character: "ExitCodePropagation=".length },
    });
    expect(exitCodeValues.map(({ label }) => label)).toEqual(["all", "any", "none"]);

    const updateValues = await request<CompletionItem[]>(client, "textDocument/completion", {
      textDocument: { uri: quadletUri },
      position: { line: 3, character: "AutoUpdate=".length },
    });
    expect(updateValues.map(({ label }) => label)).toEqual([
      "registry",
      "local",
      "name/local",
      "name/registry",
    ]);
    const hover = await request<Hover | null>(client, "textDocument/hover", {
      textDocument: { uri: quadletUri },
      position: { line: 2, character: 5 },
    });
    expect(JSON.stringify(hover)).toContain("Defaults to none");
    expect(JSON.stringify(hover)).toContain("`all`, `any`, `none`");
    await client.sendNotification("textDocument/didClose", {
      textDocument: { uri: quadletUri },
    });
  });

  it("completes workspace paths through the bounded filesystem bridge", async () => {
    const quadletUri = "file:///workspace/image.build";
    workspaceDirectories.set("file:///workspace/config", [
      { name: "nested", type: "directory" },
      { name: "Containerfile", type: "file" },
      { name: "ignore.txt", type: "file" },
    ]);
    await client.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri: quadletUri,
        languageId: "podman-quadlet",
        version: 1,
        text: "[Build]\nImageTag=demo\nSetWorkingDirectory=unit\nFile=config/\n",
      },
    });
    const completions = await request<CompletionItem[]>(client, "textDocument/completion", {
      textDocument: { uri: quadletUri },
      position: { line: 3, character: "File=config/".length },
    });
    expect(directoryRequests).toEqual(["file:///workspace/config"]);
    expect(completions.map(({ label }) => label)).toEqual([
      "nested/",
      "Containerfile",
      "ignore.txt",
    ]);
    expect(completions.map(({ kind }) => kind)).toEqual([
      CompletionItemKind.Folder,
      CompletionItemKind.File,
      CompletionItemKind.File,
    ]);
    await client.sendNotification("textDocument/didClose", {
      textDocument: { uri: quadletUri },
    });
  });

  it("cancels an in-flight workspace filesystem completion request", async () => {
    const quadletUri = "file:///workspace/cancelled.build";
    let releaseRequest: (() => void) | undefined;
    const requestStarted = new Promise<void>((resolve) => {
      releaseRequest = resolve;
    });
    let observedCancellation = false;
    directoryResponder = (_requestedUri, token) =>
      new Promise((resolve) => {
        releaseRequest?.();
        token.onCancellationRequested(() => {
          observedCancellation = true;
          resolve([]);
        });
      });
    await client.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri: quadletUri,
        languageId: "podman-quadlet",
        version: 1,
        text: "[Build]\nImageTag=demo\nFile=config/\n",
      },
    });
    const cancellation = new CancellationTokenSource();
    const completion = client.sendRequest<CompletionItem[]>(
      "textDocument/completion",
      {
        textDocument: { uri: quadletUri },
        position: { line: 2, character: "File=config/".length },
      },
      cancellation.token,
    );

    await requestStarted;
    cancellation.cancel();

    await expect(completion).resolves.toEqual([]);
    expect(observedCancellation).toBe(true);
    await client.sendNotification("textDocument/didClose", {
      textDocument: { uri: quadletUri },
    });
  });

  it("uses ecosystem-correct specifiers for Quadlet and mkosi", async () => {
    const quadletUri = "file:///workspace/specifier.container";
    await client.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri: quadletUri,
        languageId: "podman-quadlet",
        version: 1,
        text: "[Container]\nImage=alpine\nEnvironmentFile=%n\n",
      },
    });
    const quadlet = await request<CompletionItem[]>(client, "textDocument/completion", {
      textDocument: { uri: quadletUri },
      position: { line: 2, character: "EnvironmentFile=%".length },
    });
    expect(quadlet.some(({ label }) => label === "%n")).toBe(true);
    expect(quadlet.find(({ label }) => label === "%n")?.detail).toContain("systemd");

    const mkosiUri = "file:///workspace/mkosi.conf";
    await client.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri: mkosiUri,
        languageId: "mkosi",
        version: 1,
        text: "[Output]\nOutput=%d/image.raw\nImageId=%a-image\n",
      },
    });
    const mkosi = await request<CompletionItem[]>(client, "textDocument/completion", {
      textDocument: { uri: mkosiUri },
      position: { line: 1, character: "Output=%".length },
    });
    expect(mkosi.some(({ label }) => label === "%d")).toBe(true);
    expect(mkosi.some(({ label }) => label === "%n")).toBe(false);
    const architecture = await request<CompletionItem[]>(client, "textDocument/completion", {
      textDocument: { uri: mkosiUri },
      position: { line: 2, character: "ImageId=%".length },
    });
    expect(architecture.some(({ label }) => label === "%a")).toBe(true);
    const hints = await request<InlayHint[]>(client, "textDocument/inlayHint", {
      textDocument: { uri: mkosiUri },
      range: { start: { line: 0, character: 0 }, end: { line: 3, character: 0 } },
    });
    expect(hints.map(({ label }) => label)).toEqual([" = distribution", " = architecture"]);
    expect(hints[0]?.tooltip).toBe("mkosi %d specifier");
    await client.sendNotification("textDocument/didClose", {
      textDocument: { uri: quadletUri },
    });
    await client.sendNotification("textDocument/didClose", {
      textDocument: { uri: mkosiUri },
    });
  });

  it("completes source-backed udev keys, attributes, operators, and values", async () => {
    const rulesUri = "file:///workspace/90-demo.rules";
    const text = [
      "",
      "ACTION",
      "ACTION==",
      "CONST{",
      "OPTIONS=",
      "ENV{ID_MODEL}",
      'ACTION=="',
      "UNKNOWN=",
      "UNKNOWN{",
      "",
    ].join("\n");
    await client.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri: rulesUri,
        languageId: "systemd-udev-rules",
        version: 1,
        text,
      },
    });

    const keys = await request<CompletionItem[]>(client, "textDocument/completion", {
      textDocument: { uri: rulesUri },
      position: { line: 0, character: 0 },
    });
    expect(keys.map(({ label }) => label)).toEqual(
      expect.arrayContaining(["ACTION", "ENV{…}", "IMPORT{builtin}", "RUN{program}"]),
    );
    const operators = await request<CompletionItem[]>(client, "textDocument/completion", {
      textDocument: { uri: rulesUri },
      position: { line: 1, character: "ACTION".length },
    });
    expect(operators.map(({ label }) => label)).toEqual(["==", "!="]);
    const actions = await request<CompletionItem[]>(client, "textDocument/completion", {
      textDocument: { uri: rulesUri },
      position: { line: 2, character: "ACTION==".length },
    });
    expect(actions.map(({ label }) => label)).toEqual(
      expect.arrayContaining(["add", "remove", "change", "bind", "unbind"]),
    );
    const constants = await request<CompletionItem[]>(client, "textDocument/completion", {
      textDocument: { uri: rulesUri },
      position: { line: 3, character: "CONST{".length },
    });
    expect(constants.map(({ label }) => label)).toEqual(["arch", "virt", "cvm"]);
    const options = await request<CompletionItem[]>(client, "textDocument/completion", {
      textDocument: { uri: rulesUri },
      position: { line: 4, character: "OPTIONS=".length },
    });
    expect(options.map(({ label }) => label)).toEqual(
      expect.arrayContaining(["watch", "string_escape=replace", "dump-json", "log_level=debug"]),
    );
    const environmentOperators = await request<CompletionItem[]>(
      client,
      "textDocument/completion",
      {
        textDocument: { uri: rulesUri },
        position: { line: 5, character: "ENV{ID_MODEL}".length },
      },
    );
    expect(environmentOperators.map(({ label }) => label)).toEqual(["==", "!=", "=", "+="]);
    const quotedActions = await request<CompletionItem[]>(client, "textDocument/completion", {
      textDocument: { uri: rulesUri },
      position: { line: 6, character: 'ACTION=="'.length },
    });
    expect(quotedActions.find(({ label }) => label === "add")?.insertText).toBe("add");
    for (const [line, character] of [
      [7, "UNKNOWN=".length],
      [8, "UNKNOWN{".length],
    ] as const) {
      await expect(
        request<CompletionItem[]>(client, "textDocument/completion", {
          textDocument: { uri: rulesUri },
          position: { line, character },
        }),
      ).resolves.toEqual([]);
    }
    await client.sendNotification("textDocument/didClose", { textDocument: { uri: rulesUri } });
  });

  it("completes documented mount options inside a table option field", async () => {
    const tableUri = "file:///workspace/fstab";
    const text = "UUID=demo /srv ext4 defaults,\n";
    await client.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri: tableUri,
        languageId: "systemd-table",
        version: 1,
        text,
      },
    });
    const options = await request<CompletionItem[]>(client, "textDocument/completion", {
      textDocument: { uri: tableUri },
      position: { line: 0, character: text.trimEnd().length },
    });
    expect(options.map(({ label }) => label)).toEqual(
      expect.arrayContaining([
        "_netdev",
        "nofail",
        "x-systemd.automount",
        "x-systemd.device-timeout=",
        "x-systemd.requires=",
      ]),
    );
    await client.sendNotification("textDocument/didClose", { textDocument: { uri: tableUri } });
  });

  it("completes and explains source-generated hwdb matches and properties", async () => {
    const hwdbUri = "file:///workspace/90-demo.hwdb";
    const text = [
      "",
      " ",
      " ID_AUTOSUSPEND=",
      " MOUSE_DPI=",
      " ACCEL_MOUNT_MATRIX=",
      " ID_AUTOSUSPEND_DELAY_MS=",
      " KEYBOARD_KEY_a1=",
      " EVDEV_ABS_00=",
      " XKB_FIXED_LAYOUT=",
      " CUSTOM_VENDOR_PROPERTY=",
      "usb:# comment",
      "usb:v0001*",
      " ID_AUTOSUSPEND=1",
      "",
    ].join("\n");
    await client.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri: hwdbUri,
        languageId: "systemd-hwdb",
        version: 1,
        text,
      },
    });

    const matches = await request<CompletionItem[]>(client, "textDocument/completion", {
      textDocument: { uri: hwdbUri },
      position: { line: 0, character: 0 },
    });
    expect(matches.map(({ label }) => label)).toEqual(
      expect.arrayContaining(["usb:", "mouse:usb:", "evdev:atkbd:", "sensor:modalias:"]),
    );
    const properties = await request<CompletionItem[]>(client, "textDocument/completion", {
      textDocument: { uri: hwdbUri },
      position: { line: 1, character: 1 },
    });
    expect(properties.map(({ label }) => label)).toEqual(
      expect.arrayContaining([
        "ID_AUTOSUSPEND",
        "MOUSE_DPI",
        "KEYBOARD_KEY_<scan code>",
        "EVDEV_ABS_<axis>",
      ]),
    );
    const booleans = await request<CompletionItem[]>(client, "textDocument/completion", {
      textDocument: { uri: hwdbUri },
      position: { line: 2, character: " ID_AUTOSUSPEND=".length },
    });
    expect(booleans.map(({ label }) => label)).toEqual(["0", "1"]);
    const dpi = await request<CompletionItem[]>(client, "textDocument/completion", {
      textDocument: { uri: hwdbUri },
      position: { line: 3, character: " MOUSE_DPI=".length },
    });
    expect(dpi).toContainEqual(
      expect.objectContaining({ label: "DPI setting", insertText: "*${1:1000}@${2:125}" }),
    );
    for (const [line, prefix, expected] of [
      [4, " ACCEL_MOUNT_MATRIX=", "identity mount matrix"],
      [5, " ID_AUTOSUSPEND_DELAY_MS=", "integer"],
      [6, " KEYBOARD_KEY_a1=", "keycode"],
      [7, " EVDEV_ABS_00=", "axis calibration"],
    ] as const) {
      const values = await request<CompletionItem[]>(client, "textDocument/completion", {
        textDocument: { uri: hwdbUri },
        position: { line, character: prefix.length },
      });
      expect(values.map(({ label }) => label)).toContain(expected);
    }
    for (const [line, prefix] of [
      [8, " XKB_FIXED_LAYOUT="],
      [9, " CUSTOM_VENDOR_PROPERTY="],
      [10, "usb:# comment"],
    ] as const) {
      await expect(
        request<CompletionItem[]>(client, "textDocument/completion", {
          textDocument: { uri: hwdbUri },
          position: { line, character: prefix.length },
        }),
      ).resolves.toEqual([]);
    }

    const hover = await request<Hover>(client, "textDocument/hover", {
      textDocument: { uri: hwdbUri },
      position: { line: 12, character: 3 },
    });
    expect(JSON.stringify(hover.contents)).toContain("systemd hwdb boolean property");
    expect(JSON.stringify(hover.contents)).toContain("Values");
    const matchHover = await request<Hover>(client, "textDocument/hover", {
      textDocument: { uri: hwdbUri },
      position: { line: 11, character: 3 },
    });
    expect(JSON.stringify(matchHover.contents)).toContain("Hardware database match");
    const signature = await request<SignatureHelp>(client, "textDocument/signatureHelp", {
      textDocument: { uri: hwdbUri },
      position: { line: 12, character: " ID_AUTOSUSPEND=".length },
    });
    expect(signature.signatures[0]?.label).toBe("ID_AUTOSUSPEND=<boolean>");

    await client.sendNotification("textDocument/didClose", { textDocument: { uri: hwdbUri } });
  });

  it("keeps navigation total when an indexed provider returns a malformed URI escape", async () => {
    await client.sendNotification("systemd/index/documents", {
      replace: false,
      documents: [
        {
          uri: "file:///workspace/%E0%A4%A.service",
          languageId: "systemd-unit",
          source: "[Service]\nExecStart=/bin/true\n",
          mtime: 2,
          workspaceOwned: true,
        },
      ],
    });
    const navigationUri = "file:///workspace/malformed-reference.service";
    await client.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri: navigationUri,
        languageId: "systemd-unit",
        version: 1,
        text: "[Unit]\nWants=missing.service\n[Service]\nExecStart=/bin/true\n",
      },
    });

    await expect(
      request<Location[]>(client, "textDocument/definition", {
        textDocument: { uri: navigationUri },
        position: { line: 1, character: 10 },
      }),
    ).resolves.toEqual([]);
    await client.sendNotification("textDocument/didClose", {
      textDocument: { uri: navigationUri },
    });
  });

  it("applies the matching ecosystem target to diagnostics and completion", async () => {
    const quadletUri = "file:///workspace/image.build";
    await client.sendNotification("systemd/targets/detectedVersions", { podman: "5.6.9" });
    await client.sendNotification("workspace/didChangeConfiguration", {
      settings: {
        systemd: {
          validation: { enable: true, maxProblems: 200 },
          target: { systemdVersion: "latest", podmanVersion: "auto", mkosiVersion: "latest" },
        },
      },
    });
    const diagnosticsPromise = nextDiagnostics(client, quadletUri);
    await client.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri: quadletUri,
        languageId: "podman-quadlet",
        version: 1,
        text: "[Build]\nBuildArg=RELEASE=1\n",
      },
    });

    expect((await diagnosticsPromise).map(({ code }) => code)).toContain("setting-unavailable");
    const completions = await request<CompletionItem[]>(client, "textDocument/completion", {
      textDocument: { uri: quadletUri },
      position: { line: 2, character: 0 },
    });
    expect(completions.some(({ label }) => label === "BuildArg")).toBe(false);
    expect(completions.some(({ label }) => label === "Annotation")).toBe(true);

    await client.sendNotification("textDocument/didClose", { textDocument: { uri: quadletUri } });
  });

  it("switches indexed language data between stable and preview channels", async () => {
    const mkosiUri = "file:///workspace/mkosi.conf";
    const stableDiagnostics = nextDiagnostics(client, mkosiUri);
    await client.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri: mkosiUri,
        languageId: "mkosi",
        version: 1,
        text: "[Build]\nForeignUIDRange=1000\n",
      },
    });
    expect((await stableDiagnostics).map(({ code }) => code)).toContain("unknown-setting");

    const previewDiagnostics = nextDiagnostics(client, mkosiUri);
    await client.sendNotification("systemd/registry/dataChannel", { channel: "preview" });
    expect((await previewDiagnostics).map(({ code }) => code)).not.toContain("unknown-setting");
    const completions = await request<CompletionItem[]>(client, "textDocument/completion", {
      textDocument: { uri: mkosiUri },
      position: { line: 2, character: 0 },
    });
    expect(completions.some(({ label }) => label === "ForeignUIDRange")).toBe(true);

    await client.sendNotification("textDocument/didClose", { textDocument: { uri: mkosiUri } });
    await client.sendNotification("systemd/registry/dataChannel", { channel: "stable" });
  });

  it("follows indexed unit aliases and includes canonical and alias drop-ins", async () => {
    const canonicalUri = "file:///usr/lib/systemd/system/real.service";
    const aliasUri = "file:///etc/systemd/system/alias.service";
    await client.sendNotification("systemd/index/documents", {
      replace: true,
      documents: [
        {
          uri: canonicalUri,
          languageId: "systemd-unit",
          source: "[Unit]\nDescription=Canonical\n",
          mtime: 1,
        },
        {
          uri: aliasUri,
          canonicalUri,
          languageId: "systemd-unit",
          source: "[Unit]\nDescription=Canonical\n",
          mtime: 2,
        },
        {
          uri: "file:///etc/systemd/system/real.service.d/10-canonical.conf",
          languageId: "systemd-unit",
          source: "[Service]\nEnvironment=CANONICAL=1\n",
          mtime: 3,
        },
        {
          uri: "file:///etc/systemd/system/alias.service.d/20-alias.conf",
          languageId: "systemd-unit",
          source: "[Service]\nEnvironment=ALIAS=1\n",
          mtime: 4,
        },
      ],
    });

    const effective = await request<string>(client, "systemd/effectiveConfiguration", {
      uri: aliasUri,
    });
    expect(effective).toContain("# " + canonicalUri + ":2");
    expect(effective).toContain("Environment=CANONICAL=1");
    expect(effective).toContain("Environment=ALIAS=1");
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

    const hostUri = "file:///etc/systemd/system/host.service";
    await client.sendNotification("systemd/index/documents", {
      replace: false,
      documents: [
        {
          uri: hostUri,
          languageId: "systemd-unit",
          source: "[Unit]\nWants=other.service\n",
          mtime: 1,
          workspaceOwned: false,
        },
      ],
    });

    const rename = await request<WorkspaceEdit>(client, "textDocument/rename", {
      textDocument: { uri },
      position: { line: 2, character: 10 },
      newName: "replacement.service",
    });
    expect(rename.changes?.[uri]?.[0]?.newText).toBe("replacement.service");
    expect(rename.changes?.[hostUri]).toBeUndefined();

    await client.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri: hostUri,
        languageId: "systemd-unit",
        version: 1,
        text: "[Unit]\nWants=other.service\n",
      },
    });
    expect(
      await request(client, "textDocument/prepareRename", {
        textDocument: { uri: hostUri },
        position: { line: 1, character: 9 },
      }),
    ).toBeNull();
    await client.sendNotification("textDocument/didClose", { textDocument: { uri: hostUri } });

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
    expect(
      await request(client, "textDocument/prepareRename", {
        textDocument: { uri },
        position: { line: 3, character: 21 },
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

function nextDiagnostics(client: MessageConnection, targetUri = uri): Promise<Diagnostic[]> {
  return new Promise((resolve) => {
    const disposable = client.onNotification(
      "textDocument/publishDiagnostics",
      (params: { readonly uri: string; readonly diagnostics: Diagnostic[] }): void => {
        if (params.uri !== targetUri) return;
        disposable.dispose();
        resolve(params.diagnostics);
      },
    );
  });
}
