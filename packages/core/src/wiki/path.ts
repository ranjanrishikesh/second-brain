import path from "node:path";

export function canonicalWikiPagePath(pagePath: string): string {
  const unicodeNormalized = pagePath.normalize("NFKC");
  const normalized = path.posix.normalize(unicodeNormalized);
  if (
    pagePath !== unicodeNormalized ||
    pagePath.includes("\\") ||
    normalized !== pagePath ||
    path.posix.isAbsolute(pagePath) ||
    !pagePath.startsWith("wiki/pages/") ||
    !pagePath.endsWith(".md")
  ) {
    throw new Error(`Non-canonical wiki page path: ${pagePath}`);
  }
  return normalized;
}

export function canonicalWikiPagePathKey(pagePath: string): string {
  return canonicalWikiPagePath(pagePath).toLocaleLowerCase("en");
}
