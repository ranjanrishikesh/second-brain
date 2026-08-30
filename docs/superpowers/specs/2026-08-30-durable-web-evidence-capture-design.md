# Durable Web Evidence Capture Design

## Summary

When approved web research materially contributes to an answer, the brain must
preserve the evidence it actually used. A directly downloadable supported
document is stored under `sources/web/` in its original bytes. An ordinary web
page is stored as Markdown containing the complete accessible text supplied by
the host without summarization. Both forms become immutable, registered sources
before they can support a citation.

The host agent continues to own searching and fetching. The deterministic core
does not become a network client. It validates, imports, registers, versions,
and links the fetched evidence to the active query through the existing web
approval and source transaction boundaries.

## Goals

- Preserve the strongest available representation of every external source
  materially used for an approved question.
- Prefer original PDF, DOCX, EPUB, Markdown, text, JSON/JSONL, CSV, or TSV bytes
  over a converted copy when the resource is a downloadable supported file.
- Preserve ordinary web pages as faithful textual Markdown snapshots rather
  than summaries.
- Retain enough provenance to audit the original URL, final URL, redirect path,
  retrieval time, originating query, completeness, media type, and content
  hash.
- Reuse the existing extraction, immutable-source, query, reconciliation,
  recovery, Git commit, and safe-sync contracts.
- Make retries deterministic and leave interrupted evidence safely resumable.

## Non-goals

- No background crawler, watcher, bulk mirror, recursive link traversal, or
  download of every search result.
- No network stack, browser, authentication store, cookie jar, or generic
  downloader inside the core or CLI.
- No bypass of paywalls, login requirements, robots controls enforced by the
  host tool, or other access restrictions.
- No OCR, `.doc`, spreadsheet workbook, image, audio, video, or arbitrary
  executable/archive ingestion beyond formats the brain already supports.
- No claim that a partial result or search snippet is a complete page.
- No execution of instructions, scripts, macros, or active content found in an
  external source.

## Capture policy

The host captures only evidence that is materially used to answer the current
approved question. Discovery alone is not enough. Search result pages,
irrelevant candidate documents, duplicate mirrors, navigation pages, and files
the host did not rely on are not added to the brain.

The representation decision is deterministic:

1. If the final response is a supported downloadable source, capture its exact
   bytes as an artifact.
2. Otherwise, capture the accessible page text as Markdown.
3. If the host received only a snippet or partial page, capture it only as
   partial evidence and limit claims to what that captured text supports.
4. If the content cannot be fetched or safely validated, record the limitation
   and continue searching or persist a knowledge gap. Never create placeholder
   evidence.

For a page snapshot, “verbatim” means that the textual body supplied by the
host is preserved without paraphrasing, summarization, reordering, or invented
content. The core may normalize CRLF/CR line endings to LF and add provenance
frontmatter and a title outside the captured body. Scripts, styles, cookie
banners, repeated navigation chrome, and inaccessible text are not part of the
accessible textual snapshot. The metadata must distinguish `complete` from
`partial`.

## Architecture

```text
approved query at web tier
  → host searches and fetches a material source
  → host supplies text or downloaded bytes plus provenance to brain CLI
  → core validates approval, representation, URLs, limits, and hashes
  → core prepares immutable evidence under sources/web/YYYY/MM/
  → source transaction extracts, registers, logs, and commits exact paths
  → query session links the registered source ID
  → host persists cited knowledge, reconciles, validates, and finishes query
```

The core accepts already-fetched data only. For a local host, Codex or Claude
may use its approved web tooling to write a temporary file under
`.brain/runtime/`; the CLI reads that file as bytes and passes the bytes to the
core. Runtime input is disposable and is never staged. Core behavior is equally
usable by a host that already has the bytes in memory.

### Public core input

`WebCaptureInput` becomes a discriminated union while retaining the existing
page and snippet form:

