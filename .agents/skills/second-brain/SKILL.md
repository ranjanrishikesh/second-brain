---
name: second-brain
description: Use when initializing or onboarding a portable second-brain repository, or when answering and maintaining domain knowledge through its wiki, sources, setup, reconciliation, audits, web research, or sync state.
---

# Second Brain

## Core contract

The repository is durable memory. The `brain` CLI is its only write boundary. Treat a domain question as a query session; treat code, configuration, and test work as ordinary repository work unless `BRAIN.md` explicitly makes them domain knowledge.

## Onboarding lifecycle

“Initialize this second brain.”, “set up this second brain”, and “onboard this second brain” start an agent-executed workflow, not a command tutorial. Run these stages in order; after an interruption, run status and continue from its deterministic next action:

1. **Check runtime and dependencies.** Require Node.js 22.13 or newer. If dependencies are missing or broken, run `pnpm install --frozen-lockfile`. If `pnpm` is absent, try `corepack pnpm install --frozen-lockfile`. Report a blocker only for missing/old Node, denied execution permission, or a real install failure.
2. **Recover.** Run `brain recover` before changing state.
3. **Doctor and status.** Run both; route from `status.onboarding.nextAction` rather than guessing.
4. **Initialize identity.** When requested, run bare `brain init`. It derives the Git repository name without GitHub access.
5. **Add sources.** If no source is present, tell the user to add supported files under `sources/`, then pause. Resume when they say “sources added” or ask a domain question; require no special phrase.
6. **Scan sources.** Run `brain source scan`, report each unusable file accurately, and require at least one ready extraction.
7. **Infer and persist the charter.** Use, in order, existing identity; optional authenticated repository metadata already available to the host; Git common-directory name; all source titles; and deterministic representative chunks from up to 50 evenly distributed ready sources. For mixed material, describe an inclusive corpus and do not silently exclude a domain. Write the versioned JSON input in disposable runtime space and invoke `brain charter set`.
8. **Complete or resume setup.** Finish checkpointed setup batches, cited shallow source pages, graph reconciliation, and the initial map.
9. **Complete the semantic audit.** Resolve every due checkpoint before claiming readiness.
10. **Rebuild and smoke-search.** Rebuild disposable search state and run representative charter/source-derived queries.
11. **Final doctor and status.** Require healthy structure and onboarding phase `ready`.
12. **Safe sync.** Sync only to an existing owner-confirmed target; request explicit confirmation for a new or changed destination.
13. **Report readiness.** Include identity, inferred charter, source diagnostics, setup/audit/search outcome, local commit state, and synchronization state.

Never ask the user to run routine init, scan, doctor, status, search, rebuild, audit, recover, setup, commit, or eligible sync commands. The agent operates the CLI even if the host asks for execution approval. Never broadly allowlist `pnpm brain *`; the exact-question web gate and new sync-target confirmation remain human decisions.

## Decision ladder

| Situation | Required action |
| --- | --- |
| First domain question | Automatically complete the one-time shallow catalog-and-map setup, then resume the question. |
| New dropped sources after setup | Ingest their shallow source pages during the active question before relying on them. |
| Existing wiki is sufficient | Answer from it and finish log-only. |
| Wiki is insufficient | Read immutable raw source chunks, then persist cited knowledge. |
| Raw sources are insufficient | Request one approval for web research for this exact question before browsing or capturing. |
| Evidence remains insufficient | Create or update a durable `question` gap page; never guess. |

## Query lifecycle

1. Read `BRAIN.md`, then run `brain status`. Complete `brain recover` before domain work if recovery is required.
2. Run `brain query begin "<exact question>"`. It scans source changes, resumes safe synchronization, and searches the wiki. Read its `setup.required` and `deltaBootstrap.required` state; never guess which ingestion path applies.
3. If the response says `setup.required`, derive the setup purpose and boundaries from `BRAIN.md`, then automatically run `brain setup begin`, `brain setup next` batches, and shallow cited source-page mutations through `brain apply --setup`. Reconcile each mutation, complete due semantic audit work, run `brain setup finish`, then resume the original query. If `BRAIN.md` has no usable domain purpose, ask the owner only for that missing charter.
4. If `deltaBootstrap.required`, use `brain bootstrap next <query-id>` batches to add shallow source pages before an answer that relies on those new sources. Initial setup catalogs every ready source; later ingestion is question-triggered and deepens only where the question needs it.
5. Read relevant wiki pages with `brain query read <query-id> <page-or-alias> [--locator <anchor>]`. Stop at the wiki tier only when every material claim is supported, relevant conflicts are represented, and no material gap remains.
6. Otherwise run `brain query expand <query-id> --tier sources --reason "…"`, then read exact raw source chunks and locators. Raw-backed answers require a cited durable wiki mutation. For a corpus-wide question, read enough relevant raw coverage to support the whole-corpus conclusion; never call a theme “central” from a shallow page title, a small sample, or word frequency alone. Persist a reusable cited synthesis when that deeper analysis will help later questions.
7. If raw evidence is insufficient, run `brain query request-web` with the concrete gap and the current host session. Wait for the owner's decision, record it through `brain query approve-web`, and expand to web only when the matching approval is unexpired and approved. Do not use native web/search tools, URLs, snippets, or model recollection before this approval. A general past preference for research is not approval for the active question. If the owner says not to ask follow-up questions, do not create an approval request: take the no-web path and record/answer the supported local gap. One approval covers the whole active question; a denial means answer locally or record a gap.
8. Capture approved evidence with `brain web capture` before citing it. A web-backed answer must cite captured web evidence in its durable mutation.

## Reconcile and persist

For every page mutation, make a change-set draft, run `brain reconcile plan`, and inspect every returned candidate—not just its title or metadata. In a query, use `brain query read` for each candidate and targeted anchor so the current revision-bound receipts are recorded. Give every candidate a specific `changed` or `no-change` reason, update related claims/links/conflicts together, then run `brain apply --query <query-id>`. During initial setup, use `brain read` for each candidate, copy its current ID/revision/anchor receipt into the draft, and apply with `--setup <setup-id>`.

Use `[@source-id#locator]` for factual and synthesized paragraphs, declare the evidence in frontmatter, distinguish inference from source statements, retain contradictions with typed edges, and archive/merge/supersede rather than erase history.

Run required semantic audit work, then `brain query finish`. Wiki-only lookups may finish without a redundant page. Raw/web answers require a query-bound cited change; an unanswered result requires a query-bound `question` gap page.

## Synchronization and final answer

Managed operations commit locally. Only an owner-confirmed existing target may be configured with `brain sync configure --remote … --branch … --confirm`; it can push only a normal fast-forward made entirely of managed brain commits. Never push arbitrary targets, force-push, pull, rebase, or stage unrelated files.

Answer only after recovery, validation, required audit/setup, and the local managed commit succeed. If result sync is `pending` or `manual-sync-required`, answer is allowed but must copy the complete exact warning returned by `formatSyncWarning` / the CLI, beginning:

```text
⚠ Sync pending — knowledge is safely committed locally at …
```

Never hide, paraphrase away, or claim remote availability despite that warning.

## Common mistakes

- Do not ask the owner to operate the CLI just because setup is long; the host completes the automatic setup and reports truthful progress.
- Do not silently convert a general research preference, silence, or “no follow-ups” into web approval.
- Do not mark candidate review complete from search metadata; read the candidate body and targeted anchor at its current revision.
- Do not present local durability as remote sync; copy the full pending-sync warning when required.
