# Data and graph contracts

The public v1 contracts are exported as Zod schemas and checked-in JSON Schema 2020-12 files under `schemas/v1/`:

- `BrainConfigV1`
- `SourceRecordV1`
- `WikiPageV1`
- `RelationV1`
- `ChangeSetV1`
- `QuerySessionV1`
- `OperationRecordV1`
- `AuditReportV1`
- `SetupSessionV1`
- `SyncTargetV1` and `SyncStatusV1`
- `WebApprovalRequestV1` and `WebApprovalV1`

Regenerate them with `pnpm schemas:generate`; CI rejects drift.

## Source identity

A source ID is derived from SHA-256 content. Once registered, the bytes at that path may not change or disappear. A replacement is a new source record linked through `supersedes`, leaving both versions inspectable.

Extracted chunks retain deterministic locators such as `page=4`, `chapter=2`, `heading=method`, `lines=10-18`, `$.results[0]`, or `row=7`. Text PDFs use page locators; DOCX documents retain semantic heading/section locators and require a separate extraction step when no usable text exists.
Each ready source record also tracks the SHA-256 hash of its canonical extracted payload. DOCX records additionally retain versioned semantic, converted, and extracted byte measurements so a later configuration change can be enforced without trusting disposable cache metadata. Disposable cache contents must match the tracked canonical hash and current extraction policy or they are rebuilt from the immutable source before search, reading, bootstrap, or citation validation can use them.

## Wiki page identity

Canonical pages live under `wiki/pages/` with YAML frontmatter and authored Markdown. Stable page IDs survive renames; a revision hash covers identity, metadata, evidence, relations, and authored body. Updates must supply the expected revision and current catalog revision.

Factual or synthesized paragraphs cite immutable evidence inline:

```markdown
The observed period is 33 milliseconds. [@src_0123456789abcdef#page=4]
```

The same source and locator must be declared in frontmatter. Normal navigation uses Obsidian wikilinks; typed relations generate connection and backlink sections between protected markers.

## Change sets and reconciliation

Agents do not write canonical wiki/state files directly. `ChangeSetV1` carries page operations plus a reconciliation receipt. The receipt covers graph neighbors, shared evidence and tags, duplicates, and related search results. Every candidate needs a content-based `changed` or `no-change` decision after its body and targeted anchor are read.

Query-driven changes must be submitted with `brain apply --query <query-id>`. The core records the query's active evidence tier on the operation; an unbound historical mutation or a mutation from an earlier tier cannot satisfy raw/web persistence requirements.

Before query-driven apply, `brain reconcile plan` calculates the complete candidate set under the current catalog revision: graph neighbors, shared source/locator/tag/alias pages, contradictions, near duplicates, lexical results, and (after setup) semantic results. The host must use `brain query read` to record one current revision-bound read receipt for every returned candidate and every targeted anchor. It then supplies one `changed` or `no-change` decision and reason per candidate. `brain apply --query` binds the persisted receipts to the draft; manually forged or stale receipts are rejected. Initial setup follows the same plan/review rule but applies source-page mutations with `brain apply --setup <setup-id>`.

The transaction validates all pages, citations, anchors, aliases, relation types, source IDs, revisions, duplicates, and the complete structural graph. It then regenerates index, map, backlinks, sources, health, state, and logs atomically.

Contradictory claims remain cited in a conflicts section and use `supports` or `contradicts` edges. Pages are archived, merged, renamed, or superseded rather than destructively erased.

## Setup, query, and web approval state

`SetupSessionV1` is the one-time initial catalog state. It begins from a domain purpose and boundaries, returns deterministic source batches, and cannot finish until every ready initial source has a shallow source page, the structural graph is healthy, and semantic audit work is complete. The triggering query is refreshed after setup; later new sources appear as `deltaBootstrap` work in the active query instead of reopening initial setup.

`QuerySessionV1` records the exact question, tiers used, source/search results, setup and delta state, read receipts, captured web source IDs, query-bound mutation IDs, and derived sync status. Runtime query records are operational and disposable; the durable evidence and operations they bind are canonical. A query that uses raw or web evidence cannot finish without a query-bound cited mutation. An unanswered query cannot finish without a query-bound `question` page.

Web approval records are runtime-scoped but bound to the active query ID, its SHA-256 normalized-question hash, and host session. A request has `requested`, `approved`, `denied`, or `expired` state and a configured expiry. `brain query expand --tier web` and `brain web capture` both reject unless the same query has an unexpired approval. Captured evidence becomes an immutable registered source under `sources/web/`; the approval itself never substitutes for evidence.

Web text evidence is a complete or partial Markdown snapshot with versioned provenance frontmatter and an exact captured-body hash. A downloadable supported artifact retains its original bytes and has a hidden tracked `.<artifact>.web.json` sidecar. The sidecar records the artifact path/hash/size, original and final public URL, ordered redirect chain, retrieval time, query identity, completeness, detected format, media type, and optional supersession. The artifact and sidecar are one immutable portable pair: missing, moved, malformed, or changed companions fail integrity checks.

Source provenance also carries sorted structured web discoveries. Identical compatible bytes found through another approved URL reuse the source and add a discovery without changing the sealed first-capture sidecar; changed bytes create a new superseding source. Runtime download paths, credentials, cookies, and authorization data are never canonical provenance or managed commit content. Capture links the registered source to the active runtime query and refreshes bootstrap state, but durable reuse comes from the canonical source pair, manifest, cited wiki mutation, and managed operation.

## Synchronization contract

`SyncTargetV1` stores the owner-confirmed remote name, branch, and a credential-safe fingerprint of the remote URL. `SyncStatusV1` is derived rather than blindly trusted: `unconfigured`, `synced`, `pending`, or `manual-sync-required`.

The only push path checks that the current branch and remote fingerprint still match, that the remote branch is an ancestor, and that every ahead commit is a managed brain commit. It issues only a normal `HEAD:refs/heads/<branch>` push. A rejection, inaccessible remote, divergent branch, changed target, or unrelated ahead commit preserves local canonical data and produces pending/manual state. When that state carries a locally committed change, a host may answer only with the exact `⚠ Sync pending — knowledge is safely committed locally at …` warning visible to the owner.
