# V1 Knowledge Workflow Hardening — Design

**Status:** Approved for planning on 2026-08-27

## Goal

Make the portable second-brain template reliably build an initial knowledge
base from its local sources, deepen it through questions, discover and review
meaningful cross-links, require approval before web research, and safely
commit and push durable knowledge changes.

The template remains host-driven: Codex or OpenClaw is the reasoning agent;
the repository is the canonical memory, evidence store, graph validator, and
safety boundary. It does not introduce a second generic LLM loop or chat UI.

## Product decisions

| Decision | Chosen behavior |
| --- | --- |
| Brain boundary | One Git repository is one independent brain. Cross-brain links are out of scope. |
| Initial learning | A one-time, explicit setup builds the full source catalog and a shallow base graph before normal use. |
| Later learning | New sources receive shallow delta ingestion when the next question begins; deepening remains question-driven. |
| Interconnection | Each mutation scans the entire graph with structural, lexical, and local semantic signals, then requires deep review of every generated candidate. |
| Web research | It requires one user approval for the active question after local evidence is insufficient. |
| Durable changes | Managed knowledge changes auto-commit and attempt a safe push. A push failure never discards a local commit. |
| Unsupported media | v1 reports unsupported/scanned content explicitly; it never silently ignores it. |
| v1 exit | After all verification gates pass, the template explicitly prompts the owner to plan v2. |

## Non-goals

- A background watcher or daemon that ingests source files without a setup or
  query.
- A standalone LLM agent, RAG server, or custom chat UI.
- OCR, legacy `.doc` and other Office-format parsing, audio/video
  transcription, or image understanding. DOCX text extraction is supported.
- Cross-brain knowledge sharing, team permissions, or automatic conflict
  resolution.
- Automatic web approval, force-pushing, automatic pull/merge/rebase, or
  automatic template upgrades.
- A remote embedding provider or dedicated vector database.

## Lifecycle

```text
one-time setup
  source scan → extraction/index → source pages + base map
  → whole-graph reconciliation → audit → commit → safe push

normal question
  recover + retry eligible sync + source delta scan
  → wiki → raw sources → approved web
  → durable wiki update when needed → reconciliation → audit
  → commit → safe push → cited answer (+ sync warning if necessary)
```

### Setup

`brain setup` is a host-facing lifecycle, not a replacement local LLM. A
human can ask the host, for example, “set up this brain as an astronomy
knowledge base”; the host supplies the brain name and purpose from that
request or from a completed `BRAIN.md`.

Setup must:

1. Refuse an unconfigured domain charter when neither the request nor
   `BRAIN.md` states the brain's purpose.
2. Recover an interrupted canonical transaction before doing work.
3. Scan and register all initial source files, extracting every supported
   source or recording an explicit unsupported/extraction-required failure.
4. Create a cited source page for every registered source with ready
   extraction.
5. Produce a shallow, source-backed map of clearly salient topics, entities,
   concepts, contradictions, and relationships. It must not invent unsupported
   deep synthesis.
6. Run full reconciliation and a complete semantic audit.
7. Write indexes, backlinks, health data, operation history, and setup
   checkpoints in the same managed transaction.
8. Commit the result and attempt the configured safe push.

Setup is checkpointed by source and batch. It is resumable after a crash and
is automatically resumed before a question can finish. Sources introduced
while setup is open are included before setup finishes; sources arriving after
completion become delta sources. An empty source set is valid but returns a
visible warning that no local knowledge exists.

Setup never uses web evidence. The initial source catalog is therefore fully
traceable to files the owner placed in the repository.

### Query lifecycle

A query session advances only through these tiers:

```text
wiki ──insufficient reason──> sources ──insufficient reason──> web
```

At query start, the core recovers transactions, retries a pending eligible
sync, scans sources, resumes incomplete setup/audit work, and searches the
wiki. A host may answer at the wiki tier only when material claims are already
supported and no relevant unresolved gap remains.

If the wiki is insufficient, the host records why and expands to registered
raw sources. If the source tier is insufficient, it records why and requests
web approval. Captured web material is registered as immutable web evidence
before it can support a wiki claim.

Finishing rules:

- A supported wiki-only lookup is log-only.
- A novel, reusable wiki-only synthesis may create a durable page.
- A raw- or web-backed answer requires a durable, cited wiki mutation before
  it can finish.
- An unanswered or partially answered question creates or updates a meaningful
  question/gap page rather than inventing an answer.
- A due or incomplete semantic audit, incomplete setup, invalid graph, or
  required web evidence that was not captured blocks finishing.

## Whole-graph reconciliation

The phrase “study every other wiki file” is implemented in two layers:

