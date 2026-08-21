import * as vscode from "vscode";

const extensionId = "willibrandon.systemd";

interface ExtensionManifest {
  readonly browser: string;
}

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension(extensionId);
  assert(extension !== undefined, `${extensionId} was not installed in the web extension host`);
  await extension.activate();
  assert(extension.isActive, "the web extension did not activate");
  const manifest = extension.packageJSON as ExtensionManifest;
  assert(manifest.browser === "./dist/browser.js", "the browser entry is incorrect");

  const folder = vscode.workspace.workspaceFolders?.[0];
  assert(folder !== undefined, "the virtual test workspace was not opened");
  assert(folder.uri.scheme !== "file", "the web test must use a virtual filesystem");
  const unitUri = vscode.Uri.joinPath(folder.uri, "demo.service");
  const referencedUri = vscode.Uri.joinPath(folder.uri, "other.service");
  const document = await vscode.workspace.openTextDocument(unitUri);
  assert(document.languageId === "systemd-unit", "demo.service did not receive the language id");
  await vscode.window.showTextDocument(document);

  const diagnostics = await waitForDiagnostics(unitUri, "unknown-setting");
  assert(
    diagnostics.some(({ source }) => source === "systemd"),
    "the browser language server did not publish systemd diagnostics",
  );
  const completion = await vscode.commands.executeCommand<vscode.CompletionList>(
    "vscode.executeCompletionItemProvider",
    unitUri,
    new vscode.Position(7, 0),
  );
  assert(
    completion.items.some(({ label }) => label === "Restart"),
    "completion was unavailable in the browser worker",
  );
  const definitions = await vscode.commands.executeCommand<readonly vscode.Location[]>(
    "vscode.executeDefinitionProvider",
    unitUri,
    new vscode.Position(2, 10),
  );
  assert(
    definitions[0]?.uri.toString() === referencedUri.toString(),
    "cross-file definitions were unavailable in the virtual workspace",
  );
  const quadletUri = vscode.Uri.joinPath(folder.uri, "demo.container");
  const quadlet = await vscode.workspace.openTextDocument(quadletUri);
  assert(quadlet.languageId === "podman-quadlet", "demo.container did not receive the language id");
  const pathCompletion = await vscode.commands.executeCommand<vscode.CompletionList>(
    "vscode.executeCompletionItemProvider",
    quadletUri,
    new vscode.Position(2, "EnvironmentFile=dep".length),
  );
  assert(
    pathCompletion.items.some(({ label }) => label === "deploy.env"),
    "workspace path completion was unavailable in the virtual workspace",
  );

  await vscode.commands.executeCommand("systemd.showEffectiveConfiguration", unitUri);
  const effective = vscode.window.activeTextEditor?.document;
  assert(effective?.uri.scheme === "systemd-effective", "the browser effective view did not open");
  assert(
    effective.getText().includes("Description=Integration fixture"),
    "the browser effective view omitted the unit source",
  );
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function waitForDiagnostics(
  uri: vscode.Uri,
  code: string,
): Promise<readonly vscode.Diagnostic[]> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const diagnostics = vscode.languages.getDiagnostics(uri);
    if (diagnostics.some((diagnostic) => diagnosticCode(diagnostic) === code)) return diagnostics;
    await new Promise((resolve) => globalThis.setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${code} diagnostics for ${uri.toString()}.`);
}

function diagnosticCode(diagnostic: vscode.Diagnostic): string | number | undefined {
  return typeof diagnostic.code === "object" ? diagnostic.code.value : diagnostic.code;
}
