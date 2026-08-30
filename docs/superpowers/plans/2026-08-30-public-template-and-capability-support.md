# Public Template and Capability Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task-by-task. Every
> behavioral step uses `superpowers:test-driven-development`. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give template users a minimal README, end onboarding without
user-facing version-roadmap language, and let hosts offer privacy-safe,
approval-gated capability requests at the original template's issue tracker.

**Architecture:** The deterministic core validates and exposes one canonical
HTTPS issue-tracker URL through configuration and status but never contacts
GitHub. `AGENTS.md` and the shared second-brain skill classify knowledge gaps,
capability gaps, and bugs; the host may create an external issue only after
approval for the exact sanitized draft. Public README copy stays deliberately
small while detailed release checks remain maintainer-only documentation.

**Tech Stack:** TypeScript ESM, pnpm 10.9, Node.js >=22.13, Zod, YAML, Vitest,
Markdown, GitHub Issue Forms.

**Spec:**
`docs/superpowers/specs/2026-08-30-public-template-and-capability-support-design.md`

## Global Constraints

- Do not add a GitHub client, issue-creation CLI command, telemetry, background
  reporter, updater, or roadmap service.
- `packages/core` and `packages/cli` validate and expose support metadata but
  never make network calls to GitHub.
- A host may create an external issue only after explicit approval for the
  exact destination and sanitized draft.
- Never put source bytes, source excerpts, personal filenames, absolute local
  paths, credentials, secrets, or private brain content into an issue without
  separate explicit disclosure approval.
- A knowledge/evidence gap remains a durable wiki question; it is not a
  software issue.
- An unsupported product capability may be proposed for consideration, but no
  version, date, acceptance, or next-release delivery may be promised.
- Internal public contracts remain version `1`: do not rename `BrainConfigV1`,
  change durable schema versions, or create a v2 schema.
- Existing configurations without `support` remain valid through a default.
- Existing zero-command onboarding, domain-query, recovery, reconciliation,
  web-approval, Git, and synchronization behavior remains unchanged.
- `CLAUDE.md` remains exactly `@AGENTS.md\n`.
- Do not introduce OpenClaw code or hosting behavior.
- Each implementation task starts with the smallest failing test, confirms the
  expected RED, implements only the required behavior, runs targeted tests and
  `pnpm verify:fast`, then commits the green slice.

---

### Task 1: Expose the canonical template issue tracker

**Files:**

- Modify: `packages/core/src/config.ts:1-104`
- Modify: `packages/core/src/status-read.ts:13-96`
- Modify: `packages/core/src/index.ts:1-4`
- Modify: `brain.config.yaml:1-42`
- Modify: `docs/configuration.md:1-95`
- Modify: `packages/core/test/config.test.ts:1-65`
- Modify: `packages/core/test/status-read.test.ts:1-55`
- Modify: `test/e2e/zero-command-onboarding.test.ts:343-520`
- Regenerate: `schemas/v1/BrainConfigV1.schema.json`

**Interfaces:**

- Consumes: existing `brainConfigV1Schema`, `BrainConfigV1`, `statusBrain`,
  `BrainStatusV1`, `initBrain`, and the zero-command onboarding fixture.
- Produces:

```ts
export const defaultIssueTrackerUrl =
  "https://github.com/ranjanrishikesh/second-brain/issues";

// Added to BrainConfigV1 by Zod inference.
support: {
  issueTrackerUrl: string;
};

// Added to BrainStatusV1 and `brain status --json`.
support: BrainConfigV1["support"];
```

- Compatibility: omitted `support` defaults to the canonical URL; a supplied
  value must be an absolute HTTPS URL. Initialization and charter changes
  preserve the configured section because they already spread existing config.

- [ ] **Step 1: Write failing configuration tests**

In `packages/core/test/config.test.ts`, extend the valid-config test and add an
HTTPS validation test:

