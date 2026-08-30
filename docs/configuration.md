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

- `sources.roots`: canonical repository-relative immutable source roots using
  `/` separators, such as `sources` or `documents/research`. Absolute paths,
  Windows drive/UNC paths, backslashes, control characters, line separators,
  empty segments, and `.` or `..` path segments are rejected. The default is
  `sources`.
- `sources.maxFileBytes`: maximum local source-file or downloaded-artifact input size read in-process; default `104857600` bytes. For DOCX, the same limit also caps declared and streamed cumulative uncompressed content plus semantic/rendered extraction output; its logical-block ceiling is derived from that semantic byte budget rather than the general text-family chunk default. Physical entries, paths, sizes, checksums, and repeated note/comment expansion are validated before extraction. An oversized local file found by source scanning is registered with a visible failure. An oversized downloaded web artifact is rejected before capture prepares files or registers a source.
- `sources.textExtraction.maxExtractedBytes`: maximum cumulative UTF-8 retained across the title, primary text, chunk locators, and chunk text for Markdown, text, HTML, JSON/JSONL, CSV, and TSV extraction; default `8388608` bytes.
- `sources.textExtraction.maxChunks`: maximum retained chunks or structured entries for those text-family extractors; default `10000`.
- `sources.pdf.maxPages`: maximum PDF page count; default `2000`.
- `sources.pdf.maxExtractedBytes`: cumulative normalized PDF text budget; default `104857600` bytes.
- `sources.epub.maxEntries`: maximum physical/decoded archive entries and logical spine items; default `1000`.
- `sources.epub.maxExpandedBytes`: cumulative EPUB expanded-byte budget; default `104857600` bytes.
- `sources.epub.maxExtractedBytes`: cumulative UTF-8 budget across the normalized EPUB title, primary chapter text including inter-chapter separators, every chunk locator, and every chunk's chapter text; default `104857600` bytes.

Text-family output and entry limits are enforced while parsing, before an
unbounded chunk list or joined output can be retained. HTML blocks are
processed sequentially with cumulative accounting, preserving stable nested
block output without retaining an unbounded expansion. Lowering an input,
output, or chunk limit invalidates disposable extraction and search caches; an
older oversized cache is not treated as current evidence.

PDF input bytes, page count, retained text, and the core string buffer are bounded, and pages are processed sequentially. PDF.js must still parse catalog/xref structures before reporting page count, and one emitted text-stream chunk/item may already exist when incremental accounting rejects it. These accepted residual allocations are bounded only indirectly by input bytes; PDF handling is not claimed to provide subprocess isolation or a complete memory boundary.
- `bootstrap.mode`: `catalog-map` in v1.
- `bootstrap.batchSize`: maximum source contexts returned by `brain bootstrap next`.

Bootstrap creates a shallow source catalog and relationship map. The host agent starts or resumes it automatically from the first domain question, using the purpose and boundaries in `BRAIN.md`; it is not a file watcher or background job. It is checkpointed by durable source pages and must catalog every ready initial source before setup can finish. After setup, newly dropped files are scanned on query start and cataloged in query-triggered delta batches when they are needed. Later questions deepen the graph only where useful.

## Learning and web evidence

- `learning.mode`: `durable`; raw/web-backed answers must change canonical knowledge.
- `web.capture`: `evidence`; every external claim must first be captured under `sources/web/`.
- `web.approvalTtlHours`: the lifespan of one owner decision for one active question; default `24`. Approval is bound to the query ID, normalized question, and host session. A past general preference for research does not authorize a new query.

Web captures record URL, retrieval time, originating query, capture kind, content hash, and version/supersession data. They obey the same immutable-source contract as local files.

The host owns all web searching, redirects, and fetching. The web-capture core API and `brain web capture` command receive host-supplied bytes or text and do not make an HTTP request themselves. This claim is limited to the capture path: initial semantic setup can download the pinned model described below. The host may fetch only public HTTP(S) destinations after exact-question approval, with at most five ordered redirects, no private/loopback/link-local/metadata destinations, no access-control bypass, and no HTTPS-to-HTTP downgrade. Credentials and temporary local paths are not provenance.

Artifact capture accepts exact PDF, DOCX, EPUB, Markdown, text, JSON/JSONL, CSV, or TSV bytes. Magic/container validation and the filename format declaration must agree; an absent or generic `application/octet-stream` media type is allowed, but a conflicting format-specific media type is rejected. Text formats require valid UTF-8 and use their existing structured parser. Ordinary HTML pages are not artifact inputs: preserve their accessible text as complete or partial Markdown snapshots. The CLI passes a safe basename as a detection hint and never stores its runtime input path.

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

Safe remote synchronization is separate and opt-in. The host agent may configure an existing remote and branch only after the owner explicitly confirms that exact destination. After confirmation, the host runs routine status and eligible sync operations for the owner; a manual troubleshooting/reference equivalent is `brain sync configure --remote <name> --branch <branch> --confirm`. The core may then attempt only a normal fast-forward push whose commits are all marked as managed brain operations. A pending or manual-sync-required result never discards the local commit; hosts must visibly report the exact `⚠ Sync pending — …` warning before answering. It never force-pushes, pulls, rebases, or pushes unrelated local commits.

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
