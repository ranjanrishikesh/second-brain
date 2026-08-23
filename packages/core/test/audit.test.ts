import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import {
  applyChangeSetTransaction,
  calculateCatalogRevision,
  initBrain,
  nextSemanticAuditBatch,
  recordSemanticAuditBatch,
  type WikiPageV1,
} from "../src/index.js";

const execFile = promisify(execFileCallback);

async function git(root: string, args: string[]): Promise<string> {
  return (await execFile("git", args, { cwd: root })).stdout.trim();
}

function sourcePage(id: string, title: string): WikiPageV1 {
  return {
    schema: 1,
    id,
    path: `wiki/pages/sources/${id.replace(/^pg_/, "")}.md`,
    title,
    type: "source",
    status: "active",
    summary: `${title} summary.`,
    aliases: [],
    tags: [],
    createdAt: "2026-08-23T00:00:00.000Z",
    updatedAt: "2026-08-23T00:00:00.000Z",
    revision: "pending",
    sources: [],
    relations: [],
    body: `# ${title}\n\n${title} summary.`,
  };
}

describe("semantic audit checkpoints", () => {
  test("becomes due after 25 mutations and resumes from unreviewed pages", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-audit-"));
    await initBrain(root, { name: "Audit", description: "Audit tests" });
    await writeFile(
      path.join(root, ".gitignore"),
      ".brain/cache/\n.brain/runtime/\n",
    );
    const statePath = path.join(root, ".brain", "state.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    state.knowledgeMutations = 24;
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
    await git(root, ["init"]);
    await git(root, ["config", "user.name", "Second Brain Test"]);
    await git(root, ["config", "user.email", "brain-test@example.invalid"]);
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "initial brain"]);

    const firstPage = sourcePage("pg_source_one", "Source One");
    const secondPage = sourcePage("pg_source_two", "Source Two");
    await applyChangeSetTransaction(root, {
      version: 1,
      operationId: "op_mutation_25",
      catalogRevision: calculateCatalogRevision([]),
      reason: "Reach the semantic audit threshold",
      pages: [
        { action: "create", page: firstPage },
        { action: "create", page: secondPage },
      ],
      reconciliation: { candidatePageIds: [], reviewed: [] },
    });

    const dueState = JSON.parse(await readFile(statePath, "utf8"));
    expect(dueState).toMatchObject({
      knowledgeMutations: 25,
      semanticAuditDue: true,
    });
    const initial = await nextSemanticAuditBatch(root);
    expect(initial.pageIds).toEqual([firstPage.id, secondPage.id]);

    const checkpoint = await recordSemanticAuditBatch(root, {
      pageIds: [firstPage.id],
      summary: "Reviewed the first source page; no conflict found.",
    });
    expect(checkpoint.complete).toBe(false);
    expect((await nextSemanticAuditBatch(root)).pageIds).toEqual([
      secondPage.id,
    ]);

    const completed = await recordSemanticAuditBatch(root, {
      pageIds: [secondPage.id],
      summary: "Reviewed the second source page; no conflict found.",
    });
    expect(completed.complete).toBe(true);
    expect(JSON.parse(await readFile(statePath, "utf8"))).toMatchObject({
      semanticAuditDue: false,
      lastSemanticAuditMutation: 25,
      semanticAudit: { status: "completed", pendingPageIds: [] },
    });
    expect(await git(root, ["status", "--short", "--", "wiki", ".brain"])).toBe(
      "",
    );
  });
});