```ts
expect(config.support).toEqual({
  issueTrackerUrl:
    "https://github.com/ranjanrishikesh/second-brain/issues",
});

test("accepts only an absolute HTTPS issue tracker URL", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-support-config-"));
  await writeFile(
    path.join(root, "brain.config.yaml"),
    [
      "version: 1",
      "brain:",
      "  name: Support test",
      "support:",
      "  issueTrackerUrl: http://example.test/issues",
      "",
    ].join("\n"),
  );

  await expect(loadBrainConfig(root)).rejects.toThrow(
    "support.issueTrackerUrl must be an absolute HTTPS URL",
  );

  await writeFile(
    path.join(root, "brain.config.yaml"),
    [
      "version: 1",
      "brain:",
      "  name: Support test",
      "support:",
      "  issueTrackerUrl: https://example.test/brain/issues",
      "",
    ].join("\n"),
  );

  await expect(loadBrainConfig(root)).resolves.toMatchObject({
    support: { issueTrackerUrl: "https://example.test/brain/issues" },
  });
});
```

- [ ] **Step 2: Write failing status and clone-lifecycle tests**

In `packages/core/test/status-read.test.ts`, add this assertion to the first
status test:

```ts
expect((await statusBrain(initializedEmptyRoot)).support).toEqual({
  issueTrackerUrl:
    "https://github.com/ranjanrishikesh/second-brain/issues",
});
```

In the installed-process onboarding test in
`test/e2e/zero-command-onboarding.test.ts`, assert that the URL survives the
template materializer and bare initialization:

```ts
expect(initialized.status).toMatchObject({
  support: {
    issueTrackerUrl:
      "https://github.com/ranjanrishikesh/second-brain/issues",
  },
  onboarding: {
    phase: "awaiting-sources",
    nextAction: "add-sources",
  },
});
```

- [ ] **Step 3: Run the focused tests and confirm RED**

Run:

```bash
pnpm exec vitest run packages/core/test/config.test.ts packages/core/test/status-read.test.ts test/e2e/zero-command-onboarding.test.ts
```

Expected: FAIL because `BrainConfigV1` and `BrainStatusV1` do not yet contain
`support`, and invalid HTTP configuration is currently accepted or stripped.

- [ ] **Step 4: Add the defaulted HTTPS configuration contract**

In `packages/core/src/config.ts`, add the exported constant and schema before
`brainConfigV1Schema`:

```ts
export const defaultIssueTrackerUrl =
  "https://github.com/ranjanrishikesh/second-brain/issues";

const absoluteHttpsUrlV1Schema = z
  .string()
  .url()
  .startsWith(
    "https://",
    "support.issueTrackerUrl must be an absolute HTTPS URL",
  );
```

Add this defaulted section to `brainConfigV1Schema` immediately after `brain`:

```ts
support: z
  .object({
    issueTrackerUrl: absoluteHttpsUrlV1Schema.default(defaultIssueTrackerUrl),
  })
  .default({ issueTrackerUrl: defaultIssueTrackerUrl }),
```

Export the constant from `packages/core/src/index.ts` alongside the other
configuration exports:

```ts
export {
  defaultIssueTrackerUrl,
  defaultSemanticModelV1,
} from "./config.js";
```

- [ ] **Step 5: Expose support metadata through status**

Import the config type in `packages/core/src/status-read.ts`:

```ts
import {
  loadBrainConfig,
  type BrainConfigV1,
} from "./config.js";
```

Add the field to `BrainStatusV1`:

```ts
support: BrainConfigV1["support"];
```

Add the value to the `statusBrain` result immediately after `brain`:

```ts
support: config.support,
```

No CLI action is needed: `brain status --json` already serializes the complete
status object.

- [ ] **Step 6: Put the canonical URL in the template configuration and reference**

Add this section after `brain` in `brain.config.yaml`:

```yaml
support:
  issueTrackerUrl: https://github.com/ranjanrishikesh/second-brain/issues
```

Add this section after “Version and identity” in `docs/configuration.md`:

