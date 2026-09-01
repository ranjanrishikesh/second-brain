# Agent-Owned Relevance and Biome Ownership Design

## Summary

This change has two independent workstreams:

1. Fix issue #5 by keeping Biome focused on software-owned files and outside
   CLI-owned brain state, immutable evidence, generated knowledge, and ignored
   workspaces.
2. Make relevance a host-agent judgment. The agent automatically admits
   clearly relevant material, asks before adding material it judges unrelated
   or uncertain, and treats approval as an exception for that exact item only.

The deterministic CLI does not classify meaning, compute a relevance score, or
decide what belongs to the domain. It provides a safe preview and an exact-byte
review receipt so that its current automatic source registration cannot run
ahead of the agent's judgment.

## Confirmed product policy

One brain has one primary purpose and domain, recorded in `BRAIN.md`.

For every prospective source, captured web item, or durable wiki addition, the
host agent compares the material with that purpose and its boundaries:

- Clearly related material proceeds without interrupting the owner.
- Material that appears unrelated, or whose relevance is genuinely uncertain,
  requires a concise owner decision before durable addition.
- An approval applies only to the exact item presented. It does not edit the
  charter, create an allowlist, or automatically approve similar material.
- A declined item is not registered as evidence, captured from the web, or
  written into the wiki.
- Expanding the brain's primary scope requires a separate explicit owner
  request.

The standard prompt is:

> This appears outside the brain's main scope of `<scope>`: `<brief item
> description>`. Do you want me to add it as a one-time exception? This will
> not expand the brain's scope.

The agent may batch a small group of related out-of-scope candidates into one
prompt when it identifies each item clearly. Silence is never approval.

An otherwise relevant source remains complete and immutable for citation
integrity. Incidental unrelated facts inside it are not promoted into the wiki
without their own owner approval. Facts that are necessary context for an
in-scope question count as related; the prompt is for genuinely tangential
material, not every supporting detail.

## Approaches considered

### Contract-only instructions

Updating only `AGENTS.md` and the bundled second-brain skill would express the
desired behavior, but it would be unreliable. `brain query begin` currently
registers every newly discovered source before the host can ask, and the host
has no safe uniform preview for PDF, DOCX, EPUB, and the other supported
formats.

### Deterministic semantic classifier

The core could score candidates against the charter and enforce a threshold.
This is explicitly rejected. Relevance is contextual, model-owned semantic
judgment; a deterministic threshold would create false certainty and put the
decision in the wrong layer.

### Agent judgment with deterministic review plumbing

This is the selected approach. The CLI safely previews exact candidate bytes,
records the agent/owner decision for those bytes, and registers only admitted
candidates. It validates identity and lifecycle, not meaning.

## Workstream 1: Biome ownership boundary

`biome.json` enables Git integration and ignore-file support:

```json
"vcs": {
  "enabled": true,
  "clientKind": "git",
  "useIgnoreFile": true
}
```

The global `files.includes` list force-ignores software outputs and root-level
brain-owned paths:

```json
[
  "**",
  "!!**/dist",
  "!!.brain",
  "!!sources",
  "!!wiki",
  "!!BRAIN.md",
  "!!brain.config.yaml"
]
```

The force-ignore form prevents scanner traversal as well as formatter/linter
ownership conflicts. Git integration also respects `.gitignore`, nested ignore
files, the Git common-directory exclude file used by linked worktrees, and
Conductor's ignored `.context` workspace.

A behavioral test creates a disposable Git repository using the checked-in
Biome configuration. Intentionally noncanonical JSON under `.brain/`,
`sources/`, `wiki/`, and a Git-ignored workspace must not fail `biome format
.`. The same noncanonical JSON under a software-owned directory must fail. This
proves both halves of the boundary instead of merely asserting configuration
strings.

## Workstream 2: Local source review

### Read-only candidate preview

A new `brain source review --json` command inspects every unregistered local
candidate through the existing containment, stable-open, size, format, and
extraction policies. It returns a versioned review payload containing:

- relative path, byte length, SHA-256, title, media type, and extraction
  status;
- extraction diagnostics for unsupported, extraction-required, and failed
  inputs; and
- bounded representative chunks for ready inputs.

The command never changes the source manifest, durable brain state, wiki, Git
index, or HEAD. Disposable extraction artifacts may live only under
`.brain/runtime/`. Registration re-reads and revalidates the bytes, so preview
does not weaken the existing time-of-check/time-of-use protections.

### Exact-byte review decisions

The agent writes a versioned decision file under `.brain/runtime/` and submits
it with `brain source decide <decision-file>`. Each input entry binds:

```ts
interface SourceReviewDecisionInputV1 {
  path: string;
  sha256: string;
  decision: "include" | "exclude";
  basis: "agent-in-scope" | "owner-exception" | "owner-declined";
  reason: string;
}
```

Valid combinations are:

| Decision | Basis | Meaning |
| --- | --- | --- |
| `include` | `agent-in-scope` | The agent judged the exact candidate related and proceeded automatically. |
| `include` | `owner-exception` | The agent asked and the owner approved this exact item once. |
| `exclude` | `owner-declined` | The agent asked and the owner declined this exact item. |

The CLI validates the path and digest against a fresh safe read, records the
receipt through a managed transaction, and never infers the decision. Invalid
combinations, missing reasons, duplicate contradictory entries, symlinks,
changed bytes, or stale preview digests fail without partial state.

The core stamps `decidedAt`; it does not trust a host-supplied timestamp. A
receipt stores no source excerpt or inferred facts. Its reason identifies the
scope relationship or owner decision without copying private source content.

Receipts live in versioned brain state. Matching excluded bytes are treated as
reviewed but remain absent from `.brain/source-manifest.json`, search indexes,
setup batches, and the wiki. The CLI does not delete, move, or rewrite the
owner's file. If an excluded file's bytes change, its old receipt no longer
matches and the new bytes require review. Included receipts remain auditable
after registration, including the distinction between an ordinary in-scope
addition and a one-time exception.

### Registration and lifecycle ordering

`brain source scan` registers only unregistered candidates with a matching
`include` receipt. Matching `exclude` receipts are acknowledged without
registration. Any unreviewed candidate is reported as pending review rather
than silently added.

Onboarding exposes a `sources-review-required` phase with
`nextAction: review-sources`. The host-owned route becomes:

```text
discover candidates
  -> preview exact bytes
  -> agent compares them with the primary scope
  -> auto-record in-scope decisions
  -> ask only for unrelated or uncertain candidates
  -> record exact owner decisions
  -> register included candidates
  -> continue charter/setup/query work
