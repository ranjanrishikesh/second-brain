# V1 Knowledge Workflow Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the template into a safely self-compounding knowledge system with explicit setup, whole-graph hybrid reconciliation, question-scoped web approval, and safe Git synchronization.

**Architecture:** Keep Markdown, source manifests, and tracked state canonical. Add a local, rebuildable semantic index beside FTS5; use it to generate whole-graph reconciliation candidates, then require current-revision reads and a decision for each candidate. Setup, web approval, and synchronization are explicit state machines implemented in the shared core and exposed through the CLI to Codex and Claude Code.

**Tech Stack:** TypeScript ESM, pnpm, Zod v4, Vitest, SQLite FTS5, `@huggingface/transformers@4.2.0`, `Xenova/multilingual-e5-small` at revision `761b726dd34fb83930e26aab4e9ac3899aa1fa78`, and Git CLI.

**Spec:** `docs/superpowers/specs/2026-08-27-v1-knowledge-workflow-hardening-design.md`

## Global Constraints

- Keep one repository as one independent brain; do not add cross-brain links.
- Keep `sources/`, `wiki/`, `.brain/source-manifest.json`, `.brain/state.json`, and `.brain/operations.jsonl` canonical and write them only through managed core transactions.
- Keep `.brain/cache/` and `.brain/runtime/` disposable; cache deletion must never alter canonical knowledge.
- Use schema version `1` and backwards-compatible defaults for newly optional serialized fields; do not introduce a version `2` schema.
- Pin the local embedding model revision and artifact SHA-256 `f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193`; never silently fall back to lexical-only reconciliation.
- Require a per-query web approval before a query can enter the web tier; approval expires after 24 hours if the query remains open.
- Auto-commit managed knowledge changes. Push only to an explicitly confirmed target, only as a normal fast-forward, never by force, pull, merge, rebase, remote rewrite, or conflict resolution.
- Preserve unrelated unstaged work. Refuse managed writes with staged changes or dirty managed paths.
- Every production behavior starts with a focused failing Vitest test, is run red, receives minimal production code, then is run green before the task commit.
- Run `pnpm verify:fast` after every green task. Final verification additionally runs `pnpm format:check`, `pnpm build`, `pnpm test:e2e`, `pnpm schemas:generate`, and `pnpm brain doctor`.

## File map

| Path | Responsibility |
| --- | --- |
| `packages/core/src/state.ts` | Version-1 tracked-state schemas, safe state reads/writes, setup and sync state helpers. |
| `packages/core/src/semantic.ts` | Local embedding provider, model preparation/checksum verification, rebuildable semantic cache, cosine ranking. |
| `packages/core/src/reconciliation.ts` | Candidate reason calculation, RRF fusion, reconciliation plans, read receipt validation. |
| `packages/core/src/setup.ts` | Resumable initial setup and delta catalog lifecycle. |
| `packages/core/src/web-approval.ts` | Query-scoped web approval request, resolution, expiry, and validation. |
| `packages/core/src/sync.ts` | Confirmed-target Git synchronization and visible pending-state calculation. |
| `packages/core/src/search.ts` | Existing FTS5 plus hybrid result fusion and semantic-index invalidation. |
| `packages/core/src/query.ts` / `query-finish.ts` | Setup/delta, approval, and sync gates in question lifecycle. |
| `packages/core/src/wiki/types.ts` / `wiki/mutate.ts` | Versioned reconciliation receipt and mutation enforcement. |
| `packages/core/src/transaction.ts` | Managed Git trailers and post-commit synchronization without rollback on push failure. |
| `packages/core/src/status-read.ts` / `doctor.ts` | Setup, semantic, approval, writer-lock, and sync observability. |
| `packages/cli/src/program.ts` | Setup, reconciliation/read-receipt, web-approval, and sync commands. |
| `AGENTS.md` / `CLAUDE.md` / `.agents/skills/second-brain/SKILL.md` | Codex and Claude Code lifecycle rules, approval, and sync warning contract. |
| `docs/*`, `README.md`, `test/e2e/*` | Template instructions, v1 exit reminder, deterministic full-lifecycle coverage. |

---

### Task 1: Extend tracked state, configuration, and public schemas

**Files:**

- Create: `packages/core/src/state.ts`
- Modify: `packages/core/src/config.ts`
- Modify: `packages/core/src/init.ts`
- Modify: `packages/core/src/status-read.ts`
- Modify: `packages/core/src/doctor.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/src/json-schemas.ts`
- Modify: `scripts/generate-json-schemas.ts`
- Modify: `packages/core/test/config.test.ts`
- Modify: `packages/core/test/status-read.test.ts`
- Modify: `packages/core/test/public-schemas.test.ts`