1. **Whole-wiki mechanical comparison on every mutation.** The core evaluates
   every active page against the changed pages using links, source overlap,
   locators, aliases, tags, entity/concept references, duplicate detection,
   FTS ranking, and semantic-vector similarity.
2. **Deep human/agent review of every candidate.** The agent must read every
   candidate selected by that scan at its current page revision, then record a
   relationship mutation or an explicit reason for no mutation.

This is preferable to asking an LLM to reread every page from scratch after
every edit: the latter becomes slow and expensive as the brain grows and still
does not guarantee correct links. Whole-wiki retrieval maximizes recall;
auditable candidate review maximizes deliberate precision. No semantic system
can prove that every possible useful relationship was found, so the design
makes omissions observable and periodically rechecks the entire corpus.

### Reconciliation contract

The core exposes a planning operation that returns a
`ReconciliationPlanV1` containing:

- the changed page IDs and expected revisions;
- every required candidate page ID, current revision, and one or more reasons
  it was selected;
- the graph/configuration/search revision used to calculate the plan; and
- whether a complete semantic audit is due.

The host records `ReadReceiptV1` values when it reads a wiki page or section.
A `ReconciliationReceiptV1` maps every candidate to either:

- a concrete relationship/page update; or
- a non-empty explanation of why no relationship change is appropriate.

`brain apply` recalculates the plan immediately before writing. It rejects a
change set if its plan is stale, a required candidate lacks a current read
receipt, a candidate lacks a decision, or an expected revision changed. The
existing whole-graph structural validation remains mandatory after every
mutation: citations, source locators, page paths, aliases, links, anchors,
relations, backlinks, generated indexes, and health report must all agree.

### Hybrid search and semantic cache

Search remains rebuildable and local. The lexical layer uses existing SQLite
FTS5/BM25 over wiki pages and extracted source chunks. The semantic layer adds
a local embedding cache for active wiki pages and extracted source chunks.
Candidate generation is the union of:

- direct graph neighbors and backlinks;
- shared sources, locators, tags, entities, concepts, and aliases;
- duplicate and contradiction candidates;
- top lexical FTS results; and
- top semantic-vector results.

Ranks are combined with Reciprocal Rank Fusion. Semantic embeddings are not
canonical: deleting `.brain/cache/` must rebuild equivalent vectors from
canonical pages and source extraction cache.

The default model is the exact pinned `Xenova/multilingual-e5-small` int8
ONNX revision, downloaded once during setup, checksum verified, and executed
locally through an exact pinned `@huggingface/transformers` dependency. The
model is multilingual, has no brain-text network egress, and belongs in a
disposable cache. If it is unavailable or its checksum differs, reconciliation
fails visibly; it must not silently fall back to lexical-only matching.

Semantic audit covers every active page in checkpointed batches. It is due
after setup, after at most 25 knowledge-changing mutations, and immediately
after an embedding-model change, ontology/configuration change, source
supersession, or broad page merge. Audit completion is race-safe: mutations
that occur during the audit keep it due.

## Web approval and evidence

Web use is a per-query grant. Its lifecycle is:

```text
sources insufficient → request approval → approved or denied
approved → relevant searches/fetches/captures for this query only → query ends
denied/expired → no web use; answer locally and persist a gap when appropriate
```

An approval records the query ID and normalized question hash, host/session
identity, approval timestamp, expiration (24 hours for an abandoned open
query), and outcome. It grants the full active question—not individual URLs—so
the host can perform the relevant research without repeatedly interrupting the
owner. It cannot transfer to a different query.

Core operations that transition to web, capture web evidence, or finish a
web-tier answer validate an unexpired approval. Web captures include URL,
retrieval time, query, capture kind, content, and SHA-256. They follow the
existing immutable source/supersession rules.

OpenClaw is the reference hard-enforced host. Its plugin requests approval
before web tools, binds an approved request to the query, and uses a restrictive
tool allowlist for knowledge work. A denied, expired, unavailable, or timed-out
approval fails closed.

Local Codex has a documented platform limitation: repository hooks cannot
intercept its native hosted WebSearch tool. v1 therefore enforces local web
approval through the core query state, agent contract, and audit trail; native
web search remains disabled unless the current query has an approval. A custom
hard-gated web MCP provider is explicitly deferred because it needs a selected
provider, credentials, and a second web integration.

## Git commit and synchronization

Every successful managed knowledge mutation creates a local Git commit. Once
setup confirms a sync target, it also attempts a normal, fast-forward push.

`brain sync configure` must capture and confirm:

- remote name;
- canonical remote URL fingerprint (without exposing credentials);
- branch/ref; and
- whether the remote is intentionally the independent brain repository.

This confirmation prevents a fresh clone from accidentally pushing knowledge
into the original template repository. The template starts with auto-push
disabled; setup enables it only after confirmation.

