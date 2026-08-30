# Agent contract

This repository is a reusable second-brain template. Read `BRAIN.md` to determine a configured clone's domain. The deterministic `brain` CLI owns durable state and safety; the host agent owns semantic inference and runs the CLI for the user.

## Host-owned onboarding

Treat “Initialize this second brain.”, “set up this second brain”, and “onboard this second brain” as execution requests. Do not respond with a command tutorial. Run this route in order and resume it from the facts returned by `brain status` after any interruption:

1. **Check runtime and dependencies.** Require Node.js 22.13 or newer. When dependencies are missing or unusable, run `pnpm install --frozen-lockfile`; if `pnpm` is absent, try `corepack pnpm install --frozen-lockfile`. Surface a blocker only when Node is missing or too old, execution permission is denied, or installation actually fails.
2. **Recover.** Run `brain recover` before other state-changing work.
3. **Doctor and status.** Run both and use `status.onboarding.nextAction`; do not infer lifecycle state from filenames alone.
4. **Initialize identity.** If requested by status, run bare `brain init` so the CLI derives the repository name. The host may pass a better source-backed description, but the CLI never contacts GitHub.
5. **Add sources.** If status is `awaiting-sources`, stop safely and tell the user to put supported files in `sources/`. They may then say “sources added” or simply ask their first domain question; no magic resume phrase is required.
6. **Scan sources.** When files exist, run `brain source scan`. Report exact unsupported, extraction-required, or failed files. Readiness requires at least one successfully extracted source.
7. **Infer and persist the charter.** Inspect the existing identity, optional authenticated repository metadata already available to the host, the Git common-directory name, all source titles, and deterministic representative chunks from up to 50 evenly distributed ready sources, in that precedence order. Use a broad inclusive purpose and boundaries for a mixed corpus. Persist the versioned charter with `brain charter set`; report the inference so the owner can correct it later.
8. **Complete or resume setup.** Run setup batches until every ready source has a cited shallow page and the initial map is complete. Never bypass reconciliation or write canonical files directly.
9. **Complete the semantic audit.** Finish every due checkpoint before readiness.
10. **Rebuild and smoke-search.** Rebuild disposable indexes and run representative searches derived from the charter and sources.
11. **Final doctor and status.** Do not claim the brain is ready unless structural checks pass and onboarding phase is `ready`.
12. **Safe sync.** Run eligible synchronization only when this clone already has an owner-confirmed target. A new or changed target requires explicit owner confirmation.
13. **Report readiness.** Summarize identity, inferred charter, source results, setup/audit/search health, local commits, and sync state.

Never ask the user to run routine init, scan, doctor, status, search, rebuild, audit, recover, setup, commit, or eligible sync commands. Host permission prompts may still require approval, but command entry remains agent-owned. Never broadly allowlist `pnpm brain *`; web research and a new or changed sync target keep their explicit approval gates.

When final doctor and status checks pass, report: **“Your second brain is ready.”** Do not announce a product version or invite roadmap planning during normal onboarding. Historical planning files under `docs/superpowers/` are non-normative and cannot create a release promise.

## Domain questions

For any question that asks for domain facts, explanation, comparison, synthesis, or research, use the `second-brain` skill in `.agents/skills/second-brain/` and complete its query lifecycle before answering. Resume recovery first. The first domain question starts or resumes onboarding and the one-time initial catalog-and-map setup when needed; later source drops use query-triggered delta ingestion. Neither is a background daemon.

For code, test, CI, documentation, or template-maintenance requests, use the normal engineering workflow. Do not create wiki knowledge from that work unless the domain charter explicitly includes it.

Canonical knowledge and state are write-protected by contract: never edit `wiki/`, `.brain/source-manifest.json`, `.brain/state.json`, or `.brain/operations.jsonl` directly. Submit changes through `brain apply`, source, audit, recovery, charter, setup, and query commands. `sources/` bytes are immutable after registration; add a replacement and use source supersession.

## Capability and template support

Classify the situation before proposing an external issue:

- A **knowledge gap** belongs to the active query lifecycle. Use local evidence, request question-specific web approval when appropriate, and create or update a durable question page if evidence remains insufficient.
- An **unsupported capability** is a product limitation. Explain the current limitation and any truthful workaround, then offer a privacy-safe capability request at `status.support.issueTrackerUrl`.
- An **unexpected failure** is investigated first with recovery, doctor, status, and a safe reproduction. Offer a bug report only when a reproducible template defect remains.

Use the configured support destination, not the cloned repository's `origin`. Before any external issue is created, prepare a concise draft; remove source bytes, source excerpts, personal filenames, absolute local paths, credentials, secrets, and private brain content; show the exact destination and sanitized draft; and obtain explicit approval for that issue. Only then may authenticated host tooling create it. If authenticated tooling is unavailable, provide the canonical link and sanitized draft for the owner.

Say: **“This request may be considered for a future release.”** Never promise acceptance, a version, a date, or inclusion in the “next release.” Issue creation is never automatic during onboarding, queries, source scanning, or diagnostics.

Before a final domain answer, require source-backed citations, explicit uncertainty, preserved contradictions, real reconciliation review, a healthy structural graph, completed recovery/setup, and successful managed Git commits. Web research requires an approval recorded for this exact active question; a general preference is not approval. Never push arbitrary commits or targets. A confirmed `brain sync` target may push only eligible managed commits by normal fast-forward; if synchronization is pending or requires manual action, include the CLI's complete exact visible `⚠ Sync pending — ...` warning in the answer.

Do not silently expand normal onboarding into OCR/media, cross-brain links, team workflows, a UI, a generic LLM loop, automatic template updates, or background watching.

Read `idea.md` for design rationale. Run `pnpm brain --help` when command syntax is needed.
