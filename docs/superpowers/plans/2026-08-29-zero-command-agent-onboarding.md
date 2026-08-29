# Zero-Command Agent Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Every behavioral slice uses `superpowers:test-driven-development`.

**Goal:** Let a user clone the template, open it in Codex or Claude Code, say “initialize this second brain,” add sources when requested, and have the agent run every routine CLI operation through readiness.

**Architecture:** `AGENTS.md` remains the canonical host contract and `CLAUDE.md` imports it. The host agent performs semantic work and invokes the deterministic CLI; the CLI owns initialization, charter persistence, source registration, setup, validation, recovery, commits, and safe synchronization.

**Tech stack:** TypeScript ESM, pnpm 10.9, Node ≥22.13, Commander, Zod, Vitest, Git-backed canonical transactions.

**Plan artifact:** `docs/superpowers/plans/2026-08-29-zero-command-agent-onboarding.md`

**Spec:** Existing workflow design in `docs/superpowers/specs/2026-08-27-v1-knowledge-workflow-hardening-design.md`, amended by the approved zero-command onboarding decisions captured here.

## Global constraints

- No OpenClaw, background watcher, generic LLM loop, custom chat UI, or automatic template updater.
- The user never runs routine `brain` commands; Codex or Claude Code runs them.
- The CLI never performs semantic inference or contacts GitHub. The host may read repository metadata when available and passes its inference to the CLI.
- Web research and sync-target confirmation retain their existing user-approval gates.
- Initial setup requires at least one successfully extracted source; an empty or unusable source set pauses onboarding.
- Existing explicit `brain init --name … --description …` usage remains compatible.
- Legacy configured `BRAIN.md` files remain valid; the unchanged template placeholder remains invalid.
- Source, wiki, citation, reconciliation, audit, and query formats remain v1-compatible.
- Every green slice runs its targeted tests, then `pnpm verify:fast`, and is committed before the next slice.

## Public interfaces

Add these versioned contracts:

```ts
type OnboardingPhaseV1 =
  | "needs-initialization"
  | "awaiting-sources"
  | "sources-unregistered"
  | "sources-blocked"
  | "awaiting-charter"
  | "ready-for-setup"
  | "setup-in-progress"
  | "ready";

type OnboardingNextActionV1 =
  | "initialize"
  | "add-sources"
  | "scan-sources"
  | "resolve-source-errors"
  | "set-charter"
  | "begin-setup"
  | "resume-setup"
  | "ask-question";

interface BrainCharterV1 {
  version: 1;
  description: string;
  purpose: string;
  boundaries: string[];
  domainConventions: string[];
  evidencePreferences: string[];
  origin: "inferred" | "owner-specified";
}

interface OnboardingStatusV1 {
  version: 1;
  phase: OnboardingPhaseV1;
  nextAction: OnboardingNextActionV1;
  identity: {
    template: boolean;
    name: string;
    description: string;
    suggestedName: string;
  };
  charter: {
    configured: boolean;
    origin: "pending" | "inferred" | "owner-specified" | "legacy";
  };
  sourceFiles: {
    discovered: number;
    supportedCandidates: number;
    unsupportedCandidates: number;
    registered: number;
    ready: number;
    unsupported: number;
    extractionRequired: number;
    failed: number;
    samplePaths: string[];
  };
  setup: {
    status: "not-started" | "in-progress" | "completed";
  };
}
```

Extend `BrainStatusV1` with `onboarding: OnboardingStatusV1`.

Change initialization to:

```ts
interface InitBrainOptions {
  name?: string;
  description?: string;
}

async function initBrain(
  root: string,
  options?: InitBrainOptions,
  testOptions?: TransactionTestOptions,
): Promise<InitBrainResultV1>;
```

Add:

```ts
async function inspectOnboarding(root: string): Promise<OnboardingStatusV1>;

async function setBrainCharter(
  root: string,
  charter: BrainCharterV1,
  testOptions?: TransactionTestOptions,
): Promise<BrainCharterResultV1>;
```

CLI changes:

```text
brain init [--name <name>] [--description <description>] [--json]
brain charter set <charter-json-file> [--json]
brain status [--json]
```

