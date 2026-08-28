import ignore from "ignore";

export interface GitIgnoreFile {
  readonly contents: string;
  readonly directory: string;
}

interface IgnoreScope {
  readonly directory: string;
  readonly matcher: ReturnType<typeof ignore>;
}

export class GitIgnoreRules {
  private readonly scopes: readonly IgnoreScope[];

  public constructor(files: readonly GitIgnoreFile[]) {
    const scopes: IgnoreScope[] = [];
    const ordered = files
      .map((file) => ({ ...file, directory: normalizePath(file.directory, false) }))
      .sort(
        (left, right) =>
          pathDepth(left.directory) - pathDepth(right.directory) ||
          left.directory.localeCompare(right.directory),
      );
    for (const file of ordered) {
      if (file.directory !== "" && ignoredByScopes(file.directory + "/", scopes)) {
        continue;
      }
      try {
        scopes.push({
          directory: file.directory,
          matcher: ignore().add(file.contents),
        });
      } catch {
        // A malformed ignore file must not disable workspace indexing.
      }
    }
    this.scopes = scopes;
  }

  public ignores(relativePath: string, directory = false): boolean {
    const normalized = normalizePath(relativePath, directory);
    return normalized !== "" && ignoredByScopes(normalized, this.scopes);
  }
}

function ignoredByScopes(path: string, scopes: readonly IgnoreScope[]): boolean {
  let ignored = false;
  for (const scope of scopes) {
    if (
      scope.directory !== "" &&
      path !== scope.directory &&
      !path.startsWith(scope.directory + "/")
    ) {
      continue;
    }
    const scoped = scope.directory === "" ? path : path.slice(scope.directory.length + 1);
    if (scoped === "") continue;
    const result = scope.matcher.test(scoped);
    if (result.ignored) ignored = true;
    else if (result.unignored) ignored = false;
  }
  return ignored;
}

function normalizePath(value: string, directory: boolean): string {
  const normalized = value
    .replaceAll("\\", "/")
    .replace(/^\.\//u, "")
    .replace(/^\/+|\/+$/gu, "")
    .replace(/\/{2,}/gu, "/");
  return directory && normalized !== "" ? normalized + "/" : normalized;
}

function pathDepth(value: string): number {
  return value === "" ? 0 : value.split("/").length;
}
