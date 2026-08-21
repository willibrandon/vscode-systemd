import { NotificationType, RequestType } from "vscode-languageserver-protocol";
import type { DialectId } from "@systemd/language-core";

export interface ReadFileParams {
  readonly uri: string;
}

export interface ReadDirectoryParams {
  readonly uri: string;
}

export interface FileStat {
  readonly type: "file" | "directory" | "other";
  readonly size: number;
  readonly mtime: number;
}

export interface EffectiveConfigurationParams {
  readonly uri: string;
}

export interface DependencyGraphParams {
  readonly uri?: string;
}

export interface DependencyGraph {
  readonly nodes: readonly string[];
  readonly edges: readonly {
    readonly source: string;
    readonly target: string;
    readonly kind: string;
  }[];
}

export interface DialectDetectionParams {
  readonly uri: string;
  readonly source: string;
}

export interface IndexedDocument {
  readonly uri: string;
  readonly languageId: DialectId;
  readonly source: string;
  readonly mtime: number;
}

export interface IndexedDocumentsParams {
  readonly documents: readonly IndexedDocument[];
  readonly replace: boolean;
}

export const readFileRequest: RequestType<ReadFileParams, string, void> = new RequestType<
  ReadFileParams,
  string,
  void
>("systemd/fs/readFile");
export const readDirectoryRequest: RequestType<ReadDirectoryParams, readonly string[], void> =
  new RequestType<ReadDirectoryParams, readonly string[], void>("systemd/fs/readDirectory");
export const statRequest: RequestType<ReadFileParams, FileStat, void> = new RequestType<
  ReadFileParams,
  FileStat,
  void
>("systemd/fs/stat");
export const effectiveConfigurationRequest: RequestType<
  EffectiveConfigurationParams,
  string,
  void
> = new RequestType<EffectiveConfigurationParams, string, void>("systemd/effectiveConfiguration");
export const dependencyGraphRequest: RequestType<DependencyGraphParams, DependencyGraph, void> =
  new RequestType<DependencyGraphParams, DependencyGraph, void>("systemd/dependencyGraph");
export const detectDialectRequest: RequestType<DialectDetectionParams, DialectId | null, void> =
  new RequestType<DialectDetectionParams, DialectId | null, void>("systemd/detectDialect");
export const indexedDocumentsNotification: NotificationType<IndexedDocumentsParams> =
  new NotificationType<IndexedDocumentsParams>("systemd/index/documents");
export const refreshDiagnosticsNotification: NotificationType<{ readonly uri?: string }> =
  new NotificationType<{ readonly uri?: string }>("systemd/diagnostics/refresh");
