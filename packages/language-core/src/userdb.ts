import rawUserDb from "./generated/userdb.json" with { type: "json" };

export type UserDbRecordKind = "user" | "group";
export type JsonValueType = "string" | "integer" | "boolean" | "array" | "object" | "null";

export interface UserDbFieldDefinition {
  readonly name: string;
  readonly types: readonly JsonValueType[];
  readonly description: string;
  readonly itemTypes?: readonly JsonValueType[];
  readonly choices?: readonly string[];
  readonly itemChoices?: readonly string[];
  readonly minimum?: number;
  readonly maximum?: number;
  readonly sensitive?: boolean;
}

export interface UserDbRecordDefinition {
  readonly documentation: string;
  readonly required: readonly string[];
  readonly fields: readonly UserDbFieldDefinition[];
}

export interface RawUserDbFile {
  readonly schemaVersion: number;
  readonly upstream: string;
  readonly user: UserDbRecordDefinition;
  readonly group: UserDbRecordDefinition;
}

const userDb = parseUserDbMetadata(rawUserDb);

export function parseUserDbMetadata(value: unknown): RawUserDbFile {
  if (!isRecord(value)) throw new Error("Bundled systemd userdb metadata must be an object.");
  const user = value["user"];
  const group = value["group"];
  if (
    value["schemaVersion"] !== 1 ||
    typeof value["upstream"] !== "string" ||
    !/^[0-9a-f]{40}$/u.test(value["upstream"]) ||
    !isRecordDefinition(user) ||
    !isRecordDefinition(group)
  ) {
    throw new Error("Bundled systemd userdb metadata is invalid.");
  }
  return {
    schemaVersion: 1,
    upstream: value["upstream"],
    user,
    group,
  };
}

export const userDbMetadata: Readonly<{
  readonly upstream: string;
  readonly user: UserDbRecordDefinition;
  readonly group: UserDbRecordDefinition;
}> = {
  upstream: userDb.upstream,
  user: userDb.user,
  group: userDb.group,
};

export function userDbDefinition(kind: UserDbRecordKind): UserDbRecordDefinition {
  return userDbMetadata[kind];
}

export function userDbFieldFor(
  kind: UserDbRecordKind,
  name: string,
): UserDbFieldDefinition | undefined {
  return userDbDefinition(kind).fields.find((field) => field.name === name);
}

function isRecordDefinition(value: unknown): value is UserDbRecordDefinition {
  return (
    isRecord(value) &&
    typeof value["documentation"] === "string" &&
    Array.isArray(value["required"]) &&
    value["required"].every((name) => typeof name === "string") &&
    Array.isArray(value["fields"]) &&
    value["fields"].every(
      (field) =>
        isRecord(field) &&
        typeof field["name"] === "string" &&
        Array.isArray(field["types"]) &&
        field["types"].every((type) => typeof type === "string"),
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
