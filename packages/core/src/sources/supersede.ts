import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { sourceRecordV1Schema, type SourceRecordV1 } from "./types.js";

export async function supersedeSource(
  root: string,
  previousSourceId: string,
  replacementSourceId: string,
): Promise<SourceRecordV1> {
  if (previousSourceId === replacementSourceId) {
    throw new Error("A source cannot supersede itself");
  }
  const manifestPath = path.join(root, ".brain", "source-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    version: 1;
    sources: unknown[];
  };
  const sources = manifest.sources.map((source) =>
    sourceRecordV1Schema.parse(source),
  );
  if (!sources.some((source) => source.id === previousSourceId)) {
    throw new Error(`Previous source does not exist: ${previousSourceId}`);
  }
  const replacementIndex = sources.findIndex(
    (source) => source.id === replacementSourceId,
  );
  if (replacementIndex < 0)
    throw new Error(
      `Replacement source does not exist: ${replacementSourceId}`,
    );
  const replacement = sourceRecordV1Schema.parse({
    ...sources[replacementIndex],
    supersedes: previousSourceId,
  });
  sources[replacementIndex] = replacement;
  await writeFile(
    manifestPath,
    `${JSON.stringify({ version: 1, sources }, null, 2)}\n`,
    "utf8",
  );
  return replacement;
}
