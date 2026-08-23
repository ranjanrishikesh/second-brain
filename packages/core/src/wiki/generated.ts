import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SourceRecordV1 } from "../sources/types.js";
import { loadWikiPages, validateWikiGraph } from "./graph.js";
import { renderWikiPage } from "./page.js";
import type { WikiPageV1 } from "./types.js";

function wikiTarget(page: WikiPageV1, anchor?: string): string {
  const vaultPath = page.path.replace(/^wiki\//, "").replace(/\.md$/, "");
  return `${vaultPath}${anchor ? `#${anchor}` : ""}`;
}

function pageLink(page: WikiPageV1, anchor?: string): string {
  const label = anchor ? `${page.title} § ${anchor}` : page.title;
  return `[[${wikiTarget(page, anchor)}|${label}]]`;
}

function generatedSections(
  page: WikiPageV1,
  pages: WikiPageV1[],
  sourcesById: Map<string, SourceRecordV1>,
): string {
  const pagesById = new Map(
    pages.map((candidate) => [candidate.id, candidate]),
  );
  const connections = page.relations.flatMap((relation) => {
    const target = pagesById.get(relation.targetId);
    if (!target) return [];
    const evidence = relation.sourceIds
      .map((sourceId) => `[@${sourceId}]`)
      .join(" ");
    const description = [relation.kind, relation.note, evidence]
      .filter(Boolean)
      .join(" — ");
    return [`- ${pageLink(target, relation.anchor)} — ${description}`];
  });
  const backlinks = pages.flatMap((candidate) =>
    candidate.relations
      .filter((relation) => relation.targetId === page.id)
      .map((relation) => `- ${pageLink(candidate)} — ${relation.kind}`),
  );
  const sourceLines = page.sources.map((reference) => {
    const source = sourcesById.get(reference.id);
    const locators = reference.locators
      .map((locator) => `#${locator}`)
      .join(", ");
    return `- [@${reference.id}] ${source?.title ?? "Unknown source"} — \`${source?.path ?? "missing"}\`${
      locators ? ` — ${locators}` : ""
    }`;
  });
  return [
    "## Connections",
    "",
    connections.length ? connections.join("\n") : "_None._",
    "",
    "## Backlinks",
    "",
    backlinks.length ? backlinks.join("\n") : "_None._",
    "",
    "## Sources",
    "",
    sourceLines.length ? sourceLines.join("\n") : "_No sources declared._",
  ].join("\n");
}

export async function writeGeneratedWikiFiles(root: string): Promise<void> {
  const pages = await loadWikiPages(root);
  const manifest = JSON.parse(
    await readFile(path.join(root, ".brain", "source-manifest.json"), "utf8"),
  ) as { sources: SourceRecordV1[] };
  const sourcesById = new Map(
    manifest.sources.map((source) => [source.id, source]),
  );
  for (const page of pages) {
    await writeFile(
      path.join(root, page.path),
      renderWikiPage(page, generatedSections(page, pages, sourcesById)),
      "utf8",
    );
  }

  const groups = new Map<string, WikiPageV1[]>();
  for (const page of pages) {
    const group = groups.get(page.type) ?? [];
    group.push(page);
    groups.set(page.type, group);
  }
  const indexLines = ["# Wiki Index", ""];
  for (const type of [...groups.keys()].sort()) {
    indexLines.push(`## ${type[0]?.toUpperCase()}${type.slice(1)}`, "");
    for (const page of (groups.get(type) ?? []).sort((left, right) =>
      left.title.localeCompare(right.title),
    )) {
      indexLines.push(`- ${pageLink(page)} — ${page.summary}`);
    }
    indexLines.push("");
  }
  await writeFile(
    path.join(root, "wiki", "index.md"),
    `${indexLines.join("\n").trim()}\n`,
  );

  const mapLines = ["# Knowledge Map", "", "## Relationships", ""];
  const relationships = pages.flatMap((page) =>
    page.relations.flatMap((relation) => {
      const target = pages.find(
        (candidate) => candidate.id === relation.targetId,
      );
      return target
        ? [`- ${pageLink(page)} — **${relation.kind}** → ${pageLink(target)}`]
        : [];
    }),
  );
  mapLines.push(
    ...(relationships.length ? relationships : ["_No relationships yet._"]),
  );
  await writeFile(
    path.join(root, "wiki", "map.md"),
    `${mapLines.join("\n")}\n`,
  );

  const report = await validateWikiGraph(root);
  const healthLines = [
    "# Brain Health",
    "",
    `- Status: **${report.ok ? "healthy" : "needs attention"}**`,
    `- Pages: ${report.pageCount}`,
    `- Relationships: ${report.edgeCount}`,
    `- Catalog revision: \`${report.catalogRevision}\``,
    "",
    "## Issues",
    "",
    ...(report.issues.length
      ? report.issues.map(
          (issue) =>
            `- **${issue.severity} / ${issue.code}**${issue.pageId ? ` (${issue.pageId})` : ""}: ${issue.message}`,
        )
      : ["_No structural issues._"]),
  ];
  await writeFile(
    path.join(root, "wiki", "reports", "health.md"),
    `${healthLines.join("\n")}\n`,
  );
}
