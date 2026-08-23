---
name: second-brain
description: Use when answering or maintaining domain knowledge in a portable second-brain repository, including wiki lookup, raw-source fallback, web evidence, knowledge graph updates, contradictions, unanswered gaps, bootstrap, or semantic audits.
---

# Second Brain

## Core contract

Treat the repository as durable memory and the `brain` CLI or `brain_*` tools as its only write boundary. Answer domain questions through a query session. Handle code, configuration, deployment, and tests as ordinary repository work; never store them in the wiki unless `BRAIN.md` explicitly includes software engineering as domain knowledge.

## Query workflow

1. Read `BRAIN.md`. Run `brain status`; run `brain recover` first when recovery is required.
2. Run `brain query begin "<exact question>"`. It scans new sources and searches the wiki.
3. Complete pending bootstrap in returned batches. Create shallow source pages with exact source IDs/locators and apply them through the query.
4. Read relevant wiki results. Stop at wiki only when every material claim is supported and no relevant conflict or gap remains.
5. If insufficient, expand to `sources` with a concrete reason, search/read exact chunks, and preserve locators. Expand to `web` only after sources are insufficient.
6. Capture every web page or snippet before using it. Never persist or answer from an uncaptured URL, search snippet, or model recollection.
7. Persist before answering:
   - Wiki-only lookup: finish log-only; do not duplicate pages.
   - Reusable wiki-only synthesis: optionally persist it.
   - Raw/web evidence used: apply at least one cited wiki mutation.
   - Unanswered: apply a `question` gap page stating uncertainty and evidence needed.
   - Conflict: retain both claims in a conflicts section and connect them with `supports` or `contradicts`; never overwrite history silently.
8. Run/complete a due semantic audit. Finish the query. Answer only after validation and the required Git commits succeed.

## Mutation receipt

For every create/update/merge/archive:

1. Search for title/alias duplicates, shared entities, claims, tags, and configured related-page results.
2. Collect graph neighbors, shared-source pages, duplicate candidates, and search results.
3. **Read every candidate page and any targeted anchor before deciding.** Metadata, unchanged tags, or unchanged links are not a review.
4. Update affected claims, links, anchors, backlinks, conflicts, or summaries together. Record a specific `changed` or `no-change` reason for every candidate.
5. Submit one validated change set with current catalog/page revisions and the active query ID (`brain apply --query <query-id>`). Let the core bind the evidence tier, regenerate indexes/backlinks/health, and commit exact managed paths.

## Evidence rules

- Cite factual and synthesized paragraphs as `[@source-id#locator]`.
- Declare the same source/locator in page frontmatter.
- Separate source statements from inference; state uncertainty explicitly.
- Use stable Obsidian wikilinks and section anchors for meaningful connections.
- Archive, merge, or supersede pages and sources; do not destructively delete history.

## Never bypass

- Never write `wiki/`, `.brain/source-manifest.json`, `.brain/state.json`, or `.brain/operations.jsonl` directly.
- Never claim a candidate was reviewed without reading it.
- Never answer after a failed apply, audit, recovery, or finish.
- Never stage unrelated files or push automatically.

## Minimal raw-fallback example

```text
brain query begin → assess wiki insufficient → brain query expand sources
→ brain read exact chunks → read every reconciliation candidate
→ brain apply --query → brain query finish → answer
```
