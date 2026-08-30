import { validateZipArchiveBudget } from "./zip-archive-budget.js";

const maximumArchiveEntries = 1_000;

/**
 * Validates the physical and streamed DOCX ZIP before Mammoth sees it. The
 * generic validator preserves the existing DOCX entry, expansion, path, size,
 * and CRC guarantees while sharing the same pre-decompression boundary with
 * EPUB extraction.
 */
export async function validateDocxArchive(
  bytes: Uint8Array,
  maxBytes: number,
): Promise<void> {
  if (bytes.byteLength > maxBytes) {
    throw new Error(
      `DOCX source exceeds configured maximum of ${maxBytes} bytes`,
    );
  }
  await validateZipArchiveBudget(bytes, {
    label: "DOCX",
    maxEntries: maximumArchiveEntries,
    maxExpandedBytes: maxBytes,
  });
}
