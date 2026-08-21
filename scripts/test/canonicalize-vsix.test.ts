import { describe, expect, it } from "vitest";

interface CanonicalizeVsixModule {
  readonly canonicalizeVsix: (value: Buffer) => Buffer;
}

const moduleUrl = new URL("../canonicalize-vsix.mjs", import.meta.url);
const { canonicalizeVsix } = (await import(moduleUrl.href)) as CanonicalizeVsixModule;

describe("VSIX canonicalization", () => {
  it("normalizes ZIP timestamps and permissions without changing entry data", () => {
    const first = archive(0x1111, 0x2222, 0o100600, "same");
    const second = archive(0x3333, 0x4444, 0o100777, "same");
    const normalized = canonicalizeVsix(first);

    expect(normalized).toEqual(canonicalizeVsix(second));
    expect(normalized).toEqual(canonicalizeVsix(normalized));
    expect(normalized.readUInt16LE(10)).toBe(0);
    expect(normalized.readUInt16LE(12)).toBe(33);
    const central = first.readUInt32LE(first.length - 6);
    expect(normalized.readUInt16LE(central + 12)).toBe(0);
    expect(normalized.readUInt16LE(central + 14)).toBe(33);
    expect(normalized.readUInt32LE(central + 38) >>> 16).toBe(0o100644);
  });

  it("retains content differences and rejects malformed archives", () => {
    expect(canonicalizeVsix(archive(1, 1, 0o100644, "one"))).not.toEqual(
      canonicalizeVsix(archive(1, 1, 0o100644, "two")),
    );
    expect(() => canonicalizeVsix(Buffer.alloc(32))).toThrow(
      "VSIX end-of-central-directory record is missing.",
    );
    const multidisk = archive(1, 1, 0o100644, "same");
    multidisk.writeUInt16LE(1, multidisk.length - 18);
    expect(() => canonicalizeVsix(multidisk)).toThrow(
      "VSIX must be a single-disk, non-ZIP64 archive.",
    );
  });
});

function archive(time: number, date: number, mode: number, text: string): Buffer {
  const filename = Buffer.from("extension/file.txt");
  const data = Buffer.from(text);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(time, 10);
  local.writeUInt16LE(date, 12);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(filename.length, 26);

  const centralOffset = local.length + filename.length + data.length;
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(0x0314, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(time, 12);
  central.writeUInt16LE(date, 14);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(filename.length, 28);
  central.writeUInt32LE((mode << 16) >>> 0, 38);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + filename.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([local, filename, data, central, filename, end]);
}