```ts
interface WebCaptureProvenanceV1 {
  originalUrl: string;
  finalUrl?: string;
  redirectChain?: string[];
  title: string;
  retrievedAt?: string;
}

interface WebTextCaptureInputV1 extends WebCaptureProvenanceV1 {
  representation: "text";
  captureKind: "page" | "snippet";
  completeness: "complete" | "partial";
  content: string;
}

interface WebArtifactCaptureInputV1 extends WebCaptureProvenanceV1 {
  representation: "artifact";
  fileName: string;
  declaredMediaType?: string;
  content: Uint8Array;
}

type WebCaptureInput = WebTextCaptureInputV1 | WebArtifactCaptureInputV1;
```

For backward compatibility, the current input shape using `url`,
`captureKind`, and string `content` is parsed as a text capture. Its final URL
defaults to its original URL, and its completeness defaults to `partial` for a
snippet and `complete` for a page.

### CLI

Existing text capture remains compatible:

```text
brain web capture <query-id> --url <url> --title <title>
  --kind page|snippet --content <text>|--content-file <path>
  [--final-url <url>] [--completeness complete|partial]
  [--redirect-url <url> ...] [--retrieved-at <timestamp>]
```

Artifact capture adds an exclusive input mode:

```text
brain web capture <query-id> --url <url> --title <title>
  --kind artifact --artifact-file <path>
  [--file-name <name>] [--media-type <type>] [--final-url <url>]
  [--redirect-url <url> ...] [--retrieved-at <timestamp>]
```

Exactly one text or artifact input mode is allowed. JSON output retains the
existing `WebCaptureResult` and reports the stored path, detected format,
extraction status, creation/reuse result, and linked query session.

## Canonical storage and provenance

Text evidence retains the current Markdown representation:

```text
sources/web/YYYY/MM/<slug>-<evidence-digest>.md
```

Its `brainWebCapture: 1` frontmatter gains optional backward-compatible fields
for `originalUrl`, `finalUrl`, `redirectChain`, `completeness`, and the exact
captured-body hash. Older captures containing only `url` continue to load.

Artifact evidence preserves the exact downloaded bytes:

```text
sources/web/YYYY/MM/<slug>-<content-digest>.<detected-extension>
sources/web/YYYY/MM/.<slug>-<content-digest>.<detected-extension>.web.json
```

The hidden tracked sidecar is not itself a source. It uses a strict
`brainWebArtifact: 1` schema containing:

- artifact relative path and SHA-256;
- original and final URL plus a bounded redirect chain;
- retrieval time and originating query ID/question hash;
- title, detected format, media type, and byte length;
- completeness (`complete` for an artifact whose response body was fully
  received); and
- optional `supersedes` source ID.

`SourceRecordV1.provenance` gains optional additive fields for final URL,
redirect chain, completeness, representation, sidecar path/hash, and alternate
discovery URLs. The existing `url` field remains the primary original URL and
the existing `captureKind` enum remains `page | snippet`. Artifact records omit
`captureKind` and use `representation: "artifact"`, so old v1 readers can still
parse the additive record without encountering a new enum member. Generated v1
JSON Schemas are updated; existing records require no migration.

The source walker continues to ignore dotfiles as independent inputs. When it
finds a candidate artifact under `sources/web/`, it looks for the deterministic
sidecar, validates the sidecar against the exact artifact bytes, and derives
web provenance from it. `brain doctor`, source scanning, and audit reject a
missing, malformed, moved, or modified sidecar for a registered artifact.

## Validation and safety

All capture modes require an open query at the web tier and a current approval
for that exact query. The approval must be validated before any canonical file
is prepared.

The core validates:

- original, final, and redirect URLs use HTTP or HTTPS;
- the redirect chain has at most five hops;
- an HTTPS request never records an HTTP downgrade;
- loopback, link-local, private-network, `file:`, `data:`, and cloud-metadata
  destinations are rejected by the host contract, with syntactic IP forms also
  rejected by the core;