**Interfaces:**

- Consumes: existing `BrainConfigV1`, `.brain/state.json`, and `BrainStatusV1`.
- Produces: `BrainStateV1`, `SetupStateV1`, `SyncTargetV1`, `SyncStatusV1`, `SemanticIndexMetadataV1`, and configuration defaults used by every later task.

- [ ] **Step 1: Write failing state/configuration tests**

Add tests proving that a fresh brain exposes a `setup.status` of `not-started`, has no configured sync target, and keeps auto-push disabled. Add a test that parses a legacy state file without the new fields and yields the same defaults.

```ts
test("defaults legacy state to an unconfigured setup and disabled push", async () => {
  const root = await initializedBrain();
  await writeFile(
    path.join(root, ".brain", "state.json"),
    JSON.stringify({ version: 1, catalogRevision: "empty", knowledgeMutations: 0, lastSemanticAuditMutation: 0 }),
  );

  expect(await statusBrain(root)).toMatchObject({
    setup: { status: "not-started", required: true },
    sync: { status: "unconfigured" },
  });
  expect((await loadBrainConfig(root)).git.autoPush).toBe(false);
});
```

- [ ] **Step 2: Run the focused tests and confirm they fail because the fields are absent**

Run: `pnpm vitest run packages/core/test/config.test.ts packages/core/test/status-read.test.ts packages/core/test/public-schemas.test.ts`

Expected: FAIL with missing `setup` or `sync` properties, not a fixture or TypeScript error.

- [ ] **Step 3: Implement only the shared v1 state/configuration defaults**

Create `state.ts` with Zod schemas and helpers. Keep serialised additions optional with defaults so existing clone state remains readable.

```ts
export const setupStateV1Schema = z.object({
  status: z.enum(["not-started", "in-progress", "completed"]).default("not-started"),
  id: z.string().regex(/^setup_[a-f0-9]{32}$/).optional(),
  pendingSourceIds: z.array(sourceIdSchema).default([]),
  completedAt: z.string().datetime().optional(),
});

export const syncStatusV1Schema = z.object({
  status: z.enum(["unconfigured", "synced", "pending", "manual-sync-required"]),
  commit: z.string().regex(/^[a-f0-9]{40,64}$/).optional(),
  remote: z.string().optional(),
  branch: z.string().optional(),
  reason: z.string().optional(),
});
```

Make `git.autoPush` a boolean defaulting to `false`; add `web.approvalTtlHours` default `24`; add `graph.semanticModel` metadata defaults containing the exact model revision/checksum. Initialize these state fields in `initBrain`, expose them in `BrainStatusV1`, and make `doctorBrain` parse them.

- [ ] **Step 4: Re-run focused tests and full fast verification**

Run: `pnpm vitest run packages/core/test/config.test.ts packages/core/test/status-read.test.ts packages/core/test/public-schemas.test.ts && pnpm verify:fast && pnpm schemas:generate && git diff --exit-code -- schemas`

Expected: PASS; generated schemas include the new public state/status contracts.

- [ ] **Step 5: Commit the green slice**

```bash
git add packages/core/src/state.ts packages/core/src/config.ts packages/core/src/init.ts packages/core/src/status-read.ts packages/core/src/doctor.ts packages/core/src/index.ts packages/core/src/json-schemas.ts scripts/generate-json-schemas.ts packages/core/test/config.test.ts packages/core/test/status-read.test.ts packages/core/test/public-schemas.test.ts schemas
git commit -m "feat: add v1 setup and sync state contracts"
```

### Task 2: Add a rebuildable local semantic index and hybrid search

**Files:**

- Create: `packages/core/src/semantic.ts`
- Create: `packages/core/test/semantic.test.ts`
- Create: `packages/core/test/helpers/embeddings.ts`
- Modify: `packages/core/package.json`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `packages/core/src/search.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/test/search.test.ts`

**Interfaces:**

- Consumes: `BrainConfigV1.graph.semanticModel`, source extraction cache, rendered wiki pages, and FTS result records.
- Produces: `EmbeddingProvider`, `SemanticIndexMetadataV1`, `prepareSemanticModel`, `rebuildSemanticIndex`, `semanticSearch`, and `searchBrain(..., { ranking: "hybrid" })`.

