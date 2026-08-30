import { crc32 } from "node:zlib";
import { fromBufferPromise } from "yauzl";

const centralDirectorySignature = 0x02014b50;
const endOfCentralDirectorySignature = 0x06054b50;
const zip64EndOfCentralDirectorySignature = 0x06064b50;
const zip64EndOfCentralDirectoryLocatorSignature = 0x07064b50;
const maximumZipCommentBytes = 0xffff;

export interface ZipArchiveBudget {
  label: "DOCX" | "EPUB";
  maxEntries: number;
  maxExpandedBytes: number;
}

class ZipArchiveValidationError extends Error {}

interface CentralDirectoryMetadata {
  centralOffset: number;
  centralSize: number;
  entryCount: number;
  metadataOffset: number;
}

function validationError(message: string): never {
  throw new ZipArchiveValidationError(message);
}

function invalidArchive(label: string, message: string): never {
  validationError(`Invalid ${label} archive: ${message}`);
}

function readSafeUInt64(
  buffer: Buffer,
  offset: number,
  field: string,
  label: string,
): number {
  if (offset < 0 || offset + 8 > buffer.length)
    invalidArchive(label, `${field} is truncated`);
  const value = buffer.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER))
    invalidArchive(label, `${field} exceeds the supported integer range`);
  return Number(value);
}

function findEndOfCentralDirectory(buffer: Buffer, label: string): number {
  if (buffer.length < 22)
    invalidArchive(label, "end of central directory is missing");
  const earliestOffset = Math.max(
    0,
    buffer.length - 22 - maximumZipCommentBytes,
  );
  for (let offset = buffer.length - 22; offset >= earliestOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== endOfCentralDirectorySignature)
      continue;
    const commentLength = buffer.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === buffer.length) return offset;
  }
  invalidArchive(label, "end of central directory is missing or malformed");
}

function readCentralDirectoryMetadata(
  buffer: Buffer,
  label: string,
): CentralDirectoryMetadata {
  const eocdOffset = findEndOfCentralDirectory(buffer, label);
  const diskNumber = buffer.readUInt16LE(eocdOffset + 4);
  const centralDiskNumber = buffer.readUInt16LE(eocdOffset + 6);
  const diskEntryCount = buffer.readUInt16LE(eocdOffset + 8);
  let entryCount = buffer.readUInt16LE(eocdOffset + 10);
  let centralSize = buffer.readUInt32LE(eocdOffset + 12);
  let centralOffset = buffer.readUInt32LE(eocdOffset + 16);
  let metadataOffset = eocdOffset;

  const locatorOffset = eocdOffset - 20;
  const hasZip64Locator =
    locatorOffset >= 0 &&
    buffer.readUInt32LE(locatorOffset) ===
      zip64EndOfCentralDirectoryLocatorSignature;
  if (hasZip64Locator) {
    if (
      buffer.readUInt32LE(locatorOffset + 4) !== 0 ||
      buffer.readUInt32LE(locatorOffset + 16) !== 1
    ) {
      invalidArchive(label, "multi-disk ZIP64 archives are unsupported");
    }
    const zip64Offset = readSafeUInt64(
      buffer,
      locatorOffset + 8,
      "ZIP64 directory offset",
      label,
    );
    if (
      zip64Offset + 56 > locatorOffset ||
      buffer.readUInt32LE(zip64Offset) !== zip64EndOfCentralDirectorySignature
    ) {
      invalidArchive(label, "ZIP64 end of central directory is malformed");
    }
    const zip64RecordSize = readSafeUInt64(
      buffer,
      zip64Offset + 4,
      "ZIP64 directory record size",
      label,
    );
    if (
      zip64RecordSize < 44 ||
      zip64Offset + 12 + zip64RecordSize !== locatorOffset
    ) {
      invalidArchive(label, "ZIP64 directory record length is inconsistent");
    }
    if (
      buffer.readUInt32LE(zip64Offset + 16) !== 0 ||
      buffer.readUInt32LE(zip64Offset + 20) !== 0
    ) {
      invalidArchive(label, "multi-disk ZIP64 archives are unsupported");
    }
    const zip64DiskEntryCount = readSafeUInt64(
      buffer,
      zip64Offset + 24,
      "ZIP64 disk entry count",
      label,
    );
    entryCount = readSafeUInt64(
      buffer,
      zip64Offset + 32,
      "ZIP64 entry count",
      label,
    );
    if (zip64DiskEntryCount !== entryCount)
      invalidArchive(label, "ZIP64 entry counts are inconsistent");
    centralSize = readSafeUInt64(
      buffer,
      zip64Offset + 40,
      "ZIP64 central directory size",
      label,
    );
    centralOffset = readSafeUInt64(
      buffer,
      zip64Offset + 48,
      "ZIP64 central directory offset",
      label,
    );
    metadataOffset = zip64Offset;
  } else {
    if (
      diskNumber === 0xffff ||
      centralDiskNumber === 0xffff ||
      diskEntryCount === 0xffff ||
      entryCount === 0xffff ||
      centralSize === 0xffffffff ||
      centralOffset === 0xffffffff
    ) {
      invalidArchive(label, "ZIP64 metadata is missing");
    }
    if (diskNumber !== 0 || centralDiskNumber !== 0)
      invalidArchive(label, "multi-disk archives are unsupported");
    if (diskEntryCount !== entryCount)
      invalidArchive(label, "central directory entry counts are inconsistent");
  }
  return { centralOffset, centralSize, entryCount, metadataOffset };
}

