const assert = require("node:assert/strict");
const { TextEncoder } = require("node:util");
const vscode = require("vscode");

const extensionId = "willibrandon.systemd";

exports.run = async function run() {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  assert.ok(root, "The fixture workspace must be open.");

  const extension = vscode.extensions.getExtension(extensionId);
  assert.ok(extension, extensionId + " must be installed as the development extension.");

  const uri = vscode.Uri.joinPath(root, "demo.service");
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document);
  assert.equal(document.languageId, "systemd-unit");

  await extension.activate();
  assert.equal(extension.isActive, true);
  const installedPathPrefix = process.env.SYSTEMD_EXPECTED_INSTALLED_EXTENSION_PATH_PREFIX;
  if (installedPathPrefix !== undefined) {
    assert.equal(
      extension.packageJSON.version,
      process.env.SYSTEMD_EXPECTED_INSTALLED_EXTENSION_VERSION,
    );
    assert.ok(
      extension.extensionPath.startsWith(installedPathPrefix),
      "The smoke test must activate the extension installed from the VSIX.",
    );
  }

  const completion = await vscode.commands.executeCommand(
    "vscode.executeCompletionItemProvider",
    uri,
    new vscode.Position(7, 0),
  );
  assert.ok(completion.items.some((item) => item.label === "Restart"));

  const diagnostics = await waitFor(
    () => vscode.languages.getDiagnostics(uri),
    (items) => items.some((item) => diagnosticCode(item) === "unknown-setting"),
    "unknown-setting diagnostic",
  );
  assert.ok(diagnostics.some((item) => item.source === "systemd"));

  const hovers = await vscode.commands.executeCommand(
    "vscode.executeHoverProvider",
    uri,
    new vscode.Position(1, 4),
  );
  assert.ok(hovers.length > 0);

  const symbols = await vscode.commands.executeCommand("vscode.executeDocumentSymbolProvider", uri);
  assert.deepEqual(
    symbols.map((symbol) => symbol.name),
    ["[Unit]", "[Service]"],
  );

  const dropInActions = await vscode.commands.executeCommand(
    "vscode.executeCodeActionProvider",
    uri,
    new vscode.Range(0, 0, 0, 0),
    vscode.CodeActionKind.RefactorRewrite.value,
  );
  const dropInAction = dropInActions.find(
    (action) => action.title === "Create workspace unit drop-in",
  );
  assert.ok(dropInAction, "The unit drop-in code action must be available.");
  await executeCodeAction(dropInAction);
  const dropInUri = vscode.Uri.joinPath(root, "demo.service.d", "override.conf");
  const dropIn = vscode.window.activeTextEditor?.document;
  assert.equal(dropIn?.uri.toString(), dropInUri.toString());
  assert.equal(dropIn.languageId, "systemd-unit");
  assert.equal(dropIn.getText(), "[Service]\n");
  await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
  await vscode.window.showTextDocument(document);

  const definitions = await vscode.commands.executeCommand(
    "vscode.executeDefinitionProvider",
    uri,
    new vscode.Position(2, 10),
  );
  assert.equal(
    definitions[0]?.uri.toString(),
    vscode.Uri.joinPath(root, "other.service").toString(),
  );

  const edits = await vscode.commands.executeCommand("vscode.executeFormatDocumentProvider", uri, {
    insertSpaces: true,
    tabSize: 2,
  });
  const formatted = [...edits]
    .sort(
      (left, right) => document.offsetAt(right.range.start) - document.offsetAt(left.range.start),
    )
    .reduce((text, edit) => {
      const start = document.offsetAt(edit.range.start);
      const end = document.offsetAt(edit.range.end);
      return text.slice(0, start) + edit.newText + text.slice(end);
    }, document.getText());
  assert.match(formatted, /^ExecStart=\/bin\/echo %n$/mu);

  const inlayHints = await vscode.commands.executeCommand(
    "vscode.executeInlayHintProvider",
    uri,
    new vscode.Range(0, 0, document.lineCount - 1, 1000),
  );
  assert.ok(inlayHints.some((hint) => hint.label === " = full unit name"));

  const codeLenses = await vscode.commands.executeCommand(
    "vscode.executeCodeLensProvider",
    uri,
    10,
  );
  assert.ok(
    codeLenses.some((lens) => lens.command?.command === "systemd.showEffectiveConfiguration"),
  );

  const quadlet = await vscode.workspace.openTextDocument(
    vscode.Uri.joinPath(root, "demo.container"),
  );
  assert.equal(quadlet.languageId, "podman-quadlet");
  const pathCompletion = await vscode.commands.executeCommand(
    "vscode.executeCompletionItemProvider",
    quadlet.uri,
    new vscode.Position(2, "EnvironmentFile=dep".length),
  );
  assert.ok(pathCompletion.items.some((item) => item.label === "deploy.env"));

  const lifecycleUri = vscode.Uri.joinPath(root, "lifecycle.container");
  const networkUri = vscode.Uri.joinPath(root, "lifecycle.network");
  await vscode.workspace.fs.writeFile(
    lifecycleUri,
    new TextEncoder().encode(
      "[Container]\nImage=quay.io/podman/hello\nNetwork=lifecycle.network\n",
    ),
  );
  const lifecycle = await vscode.workspace.openTextDocument(lifecycleUri);
  await vscode.window.showTextDocument(lifecycle);
  assert.equal(lifecycle.languageId, "podman-quadlet");
  const missingNetwork = await waitForDiagnostic(
    lifecycleUri,
    "missing-quadlet-reference",
    "missing Quadlet network diagnostic",
  );
  const referenceActions = await vscode.commands.executeCommand(
    "vscode.executeCodeActionProvider",
    lifecycleUri,
    missingNetwork.range,
    vscode.CodeActionKind.QuickFix.value,
  );
  const createNetwork = referenceActions.find(
    (action) => action.title === "Create lifecycle.network",
  );
  assert.ok(createNetwork, "The missing-network code action must be available.");
  await executeCodeAction(createNetwork);
  const createdNetwork = vscode.window.activeTextEditor?.document;
  assert.equal(createdNetwork?.uri.toString(), networkUri.toString());
  assert.equal(createdNetwork.languageId, "podman-quadlet");
  assert.equal(createdNetwork.getText(), "[Network]\nDisableDNS=false\n");
  await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
  await vscode.window.showTextDocument(lifecycle);
  await waitForNoDiagnostic(
    lifecycleUri,
    "missing-quadlet-reference",
    "missing network diagnostic to clear after creation",
  );

  const networkDefinitions = await vscode.commands.executeCommand(
    "vscode.executeDefinitionProvider",
    lifecycleUri,
    new vscode.Position(2, "Network=lifecycle".length),
  );
  assert.equal(networkDefinitions[0]?.uri.toString(), networkUri.toString());

  const watcherUri = vscode.Uri.joinPath(root, "watcher.container");
  const watchedNetworkUri = vscode.Uri.joinPath(root, "watched.network");
  const renamedNetworkUri = vscode.Uri.joinPath(root, "renamed.network");
  await vscode.workspace.fs.writeFile(
    watcherUri,
    new TextEncoder().encode("[Container]\nImage=quay.io/podman/hello\nNetwork=watched.network\n"),
  );
  const watcher = await vscode.workspace.openTextDocument(watcherUri);
  await vscode.window.showTextDocument(watcher);
  await waitForDiagnostic(
    watcherUri,
    "missing-quadlet-reference",
    "new dependency diagnostic before the referenced file is created",
  );
  await vscode.workspace.fs.writeFile(
    watchedNetworkUri,
    new TextEncoder().encode("[Network]\nDisableDNS=false\n"),
  );
  await waitForNoDiagnostic(
    watcherUri,
    "missing-quadlet-reference",
    "new dependency diagnostic to clear after file creation",
  );
  await waitFor(
    () =>
      vscode.commands.executeCommand(
        "vscode.executeDefinitionProvider",
        watcherUri,
        new vscode.Position(2, "Network=watched".length),
      ),
    (locations) => locations[0]?.uri.toString() === watchedNetworkUri.toString(),
    "newly created dependency to enter the index",
  );

  const renameNetwork = new vscode.WorkspaceEdit();
  renameNetwork.renameFile(watchedNetworkUri, renamedNetworkUri);
  assert.equal(await vscode.workspace.applyEdit(renameNetwork), true);
  await waitForDiagnostic(
    watcherUri,
    "missing-quadlet-reference",
    "missing network diagnostic after dependency rename",
  );
  const restoreNetwork = new vscode.WorkspaceEdit();
  restoreNetwork.renameFile(renamedNetworkUri, watchedNetworkUri);
  assert.equal(await vscode.workspace.applyEdit(restoreNetwork), true);
  await waitForNoDiagnostic(
    watcherUri,
    "missing-quadlet-reference",
    "missing network diagnostic to clear after dependency restoration",
  );
  await vscode.workspace.fs.delete(watchedNetworkUri);
  await waitForDiagnostic(
    watcherUri,
    "missing-quadlet-reference",
    "missing network diagnostic after dependency deletion",
  );
  await vscode.workspace.fs.writeFile(
    watchedNetworkUri,
    new TextEncoder().encode("[Network]\nDisableDNS=false\n"),
  );
  await waitForNoDiagnostic(
    watcherUri,
    "missing-quadlet-reference",
    "missing network diagnostic to clear after dependency recreation",
  );

  for (const [name, expectedLanguage] of [
    ["custom.daemon", "systemd-unit"],
    ["templated.service.rendered", "systemd-unit"],
  ]) {
    const configuredDocument = await vscode.workspace.openTextDocument(
      vscode.Uri.joinPath(root, name),
    );
    await waitFor(
      () => configuredDocument.languageId,
      (languageId) => languageId === expectedLanguage,
      name + " language detection",
    );
  }

  const commands = await vscode.commands.getCommands(true);
  for (const command of [
    "systemd.refreshIndex",
    "systemd.showEffectiveConfiguration",
    "systemd.showDependencyGraph",
    "systemd.createDropIn",
    "systemd.selectDialect",
  ]) {
    assert.ok(commands.includes(command), command + " must be registered.");
  }

  await vscode.commands.executeCommand("systemd.showEffectiveConfiguration", uri);
  const effective = vscode.window.activeTextEditor?.document;
  assert.ok(effective, "Effective configuration must open in an editor.");
  assert.equal(effective.uri.scheme, "systemd-effective");
  assert.match(effective.getText(), /Description=Integration fixture/u);
  assert.match(effective.getText(), /Sources are listed in increasing precedence/u);
  assert.match(effective.getText(), /demo\.service\.d\/override\.conf/u);

  await vscode.commands.executeCommand("systemd.showDependencyGraph", uri);
  const graph = vscode.window.activeTextEditor?.document;
  assert.ok(graph, "Dependency graph must open in an editor.");
  assert.equal(graph.uri.scheme, "systemd-dependency-graph");
  assert.match(graph.getText(), /flowchart LR/u);
  assert.match(graph.getText(), /other\.service/u);

  await vscode.window.showTextDocument(document);

  const correction = new vscode.WorkspaceEdit();
  correction.replace(uri, new vscode.Range(6, 0, 6, 6), "Restart");
  assert.equal(await vscode.workspace.applyEdit(correction), true);
  await waitFor(
    () => vscode.languages.getDiagnostics(uri),
    (items) => items.every((item) => diagnosticCode(item) !== "unknown-setting"),
    "diagnostics to clear after an incremental correction",
  );
  assert.equal(document.isDirty, true);
  assert.equal(await document.save(), true);
  assert.equal(document.isDirty, false);

  const installSection = new vscode.WorkspaceEdit();
  installSection.insert(
    uri,
    document.positionAt(document.getText().length),
    "\n[Install]\nWantedBy=multi-user.target\n",
  );
  assert.equal(await vscode.workspace.applyEdit(installSection), true);
  const changedSymbols = await waitFor(
    () => vscode.commands.executeCommand("vscode.executeDocumentSymbolProvider", uri),
    async (items) => (await items).some((symbol) => symbol.name === "[Install]"),
    "symbols to update after an incremental change",
  );
  assert.ok((await changedSymbols).some((symbol) => symbol.name === "[Install]"));
  assert.equal(await document.save(), true);
  const savedSymbols = await vscode.commands.executeCommand(
    "vscode.executeDocumentSymbolProvider",
    uri,
  );
  assert.ok(savedSymbols.some((symbol) => symbol.name === "[Install]"));

  const invalidUri = vscode.Uri.joinPath(root, "configuration.service");
  await vscode.workspace.fs.writeFile(
    invalidUri,
    new TextEncoder().encode("[Service]\nRestar=always\n"),
  );
  const invalid = await vscode.workspace.openTextDocument(invalidUri);
  await vscode.window.showTextDocument(invalid);
  await waitForDiagnostic(invalidUri, "unknown-setting", "configuration fixture diagnostic");
  const configuration = vscode.workspace.getConfiguration("systemd", invalidUri);
  await configuration.update(
    "validation.enable",
    false,
    vscode.ConfigurationTarget.WorkspaceFolder,
  );
  await waitFor(
    () => vscode.languages.getDiagnostics(invalidUri),
    (items) => items.length === 0,
    "diagnostics to clear after validation is disabled",
  );
  await configuration.update("validation.enable", true, vscode.ConfigurationTarget.WorkspaceFolder);
  await waitForDiagnostic(
    invalidUri,
    "unknown-setting",
    "diagnostics to return after validation is enabled",
  );
  await configuration.update(
    "validation.enable",
    undefined,
    vscode.ConfigurationTarget.WorkspaceFolder,
  );
  await vscode.languages.setTextDocumentLanguage(invalid, "plaintext");
  await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
  await waitFor(
    () => vscode.languages.getDiagnostics(invalidUri),
    (items) => items.length === 0,
    "diagnostics to clear after the language client closes the document",
  );
};

async function executeCodeAction(action) {
  assert.ok(action.command, action.title + " must execute a command.");
  await vscode.commands.executeCommand(action.command.command, ...(action.command.arguments ?? []));
}

async function waitForDiagnostic(uri, code, description) {
  const diagnostics = await waitFor(
    () => vscode.languages.getDiagnostics(uri),
    (items) => items.some((item) => diagnosticCode(item) === code),
    description,
  );
  return diagnostics.find((item) => diagnosticCode(item) === code);
}

async function waitForNoDiagnostic(uri, code, description) {
  return waitFor(
    () => vscode.languages.getDiagnostics(uri),
    (items) => items.every((item) => diagnosticCode(item) !== code),
    description,
  );
}

function diagnosticCode(diagnostic) {
  return typeof diagnostic.code === "object" ? diagnostic.code.value : diagnostic.code;
}

async function waitFor(read, accept, description) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (await accept(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const diagnostics = vscode.languages
    .getDiagnostics()
    .map(([uri, items]) => [uri.toString(), items.map((item) => item.message)]);
  process.stderr.write("Current diagnostics: " + JSON.stringify(diagnostics) + "\n");
  assert.fail("Timed out waiting for " + description + ".");
}