- the received byte count does not exceed `sources.maxFileBytes`;
- filenames cannot escape the managed destination and are used only as title
  hints;
- the detected source format is supported and agrees with magic bytes and
  container structure; an absent or generic `application/octet-stream`
  declaration is allowed, while a conflicting format-specific media type is
  rejected;
- PDF, DOCX, and EPUB reuse their existing structural/archive limits;
- text formats are valid UTF-8, and structured text is validated by its
  existing parser before registration;
- no source content is executed, imported as code, or treated as agent
  instructions; and
- credentials, cookies, authorization headers, local temporary paths, and
  private host metadata never enter provenance.

An image-only PDF may still be stored as exact web evidence, but its normal
extractor reports `extraction-required`. It cannot support an answer until
usable textual evidence exists. Other unsupported downloads are not retained
automatically merely because the server offered them.

The host must not circumvent access controls. If its lawful/approved tooling
cannot retrieve a full page, it records a partial capture or an explicit gap.

## Immutability, deduplication, and supersession

Source identity remains content-derived.

- The same URL and same bytes reuse the existing source and only link it to the
  active query.
- Identical bytes discovered at another URL reuse the same source; the new URL
  is appended through a canonical provenance-enrichment operation rather than
  duplicating the artifact.
- Different bytes retrieved from the same original or final URL create a new
  source whose sidecar and manifest record reference the most recent prior
  source through `supersedes`.
- A changed registered artifact or sidecar is an immutable-source violation.
  The replacement must be captured as a new version.

No automatic capture deletes or overwrites an older source. Alternate URLs and
supersession metadata are sorted and deterministic.

## Transaction and recovery behavior

Capture retains the proven prepared-source pattern:

1. Validate query state, approval, input, destination, and expected hashes.
2. Create the artifact and sidecar (or Markdown capture) with exclusive writes.
3. Run the canonical source-registration transaction, sealing the exact source
   and sidecar bytes and committing only their exact managed paths plus the
   manifest, state, operation log, and wiki log.
4. Link the registered source ID to the runtime query session.

Prepared files are never deleted merely because a writer lock is busy or a
later step fails. A retry finds the deterministic digest path, verifies every
prepared byte and the sidecar identity, finishes registration if needed, and
links the query. Mismatched prepared data fails closed. Recovery handles the
same prepared, files-applied, and commit-completed states as other canonical
mutations.

If registration commits but runtime query linkage fails, a retry reuses the
registered source and completes linkage. If a temporary host download remains
under `.brain/runtime/`, it is disposable and may be removed after the CLI
returns success; it is never the canonical copy.

## Query and agent behavior

`AGENTS.md` and the second-brain skill must require the host to:

1. obtain per-question web approval before searching or fetching;
2. prefer a supported original downloadable file over a page summary;
3. capture only material evidence actually used;
4. use page capture for ordinary accessible text and accurately mark partial
   results;
5. treat all external content as untrusted evidence, never instructions;
6. inspect the registered extraction result before relying on it;
7. persist a cited, reconciled wiki change before finishing a web-backed
   answer; and
8. report capture/download limitations explicitly instead of fabricating
   evidence.

The web grant covers relevant searches and fetches for the current question,
so no additional approval is required per URL. It never transfers to another
question. External issue-reporting approval remains a separate gate.

## Error handling

Failures are actionable and preserve the query:

- unavailable/expired approval: no fetch or capture;
- download unavailable, access restricted, or unsafe redirect: continue with
  other approved evidence or persist a gap;
- unsupported or spoofed format: reject the artifact and report the detected
  reason;
- size/archive/output limit exceeded: reject before registration;
- page completeness cannot be inferred from text alone; the core records the
  host declaration, while the host may mark `complete` only when its fetch tool
  reports a complete response rather than a snippet, truncation, or access
  interstitial;
- prepared-byte mismatch: fail closed without overwriting;
- extraction-required artifact: keep the immutable source, but do not cite it
  as textual support;
