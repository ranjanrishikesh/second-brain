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
