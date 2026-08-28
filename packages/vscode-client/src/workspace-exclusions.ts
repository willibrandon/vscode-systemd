import * as vscode from "vscode";
import { minimatch } from "minimatch";
import { GitIgnoreRules } from "./git-ignore.js";
import type { GitIgnoreFile } from "./git-ignore.js";

const commonArtifactDirectories = new Set([
  ".git",
  "node_modules",
  ".cache",
  "dist",
  "out",
  "coverage",
]);
const ignoreFileSearchExclude = "**/{.git,node_modules,.cache,dist,out,coverage}/**";
const maximumIgnoreFiles = 2_000;

export class WorkspaceExclusions {
  private readonly rulesByFolder: ReadonlyMap<string, GitIgnoreRules>;

  public constructor(rulesByFolder: ReadonlyMap<string, GitIgnoreRules>) {
    this.rulesByFolder = rulesByFolder;
  }

  public excludes(uri: vscode.Uri): boolean {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (folder === undefined) return false;
    const relative = relativePath(folder.uri, uri);
    if (relative === undefined) return false;
    if (relative.split("/").some((part) => commonArtifactDirectories.has(part))) return true;
    return this.rulesByFolder.get(folder.uri.toString())?.ignores(relative) ?? false;
  }

  public async excludesChangedUri(uri: vscode.Uri): Promise<boolean> {
    if (this.excludes(uri)) return true;
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (folder === undefined) return false;
    const relative = relativePath(folder.uri, uri);
    if (relative === undefined) return false;
    const configured = vscode.workspace
      .getConfiguration("files", uri)
      .get<Readonly<Record<string, unknown>>>("exclude", {});
    for (const [pattern, value] of Object.entries(configured)) {
      if (value === false || !matchesPathOrParent(relative, pattern)) continue;
      if (value === true || value === null || typeof value !== "object") return true;
      const when = "when" in value && typeof value.when === "string" ? value.when : undefined;
      if (when === undefined) return true;
      const name = relative.slice(relative.lastIndexOf("/") + 1);
      const extension = name.lastIndexOf(".");
      const basename = extension > 0 ? name.slice(0, extension) : name;
      const sibling = vscode.Uri.joinPath(uri, "..", when.replaceAll("$(basename)", basename));
      try {
        await vscode.workspace.fs.stat(sibling);
        return true;
      } catch {
        // The conditional exclusion does not apply without its sibling.
      }
    }
    return false;
  }
}

export async function loadWorkspaceExclusions(
  configurationSection: string,
): Promise<WorkspaceExclusions> {
  const entries = await Promise.all(
    (vscode.workspace.workspaceFolders ?? []).map(async (folder) => {
      const enabled = vscode.workspace
        .getConfiguration(configurationSection, folder.uri)
        .get<boolean>("index.useIgnoreFiles", true);
      if (!enabled) return undefined;
      let uris: readonly vscode.Uri[] = [];
      try {
        uris = await vscode.workspace.findFiles(
          new vscode.RelativePattern(folder, "**/.gitignore"),
          ignoreFileSearchExclude,
          maximumIgnoreFiles,
        );
      } catch {
        // Virtual providers may not implement file search even when reads work.
      }
      const rootIgnoreUri = vscode.Uri.joinPath(folder.uri, ".gitignore");
      const ignoreUris = new Map(
        [rootIgnoreUri, ...uris].map((uri) => [uri.toString(), uri] as const),
      );
      const files = await Promise.all(
        [...ignoreUris.values()].map(async (uri): Promise<GitIgnoreFile | undefined> => {
          const relative = relativePath(folder.uri, uri);
          if (relative === undefined) return undefined;
          try {
            const contents = new TextDecoder("utf-8", { fatal: true }).decode(
              await vscode.workspace.fs.readFile(uri),
            );
            return {
              contents,
              directory: relative.includes("/") ? relative.slice(0, relative.lastIndexOf("/")) : "",
            };
          } catch {
            return undefined;
          }
        }),
      );
      return [
        folder.uri.toString(),
        new GitIgnoreRules(files.filter((file) => file !== undefined)),
      ] as const;
    }),
  );
  return new WorkspaceExclusions(new Map(entries.filter((entry) => entry !== undefined)));
}

export function isGitIgnoreFile(uri: vscode.Uri): boolean {
  return uri.path.endsWith("/.gitignore") || uri.path === ".gitignore";
}

function relativePath(root: vscode.Uri, uri: vscode.Uri): string | undefined {
  if (root.scheme !== uri.scheme || root.authority !== uri.authority) return undefined;
  const prefix = root.path.endsWith("/") ? root.path : root.path + "/";
  if (!uri.path.startsWith(prefix)) return uri.path === root.path ? "" : undefined;
  return uri.path.slice(prefix.length).replaceAll("\\", "/");
}

function matchesPathOrParent(relative: string, pattern: string): boolean {
  const parts = relative.split("/");
  for (let index = 1; index <= parts.length; index += 1) {
    try {
      if (minimatch(parts.slice(0, index).join("/"), pattern, { dot: true })) return true;
    } catch {
      return false;
    }
  }
  return false;
}