function assertSafeRawEntryName(nameBytes: Buffer, label: string): void {
  const rawName = nameBytes.toString("latin1");
  if (
    rawName.length === 0 ||
    rawName.includes("\0") ||
    rawName.includes("\\") ||
    rawName.startsWith("/") ||
    /^[A-Za-z]:/.test(rawName) ||
    rawName.split("/").includes("..")
  ) {
    validationError(`Unsafe ${label} path: ${rawName || "<empty>"}`);
  }
}

function inspectPhysicalCentralDirectory(
  buffer: Buffer,
  policy: ZipArchiveBudget,
): number {
  const metadata = readCentralDirectoryMetadata(buffer, policy.label);
  if (metadata.entryCount > policy.maxEntries)
    validationError(`${policy.label} contains too many archive entries`);
  if (
    metadata.centralOffset < 0 ||
    metadata.centralSize < 0 ||
    metadata.centralOffset > metadata.metadataOffset ||
    metadata.centralSize > metadata.metadataOffset - metadata.centralOffset ||
    metadata.centralOffset + metadata.centralSize !== metadata.metadataOffset
  ) {
    invalidArchive(policy.label, "central directory bounds are inconsistent");
  }

  const centralEnd = metadata.centralOffset + metadata.centralSize;
  let cursor = metadata.centralOffset;
  let physicalEntryCount = 0;
  const rawNames = new Set<string>();
  while (cursor < centralEnd) {
    if (
      cursor + 46 > centralEnd ||
      buffer.readUInt32LE(cursor) !== centralDirectorySignature
    ) {
      invalidArchive(
        policy.label,
        "physical central directory record is malformed",
      );
    }
    const fileNameLength = buffer.readUInt16LE(cursor + 28);
    const extraFieldLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const recordLength = 46 + fileNameLength + extraFieldLength + commentLength;
    if (cursor + recordLength > centralEnd)
      invalidArchive(
        policy.label,
        "physical central directory record is truncated",
      );
    physicalEntryCount += 1;
    if (physicalEntryCount > policy.maxEntries)
      validationError(`${policy.label} contains too many archive entries`);
    const nameBytes = buffer.subarray(
      cursor + 46,
      cursor + 46 + fileNameLength,
    );
    assertSafeRawEntryName(nameBytes, policy.label);
    const rawNameKey = nameBytes.toString("hex");
    if (rawNames.has(rawNameKey)) {
      validationError(
        `Duplicate ${policy.label} archive entry: ${nameBytes.toString("utf8")}`,
      );
    }
    rawNames.add(rawNameKey);
    cursor += recordLength;
  }
  if (physicalEntryCount !== metadata.entryCount) {
    invalidArchive(
      policy.label,
      `central directory declares ${metadata.entryCount} entries but contains ${physicalEntryCount}`,
    );
  }
  return physicalEntryCount;
}