```md
## Template support

- `support.issueTrackerUrl`: the canonical HTTPS issue tracker for the
  software template. The default points to the original second-brain template,
  not the cloned brain's `origin` remote.

The host may use this destination only after it has classified a product
capability gap or reproducible template defect, removed private brain data from
the draft, and received approval for the exact external issue. The core and CLI
never contact GitHub.
```

- [ ] **Step 7: Regenerate schemas and verify GREEN**

Run:

```bash
pnpm schemas:generate
pnpm exec vitest run packages/core/test/config.test.ts packages/core/test/status-read.test.ts test/e2e/zero-command-onboarding.test.ts
git diff -- schemas/v1/BrainConfigV1.schema.json
```

The last command is expected to report a diff before the generated schema is
staged; inspect it and confirm it adds only the defaulted `support` object and
HTTPS URL constraint. Then run:

```bash
pnpm verify:fast
```

Expected: all commands pass; legacy minimal configurations load with the
default, invalid HTTP values fail, and installed zero-command status exposes
the original template tracker.

- [ ] **Step 8: Commit the support contract**

```bash
git add brain.config.yaml docs/configuration.md docs/superpowers/specs/2026-08-30-public-template-and-capability-support-design.md docs/superpowers/plans/2026-08-30-public-template-and-capability-support.md packages/core/src/config.ts packages/core/src/index.ts packages/core/src/status-read.ts packages/core/test/config.test.ts packages/core/test/status-read.test.ts test/e2e/zero-command-onboarding.test.ts schemas/v1/BrainConfigV1.schema.json
git commit -m "feat: expose canonical template support destination"
```

---

### Task 2: Add approval-gated capability reporting to the host contract

**Files:**

- Modify: `AGENTS.md:1-39`
- Modify: `.agents/skills/second-brain/SKILL.md:1-126`
- Modify: `packages/core/test/host-contract.test.ts:1-102`
- Create: `.github/ISSUE_TEMPLATE/capability-request.yml`

**Interfaces:**

- Consumes: `brain status --json` field
  `support.issueTrackerUrl`, existing query-gap behavior, existing per-question
  web approval, and existing owner-confirmed sync approval.
- Produces: a shared host-only decision contract with three classifications:
  `knowledge gap`, `unsupported capability`, and `unexpected failure`.
- External effect: after approval, authenticated Codex or Claude host tooling
  may create the exact sanitized issue; the brain CLI remains uninvolved.

- [ ] **Step 1: Write the failing active-contract tests**

Add these tests to `packages/core/test/host-contract.test.ts`:

```ts
it.each(["AGENTS.md", ".agents/skills/second-brain/SKILL.md"])(
  "%s separates knowledge gaps, capability gaps, and unexpected failures",
  async (path) => {
    const contract = await readRepositoryFile(path);

    for (const marker of [
      "knowledge gap",
      "unsupported capability",
      "unexpected failure",
      "support.issueTrackerUrl",
      "privacy-safe",
      "explicit approval",
      "may be considered for a future release",
    ]) {
      expect(contract).toContain(marker);
    }

    expect(contract).toContain("Your second brain is ready.");
    expect(contract).toContain("Never promise");
    expect(contract).not.toMatch(/\bv2\b/iu);
    expect(contract).not.toMatch(/shall we plan/iu);
  },
);

it.each(["AGENTS.md", ".agents/skills/second-brain/SKILL.md"])(
  "%s keeps external issue creation owner-approved and private",
  async (path) => {
    const contract = await readRepositoryFile(path);

    for (const forbiddenDisclosure of [
      "source bytes",
      "source excerpts",
      "personal filenames",
      "absolute local paths",
      "credentials",
      "private brain content",
    ]) {
      expect(contract).toContain(forbiddenDisclosure);
    }

    expect(contract).toContain("exact destination and sanitized draft");
    expect(contract).toContain("authenticated host tooling");
    expect(contract).toContain("not the cloned repository's `origin`");
  },
);
```

- [ ] **Step 2: Write the failing issue-form test**