`brain init` without flags derives the name from the Git common-directory repository name, falling back to the root directory. Its provisional description is `A source-backed knowledge brain for <name>.`

## TDD implementation tasks

### Task 1: Read-only onboarding status

**Files:** create `packages/core/src/onboarding.ts`; update source-format classification, status exports, public schemas, and their focused tests.

- [ ] Write failing tests proving:

```ts
expect((await inspectOnboarding(templateRoot)).phase)
  .toBe("needs-initialization");

expect((await inspectOnboarding(initializedEmptyRoot))).toMatchObject({
  phase: "awaiting-sources",
  nextAction: "add-sources",
  sourceFiles: { discovered: 0, registered: 0 },
});
```

Also cover pre-added PDF/DOCX files, ignored dotfiles, registered-but-unusable sources, pending charter, in-progress setup, completed setup, and legacy charters.

- [ ] Run:

```bash
pnpm exec vitest run packages/core/test/status-read.test.ts packages/core/test/public-schemas.test.ts packages/core/test/json-schemas.test.ts
```

Expected: failures for missing onboarding contracts and status.

- [ ] Implement a read-only source-directory inspection that shares the supported-extension classifier with source scanning, returns counts plus at most 20 sorted sample paths, and never hashes, extracts, registers, or writes cache files.
- [ ] Export `BrainCharterV1` and `OnboardingStatusV1`, add their JSON schemas, and include onboarding in `statusBrain`.
- [ ] Run targeted tests, `pnpm schemas:generate`, `pnpm verify:fast`, and commit:

```text
feat: add deterministic onboarding status
```

### Task 2: Managed zero-argument initialization

**Files:** update initialization, canonical transaction/recovery, managed-sync allowlists, and their tests.

- [ ] Write failing tests proving:

```ts
const result = await initBrain(clonedWorktree);
expect(result).toMatchObject({
  mode: "template-replaced",
  name: "Second Brain Smoke",
});
expect(await gitHeadMessage(clonedWorktree)).toContain("Brain-Managed: true");
```

Cover explicit overrides, idempotent reruns, Git worktrees whose checkout folder has a Conductor codename, non-Git roots, staged-change refusal, unrelated dirty-file preservation, crash recovery, and accidental populated-brain rename refusal.

- [ ] Run:

```bash
pnpm exec vitest run packages/core/test/config.test.ts packages/core/test/transaction.test.ts packages/core/test/sync.test.ts
```

Expected: zero-argument initialization and managed identity commit tests fail.

- [ ] Derive the local repository name from `git rev-parse --git-common-dir`; use the root basename only when unavailable. Do not call GitHub or require authentication.
- [ ] Generalize canonical transactions with a journaled `managedRootPaths` option so identity operations can safely snapshot, seal, stage, restore, and commit only `BRAIN.md` and `brain.config.yaml` in addition to their exact wiki/state outputs. Old recovery journals default to the legacy snapshot set.
- [ ] Record an `identity` operation, commit the identity with the normal private-index/HEAD protections, and allow identity files in safe managed synchronization. Same-identity reruns create no operation or commit.
- [ ] Run targeted tests, `pnpm verify:fast`, and commit:

```text
feat: add managed repository-derived initialization
```

### Task 3: CLI-managed source-informed charter

**Files:** update onboarding/core exports, setup charter validation, transaction operation records, and focused tests.

- [ ] Write failing tests for a valid inferred charter:

```ts
const result = await setBrainCharter(root, {
  version: 1,
  description: "Astronomy observations and orbital mechanics.",
  purpose: "Answer source-backed astronomy questions.",
  boundaries: ["Include all registered astronomy sources."],
  domainConventions: ["Preserve standard astronomical terminology."],
  evidencePreferences: ["Prefer primary sources and explicit citations."],
  origin: "inferred",
});

expect(await readFile(join(root, "BRAIN.md"), "utf8"))
  .toContain("brainCharter: 1");
expect((await loadBrainConfig(root)).brain.description)
  .toBe("Astronomy observations and orbital mechanics.");
```

Also reject malformed input, no ready source, template identity, setup already started, dirty managed paths, and simulated crashes without changing canonical state or HEAD.

