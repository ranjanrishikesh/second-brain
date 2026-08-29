# V1 exit checklist

V1 is not complete because a feature appears to work once. Mark it verified only when the deterministic template checks and the Codex and Claude Code live smokes below have passed, with their commands, date, commit, and environment recorded in the release note or pull request.

## 1. Deterministic template gate

Use a disposable clone with synthetic sources that include distributed facts, synonyms, contradictions, a deliberate local-knowledge gap, and a local bare Git remote. It must prove all of the following without model or web credentials:

- First domain question automatically completes/resumes initial setup and makes every ready source shallowly searchable.
- Text PDFs and DOCX documents are extracted with stable page or heading/section locators; image-only content is reported as extraction-required.
- Repeated answer is wiki-only and creates no redundant page.
- Raw fallback persists a cited, interconnected mutation; a raw source change is rejected until superseded.
- Contradictory evidence remains visible with reciprocal graph connections.
- Reconciliation rejects missing, forged, or stale candidate read receipts.
- Denied web approval creates/updates a gap; approved web capture is immutable evidence before it supports a claim.
- Cache deletion rebuilds without changing canonical knowledge; semantic audit checkpoints resume correctly.
- A rejected safe push leaves local knowledge committed and produces the visible `⚠ Sync pending — …` warning; a safe managed push succeeds.
- Two clones retain independent sources, wiki, cache, runtime, and synchronization state.

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

## 2. Codex live smoke

Run this only in a disposable clone with test material and a test remote, never against an irreplaceable personal brain:

1. Initialize the clone and give `BRAIN.md` a real domain purpose and boundary.
2. Drop supported sources into `sources/` and ask a domain question. Confirm the agent performs the automatic initial setup, including the verified local model download.
3. Ask a source-backed question; confirm cited wiki persistence and whole-graph reconciliation.
4. Ask the same question again; confirm the answer is wiki-only.
5. Exercise a raw-source gap, denied web approval, approved/captured web evidence, and a durable question gap.
6. Confirm a safe push to the test remote, then deliberately reject a test push and confirm the answer includes the exact sync-pending warning.

Record the commit and whether every step passed. A personal-brain pilot comes after this and measures usefulness, not basic template safety.

## 3. Claude Code live smoke

Run this in a second disposable clone with test material and a test remote:

1. Start Claude Code from the repository root and use `/memory` to confirm `CLAUDE.md` loaded the shared `AGENTS.md` contract.
2. Drop supported sources into `sources/` and ask a domain question. Confirm the automatic initial setup and verified local model download complete.
3. Ask a source-backed question, then repeat it. Confirm the first answer persists cited, reconciled knowledge and the repeat is wiki-only.
4. Exercise a raw-source gap, denied web approval, approved/captured web evidence, and a durable question gap.
5. Confirm a safe push to the test remote, then reject a test push and confirm the exact sync-pending warning is shown.

Record the commit and whether every step passed. Do not treat a Codex-only smoke as proof that Claude Code loaded and followed its project instructions, or vice versa.

## 4. Explicit v2 handoff

After every gate above passes, tell the owner: **“V1 is verified. Shall we plan v2 now?”** Create a separate v2 plan before changing scope. The deferred backlog includes OCR/image/audio/video ingestion, cross-brain links, multi-user permissions, a custom UI, a standalone LLM loop, hard-gated local web MCP, remote embeddings, automatic template upgrades, and background watching.