- [ ] **Step 1: Write failing semantic-cache and hybrid-ranking tests**

Use a deterministic in-process `EmbeddingProvider` test double with hand-written vectors; it replaces only model inference while all file discovery, cache writing, and ranking stay real. Prove that a semantic synonym is found when FTS has no matching token and that deleting `.brain/cache/semantic-index.json` rebuilds identical ranking.

```ts
test("finds a conceptually related page when lexical terms do not overlap", async () => {
  const root = await brainWithPages([
    page("pg_black_hole", "Black hole", "An event horizon traps light."),
    page("pg_accretion", "Accretion disk", "Matter spirals around a compact object."),
  ]);

  const results = await searchBrain(root, {
    query: "gravity well",
    scope: "wiki",
    ranking: "hybrid",
  }, { embeddings: deterministicEmbeddings({ "gravity well": [1, 0], "Black hole": [1, 0], "Accretion disk": [0, 1] }) });

  expect(results[0]?.id).toBe("pg_black_hole");
});
```

- [ ] **Step 2: Run semantic/search tests and confirm they fail because hybrid search does not exist**

Run: `pnpm vitest run packages/core/test/semantic.test.ts packages/core/test/search.test.ts`

Expected: FAIL with missing `ranking`, missing provider support, or no semantic result.

- [ ] **Step 3: Implement the smallest local semantic index**

Add exact `@huggingface/transformers` dependency version `4.2.0`. Implement a local provider that sets its model cache under `.brain/cache/models`, loads the pinned model revision, verifies the quantized ONNX SHA-256 before use, and returns normalized vectors. Store an atomic JSON semantic index under `.brain/cache/semantic-index.json` containing canonical corpus revision, model identity, dimensions, source/page chunk identity, and vectors.

```ts
export interface EmbeddingProvider {
  readonly modelId: string;
  readonly modelRevision: string;
  embed(texts: readonly string[]): Promise<readonly number[][]>;
}

export interface BrainRuntimeServices {
  embeddings?: EmbeddingProvider;
}

export async function semanticSearch(
  root: string,
  query: string,
  scope: SearchScope,
  limit: number,
  services: BrainRuntimeServices = {},
): Promise<SearchResult[]>;
```

Extend `searchBrain` with `ranking?: "lexical" | "hybrid"`, defaulting to `lexical` so a casual lookup does not download a model. Setup and reconciliation explicitly request `hybrid`. Fuse lexical and semantic ranks using Reciprocal Rank Fusion with deterministic tie-breaks by path and locator. Rebuild both caches from canonical bytes when metadata revision/model metadata does not match. Propagate model download/checksum failures instead of returning lexical-only results when hybrid ranking was explicitly requested.

- [ ] **Step 4: Re-run tests and verify cache rebuild behavior**

Run: `pnpm vitest run packages/core/test/semantic.test.ts packages/core/test/search.test.ts && pnpm verify:fast`

Expected: PASS; the synonym test proves semantic ranking, and cache deletion produces equal results.

- [ ] **Step 5: Commit the green slice**

```bash
git add package.json pnpm-lock.yaml packages/core/package.json packages/core/src/semantic.ts packages/core/src/search.ts packages/core/src/index.ts packages/core/test/helpers/embeddings.ts packages/core/test/semantic.test.ts packages/core/test/search.test.ts
git commit -m "feat: add local hybrid semantic search"
```

### Task 3: Enforce whole-graph reconciliation plans and read receipts

**Files:**

- Create: `packages/core/src/reconciliation.ts`
- Modify: `packages/core/src/wiki/types.ts`
- Modify: `packages/core/src/wiki/mutate.ts`
- Modify: `packages/core/src/transaction.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/test/wiki.test.ts`
- Create: `packages/core/test/reconciliation.test.ts`
- Modify: `packages/core/test/transaction.test.ts`

**Interfaces:**

- Consumes: proposed page mutations, page revisions, FTS/hybrid search, graph links, and `BrainRuntimeServices`.
- Produces: `ReconciliationPlanV1`, `ReadReceiptV1`, `ReconciliationReceiptV1`, `planReconciliation`, and transaction rejection for stale or unread candidates.

- [ ] **Step 1: Write failing tests for semantic candidates, stale reads, and missing decisions**

Test a changed page whose title has no common word with a related page but shares a deterministic semantic vector. Test that the operation rejects when the candidate was not read at its current revision, and rejects when a receipt omits a candidate decision.

