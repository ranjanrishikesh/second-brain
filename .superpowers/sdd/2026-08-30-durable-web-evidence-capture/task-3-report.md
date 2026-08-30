# Task 3 report — web evidence integrity and citation readiness

## Owned implementation

- Added one shared `inspectWebEvidenceIntegrity` / `assertWebEvidenceIntegrity`
  path for registered web artifact records.
- Enforced the same artifact and sidecar integrity before cached extraction and
  cache rebuild returns.
- Fed exact integrity issue codes into wiki graph validation; the existing
  doctor graph mapping exposes the same codes without a second validator.
- Rejected factual inline citations to known non-ready sources while retaining
  locator-free source references on durable question/gap pages.
- Required answered and partial web queries to cite ready evidence linked to
  the runtime session and discovered for that exact query. Legacy text web
  captures with no structured discoveries retain their prior explicit-link
  fallback, and unanswered durable gaps remain finishable.
- Rechecked every cited and session-linked captured source at finish time, so
  corruption introduced after a wiki mutation cannot satisfy the query.

## Integrity boundaries

- Artifact classification fails closed when any artifact-specific signal is
  present: `representation: artifact`, any companion fingerprint field, or an
  artifact web discovery. Removing the representation discriminator cannot
  downgrade an artifact to legacy text evidence.
- Inconsistent or partial artifact provenance reports
  `WEB_ARTIFACT_SOURCE_MISMATCH`.
- Companion paths must be deterministic and remain lexically and physically
  contained below `sources/`. Artifact and sidecar reads require regular
  non-symlink files, bounded size, `O_NOFOLLOW`, stable device/inode identity,
  stable size/mtime/ctime, and final path/containment revalidation.
- Sidecar parsing and artifact validation reuse Task 1/2's strict schemas,
  URL/format rules, and byte/hash validator. The inspector additionally binds
  recorded companion fingerprints, manifest source fingerprints/media type,
  and primary discovery metadata.
- Local sources and legacy text captures have no artifact signal and remain
  unaffected.

## TDD evidence

1. Initial focused RED:

   ```text
   pnpm exec vitest run packages/core/test/config.test.ts packages/core/test/wiki.test.ts packages/core/test/query.test.ts packages/core/test/search.test.ts
   ```

   Result: 16 expected failures / 66 passes after the initial test addition.
   Doctor and graph remained healthy for all five corruption classes; cached
   and rebuilt extraction returned despite a corrupt sidecar; non-ready inline
   citations emitted no readiness issue; and non-ready/wrong-query evidence
   incorrectly finished as answered. Two fixture/setup errors were corrected
   before implementation; the clean query RED was 2 failures / 18 passes.

2. First focused GREEN: 4 files / 82 tests passed in 43.32 seconds.

3. Adversarial RED after self-review: 4 expected failures / 82 passes. Removing
   the artifact discriminator bypassed doctor, graph, and cache integrity, and
   sidecar corruption after the wiki mutation still allowed query completion.

4. Adversarial focused GREEN: 4 files / 86 tests passed in 41.30 seconds.

## Verification and self-review

- Scoped Biome check passed after formatting.
- Scoped TypeScript project check passed with no diagnostics.
- `git diff --check` passed.
- The single required `pnpm verify:fast` exited 0: Biome checked 103 files,
  TypeScript project build passed, and Vitest passed 27 files / 385 tests in
  250.60 seconds.
- Reviewed the exact diff for cache hit/rebuild parity, issue-code mapping,
  non-ready citation behavior, current-query discovery binding, post-mutation
  corruption, legacy/local compatibility, and Task 2 path/immutability
  protections. No network behavior or general transaction behavior changed.

## Remaining concerns

None known.

## Fix Round 1 — stripped provenance and metadata-only finish bypasses

### Verified findings

- Removing `representation`, all companion fields, and all structured
  discoveries from a registered artifact removed every prior artifact signal,
  so doctor, graph validation, cached extraction, and cache rebuild treated it
  as ordinary evidence. The bypass also applied to original-download Markdown
  artifacts.
- Finish-time evidence IDs came from page `sources` frontmatter. A ready web
  source listed with no locator and no inline citation therefore satisfied both
  answered and partial web outcomes even though it was only gap metadata.

### RED/GREEN evidence

1. Full artifact-signal stripping RED: the doctor/graph/TXT-cache/Markdown-
   cache matrix produced 4 expected failures / 65 passes. Compatibility probes
   then exposed two required distinctions: historical marked web text and
   non-canonical `kind: file` sources enriched with artifact discoveries must
   remain cache-readable. The focused GREEN passed config/wiki/search, 3 files
   / 71 tests.
2. Locator-free finish RED: query tests produced 2 expected failures / 21
   passes because answered and partial outcomes both completed from metadata-
   only references. GREEN passed the query file, 23/23 tests.
3. Combined Task 3 focused matrix passed 4 files / 94 tests in 46.75 seconds.

### Boundary decisions and self-review

- Canonical `sources/web/` records and `kind: web` provenance now fail closed
  when artifact fields disappear. The only no-companion web exception is a
  positively verified `brainWebCapture: 1` Markdown snapshot: safe bounded
  source bytes, manifest byte/hash identity, strict metadata, historical or
  current canonical body shape and body hash, and matching primary provenance.
- An original-download Markdown artifact with stripped sidecar provenance is
  not mistaken for text merely because its extractor is Markdown; unmarked
  Markdown is rejected. A downloaded document that exactly impersonates the
  complete canonical marked-capture format is indistinguishable by bytes after
  all provenance is maliciously removed, which is the intentional positive
  legacy recognition boundary requested by review.
- Non-canonical local sources remain unaffected when `kind: file`, including
  after structured web-discovery enrichment. Canonical web paths cannot be
  downgraded by changing only the provenance kind.
- Answered and partial evidence IDs now come from the canonical inline citation
  parser applied to the evidence-tier mutation pages. Locator-free question/gap
  metadata cannot satisfy an answer; unanswered durable gaps remain allowed.

### Final verification

The single post-fix `pnpm verify:fast` exited 0: Biome checked 103 files with
no diagnostics, the TypeScript project build passed, and Vitest passed 27 files
/ 393 tests in 244.96 seconds. `git diff --check` also passed on the final
scoped diff.
