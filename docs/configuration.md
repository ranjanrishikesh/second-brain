# Configuration reference

`brain.config.yaml` contains domain-neutral mechanical settings. Put domain intent and editorial judgment in `BRAIN.md`, not in core code.

## Version and identity

- `version`: must be `1`; future versions are rejected.
- `brain.name`, `brain.description`, `brain.language`: identity shown by status and hosts.

## Template support

- `support.issueTrackerUrl`: the canonical HTTPS issue tracker for the
  software template. The default points to the original second-brain template,
  not the cloned brain's `origin` remote.

The host may use this destination only after it has classified a product
capability gap or reproducible template defect, removed private brain data from
the draft, and received approval for the exact external issue. The core and CLI
never contact GitHub.

## Sources and bootstrap

- `sources.roots`: repository-relative immutable source roots. The default is `sources`.
- `sources.maxFileBytes`: maximum source-file size read in-process. For DOCX, the same limit also caps declared and streamed cumulative uncompressed content plus semantic/rendered extraction output; physical entries, paths, sizes, checksums, and repeated note/comment expansion are validated before extraction. Oversized files are registered with a visible failure.
- `bootstrap.mode`: `catalog-map` in v1.
- `bootstrap.batchSize`: maximum source contexts returned by `brain bootstrap next`.

Bootstrap creates a shallow source catalog and relationship map. The host agent starts or resumes it automatically from the first domain question, using the purpose and boundaries in `BRAIN.md`; it is not a file watcher or background job. It is checkpointed by durable source pages and must catalog every ready initial source before setup can finish. After setup, newly dropped files are scanned on query start and cataloged in query-triggered delta batches when they are needed. Later questions deepen the graph only where useful.

## Learning and web evidence

- `learning.mode`: `durable`; raw/web-backed answers must change canonical knowledge.
- `web.capture`: `evidence`; every external claim must first be captured under `sources/web/`.
- `web.approvalTtlHours`: the lifespan of one owner decision for one active question; default `24`. Approval is bound to the query ID, normalized question, and host session. A past general preference for research does not authorize a new query.

Web captures record URL, retrieval time, originating query, capture kind, content hash, and version/supersession data. They obey the same immutable-source contract as local files.

## Semantic model and hybrid retrieval

- `graph.semanticModel.id`: fixed in v1 to `Xenova/multilingual-e5-small`.
- `graph.semanticModel.revision`: fixed pinned model revision, `761b726dd34fb83930e26aab4e9ac3899aa1fa78`.
- `graph.semanticModel.artifactSha256`: expected SHA-256 for `model_quantized.onnx`, `f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193`.

The first initial setup downloads the pinned model to `.brain/cache/models/` under its exact revision. It verifies the quantized model artifact and its required configuration/tokenizer files before embedding anything, then loads that local directory with network fallback disabled. Search uses deterministic SQLite FTS5 lexical retrieval by default; reconciliation during and after setup also uses the local semantic index to find conceptually related pages. The semantic index is rebuilt whenever its source/wiki corpus revision or model metadata changes. Both it and the model cache are disposable. If the model is absent and the machine is offline, setup stops before completion; restore network access or a verified cache, then resume setup.

## Graph

- `graph.semanticAuditEvery`: knowledge-changing operations between semantic audit cycles; default `25`.
- `graph.relatedPageLimit`: related-result review limit used for reconciliation.
- `graph.pageTypes`: allowed wiki page types. Defaults to source, topic, entity, concept, synthesis, and question.
- `graph.relationTypes`: allowed typed edges. Defaults include supports, contradicts, related-to, part-of, influences, depends-on, and supersedes.

You may extend page and relation types per clone without changing TypeScript.

## Git

- `git.autoCommit`: when true, successful managed operations create local commits.
- `git.autoPush`: remains `false`; it never authorizes a broad automatic push.

Safe remote synchronization is separate and opt-in. The owner must explicitly run `brain sync configure --remote <name> --branch <branch> --confirm` for an existing remote. With that confirmed target, the core may attempt only a normal fast-forward push whose commits are all marked as managed brain operations. A pending or manual-sync-required result never discards the local commit; hosts must visibly report the exact `⚠ Sync pending — …` warning before answering. It never force-pushes, pulls, rebases, or pushes unrelated local commits.

The core refuses pre-existing staged changes and dirty managed wiki/state paths. It stages exact managed paths only; unrelated unstaged work remains untouched.

## Disposable versus canonical state

Tracked canonical state:

- `.brain/source-manifest.json`
- `.brain/state.json`
- `.brain/operations.jsonl`
- `wiki/`
- `sources/`

Disposable and ignored:

- `.brain/cache/` — extracted chunks and SQLite FTS5 index, rebuilt from canonical data.
- `.brain/cache/models/` and `.brain/cache/semantic-index.json` — the pinned local model and semantic vectors, verified/rebuilt as described above.
- `.brain/runtime/` — locks, query sessions, query read receipts, web-approval records, transaction journals, and recovery snapshots.

Runtime data is operational rather than knowledge. An active recovery journal must be completed before deleting runtime state.