```ts
test("rejects an apply when a semantic candidate has not been read", async () => {
  const root = await reconciledBrain();
  const plan = await planReconciliation(root, draftFor("pg_black_hole"), testServices);

  await expect(applyChangeSetTransaction(root, {
    ...changeSetFor("pg_black_hole"),
    reconciliation: {
      plan,
      readReceipts: [],
      reviewed: plan.candidates.map((candidate) => ({
        pageId: candidate.pageId,
        decision: "no-change",
        reason: "Not read intentionally.",
      })),
    },
  }, {}, testServices)).rejects.toThrow(/read receipt/i);
});
```

- [ ] **Step 2: Run focused graph tests and confirm they fail for the missing contract**

Run: `pnpm vitest run packages/core/test/reconciliation.test.ts packages/core/test/wiki.test.ts packages/core/test/transaction.test.ts`

Expected: FAIL because `planReconciliation` and receipt validation are missing.

- [ ] **Step 3: Implement the plan and receipt boundary**

Split mutation mechanics so proposed pages can be calculated before receipt validation. Add these version-1 schemas:

```ts
export const reconciliationCandidateV1Schema = z.object({
  pageId: pageIdSchema,
  revision: z.string().min(1),
  reasons: z.array(z.enum([
    "graph-neighbor", "shared-source", "shared-locator", "shared-tag",
    "shared-alias", "near-duplicate", "contradiction", "lexical", "semantic",
  ])).min(1),
});

export const readReceiptV1Schema = z.object({
  pageId: pageIdSchema,
  revision: z.string().min(1),
  anchor: z.string().min(1).optional(),
  readAt: z.string().datetime(),
});
```

`planReconciliation` must calculate candidates from every active page, union graph/source/tag/alias/duplicate/contradiction signals with lexical and semantic result sets, and give each candidate one or more reasons. `applyChangeSetTransaction` must recompute the plan immediately inside the writer lock, require exact candidate IDs/revisions, require a current read receipt and exactly one non-empty decision for every candidate, then run existing structural validation and generated-file writes. Preserve archive/merge semantics and reject a stale plan before touching canonical files.

- [ ] **Step 4: Re-run focused tests and all fast verification**

Run: `pnpm vitest run packages/core/test/reconciliation.test.ts packages/core/test/wiki.test.ts packages/core/test/transaction.test.ts && pnpm verify:fast`

Expected: PASS; changing a candidate page revision, omitting a receipt, or omitting a decision produces a rejection while a current complete receipt writes successfully.

- [ ] **Step 5: Commit the green slice**

```bash
git add packages/core/src/reconciliation.ts packages/core/src/wiki/types.ts packages/core/src/wiki/mutate.ts packages/core/src/transaction.ts packages/core/src/index.ts packages/core/test/reconciliation.test.ts packages/core/test/wiki.test.ts packages/core/test/transaction.test.ts
git commit -m "feat: enforce whole-graph reconciliation receipts"
```

### Task 4: Add the resumable one-time setup and delta catalog lifecycle

**Files:**

- Create: `packages/core/src/setup.ts`
- Modify: `packages/core/src/state.ts`
- Modify: `packages/core/src/query.ts`
- Modify: `packages/core/src/query-finish.ts`
- Modify: `packages/core/src/transaction.ts`
- Modify: `packages/core/src/status-read.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/test/query.test.ts`
- Create: `packages/core/test/setup.test.ts`

**Interfaces:**

- Consumes: state schemas, source registration, bootstrap source contexts, semantic model preparation, reconciliation/audit APIs.
- Produces: `SetupSessionV1`, `beginSetup`, `nextSetupBatch`, `attachSetupChange`, `finishSetup`, and query-visible setup/delta status.

- [ ] **Step 1: Write failing setup lifecycle tests**

Prove that setup snapshots initial sources, cannot finish while a ready source lacks a source page, resumes after a crash, and that a source added after successful setup appears as delta work on the next query rather than resetting setup.

```ts
test("does not finish setup until every ready initial source has a source page", async () => {
  const root = await initializedBrainWithSource("orbit.md", "# Orbit\n\nBodies orbit masses.");
  const setup = await beginSetup(root, { purpose: "Astronomy concepts" }, testServices);

  await expect(finishSetup(root, setup.id, { summary: "Initial map" }))
    .rejects.toThrow(/source page.*orbit/i);
});
```

- [ ] **Step 2: Run setup/query tests and confirm they fail because setup APIs do not exist**