Import `parse` from `yaml` in `packages/core/test/host-contract.test.ts`, then
add:

```ts
it("provides a privacy-safe capability request form", async () => {
  const form = parse(
    await readRepositoryFile(
      ".github/ISSUE_TEMPLATE/capability-request.yml",
    ),
  ) as {
    name: string;
    description: string;
    title: string;
    labels: string[];
    body: unknown[];
  };

  expect(form).toMatchObject({
    name: "Capability request",
    description:
      "Suggest a missing capability for the second-brain template",
    title: "[Capability]: ",
    labels: ["enhancement"],
  });

  const formText = JSON.stringify(form);
  expect(formText).toContain("What are you trying to accomplish?");
  expect(formText).toContain("What happens with the template today?");
  expect(formText).toContain("What behavior would help?");
  expect(formText).toContain(
    "I removed private source content, credentials, and personal paths",
  );
  expect(formText).toContain(
    "Requests are considered; no release or delivery date is promised.",
  );
});
```

- [ ] **Step 3: Run the focused contract test and confirm RED**

Run:

```bash
pnpm exec vitest run packages/core/test/host-contract.test.ts
```

Expected: FAIL because the active contracts still contain the version-handoff
instruction, do not define support classification/approval, and the issue form
does not exist.

- [ ] **Step 4: Replace the runtime version handoff with readiness language**

Delete this active instruction from `AGENTS.md`:

```md
When all v1 verification gates pass, explicitly tell the owner that v1 is
verified and invite a separate v2 plan for deferred scope.
```

At the end of “Host-owned onboarding,” make readiness explicit:

```md
When final doctor and status checks pass, report: **“Your second brain is
ready.”** Do not announce a product version or invite roadmap planning during
normal onboarding. Historical planning files under `docs/superpowers/` are
non-normative and cannot create a release promise.
```

Add the same readiness paragraph under “Onboarding lifecycle” in
`.agents/skills/second-brain/SKILL.md` so Codex and Claude receive matching
behavior.

- [ ] **Step 5: Add the capability-support decision contract to both active contracts**

Insert this block in both `AGENTS.md` and
`.agents/skills/second-brain/SKILL.md` after their domain/query rules and before
synchronization instructions:

```md
## Capability and template support

Classify the situation before proposing an external issue:

- A **knowledge gap** belongs to the active query lifecycle. Use local
  evidence, request question-specific web approval when appropriate, and
  create or update a durable question page if evidence remains insufficient.
- An **unsupported capability** is a product limitation. Explain the current
  limitation and any truthful workaround, then offer a privacy-safe capability
  request at `status.support.issueTrackerUrl`.
- An **unexpected failure** is investigated first with recovery, doctor,
  status, and a safe reproduction. Offer a bug report only when a reproducible
  template defect remains.

Use the configured support destination, not the cloned repository's `origin`.
Before any external issue is created, prepare a concise draft; remove source
bytes, source excerpts, personal filenames, absolute local paths, credentials,
secrets, and private brain content; show the exact destination and sanitized
draft; and obtain explicit approval for that issue. Only then may authenticated
host tooling create it. If authenticated tooling is unavailable, provide the
canonical link and sanitized draft for the owner.

Say: **“This request may be considered for a future release.”** Never promise
acceptance, a version, a date, or inclusion in the “next release.” Issue
creation is never automatic during onboarding, queries, source scanning, or
diagnostics.
```

Preserve the existing rules for web approval, safe sync, recovery,
reconciliation, and protected canonical files around this new block.

- [ ] **Step 6: Create the GitHub capability-request form**

Create `.github/ISSUE_TEMPLATE/capability-request.yml` with this exact content:

