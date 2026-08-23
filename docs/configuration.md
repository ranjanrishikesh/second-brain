# Configuration reference

`brain.config.yaml` contains domain-neutral mechanical settings. Put domain intent and editorial judgment in `BRAIN.md`, not in core code.

## Version and identity

- `version`: must be `1`; future versions are rejected.
- `brain.name`, `brain.description`, `brain.language`: identity shown by status and hosts.

## Sources and bootstrap

- `sources.roots`: repository-relative immutable source roots. The default is `sources`.
- `sources.maxFileBytes`: maximum bytes extracted in-process. Oversized files are registered with a visible failure.
- `bootstrap.mode`: `catalog-map` in v1.
- `bootstrap.batchSize`: maximum source contexts returned by `brain bootstrap next`.

Bootstrap creates a shallow source catalog and relationship map. It is checkpointed by durable source pages; later questions deepen the graph only where useful.

## Learning and web evidence

- `learning.mode`: `durable`; raw/web-backed answers must change canonical knowledge.
- `web.capture`: `evidence`; every external claim must first be captured under `sources/web/`.

Web captures record URL, retrieval time, originating query, capture kind, content hash, and version/supersession data. They obey the same immutable-source contract as local files.

## Graph

- `graph.semanticAuditEvery`: knowledge-changing operations between semantic audit cycles; default `25`.
- `graph.relatedPageLimit`: related-result review limit used for reconciliation.
- `graph.pageTypes`: allowed wiki page types. Defaults to source, topic, entity, concept, synthesis, and question.
- `graph.relationTypes`: allowed typed edges. Defaults include supports, contradicts, related-to, part-of, influences, depends-on, and supersedes.

You may extend page and relation types per clone without changing TypeScript.

## Git

- `git.autoCommit`: when true, successful managed operations create local commits.
- `git.autoPush`: fixed to false in v1.

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
- `.brain/runtime/` — locks, query sessions, transaction journals, and recovery snapshots.

Runtime data is operational rather than knowledge. An active recovery journal must be completed before deleting runtime state.
