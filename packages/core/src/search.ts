import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { extractMarkdown } from "./sources/extract.js";
import type { ExtractedSourceV1, SourceRecordV1 } from "./sources/types.js";
import { parseWikiPage } from "./wiki/page.js";

export type SearchScope = "wiki" | "sources" | "all";

export interface SearchOptions {
  query: string;
  scope?: SearchScope;
  limit?: number;
}

export interface SearchResult {
  kind: "wiki" | "source";
  id: string;
  title: string;
  path: string;
  locator: string;
  snippet: string;
  score: number;
}

const cacheRelativePath = path.join(".brain", "cache", "search.sqlite");

async function markdownFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await markdownFiles(absolute)));
    if (entry.isFile() && entry.name.endsWith(".md")) files.push(absolute);
  }
  return files;
}

async function currentSearchRevision(root: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(
    await readFile(path.join(root, ".brain", "source-manifest.json")),
  );
  for (const absolutePath of (
    await markdownFiles(path.join(root, "wiki"))
  ).sort()) {
    hash.update(path.relative(root, absolutePath));
    hash.update(await readFile(absolutePath));
  }
  return hash.digest("hex");
}

function titleFromWiki(markdown: string, filePath: string): string {
  return (
    markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? path.basename(filePath, ".md")
  );
}

export async function rebuildSearchIndex(root: string): Promise<void> {
  const revision = await currentSearchRevision(root);
  const cachePath = path.join(root, cacheRelativePath);
  await mkdir(path.dirname(cachePath), { recursive: true });
  await rm(cachePath, { force: true });
  const database = new Database(cachePath);
  try {
    database.exec(`
      CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE VIRTUAL TABLE documents USING fts5(
        kind UNINDEXED,
        id UNINDEXED,
        title,
        path UNINDEXED,
        locator UNINDEXED,
        text,
        tokenize = 'unicode61 remove_diacritics 2'
      );
    `);
    database
      .prepare("INSERT INTO metadata(key, value) VALUES ('revision', ?)")
      .run(revision);
    const insert = database.prepare(
      "INSERT INTO documents(kind, id, title, path, locator, text) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const manifest = JSON.parse(
      await readFile(path.join(root, ".brain", "source-manifest.json"), "utf8"),
    ) as { sources: SourceRecordV1[] };
    for (const source of manifest.sources) {
      if (source.extractionStatus !== "ready") continue;
      const extracted = JSON.parse(
        await readFile(
          path.join(root, ".brain", "cache", "extracted", `${source.id}.json`),
          "utf8",
        ),
      ) as ExtractedSourceV1;
      for (const chunk of extracted.chunks) {
        insert.run(
          "source",
          source.id,
          source.title,
          source.path,
          chunk.locator,
          chunk.text,
        );
      }
    }

    const wikiRoot = path.join(root, "wiki");
    for (const absolutePath of (await markdownFiles(wikiRoot)).sort()) {
      const markdown = await readFile(absolutePath, "utf8");
      const relativePath = path
        .relative(root, absolutePath)
        .split(path.sep)
        .join("/");
      if (relativePath.startsWith("wiki/pages/")) {
        const page = parseWikiPage(markdown, relativePath);
        const extracted = extractMarkdown(page.id, relativePath, page.body);
        for (const chunk of extracted.chunks) {
          insert.run(
            "wiki",
            page.id,
            page.title,
            relativePath,
            chunk.locator,
            chunk.text,
          );
        }
      } else {
        insert.run(
          "wiki",
          `wiki:${relativePath}`,
          titleFromWiki(markdown, relativePath),
          relativePath,
          "document",
          markdown,
        );
      }
    }
  } finally {
    database.close();
  }
}

async function searchIndexIsCurrent(
  root: string,
  cachePath: string,
): Promise<boolean> {
  try {
    await access(cachePath);
    const database = new Database(cachePath, { readonly: true });
    try {
      const row = database
        .prepare("SELECT value FROM metadata WHERE key = 'revision'")
        .get() as { value: string } | undefined;
      return row?.value === (await currentSearchRevision(root));
    } finally {
      database.close();
    }
  } catch {
    return false;
  }
}

function ftsQuery(query: string): string {
  const terms = query.match(/[\p{L}\p{N}_-]+/gu) ?? [];
  if (terms.length === 0)
    throw new Error("Search query must contain a letter or number");
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" AND ");
}

export async function searchBrain(
  root: string,
  options: SearchOptions,
): Promise<SearchResult[]> {
  const cachePath = path.join(root, cacheRelativePath);
  if (!(await searchIndexIsCurrent(root, cachePath)))
    await rebuildSearchIndex(root);
  const database = new Database(cachePath, { readonly: true });
  try {
    const scope = options.scope ?? "all";
    const scopeClause = scope === "all" ? "" : "AND kind = ?";
    const statement = database.prepare(`
      SELECT kind, id, title, path, locator,
             snippet(documents, 5, '', '', ' … ', 24) AS snippet,
             -bm25(documents, 4.0, 1.0) AS score
      FROM documents
      WHERE documents MATCH ? ${scopeClause}
      ORDER BY bm25(documents, 4.0, 1.0), path, locator
      LIMIT ?
    `);
    const parameters =
      scope === "all"
        ? [ftsQuery(options.query), options.limit ?? 10]
        : [
            ftsQuery(options.query),
            scope === "sources" ? "source" : "wiki",
            options.limit ?? 10,
          ];
    return statement
      .all(...parameters)
      .map((row) => row as unknown as SearchResult);
  } finally {
    database.close();
  }
}