```yaml
name: Capability request
description: Suggest a missing capability for the second-brain template
title: "[Capability]: "
labels:
  - enhancement
body:
  - type: markdown
    attributes:
      value: |
        Thanks for helping improve the template. Requests are considered; no release or delivery date is promised.
  - type: dropdown
    id: capability-area
    attributes:
      label: Capability area
      options:
        - Source format or extraction
        - Knowledge graph or reconciliation
        - Agent workflow
        - Search or retrieval
        - Synchronization or portability
        - Other
    validations:
      required: true
  - type: textarea
    id: use-case
    attributes:
      label: What are you trying to accomplish?
      description: Describe the outcome without including private brain content.
    validations:
      required: true
  - type: textarea
    id: current-behavior
    attributes:
      label: What happens with the template today?
      description: Include non-sensitive diagnostics or an exact public reproduction when available.
    validations:
      required: true
  - type: textarea
    id: expected-behavior
    attributes:
      label: What behavior would help?
    validations:
      required: true
  - type: checkboxes
    id: privacy
    attributes:
      label: Privacy check
      options:
        - label: I removed private source content, credentials, and personal paths
          required: true
```

- [ ] **Step 7: Run focused and fast verification**

Run:

```bash
pnpm exec vitest run packages/core/test/host-contract.test.ts
pnpm verify:fast
```

Expected: all tests pass; both hosts receive the same classification,
privacy, approval, destination, non-promise, and readiness contract.

- [ ] **Step 8: Commit the host support flow**

```bash
git add AGENTS.md .agents/skills/second-brain/SKILL.md .github/ISSUE_TEMPLATE/capability-request.yml packages/core/test/host-contract.test.ts
git commit -m "docs: add approval-gated capability support flow"
```

---

### Task 3: Replace the public README and make release verification maintainer-only

**Files:**

- Replace: `README.md`
- Rename: `docs/V1_EXIT_CHECKLIST.md` to
  `docs/maintainers/template-release-checklist.md`
- Modify: `docs/onboarding.md:46-48`
- Modify: `docs/superpowers/specs/2026-08-27-v1-knowledge-workflow-hardening-design.md:1-5`
- Modify: `docs/superpowers/plans/2026-08-27-v1-knowledge-workflow-hardening.md:1-5`
- Modify: `docs/superpowers/plans/2026-08-29-zero-command-agent-onboarding.md:1-5`
- Modify: `packages/core/test/host-contract.test.ts:70-102`

**Interfaces:**

- Consumes: the zero-command onboarding phrase, current supported input list,
  the original Karpathy Gist URL, and the live Codex/Claude smoke procedures.
- Produces: a README with exactly three `##` sections; a maintainer-only
  release checklist; explicit historical supersession notices.
- Does not change: runtime schemas, onboarding mechanics, supported formats,
  query behavior, or the contents of the detailed Codex/Claude smoke steps.

- [ ] **Step 1: Replace the old README-order test with a failing public-scope test**

In `packages/core/test/host-contract.test.ts`, replace
`"documents the zero-command path before manual CLI reference"` with:

```ts
it("keeps the public README limited to use, behavior, and inspiration", async () => {
  const readme = await readRepositoryFile("README.md");
  const headings = readme.match(/^## .+$/gmu) ?? [];

  expect(headings).toEqual([
    "## What you need to do",
    "## How it works",
    "## Original idea",
  ]);
  expect(readme).toContain("Initialize this second brain.");
  expect(readme).toContain("`sources/`");
  expect(readme).toContain("wiki → raw sources → approved web research");
  expect(readme).toContain(
    "[Andrej Karpathy's original LLM Wiki idea](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)",
  );
  expect(readme.trim().split(/\s+/u).length).toBeLessThanOrEqual(300);

  for (const outOfScopeCopy of [
    "manual cli",
    "pnpm ",
    "repository map",
    "development",
    "v1",
    "v2",
  ]) {
    expect(readme.toLowerCase()).not.toContain(outOfScopeCopy);
  }
});
```

- [ ] **Step 2: Update the checklist tests and confirm active surfaces have no roadmap prompt**

Change the live-smoke test to read the renamed maintainer file, then add:

