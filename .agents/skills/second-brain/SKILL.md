---
name: second-brain
description: Use when answering or maintaining domain knowledge in a portable second-brain repository, including questions over its wiki or sources, source ingestion, web research, graph changes, contradictions, gaps, setup, reconciliation, audits, or sync state.
---

# Second Brain

## Core contract

The repository is durable memory. The `brain` CLI is its only write boundary. Treat a domain question as a query session; treat code, configuration, and test work as ordinary repository work unless `BRAIN.md` explicitly makes them domain knowledge.

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
