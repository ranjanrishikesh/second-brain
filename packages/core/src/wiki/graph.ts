import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { loadBrainConfig } from "../config.js";
import { loadExtractedSourceCache } from "../sources/rebuild-cache.js";
import { sourceRecordV1Schema } from "../sources/types.js";
import { inspectWebEvidenceIntegrity } from "../sources/web-evidence.js";
import {
  extractCitations,
  extractHeadingAnchors,
  extractWikiLinks,
  parseWikiPage,
} from "./page.js";
import type { WikiPageV1 } from "./types.js";

export const auditIssueV1Schema = z.object({
  code: z.string().min(1),
  severity: z.enum(["error", "warning"]),
  message: z.string().min(1),
  pageId: z.string().optional(),
  targetId: z.string().optional(),
  path: z.string().optional(),
});

export type AuditIssueV1 = z.infer<typeof auditIssueV1Schema>;

export const auditReportV1Schema = z.object({
  version: z.literal(1),
  ok: z.boolean(),
  catalogRevision: z.string().min(1),
  pageCount: z.number().int().nonnegative(),
  edgeCount: z.number().int().nonnegative(),
  orphanPageIds: z.array(z.string()),
  issues: z.array(auditIssueV1Schema),
});

export type AuditReportV1 = z.infer<typeof auditReportV1Schema>;

interface WikiGraphTestOptions {
  /** Deterministic test seam for observing integrity-inspection scheduling. */
  inspectWebEvidenceIntegrity?: typeof inspectWebEvidenceIntegrity;
}

async function pageFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await pageFiles(absolute)));
    if (entry.isFile() && entry.name.endsWith(".md")) files.push(absolute);
  }
  return files;
}

export async function loadWikiPages(root: string): Promise<WikiPageV1[]> {
  const pages: WikiPageV1[] = [];
  for (const absolutePath of (
    await pageFiles(path.join(root, "wiki", "pages"))
  ).sort()) {
    const relativePath = path
      .relative(root, absolutePath)
      .split(path.sep)
      .join("/");
    pages.push(
      parseWikiPage(await readFile(absolutePath, "utf8"), relativePath),
    );
  }
  return pages;
}

export function calculateCatalogRevision(pages: WikiPageV1[]): string {
  const catalog = [...pages]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((page) => ({
      id: page.id,
      path: page.path,
      title: page.title,
      type: page.type,
      status: page.status,
      summary: page.summary,
      aliases: page.aliases,
      tags: page.tags,
      revision: page.revision,
      relations: page.relations,
      sources: page.sources,
    }));
  return createHash("sha256").update(JSON.stringify(catalog)).digest("hex");
}