Before pushing, the core compares the current branch to the configured
upstream. It auto-pushes only if every commit ahead of the upstream is a
brain-managed commit with an operation trailer. If unrelated committed work is
also ahead, it refuses automatic push and reports a manual-sync requirement.
It never force-pushes, pulls, merges, rebases, changes remotes, or resolves a
conflict automatically.

On a push failure, the local commit stays authoritative. Derived runtime state
records a pending safe reason and is recomputed from Git if the runtime cache
is removed. Eligible sync is retried at query start, query finish, gateway
startup, or `brain sync`; status and doctor remain read-only.

Every answer after a failed push carries this exact visible form:

```text
⚠ Sync pending — knowledge is safely committed locally at <sha>, but it has not
yet been pushed to <remote>/<branch>: <safe reason>.
```

The result contracts returned to Codex/OpenClaw contain `SyncStatusV1`, so the
host can show the same warning deterministically without exposing secrets.

## Public contracts and commands

The existing versioned core contracts remain schema version 1 and are extended
compatibly with defaults. No premature schema version 2 is introduced.

New public types:

- `SetupSessionV1` and `SetupStatusV1`
- `ReconciliationPlanV1`, `ReadReceiptV1`, and `ReconciliationReceiptV1`
- `WebApprovalV1` and `WebApprovalRequestV1`
- `SyncTargetV1` and `SyncStatusV1`
- `SemanticIndexMetadataV1`

New or expanded CLI operations:

- `brain setup begin`, `brain setup next`, `brain setup finish`, and
  `brain setup status`
- `brain reconcile plan`
- `brain query read` (records a read receipt) and `brain query approve-web`
- `brain sync configure`, `brain sync status`, and `brain sync`
- expanded `brain status` and `brain doctor` output for setup, semantic index,
  web approval, and sync state

The OpenClaw adapter adds equivalent typed setup, reconciliation, web-approval,
and sync tools. It must not introduce another database or wiki format.

## Hosting and version constraints

- Retain the stable OpenClaw `2026.7.1-2` pin.
- Update the reference OpenClaw container to Node `24.15.0`.
- Use `/readyz`, rather than only `/healthz`, for deployment readiness.
- Keep the repository mount canonical and the OpenClaw runtime volume
  disposable.
- Keep web and host credentials in environment variables, never repository
  files or operation logs.

## Verification gates

Deterministic tests must cover all new state transitions, recovery paths,
invalid/stale reconciliation receipts, source immutability, approval expiry,
safe-push refusals, and semantic-cache rebuilding. They use fake host and web
adapters in CI.

A disposable clone with synthetic sources is the required template smoke
fixture. It must contain distributed facts, synonyms, contradictions, a local
bare Git remote, and a deliberate local-knowledge gap. The live gates are:

1. **Codex live smoke:** setup, raw-source-backed answer, repeated wiki-only
   answer, push, and visible sync-pending behavior.
2. **OpenClaw live smoke:** container build/start, `/readyz`, plugin discovery,
   approval denial and approval grant, captured web evidence, restart
   persistence, and safe synchronization to the test remote.

Until both live gates pass, the project must report the precise state, for
example: “Core/Codex verified; OpenClaw verification pending.” A personal
second-brain pilot follows template verification and evaluates usefulness, not
basic mechanics.

## Post-v1 reminder

Add `docs/V1_EXIT_CHECKLIST.md` and a matching `AGENTS.md` instruction. When
all v1 verification gates pass, the agent must explicitly tell the owner that
v1 is verified and invite v2 planning. The v2 backlog contains OCR/media,
cross-brain links, multi-user workflows, hard-gated local web MCP, remote
embeddings, a UI, automatic template upgrades, and optional background
watching.

## Evidence for the selected approach

- SQLite FTS5 documents BM25 ranking: <https://www.sqlite.org/fts5.html>
- Sentence-BERT establishes efficient semantic similarity retrieval:
  <https://arxiv.org/abs/1908.10084>
- Reciprocal Rank Fusion combines independent rankings effectively:
  <https://cormack.uwaterloo.ca/cormacksigir09-rrf.pdf>
- Transformers.js supports server-side Node inference:
  <https://huggingface.co/docs/transformers.js/main/en/tutorials/node>
- The selected multilingual E5 model is Transformers.js-compatible:
  <https://huggingface.co/Xenova/multilingual-e5-small>
- OpenClaw documents approval-capable plugin hooks:
  <https://docs.openclaw.ai/plugins/hooks>
- Codex documents that hosted tools are not intercepted by repository hooks:
  <https://learn.chatgpt.com/docs/hooks>
- Git documents normal fast-forward push behavior:
  <https://git-scm.com/docs/git-push>
