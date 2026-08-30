import path from "node:path";

export type SupportedSourceFormatV1 =
  | "markdown"
  | "text"
  | "html"
  | "json"
  | "jsonl"
  | "csv"
  | "tsv"
  | "pdf"
  | "docx"
  | "epub";

export type WebArtifactSourceFormatV1 = Exclude<
  SupportedSourceFormatV1,
  "html"
>;

const sourceFormatsByExtension: Readonly<
  Record<string, SupportedSourceFormatV1>
> = {
  ".md": "markdown",
  ".markdown": "markdown",
  ".txt": "text",
  ".html": "html",
  ".htm": "html",
  ".json": "json",
  ".jsonl": "jsonl",
  ".csv": "csv",
  ".tsv": "tsv",
  ".pdf": "pdf",
  ".docx": "docx",
  ".epub": "epub",
};

export function sourceFormatForPath(
  sourcePath: string,
): SupportedSourceFormatV1 | undefined {
  return sourceFormatsByExtension[path.extname(sourcePath).toLowerCase()];
}