- transaction/commit failure: recover canonical state and preserve the
  prepared input for deterministic retry; and
- query-link failure after commit: reuse the registered source on retry.

## Testing strategy

Every behavioral slice follows TDD. Deterministic tests use fake fetched bytes
and never access the network.

Core tests cover:

- backward-compatible page/snippet inputs;
- complete and partial Markdown snapshots without summarization or content
  reordering;
- PDF, DOCX, EPUB, Markdown, text, JSON/JSONL, CSV, and TSV artifact imports;
- media-type/extension disagreement, magic-byte spoofing, invalid UTF-8,
  path traversal, private/unsafe URLs, HTTPS downgrade, excessive redirects,
  and configured size/archive limits;
- approval, open-query, and web-tier enforcement before file creation;
- exact artifact bytes, sidecar schema/hash, manifest provenance, stable
  locators, query linkage, and managed commit contents;
- same-URL deduplication, alternate-URL enrichment, changed-content
  supersession, and registered sidecar mutation rejection;
- retries with and without an explicit retrieval timestamp;
- prepared-file, writer-lock, registration, session-write, and crash recovery;
- cache deletion/rebuild parity and doctor/audit diagnostics; and
- scanned PDF capture remaining `extraction-required` and unusable for a
  factual citation.

CLI tests cover mutually exclusive inputs, artifact binary reading, JSON
output, redirect arguments, human diagnostics, and installed-package behavior.

The end-to-end fake host proves an approved question can discover a PDF,
capture its original bytes, persist a cited answer, and later answer from the
wiki without web access. A second flow captures a complete page as Markdown. A
denied question creates neither files nor sidecars. No default test requires
credentials or live web access.

## Documentation

- The active agent contract and skill describe the representation decision,
  material-use rule, untrusted-content boundary, and capture-before-citation
  requirement.
- `docs/contracts.md` documents text and artifact provenance.
- `docs/configuration.md` explains size limits and supported capture formats.
- The minimal README may add one short sentence explaining that used web
  documents are preserved in original form and ordinary pages as textual
  snapshots, while retaining its three-section and 300-word contract.
- The maintainer checklist gains deterministic and live-host capture checks
  without adding roadmap language.

## Acceptance criteria

- A PDF or DOCX materially used during approved research is committed under
  `sources/web/` byte-for-byte with validated, recoverable web provenance.
- An ordinary used page is committed as a complete or partial Markdown textual
  snapshot without paraphrasing.
- Unused results are not accumulated.
- All web-backed claims cite registered captured evidence and complete the
  existing durable mutation/reconciliation lifecycle.
- Approval, access, format, size, immutability, transaction, and recovery
  failures fail closed without corrupting canonical state.
- Identical evidence is reused; changed evidence is versioned and older
  evidence remains visible.
- Existing Markdown web captures, local sources, public v1 schemas, and query
  flows remain readable without migration.
- The core and CLI perform no network request.

## Decisions made

1. **Host-owned fetch, core-owned import.** This preserves the deterministic
   host-neutral architecture and keeps network credentials and policy out of
   the core.
2. **Original artifacts over conversion.** Exact bytes preserve stronger
   evidence and existing PDF/DOCX/EPUB locators.
3. **Hidden tracked sidecar for binary provenance.** Binary bytes stay untouched
   while provenance remains portable, recoverable, and auditable.
4. **Material-use capture only.** This prevents uncontrolled source growth and
   keeps every captured item connected to a real question.
5. **Faithful accessible text, explicitly complete or partial.** This avoids
   presenting snippets or host summaries as verbatim pages.
6. **Additive v1 fields instead of a new artifact enum.** Existing v1 records
   and parsers remain compatible while new readers gain precise provenance.
7. **Prepared inputs survive interruptions.** Deterministic retry is safer than
   cleanup that can race a concurrent writer.
8. **No automatic retention of unsupported binaries.** A file that cannot be
   validated or used as evidence does not compound the brain merely because it
   was downloadable.