- [ ] Run the focused onboarding/setup/transaction tests and confirm the expected failures.
- [ ] Render `BRAIN.md` deterministically with YAML frontmatter containing `brainCharter: 1` and `origin`, followed by name, description, purpose, boundaries, conventions, and evidence preferences.
- [ ] Update `brain.config.yaml` description in the same canonical transaction, append a `charter` operation/log entry, commit safely, and return commit/sync status.
- [ ] Centralize charter readiness: new frontmatter is authoritative; legacy non-placeholder charters are `legacy`; template or provisional markers are pending.
- [ ] Run targeted tests, `pnpm verify:fast`, and commit:

```text
feat: add CLI-managed brain charters
```

### Task 4: Onboarding gates, diagnostics, and resumability

**Files:** update setup, doctor/status behavior, and tests.

- [ ] Replace the current “empty setup succeeds” test with failures requiring at least one registered `ready` source. Cover unsupported-only, extraction-required-only, mixed ready/unusable, and sources added while setup is in progress.
- [ ] Add doctor warnings:

```text
IDENTITY_TEMPLATE
SOURCES_EMPTY
SOURCES_UNREGISTERED
SOURCES_NOT_READY
CHARTER_PENDING
SETUP_INCOMPLETE
```

Warnings keep `DoctorReport.ok === true`; structural, immutable-source, state, transaction, and lock errors remain fatal.

- [ ] Ensure phase derivation is resumable from canonical facts:

```text
template identity → needs-initialization
initialized + empty → awaiting-sources
files present + no manifest → sources-unregistered
registered + no ready extraction → sources-blocked
ready sources + pending charter → awaiting-charter
configured charter → ready-for-setup
active setup → setup-in-progress
completed setup → ready
```

- [ ] Confirm first-question setup and later delta ingestion still use the existing setup/query state machines.
- [ ] Run targeted setup, doctor, query, and status tests; then `pnpm verify:fast`.
- [ ] Commit:

```text
feat: enforce onboarding readiness gates
```

### Task 5: Agent-facing CLI surface

**Files:** update the CLI program and CLI tests.

- [ ] Write failing CLI tests proving bare `brain init`, explicit overrides, JSON output, `brain charter set`, onboarding-aware human status, and visible doctor warnings.
- [ ] Implement:

```text
brain init
brain init --name "Physics" --description "..."
brain init --json
brain charter set .brain/runtime/charter.json --json
brain status --json
```

The JSON form of `brain init` returns `{ initialization, status }`; `status` includes the deterministic next action.

- [ ] When doctor has warnings but no errors, print the warnings followed by `Brain is healthy with warnings.` and exit zero.
- [ ] Preserve all existing CLI commands and machine-readable outputs.
- [ ] Run `packages/cli/test/cli.test.ts`, then `pnpm verify:fast`.
- [ ] Commit:

```text
feat: expose zero-command onboarding CLI
```

### Task 6: Shared Codex/Claude execution contract

**Files:** update `AGENTS.md`, `CLAUDE.md`, the second-brain skill, README/onboarding documentation, and host-contract tests.

- [ ] Add a failing contract test requiring `CLAUDE.md` to import `AGENTS.md`, the initialization trigger to exist, and routine commands never to be delegated to the user.
- [ ] Make `CLAUDE.md` contain only:

```md
@AGENTS.md
```

- [ ] Add an explicit `initialize`, `set up`, or `onboard this second brain` route to `AGENTS.md` and the skill:

```text
check runtime/dependencies
→ recover
→ doctor/status
→ initialize identity if needed
→ stop with add-sources guidance when empty
→ scan sources when present
→ infer and persist charter
→ complete/resume setup batches
→ complete semantic audit
→ rebuild and smoke-search
→ final doctor/status
→ safe sync if already confirmed
→ report readiness
```