```

`brain query begin`, setup, and other convenience paths no longer bypass this
ordering by registering arbitrary unreviewed local files. They may register
already admitted candidates, but they return a clear review-required result
when unresolved candidates exist. The host continues operating all routine CLI
commands for the owner.

Existing registered sources are grandfathered. The feature does not
retroactively classify, remove, or rewrite them.

## Charter inference and onboarding behavior

The active host contracts stop instructing the agent to broaden a charter for
a mixed corpus. Instead, the agent infers one primary scope using the existing
precedence of identity, available repository metadata, Git common-directory
name, source titles, and representative chunks.

Clearly coherent candidates establish or reinforce that primary scope.
Outliers require confirmation. If identity and candidates do not reveal a
single defensible primary scope, the agent asks the owner to name it rather
than silently creating a multi-domain brain.

The charter is inferred from primary-scope material. A source admitted as an
`owner-exception` remains available as exact evidence but does not broaden the
purpose or boundaries. The owner may later request a deliberate charter change
as a separate operation; this design does not add automatic charter mutation.

## Web evidence and wiki changes

No semantic logic is added to the web-capture or wiki-transaction core.
Instead, `AGENTS.md` and `.agents/skills/second-brain/SKILL.md` add explicit
host checkpoints:

1. Before `brain web capture`, the agent decides whether the material evidence
   is related to the primary scope and active question.
2. Before drafting or applying a wiki mutation, the agent checks every new
   durable claim or page for relevance.
3. Clearly related material proceeds. Unrelated or uncertain material uses the
   one-time-exception prompt.
4. A decline means no capture and no wiki mutation for that item. An approval
   is documented in the exact operation reason but does not modify `BRAIN.md`
   or approve future items.

Question-scoped web approval remains a separate permission. Approval to search
the web is not approval to add an unrelated discovery, and a scope exception
is not permission to perform web research when the active query lacks web
approval.

## Failure and recovery behavior

- A candidate that changes between preview, decision, and registration is
  treated as a new candidate and must be reviewed again.
- Unsupported or extraction-blocked files retain the existing exact
  diagnostics; relevance review never upgrades them into usable evidence.
- If the agent cannot judge relevance from the bounded preview, it asks rather
  than guessing or reading past configured safety limits.
- Interrupted decision writes and registrations use the existing canonical
  transaction journal and recovery path.
- A declined local file may remain physically present under the source root,
  but its exact bytes are not a registered brain source and cannot enter setup,
  search, citations, or the wiki.
- Scope review never triggers web access, deletion, arbitrary Git actions, or
  synchronization to an unconfirmed target.

## Public contracts and compatibility

The following versioned contracts gain backward-compatible fields or new
schemas, with generated JSON Schemas updated in the same change:

- brain state gains defaulted source-review receipts;
- onboarding status gains the review-required phase/action and pending count;
- source scan results distinguish included, excluded, and pending-review
  candidates;
- new source-review preview and decision payload schemas are exported by the
  core package.

Legacy state without review receipts parses with an empty default. Existing
registered sources remain valid. Web captures created by the approved capture
flow continue through their existing atomic registration path; local candidate
review does not reinterpret managed `sources/web/` artifacts.

`README.md`, `docs/onboarding.md`, `AGENTS.md`, the bundled second-brain skill,
CLI help, and maintainer verification documentation describe the owner-visible
behavior without exposing routine command entry to the owner.

## Verification

Implementation is complete only when tests prove:

- Biome ignores CLI-owned and Git-ignored files while still rejecting
  noncanonical software-owned files;
- candidate preview is read-only and uses the same containment and extraction
  limits as registration;
- clearly in-scope decisions can be submitted without owner interaction;
- out-of-scope inclusion requires the host's owner-exception path and remains
  exact-item-only;
- declined exact bytes never enter the manifest, setup, search, or wiki;
- changed excluded bytes become pending review again;
- unreviewed files cannot be silently registered by query or setup convenience
  paths;
- mixed onboarding retains one primary charter instead of broadening it;
- existing registered sources and existing web-capture flows remain
  compatible;
- recovery, doctor, status, schema generation, and end-to-end onboarding stay
  healthy; and
- `pnpm verify` and `pnpm test:e2e` pass from the completed worktree.

## Non-goals

- No relevance model, embedding threshold, keyword allowlist, taxonomy engine,
  or semantic decision inside the deterministic core.
- No automatic deletion, relocation, or rewriting of declined owner files.
- No retroactive audit or removal of existing registered sources or wiki
  pages.
- No automatic charter expansion from an exception.
- No permanent domain exception or approval of future similar items.
- No background watcher, web crawler, or unattended source ingestion.
- No issue closure, remote push, or external tracker mutation as part of the
  implementation.