```ts
it("keeps release verification internal and roadmap-neutral", async () => {
  const checklist = await readRepositoryFile(
    "docs/maintainers/template-release-checklist.md",
  );
  expect(checklist).toContain("Template release verification checklist");
  expect(checklist).toContain("maintainers");
  expect(checklist).toContain("Your second brain is ready.");
  expect(checklist).not.toMatch(/\bv2\b/iu);
  expect(checklist).not.toMatch(/shall we plan/iu);

  for (const activePath of [
    "README.md",
    "AGENTS.md",
    ".agents/skills/second-brain/SKILL.md",
    "docs/onboarding.md",
    "docs/maintainers/template-release-checklist.md",
  ]) {
    expect(await readRepositoryFile(activePath)).not.toMatch(/\bv2\b/iu);
  }
});

it.each([
  "docs/superpowers/specs/2026-08-27-v1-knowledge-workflow-hardening-design.md",
  "docs/superpowers/plans/2026-08-27-v1-knowledge-workflow-hardening.md",
  "docs/superpowers/plans/2026-08-29-zero-command-agent-onboarding.md",
])("marks %s as a non-normative historical record", async (path) => {
  const document = await readRepositoryFile(path);
  expect(document).toContain("Historical record");
  expect(document).toContain(
    "2026-08-30-public-template-and-capability-support-design.md",
  );
});
```

- [ ] **Step 3: Run the host-contract test and confirm RED**

Run:

```bash
pnpm exec vitest run packages/core/test/host-contract.test.ts
```

Expected: FAIL because the README has extra sections, the maintainer path does
not exist, the old checklist commands a version handoff, and historical files
lack supersession notices.

- [ ] **Step 4: Replace README.md with the approved minimal copy**

Replace the complete file with:

```md
# Portable Self-Maintaining Second Brain

Turn your source files and questions into a cited, interconnected Markdown wiki
maintained by Codex or Claude Code.

## What you need to do

1. Select **Use this template** on GitHub and create a new repository. Make it
   private when your sources should not be public.
2. Open the new repository root in Codex or Claude Code.
3. Say **“Initialize this second brain.”**
4. When asked, add text-based PDF, DOCX, Markdown, text, HTML, EPUB, JSON/JSONL,
   CSV, or TSV files to `sources/`.
5. Ask questions normally. The agent runs routine setup and maintenance
   commands for you; you only approve question-specific web research and a new
   synchronization target when either is needed.

## How it works

Initialization registers your source files as immutable evidence and builds a
shallow, cited page for every usable source plus an initial relationship map.
Each question then follows:

`wiki → raw sources → approved web research → cited wiki update`

If the wiki already supports the answer, the agent uses it without creating a
duplicate page. Otherwise it reads the raw sources, or asks before researching
the web, and saves reusable knowledge with citations and meaningful links. It
reconciles the affected graph, validates it, and commits the managed changes.
The wiki becomes deeper and more interconnected as you ask questions.

## Original idea

This project implements [Andrej Karpathy's original LLM Wiki idea](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f):
use an LLM to build and maintain a persistent wiki that compounds instead of
re-deriving the same knowledge from raw documents for every question.
```

- [ ] **Step 5: Rename and neutralize the maintainer release checklist**

Create the directory and rename the file with Git history preserved:

```bash
mkdir -p docs/maintainers
git mv docs/V1_EXIT_CHECKLIST.md docs/maintainers/template-release-checklist.md
```

Change its title and opening paragraph to:

```md
# Template release verification checklist

This checklist is for template maintainers. A feature is not release-verified
because it appeared to work once: record the deterministic template gate and
separate Codex and Claude Code live smokes with their commands, date, commit,
and environment in the release note or pull request. This file is not a cloned
brain onboarding instruction and does not announce a product roadmap.
```

Keep the existing deterministic, Codex, and Claude smoke procedures, but
replace the final “Explicit v2 handoff” section with:

```md
## 4. Release closeout

After every gate above passes, record the verified commit, date, environments,
and results for maintainers. Normal cloned-brain onboarding ends with:
**“Your second brain is ready.”** Do not announce or promise another version,
roadmap item, delivery date, or next-release inclusion.
```

