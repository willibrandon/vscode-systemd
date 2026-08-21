const assert = require("node:assert/strict");
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
};

function diagnosticCode(diagnostic) {
  return typeof diagnostic.code === "object" ? diagnostic.code.value : diagnostic.code;
}

async function waitFor(read, accept, description) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const value = read();
    if (accept(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const diagnostics = vscode.languages
    .getDiagnostics()
    .map(([uri, items]) => [uri.toString(), items.map((item) => item.message)]);
  process.stderr.write("Current diagnostics: " + JSON.stringify(diagnostics) + "\n");
  assert.fail("Timed out waiting for " + description + ".");
}
