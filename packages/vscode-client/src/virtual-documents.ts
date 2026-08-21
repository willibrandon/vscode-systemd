import * as vscode from "vscode";
import type { BaseLanguageClient } from "vscode-languageclient";
import {
  dependencyGraphRequest,
  effectiveConfigurationRequest,
} from "@systemd/language-server/protocol";
import type { DependencyGraph } from "@systemd/language-server/protocol";

const effectiveScheme = "systemd-effective";
const graphScheme = "systemd-dependency-graph";

export interface VirtualDocuments extends vscode.Disposable {
  showEffective(source: vscode.Uri): Promise<void>;
  showDependencyGraph(source: vscode.Uri | undefined): Promise<void>;
  refreshEffectiveDocuments(): Promise<void>;
  sourceFor(document: vscode.Uri): vscode.Uri | undefined;
}

export function registerVirtualDocuments(
  context: vscode.ExtensionContext,
  client: BaseLanguageClient,
): VirtualDocuments {
  const provider = new SystemdVirtualDocumentProvider(client);
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(effectiveScheme, provider),
    vscode.workspace.registerTextDocumentContentProvider(graphScheme, provider),
    provider,
  );
  return provider;
}

export function renderDependencyGraph(graph: DependencyGraph): string {
  const lines = ["# systemd dependency graph", "", "```mermaid", "flowchart LR"];
  for (const edge of graph.edges) {
    lines.push(
      "  " +
        mermaidId(edge.source) +
        '["' +
        escapeMermaid(edge.source) +
        '"] -->|' +
        escapeMermaid(edge.kind) +
        "| " +
        mermaidId(edge.target) +
        '["' +
        escapeMermaid(edge.target) +
        '"]',
    );
  }
  lines.push("```", "");
  if (graph.edges.length === 0) lines.push("_No indexed dependencies were found._", "");
  return lines.join("\n");
}

class SystemdVirtualDocumentProvider
  implements vscode.TextDocumentContentProvider, VirtualDocuments
{
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  private readonly content = new Map<string, string>();
  private readonly effectiveSources = new Map<string, vscode.Uri>();
  private disposed = false;
  private readonly client: BaseLanguageClient;

  public readonly onDidChange = this.changed.event;

  public constructor(client: BaseLanguageClient) {
    this.client = client;
  }

  public provideTextDocumentContent(uri: vscode.Uri): string {
    return this.content.get(uri.toString()) ?? "# Loading systemd configuration…\n";
  }

  public async showEffective(source: vscode.Uri): Promise<void> {
    const uri = virtualUri(effectiveScheme, source, basename(source.path));
    this.effectiveSources.set(uri.toString(), source);
    const content = await this.client.sendRequest(effectiveConfigurationRequest, {
      uri: source.toString(),
    });
    this.update(uri, content);
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: false });
  }

  public async showDependencyGraph(source: vscode.Uri | undefined): Promise<void> {
    const graph = await this.client.sendRequest(
      dependencyGraphRequest,
      source === undefined ? {} : { uri: source.toString() },
    );
    const seed = source ?? vscode.Uri.parse("systemd:workspace");
    const uri = virtualUri(graphScheme, seed, "dependencies.md");
    this.update(uri, renderDependencyGraph(graph));
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: false });
  }

  public async refreshEffectiveDocuments(): Promise<void> {
    await Promise.all(
      [...this.effectiveSources.entries()].map(async ([key, source]): Promise<void> => {
        const uri = vscode.Uri.parse(key);
        const content = await this.client.sendRequest(effectiveConfigurationRequest, {
          uri: source.toString(),
        });
        this.update(uri, content);
      }),
    );
  }

  public sourceFor(document: vscode.Uri): vscode.Uri | undefined {
    return this.effectiveSources.get(document.toString());
  }

  public dispose(): void {
    this.disposed = true;
    this.content.clear();
    this.effectiveSources.clear();
    this.changed.dispose();
  }

  private update(uri: vscode.Uri, content: string): void {
    if (this.disposed) return;
    const key = uri.toString();
    if (this.content.get(key) === content) return;
    this.content.set(key, content);
    this.changed.fire(uri);
  }
}

function virtualUri(scheme: string, source: vscode.Uri, name: string): vscode.Uri {
  return vscode.Uri.from({
    scheme,
    authority: "workspace",
    path: "/" + shortHash(source.toString()) + "/" + sanitizeName(name),
  });
}

function sanitizeName(name: string): string {
  const sanitized = name.replaceAll(/[^A-Za-z0-9_.@-]/gu, "-");
  return sanitized === "" ? "configuration.conf" : sanitized;
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function shortHash(value: string): string {
  let hash = 2_166_136_261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function mermaidId(value: string): string {
  return "n" + shortHash(value);
}

function escapeMermaid(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}
