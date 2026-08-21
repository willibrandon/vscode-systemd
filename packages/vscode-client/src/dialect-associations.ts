import { escape as escapeGlob } from "minimatch";

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/\/+$/u, "");
}

export function exactDialectAssociationPattern(
  documentPath: string,
  workspaceFolderPath?: string,
): string {
  const document = normalizePath(documentPath);
  const workspace =
    workspaceFolderPath === undefined ? undefined : normalizePath(workspaceFolderPath);
  const relative =
    workspace !== undefined && (document === workspace || document.startsWith(workspace + "/"))
      ? document.slice(workspace.length).replace(/^\/+/, "")
      : document.replace(/^\/+/, "");
  return escapeGlob(relative);
}

export function withDialectAssociation(
  current: Readonly<Record<string, string>> | undefined,
  pattern: string,
  dialect: string,
): Readonly<Record<string, string>> {
  return { ...current, [pattern]: dialect };
}
