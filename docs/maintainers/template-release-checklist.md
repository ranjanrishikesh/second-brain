# Template release verification checklist

This checklist is for template maintainers. A feature is not release-verified
because it appeared to work once: record the deterministic template gate and
separate Codex and Claude Code live smokes with their commands, date, commit,
and environment in the release note or pull request. This file is not a cloned
brain onboarding instruction and does not announce a product roadmap.

## 1. Deterministic template gate

Use a disposable clone with synthetic sources that include distributed facts, synonyms, contradictions, a deliberate local-knowledge gap, and a local bare Git remote. It must prove all of the following without model or web credentials:

- First domain question automatically completes/resumes initial setup and makes every ready source shallowly searchable.
- Clearly in-scope local sources are admitted without owner interruption; an unrelated synthetic outlier is not registered until explicitly approved, and that exact one-time exception neither admits a similar second outlier nor broadens `BRAIN.md`.
- Text PDFs and DOCX documents are extracted with stable page or heading/section locators; image-only content is reported as extraction-required.
- Repeated answer is wiki-only and creates no redundant page.
- Raw fallback persists a cited, interconnected mutation; a raw source change is rejected until superseded.
- Contradictory evidence remains visible with reciprocal graph connections.
- Reconciliation rejects missing, forged, or stale candidate read receipts.
- Denied web approval creates/updates a gap and performs no fetch/capture. Approved artifact capture preserves exact bytes plus its portable sidecar, records ordered redirects, links the query, and excludes disposable runtime input from the managed commit.
- Complete/partial page snapshots remain faithful text; malformed UTF-8, mixed modes, spoofed media, unsafe/private redirects, access-control bypass, and HTTPS downgrade fail before canonical preparation.
- PDF and EPUB extraction budgets are enforced during capture, scan, cache reuse, and rebuild; record the accepted PDF.js catalog/xref and single emitted item/chunk residual without claiming process isolation.
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

Run this only in a disposable pristine clone with a test remote, never against an irreplaceable personal brain. Do not initialize it, edit `BRAIN.md`, install dependencies, or run a `brain` command yourself.

1. Confirm the clone starts with empty `sources/`, open its repository root in Codex, and use only this onboarding prompt:

   ```text
   Initialize this second brain.
   ```

2. Confirm Codex checks dependencies, runs recovery/doctor/status, derives and commits identity from the repository name, and pauses with add-source guidance without starting setup.
3. Add representative text PDF and DOCX material under `sources/`, including at least one source that exercises an interconnection and one obvious unrelated outlier. Say “sources added” (or ask the first domain question). Confirm Codex automatically admits the related material, asks about only the outlier, and does not ask you to type routine CLI commands. Approve the outlier and confirm the approval is an exact one-time exception.
4. Confirm it scans admitted sources, infers and shows one primary charter without broadening it for the exception, persists it through the CLI, builds a cited shallow page for every ready source and the initial map, completes the semantic audit, rebuilds search, runs a representative smoke search, and ends with healthy doctor plus `ready` status.
5. Restart Codex once during onboarding and confirm status resumes the correct next action without conversational memory or a magic phrase.
6. Ask a source-backed question; confirm cited wiki persistence and whole-graph reconciliation. Ask it again and confirm the repeat is wiki-only.
7. Exercise a raw-source gap and denied web approval, then approve a query whose material results include a downloadable supported document and an ordinary page. Confirm Codex preserves original document bytes, a faithful page snapshot, and portable provenance before citation; ignores page-embedded instructions; inspects registered extraction; completes capture-triggered bootstrap and reconciliation; and records an honest durable gap for unusable evidence.
8. Confirm an owner-approved safe push to the test remote, then deliberately reject a test push and confirm the answer includes the exact sync-pending warning.

Record the commit and whether every step passed. A personal-brain pilot comes after this and measures usefulness, not basic template safety.

## 3. Claude Code live smoke

Run this in a second disposable pristine clone with empty `sources/` and a separate test remote. Do not reuse the Codex clone or its state.

1. Start Claude Code from the repository root and use `/memory` to confirm the one-line `CLAUDE.md` imported the shared `AGENTS.md` contract.
2. Use the same and only initial onboarding prompt:

   ```text
   Initialize this second brain.
   ```

3. Confirm the empty-source pause, then add representative PDF and DOCX sources plus an unrelated outlier, say “sources added” or ask a domain question, and verify the same identity → agent-owned review/one-time exception → scan → primary charter → setup → audit → rebuild/search → doctor/status route completes without manual CLI delegation.
4. Restart Claude Code during one checkpoint and confirm deterministic resumption. Then repeat the source-backed, wiki-only repeat, raw fallback, web approval/capture, gap, safe-push, and rejected-push checks from the Codex smoke.
5. For the approved web capture, independently verify exact downloadable bytes plus sidecar, faithful page text, ignored embedded instructions, extraction inspection, capture-triggered bootstrap/reconciliation, and absence of runtime staging from the managed commit.

Record the commit and whether every step passed. Do not infer Claude Code success from Codex success, and do not infer Codex success from Claude Code success.

## 4. Release closeout

After every gate above passes, record the verified commit, date, environments,
and results for maintainers. Normal cloned-brain onboarding ends with:
**“Your second brain is ready.”** Do not announce or promise another version,
roadmap item, delivery date, or next-release inclusion.