- [ ] **Step 6: Update active documentation and mark old planning records as historical**

Replace the final paragraph of `docs/onboarding.md` with:

```md
For command-level troubleshooting, run `pnpm brain --help` or ask the host
agent to inspect the failing phase. The [recovery guide](recovery.md) documents
canonical safety behavior; the
[maintainer release checklist](maintainers/template-release-checklist.md)
separates deterministic verification from real Codex and Claude live smokes.
```

Immediately below the title of each historical plan/spec listed in this task,
insert this notice. Use `../specs/...` from files under `plans/`, and the bare
filename from the older spec in `specs/`:

```md
> **Historical record:** User-facing version and roadmap handoff language in
> this document is superseded by
> [Public Template and Capability Support Design](../specs/2026-08-30-public-template-and-capability-support-design.md).
> Active hosts follow `AGENTS.md` and the second-brain skill; this file is not
> a runtime instruction or release promise.
```

For
`docs/superpowers/specs/2026-08-27-v1-knowledge-workflow-hardening-design.md`,
use this same-directory link instead:

```md
[Public Template and Capability Support Design](2026-08-30-public-template-and-capability-support-design.md)
```

- [ ] **Step 7: Run focused and fast verification**

Run:

```bash
pnpm exec vitest run packages/core/test/host-contract.test.ts
pnpm format:check
pnpm verify:fast
```

Expected: the README has exactly the three approved sections and direct Gist
link; active user/host surfaces contain no roadmap handoff; maintainers retain
the complete live-smoke procedure under the renamed path.

- [ ] **Step 8: Commit the public documentation contract**

```bash
git add README.md docs/onboarding.md docs/maintainers/template-release-checklist.md docs/superpowers/specs/2026-08-27-v1-knowledge-workflow-hardening-design.md docs/superpowers/plans/2026-08-27-v1-knowledge-workflow-hardening.md docs/superpowers/plans/2026-08-29-zero-command-agent-onboarding.md packages/core/test/host-contract.test.ts
git commit -m "docs: simplify public second-brain guidance"
```

---

## Final Verification and Review

- [ ] Confirm active surfaces do not contain the retired roadmap prompt:

```bash
grep -RniE '\bv2\b|shall we plan|invite.*roadmap' README.md AGENTS.md .agents/skills/second-brain/SKILL.md docs/onboarding.md docs/maintainers || true
```

Expected: no matches. Internal schema names such as `BrainConfigV1` and
historical planning records are intentionally outside this active-surface scan.

- [ ] Run the complete verification suite:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
pnpm schemas:generate
git diff --exit-code -- schemas
pnpm brain doctor
pnpm brain audit
```

Expected: all commands exit zero. On the untouched template, doctor may print
the established non-fatal onboarding warnings; audit must remain structurally
healthy.

- [ ] Run a disposable derived-brain acceptance check:

1. Create a new repository from the updated template.
2. Open it in Codex and say only `Initialize this second brain.`
3. Confirm the empty-source pause, then add one text PDF and one DOCX.
4. Resume and confirm the final message is `Your second brain is ready.` with
   no product-version or roadmap invitation.
5. Ask for an unsupported capability such as OCR. Confirm the host explains
   the limitation, reads the original template issue tracker from status,
   prepares a sanitized draft, and waits for approval before any external
   write.
6. Deny the issue once and confirm nothing external is created. Repeat, approve
   a privacy-safe draft, and confirm the issue goes to
   `ranjanrishikesh/second-brain`, not the derived brain's `origin`.
7. Ask an unanswerable domain question and confirm it creates a durable
   knowledge gap rather than offering a GitHub issue.

- [ ] Use `superpowers:verification-before-completion`, then
  `superpowers:requesting-code-review`. Resolve every Critical or Important
  finding and rerun the affected tests plus the complete verification suite.

- [ ] Record the final commit and evidence in the pull request. Do not merge or
  create external issues without the owner's separate approval.
