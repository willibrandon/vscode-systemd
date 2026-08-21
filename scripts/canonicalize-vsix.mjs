import { Buffer } from "node:buffer";

const endOfCentralDirectorySignature = 0x06054b50;
const centralDirectorySignature = 0x02014b50;
const localFileSignature = 0x04034b50;
const canonicalTime = 0;
const canonicalDate = 33; // 1980-01-01, the earliest date representable by ZIP.

export function canonicalizeVsix(value) {
  if (!Buffer.isBuffer(value)) throw new TypeError("VSIX input must be a Buffer.");
  const archive = Buffer.from(value);
  const end = findEndOfCentralDirectory(archive);
  const disk = archive.readUInt16LE(end + 4);
  const centralDisk = archive.readUInt16LE(end + 6);
  const diskEntries = archive.readUInt16LE(end + 8);
  const entries = archive.readUInt16LE(end + 10);
  const centralSize = archive.readUInt32LE(end + 12);
  const centralOffset = archive.readUInt32LE(end + 16);
  if (
    disk !== 0 ||
    centralDisk !== 0 ||
    diskEntries !== entries ||
    entries === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff
  ) {
    throw new Error("VSIX must be a single-disk, non-ZIP64 archive.");
  }
  const centralEnd = centralOffset + centralSize;
  if (centralEnd !== end || centralEnd > archive.length) {
    throw new Error("VSIX central directory is malformed.");
  }

  let offset = centralOffset;
  for (let index = 0; index < entries; index += 1) {
    assertSignature(archive, offset, centralDirectorySignature, "central directory");
    const filenameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localOffset = archive.readUInt32LE(offset + 42);
    const filenameStart = offset + 46;
    const next = filenameStart + filenameLength + extraLength + commentLength;
    if (next > centralEnd || filenameLength === 0) {
      throw new Error("VSIX central directory entry is malformed.");
    }
    assertSignature(archive, localOffset, localFileSignature, "local file");
    const localFilenameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    if (localOffset + 30 + localFilenameLength + localExtraLength > centralOffset) {
      throw new Error("VSIX local file entry is malformed.");
    }

    archive.writeUInt16LE(canonicalTime, localOffset + 10);
    archive.writeUInt16LE(canonicalDate, localOffset + 12);
    archive.writeUInt16LE(canonicalTime, offset + 12);
    archive.writeUInt16LE(canonicalDate, offset + 14);
    const directory = archive[filenameStart + filenameLength - 1] === 0x2f;
    const unixMode = directory ? 0o40755 : 0o100644;
    archive.writeUInt32LE(((unixMode << 16) | (directory ? 0x10 : 0)) >>> 0, offset + 38);
    offset = next;
  }
  if (offset !== centralEnd) throw new Error("VSIX central directory entry count is malformed.");
  return archive;
}

function findEndOfCentralDirectory(archive) {
  const minimum = Math.max(0, archive.length - 65_557);
  for (let offset = archive.length - 22; offset >= minimum; offset -= 1) {
    if (archive.readUInt32LE(offset) !== endOfCentralDirectorySignature) continue;
    const commentLength = archive.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === archive.length) return offset;
  }
  throw new Error("VSIX end-of-central-directory record is missing.");
}

function assertSignature(archive, offset, expected, description) {
  if (offset < 0 || offset + 4 > archive.length || archive.readUInt32LE(offset) !== expected) {
    throw new Error("VSIX " + description + " signature is malformed.");
  }
}
