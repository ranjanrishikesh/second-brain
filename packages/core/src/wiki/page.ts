import { createHash } from "node:crypto";
import { parse, stringify } from "yaml";
import {
  citationV1Schema,
  type CitationV1,
  wikiPageV1Schema,
  type WikiPageV1,
} from "./types.js";

interface PageFrontmatterV1 {
  schema: 1;
  id: string;
  title: string;
  type: string;
  status: string;
  summary: string;
  aliases: string[];
  tags: string[];
  created_at: string;
  updated_at: string;
  revision: string;
  sources: WikiPageV1["sources"];
  relations: Array<{
    target_id: string;
    kind: string;
    anchor?: string;
    note?: string;
    source_ids: string[];
  }>;
}

const generatedStart = "<!-- brain:generated:start -->";
const generatedEnd = "<!-- brain:generated:end -->";

function revisionPayload(page: WikiPageV1): string {
  return JSON.stringify({
    schema: page.schema,
    id: page.id,
    path: page.path,
    title: page.title,
    type: page.type,
    status: page.status,
    summary: page.summary,
    aliases: page.aliases,
    tags: page.tags,
    createdAt: page.createdAt,
    updatedAt: page.updatedAt,
    sources: page.sources,
    relations: page.relations,
    body: page.body.trim(),
  });
}

export function calculatePageRevision(page: WikiPageV1): string {
  return createHash("sha256").update(revisionPayload(page)).digest("hex");
}

export function renderWikiPage(
  input: WikiPageV1,
  generatedMarkdown?: string,
): string {
  const page = wikiPageV1Schema.parse(input);
  const revision = calculatePageRevision(page);
  const frontmatter: PageFrontmatterV1 = {
    schema: 1,
    id: page.id,
    title: page.title,
    type: page.type,
    status: page.status,
    summary: page.summary,
    aliases: page.aliases,
    tags: page.tags,
    created_at: page.createdAt,
    updated_at: page.updatedAt,
    revision,
    sources: page.sources,
    relations: page.relations.map((relation) => ({
      target_id: relation.targetId,
      kind: relation.kind,
      ...(relation.anchor ? { anchor: relation.anchor } : {}),
      ...(relation.note ? { note: relation.note } : {}),
      source_ids: relation.sourceIds,
    })),
  };
  const generated = generatedMarkdown?.trim()
    ? `\n\n${generatedStart}\n${generatedMarkdown.trim()}\n${generatedEnd}`
    : "";
  return `---\n${stringify(frontmatter, { lineWidth: 0 }).trim()}\n---\n\n${page.body.trim()}${generated}\n`;
}

export function parseWikiPage(markdown: string, pagePath: string): WikiPageV1 {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n+([\s\S]*)$/);
  if (!match)
    throw new Error(`Wiki page is missing YAML frontmatter: ${pagePath}`);
  const frontmatter = parse(match[1] ?? "") as PageFrontmatterV1;
  const bodyWithGenerated = (match[2] ?? "").trim();
  const body = bodyWithGenerated
    .replace(
      new RegExp(`\\n*${generatedStart}[\\s\\S]*?${generatedEnd}\\s*$`),
      "",
    )
    .trim();
  const page = wikiPageV1Schema.parse({
    schema: frontmatter.schema,
    id: frontmatter.id,
    path: pagePath,
    title: frontmatter.title,
    type: frontmatter.type,
    status: frontmatter.status,
    summary: frontmatter.summary,
    aliases: frontmatter.aliases ?? [],
    tags: frontmatter.tags ?? [],
    createdAt: frontmatter.created_at,
    updatedAt: frontmatter.updated_at,
    revision: frontmatter.revision,
    sources: frontmatter.sources ?? [],
    relations: (frontmatter.relations ?? []).map((relation) => ({
      targetId: relation.target_id,
      kind: relation.kind,
      ...(relation.anchor ? { anchor: relation.anchor } : {}),
      ...(relation.note ? { note: relation.note } : {}),
      sourceIds: relation.source_ids ?? [],
    })),
    body,
  });
  const expectedRevision = calculatePageRevision(page);
  if (page.revision !== expectedRevision) {
    throw new Error(`Wiki page revision mismatch: ${pagePath}`);
  }
  return page;
}

export function extractCitations(markdown: string): CitationV1[] {
  const citations: CitationV1[] = [];
  const expression = /\[@(src_[a-f0-9]{16})(?:#([^\]]+))?\]/g;
  for (const match of markdown.matchAll(expression)) {
    citations.push(
      citationV1Schema.parse({
        sourceId: match[1],
        ...(match[2] ? { locator: match[2] } : {}),
      }),
    );
  }
  return citations;
}

export function extractHeadingAnchors(markdown: string): Set<string> {
  const anchors = new Set<string>();
  const counts = new Map<string, number>();
  for (const match of markdown.matchAll(/^#{1,6}\s+(.+?)\s*#*$/gm)) {
    const base = (match[1] ?? "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-|-$/g, "");
    if (!base) continue;
    const count = (counts.get(base) ?? 0) + 1;
    counts.set(base, count);
    anchors.add(`${base}${count > 1 ? `-${count}` : ""}`);
  }
  return anchors;
}

export interface WikiLinkV1 {
  target: string;
  anchor?: string;
}

export function extractWikiLinks(markdown: string): WikiLinkV1[] {
  const links: WikiLinkV1[] = [];
  const expression = /(^|[^!])\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
  for (const match of markdown.matchAll(expression)) {
    const [target, anchor] = (match[2] ?? "").split("#", 2);
    if (!target) continue;
    links.push({
      target: target.replace(/\.md$/, ""),
      ...(anchor ? { anchor } : {}),
    });
  }
  return links;
}