Run: `pnpm vitest run packages/core/test/setup.test.ts packages/core/test/query.test.ts`

Expected: FAIL with missing setup functions or a query that can finish before setup.

- [ ] **Step 3: Implement setup as a tracked state machine**

Add `beginSetup(root, { purpose, boundaries? }, services?)`. It must reject a placeholder domain charter, recover first, scan sources, prepare the semantic model, and commit `setup.status = "in-progress"` with a stable `setup_<uuid>` ID and current pending source IDs. `nextSetupBatch` returns extracted source contexts from state. `attachSetupChange` accepts only an apply operation bound to the same setup ID. `finishSetup` requires zero pending ready-source pages, a completed semantic audit, and healthy graph before setting `completed`.

Extend `applyChangeSetTransaction` binding from `queryId?` to a discriminated context:

```ts
export type KnowledgeMutationContext =
  | { kind: "query"; id: string }
  | { kind: "setup"; id: string };
```

At `beginQuery`, recover and scan sources. If setup is not complete, attach its setup status to the query and block finishing. If setup is complete, expose only uncataloged new source IDs as `deltaBootstrap`; source page creation for that delta is required before a raw/web answer finishes.

- [ ] **Step 4: Re-run setup/query tests and fast verification**

Run: `pnpm vitest run packages/core/test/setup.test.ts packages/core/test/query.test.ts && pnpm verify:fast`

Expected: PASS; setup is resumable, uses no web tier, and later sources are shallow delta work.

- [ ] **Step 5: Commit the green slice**

```bash
git add packages/core/src/setup.ts packages/core/src/state.ts packages/core/src/query.ts packages/core/src/query-finish.ts packages/core/src/transaction.ts packages/core/src/status-read.ts packages/core/src/index.ts packages/core/test/setup.test.ts packages/core/test/query.test.ts
git commit -m "feat: add resumable brain setup lifecycle"
```

### Task 5: Gate web evidence behind one question-scoped approval

**Files:**

- Create: `packages/core/src/web-approval.ts`
- Modify: `packages/core/src/query.ts`
- Modify: `packages/core/src/query-finish.ts`
- Modify: `packages/core/src/web-capture.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/test/query.test.ts`
- Create: `packages/core/test/web-approval.test.ts`

**Interfaces:**

- Consumes: open query sessions at the source tier and the web evidence capture flow.
- Produces: `WebApprovalRequestV1`, `WebApprovalV1`, `requestWebApproval`, `resolveWebApproval`, and `assertWebApproval`.

- [ ] **Step 1: Write failing approval tests**

Cover four observable behaviors: a query cannot enter web without an approved grant; one grant permits several captures for the exact question; a denied grant keeps the query local; and a 24-hour-old open grant is rejected.

```ts
test("requires an approval bound to the active query before entering web", async () => {
  const { root, session } = await sourceTierQuery();

  await expect(expandQuery(root, session.id, {
    tier: "web",
    reason: "Local evidence is insufficient.",
  })).rejects.toThrow(/web approval/i);
});
```

- [ ] **Step 2: Run the approval/query tests and confirm expected red failures**

Run: `pnpm vitest run packages/core/test/web-approval.test.ts packages/core/test/query.test.ts`

Expected: FAIL because the present query can enter web directly.

- [ ] **Step 3: Implement approval state and enforce it at all core boundaries**

Store approval only in the query runtime session. Its schema includes query ID, SHA-256 hash of normalized question, host/session identity, status, requested/decided timestamps, expiration, and denial reason when present.

```ts
export async function requestWebApproval(
  root: string,
  queryId: string,
  input: { reason: string; hostSessionId: string },
): Promise<WebApprovalRequestV1>;

export async function resolveWebApproval(
  root: string,
  queryId: string,
  input: { approved: boolean; decidedBy: string },
): Promise<QuerySessionV1>;
```

Only `expandQuery(..., { tier: "web" })` after an approved, non-expired grant may change the tier. `captureWebEvidence` calls `assertWebApproval` before creating a prepared evidence file or registering it. `finishQuery` validates the same grant for every web-tier outcome. A denied or expired request leaves the session at sources and allows a locally uncertain partial/unanswered result with a durable gap page.

- [ ] **Step 4: Re-run approval tests and fast verification**

Run: `pnpm vitest run packages/core/test/web-approval.test.ts packages/core/test/query.test.ts && pnpm verify:fast`

Expected: PASS; all web captures and web-backed finishes are bound to one approved active question.

- [ ] **Step 5: Commit the green slice**