- [ ] Require the agent to install dependencies itself with `pnpm install --frozen-lockfile` when needed. If pnpm is absent, try `corepack pnpm`; only surface a blocker when Node is missing/too old, execution permission is denied, or installation fails.
- [ ] Define inference precedence: existing identity, optional authenticated repository metadata, Git common-directory name, all source titles, and deterministic representative chunks from up to 50 evenly distributed ready sources. Mixed corpora receive a broad inclusive charter rather than silent exclusions.
- [ ] If sources are absent, tell the user to add supported files and then either say “sources added” or ask the first question. No magic resume phrase is required.
- [ ] Never ask the user to run routine init, scan, doctor, status, search, rebuild, audit, recovery, setup, commit, or eligible sync commands.
- [ ] Keep web approval and new sync-target confirmation as explicit user gates; never allowlist all `pnpm brain *` commands in host permission settings.
- [ ] Simplify README onboarding to clone → open in Codex/Claude → say “initialize this second brain” → add sources. Move manual CLI examples to troubleshooting/reference.
- [ ] Run the contract test and `pnpm verify:fast`, then commit:

```text
docs: add shared zero-command agent onboarding
```

### Task 7: End-to-end and live-host verification

**Files:** add a zero-command onboarding E2E test and update the v1 exit checklist.

- [ ] Add a deterministic fake-host E2E covering:

  - Empty clone initializes identity and pauses without starting setup.
  - A new process/session resumes after PDF and DOCX files are added.
  - Source scanning reports ready, unsupported, and extraction-required files.
  - The fake host writes an inferred charter through the CLI.
  - Every ready source receives a cited shallow page and the map is built.
  - Semantic audit, rebuild, representative search, doctor, and final status complete.
  - Final phase is `ready`; setup is completed; Git contains managed identity, source, charter, setup, and audit commits.
  - Pre-added sources skip the waiting response.
  - Repeated initialization is idempotent.
  - Interruptions after identity, source registration, charter persistence, and setup checkpoint resume from the correct next action.
  - Unrelated worktree edits survive.
  - Confirmed safe sync can push identity/charter commits; an unconfirmed or mismatched destination cannot.

- [ ] Run:

```bash
pnpm exec vitest run test/e2e/zero-command-onboarding.test.ts
pnpm test:e2e
pnpm verify
pnpm schemas:generate
git diff --exit-code -- schemas
pnpm brain doctor
```

- [ ] Update live-smoke instructions to start from a disposable pristine clone and use only this prompt:

```text
Initialize this second brain.
```

Test once with empty `sources/`, resume after adding PDF/DOCX material, then repeat in Claude Code while confirming `CLAUDE.md` imported `AGENTS.md`.

- [ ] Record any unavailable live host as an explicit verification blocker; never infer Claude success from Codex success.
- [ ] Use `superpowers:verification-before-completion`, then `superpowers:requesting-code-review`.
- [ ] Commit:

```text
test: verify zero-command onboarding end to end
```

## Acceptance criteria

- A fresh clone requires no user-entered CLI commands.
- Codex and Claude Code both recognize natural-language initialization requests.
- Dependency installation is attempted by the agent and only genuine environment blockers reach the user.
- Repository identity is derived without requiring GitHub access.
- Empty sources produce clear add-source guidance and resumable state.
- Pre-existing sources continue automatically without a questionnaire.
- Purpose, boundaries, conventions, and evidence preferences are inferred, persisted, committed, and shown to the user.
- No setup can finish without at least one ready extracted source.
- Doctor, status, setup, audit, rebuild, search smoke, commit, and eligible sync are performed at the correct lifecycle stages.
- Critical state changes remain CLI-enforced and recoverable.
- `CLAUDE.md` and Codex cannot drift because Claude imports the canonical `AGENTS.md`.
- Existing explicit initialization and configured legacy brains continue to work.
- No background process, OpenClaw code, automatic remote confirmation, or automatic template upgrade is introduced.

## Assumptions and defaults

- The common path requires only cloning, opening the repository, adding sources, and speaking naturally.
- Host permission prompts may still require approval, but the user is never asked to type the command.
- The core never depends on `gh`; repository descriptions are optional host-provided input.
- If metadata and sources remain ambiguous, the agent uses an inclusive source-backed charter and reports the inference for later correction.
- A scanned PDF or otherwise unusable corpus blocks readiness with exact file-level diagnostics.
- Setup invoked explicitly during onboarding completes immediately after sources and charter are ready; the first domain question remains a fallback trigger when onboarding was not explicitly requested.
- Template changes do not propagate automatically to existing brains; that remains deferred.
- Baseline targeted initialization/setup/status/CLI tests currently pass: 41/41.
