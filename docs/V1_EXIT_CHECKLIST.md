# V1 exit checklist

V1 is not complete because a feature appears to work once. Mark it verified only when the deterministic template checks and both credential-gated live smokes below have passed, with their commands, date, commit, and environment recorded in the release note or pull request.

## 1. Deterministic template gate

Use a disposable clone with synthetic sources that include distributed facts, synonyms, contradictions, a deliberate local-knowledge gap, and a local bare Git remote. It must prove all of the following without model or web credentials:

- First domain question automatically completes/resumes initial setup and makes every ready source shallowly searchable.
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
docker compose -f deploy/openclaw/compose.yaml config
docker compose -f deploy/openclaw/compose.yaml build
```

If Docker is unavailable, record that the OpenClaw container gate is pending; do not call hosted v1 verification complete.

## 2. Codex live smoke

Run this only in a disposable clone with test material and a test remote, never against an irreplaceable personal brain:

1. Initialize the clone and give `BRAIN.md` a real domain purpose and boundary.
2. Drop supported sources into `sources/` and ask a domain question. Confirm the agent performs the automatic initial setup, including the verified local model download.
3. Ask a source-backed question; confirm cited wiki persistence and whole-graph reconciliation.
4. Ask the same question again; confirm the answer is wiki-only.
5. Exercise a raw-source gap, denied web approval, approved/captured web evidence, and a durable question gap.
6. Confirm a safe push to the test remote, then deliberately reject a test push and confirm the answer includes the exact sync-pending warning.

Record the commit and whether every step passed. A personal-brain pilot comes after this and measures usefulness, not basic template safety.

## 3. OpenClaw live smoke

Run after the OpenClaw adapter is built, using only test credentials and a disposable repository mount:

1. Build and start `deploy/openclaw/compose.yaml`; confirm `/readyz` and plugin discovery.
2. Ask the same setup/raw/repeated-wiki question sequence through the gateway.
3. Verify a denied web request blocks native web use, then approve the active question and verify captured evidence is persisted before a claim.
4. Restart the gateway. Confirm the repository knowledge remains while the OpenClaw runtime cache is treated as disposable.
5. Exercise successful and rejected safe sync to the test remote.

Until this smoke passes, report the precise state—for example, “Core and Codex verified; OpenClaw live verification pending.”

## 4. Explicit v2 handoff

After every gate above passes, tell the owner: **“V1 is verified. Shall we plan v2 now?”** Create a separate v2 plan before changing scope. The deferred backlog includes OCR/image/audio/video ingestion, cross-brain links, multi-user permissions, a custom UI, a standalone LLM loop, hard-gated local web MCP, remote embeddings, automatic template upgrades, and background watching.