```bash
git add packages/core/src/web-approval.ts packages/core/src/query.ts packages/core/src/query-finish.ts packages/core/src/web-capture.ts packages/core/src/index.ts packages/core/test/web-approval.test.ts packages/core/test/query.test.ts
git commit -m "feat: require question-scoped web approval"
```

### Task 6: Add safe managed Git synchronization and pending warnings

**Files:**

- Create: `packages/core/src/sync.ts`
- Modify: `packages/core/src/state.ts`
- Modify: `packages/core/src/transaction.ts`
- Modify: `packages/core/src/query.ts`
- Modify: `packages/core/src/query-finish.ts`
- Modify: `packages/core/src/source-transaction.ts`
- Modify: `packages/core/src/status-read.ts`
- Modify: `packages/core/src/doctor.ts`
- Modify: `packages/core/src/index.ts`
- Create: `packages/core/test/sync.test.ts`
- Modify: `packages/core/test/transaction.test.ts`
- Modify: `packages/core/test/query.test.ts`

**Interfaces:**

- Consumes: a managed commit returned by `runCanonicalWrite`, configured remote URL, branch, and Git repository state.
- Produces: `configureSyncTarget`, `syncBrain`, `attemptManagedSync`, `SyncStatusV1`, and sync-bearing transaction/query results.

- [ ] **Step 1: Write failing Git integration tests with a local bare remote**

Use real temporary Git repositories. Prove that an unconfirmed target refuses push, a confirmed target pushes a managed commit, a non-fast-forward failure leaves the local commit intact and returns `pending`, and an unrelated commit ahead blocks auto-push with `manual-sync-required`.

```ts
test("keeps a managed commit when the configured remote rejects its push", async () => {
  const { root, remote } = await gitBrainWithBareRemote();
  await configureSyncTarget(root, { remote: "origin", branch: "main", confirm: true });
  await advanceRemoteOutsideBrain(remote);

  const result = await applyManagedChange(root);

  expect(result.commit).toMatch(/^[a-f0-9]{40}$/);
  expect(result.sync).toMatchObject({ status: "pending" });
  await expect(git(root, ["cat-file", "-e", `${result.commit}^{commit}`])).resolves.toBeDefined();
});
```

- [ ] **Step 2: Run sync/transaction tests and confirm they fail because no push policy exists**

Run: `pnpm vitest run packages/core/test/sync.test.ts packages/core/test/transaction.test.ts packages/core/test/query.test.ts`

Expected: FAIL with missing sync configuration/result or no remote push attempt.

- [ ] **Step 3: Implement post-commit-only synchronization**

Add a sync target to tracked state containing remote name, branch, credential-free canonical URL fingerprint, and confirmation timestamp. `configureSyncTarget` reads `git remote get-url`, validates the branch, requires `confirm: true`, and never edits remotes. Add managed commit trailers in `runCanonicalWrite`:

```text
Brain-Managed: true
Brain-Operation: op_<operation-id>
```

After a canonical commit is fully durable and the transaction journal is removed, call `attemptManagedSync`. It must inspect commits ahead of the configured upstream; every commit must contain both trailers. Use `git push <remote> HEAD:refs/heads/<branch>` without `--force`. On failure, return a `pending` status with a safe reason; never restore the snapshot or amend the commit. Recompute pending state from Git if runtime status disappears. Retry eligible sync at query start, query finish, and explicit `syncBrain` only.

- [ ] **Step 4: Re-run Git integration tests and fast verification**

Run: `pnpm vitest run packages/core/test/sync.test.ts packages/core/test/transaction.test.ts packages/core/test/query.test.ts && pnpm verify:fast`

Expected: PASS; unrelated work remains unpushed, failed pushes preserve commits, and normal safe pushes update the bare remote.

- [ ] **Step 5: Commit the green slice**

```bash
git add packages/core/src/sync.ts packages/core/src/state.ts packages/core/src/transaction.ts packages/core/src/query.ts packages/core/src/query-finish.ts packages/core/src/source-transaction.ts packages/core/src/status-read.ts packages/core/src/doctor.ts packages/core/src/index.ts packages/core/test/sync.test.ts packages/core/test/transaction.test.ts packages/core/test/query.test.ts
git commit -m "feat: safely synchronize managed brain commits"
```

### Task 7: Expose setup, receipt, approval, and sync through the CLI

**Files:**