export async function validateWikiGraph(
  root: string,
  testOptions: WikiGraphTestOptions = {},
): Promise<AuditReportV1> {
  const config = await loadBrainConfig(root);
  const pages = await loadWikiPages(root);
  const manifest = z
    .object({ version: z.literal(1), sources: z.array(sourceRecordV1Schema) })
    .parse(
      JSON.parse(
        await readFile(
          path.join(root, ".brain", "source-manifest.json"),
          "utf8",
        ),
      ),
    );
  const sourceIds = new Set(manifest.sources.map((source) => source.id));
  const sourcesById = new Map(
    manifest.sources.map((source) => [source.id, source]),
  );
  const integrityIssues: Awaited<
    ReturnType<typeof inspectWebEvidenceIntegrity>
  > = [];
  const integrityInspector =
    testOptions.inspectWebEvidenceIntegrity ?? inspectWebEvidenceIntegrity;
  for (const source of manifest.sources) {
    integrityIssues.push(...(await integrityInspector(root, source)));
  }
  const validLocators = new Map<string, Set<string>>();
  for (const source of manifest.sources) {
    if (source.extractionStatus !== "ready") continue;
    try {
      const extracted = await loadExtractedSourceCache(root, source);
      validLocators.set(
        source.id,
        new Set(extracted.chunks.map((chunk) => chunk.locator)),
      );
    } catch {
      validLocators.set(source.id, new Set());
    }
  }
  const pageIds = new Set(pages.map((page) => page.id));
  const pagesById = new Map(pages.map((page) => [page.id, page]));
  const pagesByLinkName = new Map<string, WikiPageV1>();
  for (const page of pages) {
    pagesByLinkName.set(
      page.path.replace(/^wiki\//, "").replace(/\.md$/, ""),
      page,
    );
    for (const name of [page.title, ...page.aliases]) {
      pagesByLinkName.set(
        name.normalize("NFKC").trim().toLocaleLowerCase("en"),
        page,
      );
    }
  }
  const degrees = new Map(pages.map((page) => [page.id, 0]));
  const issues: AuditIssueV1[] = integrityIssues.map((issue) => ({
    code: issue.code,
    severity: "error",
    message: issue.message,
    path: issue.path,
  }));
  const pageIdCounts = new Map<string, number>();
  for (const page of pages)
    pageIdCounts.set(page.id, (pageIdCounts.get(page.id) ?? 0) + 1);
  for (const [pageId, count] of pageIdCounts) {
    if (count < 2) continue;
    issues.push({
      code: "DUPLICATE_PAGE_ID",
      severity: "error",
      message: `Stable page ID appears at ${count} paths: ${pageId}`,
      pageId,
    });
  }
  const names = new Map<string, string>();
  const duplicateNameIssues = new Set<string>();
  let edgeCount = 0;
  for (const page of pages) {
    if (!config.graph.pageTypes.includes(page.type)) {
      issues.push({
        code: "UNKNOWN_PAGE_TYPE",
        severity: "error",
        message: `Page type is not configured: ${page.type}`,
        pageId: page.id,
      });
    }
    for (const name of [page.title, ...page.aliases]) {
      const normalized = name
        .normalize("NFKC")
        .trim()
        .replace(/\s+/g, " ")
        .toLocaleLowerCase("en");
      const existingPageId = names.get(normalized);
      if (existingPageId && existingPageId !== page.id) {
        for (const pageId of [existingPageId, page.id]) {
          const issueKey = `${normalized}:${pageId}`;
          if (duplicateNameIssues.has(issueKey)) continue;
          duplicateNameIssues.add(issueKey);
          issues.push({
            code: "DUPLICATE_PAGE_NAME",
            severity: "error",
            message: `Page title or alias is not unique: ${name}`,
            pageId,
          });
        }
      } else {
        names.set(normalized, page.id);
      }
    }
    const citations = extractCitations(page.body);
    const referencedSourceIds = new Set([
      ...page.sources.map((source) => source.id),
      ...citations.map((citation) => citation.sourceId),
      ...page.relations.flatMap((relation) => relation.sourceIds),
    ]);
    for (const sourceId of referencedSourceIds) {
      if (sourceIds.has(sourceId)) continue;
      issues.push({
        code: "UNKNOWN_SOURCE",
        severity: "error",
        message: `Referenced source does not exist: ${sourceId}`,
        pageId: page.id,
      });
    }
    for (const sourceReference of page.sources) {
      const sourceLocators = validLocators.get(sourceReference.id);
      if (!sourceLocators) continue;
      for (const locator of sourceReference.locators) {
        if (sourceLocators.has(locator)) continue;
        issues.push({
          code: "INVALID_SOURCE_LOCATOR",
          severity: "error",
          message: `Source locator does not exist: ${sourceReference.id}#${locator}`,
          pageId: page.id,
        });
      }
    }
    const declaredLocators = new Map(
      page.sources.map((source) => [source.id, new Set(source.locators)]),
    );
    for (const citation of citations) {
      const citedSource = sourcesById.get(citation.sourceId);
      if (citedSource && citedSource.extractionStatus !== "ready") {
        issues.push({
          code: "SOURCE_NOT_READY_FOR_CITATION",
          severity: "error",
          message: `Inline citation requires a ready source: ${citation.sourceId}`,
          pageId: page.id,
        });
      }
      if (!citation.locator) {
        issues.push({
          code: "MISSING_CITATION_LOCATOR",
          severity: "error",
          message: `Inline citation requires a locator: ${citation.sourceId}`,
          pageId: page.id,
        });
        continue;
      }
      if (!declaredLocators.get(citation.sourceId)?.has(citation.locator)) {
        issues.push({
          code: "CITATION_NOT_DECLARED",
          severity: "error",
          message: `Inline citation is not declared exactly in page sources: ${citation.sourceId}#${citation.locator}`,
          pageId: page.id,
        });
      }
      const sourceLocators = validLocators.get(citation.sourceId);
      if (sourceLocators && !sourceLocators.has(citation.locator)) {
        issues.push({
          code: "INVALID_CITATION_LOCATOR",
          severity: "error",
          message: `Inline citation locator does not exist: ${citation.sourceId}#${citation.locator}`,
          pageId: page.id,
        });
      }
    }
    for (const link of extractWikiLinks(page.body)) {
      const target = link.target.includes("/")
        ? pagesByLinkName.get(link.target.replace(/^wiki\//, ""))
        : pagesByLinkName.get(
            link.target.normalize("NFKC").trim().toLocaleLowerCase("en"),
          );
      if (!target) {
        issues.push({
          code: "DANGLING_WIKILINK",
          severity: "error",
          message: `Wikilink target does not exist: ${link.target}`,
          pageId: page.id,
        });
      } else if (
        link.anchor &&
        !extractHeadingAnchors(target.body).has(link.anchor)
      ) {
        issues.push({
          code: "DANGLING_WIKILINK_ANCHOR",
          severity: "error",
          message: `Wikilink anchor does not exist: ${link.target}#${link.anchor}`,
          pageId: page.id,
          targetId: target.id,
        });
      }
    }
    for (const relation of page.relations) {
      edgeCount += 1;
      if (!config.graph.relationTypes.includes(relation.kind)) {
        issues.push({
          code: "UNKNOWN_RELATION_TYPE",
          severity: "error",
          message: `Relationship type is not configured: ${relation.kind}`,
          pageId: page.id,
          targetId: relation.targetId,
        });
      }
      if (!pageIds.has(relation.targetId)) {
        issues.push({
          code: "DANGLING_RELATION",
          severity: "error",
          message: `Relationship target does not exist: ${relation.targetId}`,
          pageId: page.id,
          targetId: relation.targetId,
        });
      } else if (relation.anchor) {
        degrees.set(page.id, (degrees.get(page.id) ?? 0) + 1);
        degrees.set(
          relation.targetId,
          (degrees.get(relation.targetId) ?? 0) + 1,
        );
        const target = pagesById.get(relation.targetId);
        if (
          target &&
          !extractHeadingAnchors(target.body).has(relation.anchor)
        ) {
          issues.push({
            code: "DANGLING_ANCHOR",
            severity: "error",
            message: `Relationship anchor does not exist: ${relation.targetId}#${relation.anchor}`,
            pageId: page.id,
            targetId: relation.targetId,
          });
        }
      } else {
        degrees.set(page.id, (degrees.get(page.id) ?? 0) + 1);
        degrees.set(
          relation.targetId,
          (degrees.get(relation.targetId) ?? 0) + 1,
        );
      }
    }
  }
  const orphanPageIds = [
    ...new Set(
      pages
        .filter(
          (page) =>
            page.status === "active" &&
            page.type !== "source" &&
            page.type !== "question" &&
            (degrees.get(page.id) ?? 0) === 0,
        )
        .map((page) => page.id),
    ),
  ].sort();
  for (const pageId of orphanPageIds) {
    issues.push({
      code: "ORPHAN_PAGE",
      severity: "error",
      message: "Active knowledge page has no inbound or outbound relationship",
      pageId,
    });
  }
  return {
    version: 1,
    ok: issues.every((issue) => issue.severity !== "error"),
    catalogRevision: calculateCatalogRevision(pages),
    pageCount: pages.length,
    edgeCount,
    orphanPageIds,
    issues,
  };
}