function isEntrySizeError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes("too many bytes in the stream") ||
      error.message.includes("not enough bytes in the stream") ||
      error.message.includes("compressed/uncompressed size mismatch"))
  );
}

function isEntryPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.startsWith("invalid characters in fileName") ||
      error.message.startsWith("absolute path") ||
      error.message.startsWith("invalid relative path"))
  );
}

export async function validateZipArchiveBudget(
  bytes: Uint8Array,
  policy: ZipArchiveBudget,
): Promise<void> {
  try {
    const buffer = Buffer.from(bytes);
    const physicalEntryCount = inspectPhysicalCentralDirectory(buffer, policy);
    const zipfile = await fromBufferPromise(buffer, {
      strictFileNames: true,
      validateEntrySizes: true,
    });
    if (zipfile.entryCount !== physicalEntryCount)
      invalidArchive(
        policy.label,
        "ZIP reader and physical entry counts disagree",
      );

    const names = new Set<string>();
    let entriesRead = 0;
    let declaredBytes = 0;
    let actualBytes = 0;
    try {
      for await (const entry of zipfile.eachEntry()) {
        entriesRead += 1;
        if (entriesRead > policy.maxEntries)
          validationError(`${policy.label} contains too many archive entries`);
        if (names.has(entry.fileName))
          validationError(
            `Duplicate ${policy.label} archive entry: ${entry.fileName}`,
          );
        names.add(entry.fileName);
        if (!entry.canDecodeFileData() || entry.isEncrypted()) {
          validationError(
            `${policy.label} archive entry uses unsupported encoding or encryption: ${entry.fileName}`,
          );
        }
        if (entry.uncompressedSize > policy.maxExpandedBytes - declaredBytes) {
          validationError(
            `Expanded ${policy.label} content exceeds configured maximum of ${policy.maxExpandedBytes} bytes`,
          );
        }
        declaredBytes += entry.uncompressedSize;

        let entryBytes = 0;
        let entryCrc = 0;
        try {
          const stream = await zipfile.openReadStreamPromise(entry);
          for await (const rawChunk of stream) {
            const chunk = Buffer.isBuffer(rawChunk)
              ? rawChunk
              : Buffer.from(rawChunk);
            if (chunk.byteLength > policy.maxExpandedBytes - actualBytes) {
              stream.destroy();
              validationError(
                `Expanded ${policy.label} content exceeds configured maximum of ${policy.maxExpandedBytes} bytes`,
              );
            }
            actualBytes += chunk.byteLength;
            entryBytes += chunk.byteLength;
            entryCrc = crc32(chunk, entryCrc);
          }
        } catch (error) {
          if (error instanceof ZipArchiveValidationError) throw error;
          if (isEntrySizeError(error)) {
            validationError(
              `${policy.label} entry size does not match its declaration: ${entry.fileName}`,
            );
          }
          throw error;
        }
        if (entryBytes !== entry.uncompressedSize) {
          validationError(
            `${policy.label} entry size does not match its declaration: ${entry.fileName}`,
          );
        }
        if (entryCrc !== entry.crc32)
          validationError(
            `${policy.label} entry CRC mismatch: ${entry.fileName}`,
          );
      }
    } catch (error) {
      if (isEntryPathError(error)) {
        validationError(
          `Unsafe ${policy.label} path: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      throw error;
    } finally {
      zipfile.close();
    }
    if (entriesRead !== physicalEntryCount)
      invalidArchive(
        policy.label,
        "ZIP reader stopped before the physical directory ended",
      );
  } catch (error) {
    if (error instanceof ZipArchiveValidationError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new ZipArchiveValidationError(
      `Invalid ${policy.label} archive: ${detail}`,
      { cause: error },
    );
  }
}