- Modify: `packages/cli/src/program.ts`
- Modify: `packages/cli/test/cli.test.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `README.md`

**Interfaces:**

- Consumes: public core APIs from Tasks 1–6.
- Produces: deterministic JSON CLI commands used by Codex and Claude Code.

- [ ] **Step 1: Write failing CLI lifecycle tests**

Test `setup begin`, `setup next`, `query read --query`, `query request-web`, `query approve-web`, and `sync status` via `runCli`, asserting JSON outcomes rather than command implementation text.

```ts
test("records a current page read receipt for a query", async () => {
  const { root, queryId, pageId } = await queryWithPage();
  const output: string[] = [];

  expect(await runCli([
    "query", "read", queryId, pageId, "--root", root, "--json",
  ], { write: (line) => output.push(line) })).toBe(0);

  expect(JSON.parse(output.join(""))).toMatchObject({
    pageId,
    revision: expect.any(String),
  });
});
```

- [ ] **Step 2: Run CLI tests and confirm red failures**

Run: `pnpm vitest run packages/cli/test/cli.test.ts`

Expected: FAIL because the commands are not registered.

- [ ] **Step 3: Add exact commands and machine-readable results**

Register these commands without changing existing command meanings:

```text
brain setup begin --purpose <text> [--boundaries <text>]
brain setup next [<setup-id>]
brain setup finish <setup-id> --summary <text>
brain reconcile plan <change-set-draft-file>
brain query read <query-id> <reference> [--locator <locator>]
brain query request-web <query-id> --reason <text> --host-session <id>
brain query approve-web <query-id> --approved <true|false> --decided-by <id>
brain sync configure --remote <name> --branch <branch> --confirm
brain sync status
brain sync
```

`brain apply --query` loads persisted query read receipts and includes them in validation. Human-readable output must print the exact sync-pending warning when the returned status is pending; `--json` returns the full typed object.

- [ ] **Step 4: Re-run CLI tests and fast verification**

Run: `pnpm vitest run packages/cli/test/cli.test.ts && pnpm verify:fast`

Expected: PASS; every new command returns schema-valid JSON and uses shared core state.

- [ ] **Step 5: Commit the green slice**

```bash
git add packages/cli/src/program.ts packages/cli/test/cli.test.ts packages/core/src/index.ts README.md
git commit -m "feat: expose setup approval and sync CLI workflows"
```

### Task 8: Update the host-neutral agent contract and template documentation

**Files:**

- Modify: `AGENTS.md`
- Modify: `.agents/skills/second-brain/SKILL.md`
- Modify: `docs/configuration.md`
- Modify: `docs/contracts.md`
- Modify: `docs/recovery.md`
- Create: `docs/V1_EXIT_CHECKLIST.md`
- Modify: `README.md`

**Interfaces:**

- Consumes: finalized CLI/core lifecycle names and the approved design.
- Produces: instructions that cause a host agent to use the lifecycle without creating wiki knowledge for code-maintenance work.

- [ ] **Step 1: Write a deterministic fake-host contract test**

Add a core-level scripted test that invokes real core APIs in a wiki-only flow, raw fallback, denied-web gap flow, approved-web flow, and pending-sync flow. The test’s assertions must be on operation/session state and generated warning data, not prose text.

```ts
test("returns a pending sync status after a durable raw-backed answer", async () => {
  const result = await scriptedRawFallbackWithRejectedRemote();
  expect(result.finish.sync).toMatchObject({ status: "pending" });
  expect(result.finish.session.outcome).toBe("answered");
});
```

- [ ] **Step 2: Run the fake-host and existing lifecycle tests; confirm the new behavior is absent**

Run: `pnpm vitest run packages/core/test/query.test.ts test/e2e/brain-lifecycle.test.ts`

Expected: FAIL because the scripted lifecycle cannot observe the new setup/approval/sync data.

- [ ] **Step 3: Write the agent and user documentation**

Update the skill to require: `brain setup` before initial knowledge questions; `brain query read` receipts for all reconciliation candidates; per-query web request/approval; no uncaptured web claims; completing audits; and reporting `SyncStatusV1` with the exact visible warning. Replace “Never auto-push” with “never push except through a confirmed managed sync target.”

Explain the shared Codex and Claude Code web-approval contract. Document the model’s one-time local download and checksum behavior, setup versus delta ingestion, safe Git push constraints, recovery steps, and post-v1 reminder.

- [ ] **Step 4: Re-run the lifecycle test and documentation-oriented verification**

Run: `pnpm vitest run packages/core/test/query.test.ts test/e2e/brain-lifecycle.test.ts && pnpm verify:fast && git diff --check`

Expected: PASS; the fake host proves behavior without parsing documentation source text.

- [ ] **Step 5: Commit the green slice**

```bash
git add AGENTS.md .agents/skills/second-brain/SKILL.md docs/configuration.md docs/contracts.md docs/recovery.md docs/V1_EXIT_CHECKLIST.md README.md packages/core/test/query.test.ts test/e2e/brain-lifecycle.test.ts
git commit -m "docs: codify compounding brain workflow"
```

### Task 9: Build deterministic end-to-end coverage and live-smoke handoff

**Files:**

- Create: `test/e2e/knowledge-workflow-hardening.test.ts`
- Create: `test/fixtures/smoke-brain/sources/foundations.md`
- Create: `test/fixtures/smoke-brain/sources/contradiction.md`
- Create: `test/fixtures/smoke-brain/sources/synonyms.md`
- Modify: `test/e2e/brain-lifecycle.test.ts`
- Modify: `.github/workflows/ci.yml`
- Modify: `README.md`
- Create: `CLAUDE.md`

**Interfaces:**

- Consumes: all core/CLI public contracts and both agent instruction entry points.
- Produces: repeatable fixture tests plus explicit manual Codex and Claude Code live-smoke instructions and truthful verification status.

- [ ] **Step 1: Write failing end-to-end scenarios**

Build a disposable clone from the fixture, initialize a local bare remote, and test source setup, semantic synonym link candidate, contradiction preservation, raw fallback persistence, denied-web gap, approved-web capture, semantic-cache deletion, audit checkpoint/resumption, remote rejection with visible sync state, and independent cloned brains.

```ts
test("persists a contradiction and its reciprocal graph connection", async () => {
  const root = await provisionSmokeBrain();
  await completeSetup(root);
  const result = await answerContradictoryQuestion(root);

  expect(result.audit.structural.ok).toBe(true);
  expect(await readWikiPage(root, "pg_claim_a")).toMatchObject({
    relations: expect.arrayContaining([
      expect.objectContaining({ targetId: "pg_claim_b", kind: "contradicts" }),
    ]),
  });
});
```

- [ ] **Step 2: Run the E2E test and confirm red failures**

Run: `pnpm vitest run test/e2e/knowledge-workflow-hardening.test.ts`

Expected: FAIL because the fixture lifecycle does not yet cover or satisfy all new safety gates.

- [ ] **Step 3: Implement only test fixtures and verification wiring**

Keep CI deterministic: use the test embedding provider and fake web capture content; never require a model credential in CI. Run the core/CLI suite on Node 22.22.3 and 24.15.0 and verify generated schemas remain stable.

Document two separate credential-gated live smoke procedures:

1. Codex: disposable clone → setup → raw answer → repeated wiki-only answer → denied/approved web flow → pending/successful sync.
2. Claude Code: verify shared project instructions load → run the same disposable-clone lifecycle and safe test-remote sync.

State that a personal-brain pilot is a usefulness evaluation after both agent smoke tests pass.

- [ ] **Step 4: Run the full verification matrix**

Run:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
pnpm schemas:generate
git diff --exit-code -- schemas
pnpm brain doctor
```

Expected: every command exits `0`; live agent smokes remain separately recorded, credential-gated checks.

- [ ] **Step 5: Commit the green slice**

```bash
git add test/e2e/knowledge-workflow-hardening.test.ts test/fixtures/smoke-brain test/e2e/brain-lifecycle.test.ts .github/workflows/ci.yml README.md CLAUDE.md
git commit -m "test: verify hardened second-brain workflow"
```

## Plan self-review

| Spec requirement | Implementing task |
| --- | --- |
| One-time initial setup and query-triggered delta ingestion | Task 4 |
| Local semantic model, hybrid search, rebuildable caches | Task 2 |
| Whole-wiki candidate scan, current reads, explicit decisions | Task 3 |
| Audit threshold and race-safe completion | Tasks 1, 3, and 4 |
| One approval for the full active question | Task 5 |
| Safe commit/push, pending warning, no accidental template push | Task 6 |
| CLI and host-facing contract | Task 7 |
| Agent workflow and post-v1 reminder | Task 8 |
| Deterministic and live-smoke acceptance coverage | Task 9 |

The plan uses one contract name for each public behavior, includes focused red/green commands for every implementation task, contains no deferred implementation placeholders, and keeps the design’s explicit deferred scope out of v1 work.
