# Public Template and Capability Support Design

## Summary

The template needs a simpler public face and a clearer boundary between a
configured brain and the software project that powers it.

- `README.md` serves only three purposes: tell an owner what to do, explain
  how the brain works, and link directly to Andrej Karpathy's original LLM
  Wiki idea.
- Normal onboarding ends with “Your second brain is ready.” It never announces
  a product version, invites a v2 plan, or implies that a future release is
  promised.
- Internal schema identifiers such as `BrainConfigV1` and `version: 1` remain
  unchanged because they are compatibility contracts, not roadmap messages.
- When an owner asks for a capability the template does not support, the host
  distinguishes that product limitation from a missing knowledge answer and
  offers an approval-gated, privacy-safe issue at the original template's
  canonical issue tracker.

## Public README contract

`README.md` has one title and exactly three user-facing sections:

1. **Start your second brain** — use the GitHub template, open the new
   repository in Codex or Claude Code, say “Initialize this second brain,” add
   supported source files when asked, and then ask questions normally.
2. **How it works** — immutable sources, an initially shallow cited catalog,
   wiki-first answers, raw-source fallback, approval-gated web research,
   durable cited updates, graph reconciliation, and managed local commits.
3. **Original idea** — a prominent Markdown link to
   `https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f`.

The README contains no manual CLI reference, development instructions,
verification checklist, architecture inventory, v1/v2 handoff, roadmap, or
future-release promise. Detailed operational and maintainer material stays in
`docs/`.

## Runtime readiness language

The active host contracts are `AGENTS.md` and
`.agents/skills/second-brain/SKILL.md`; `CLAUDE.md` continues to import
`AGENTS.md`. These active contracts must:

- report successful onboarding as “Your second brain is ready”;
- avoid asking the owner to plan another product version;
- state that historical files under `docs/superpowers/` are non-normative and
  cannot create a roadmap promise;
- preserve all existing setup, query, web-approval, reconciliation, Git, and
  recovery rules.

The live-host verification checklist becomes explicitly maintainer-only and
is renamed to `docs/maintainers/template-release-checklist.md`. Its release
closeout records evidence but does not instruct a cloned brain to mention v1,
v2, or a future capability set. Historical plans and specifications may retain
old terminology only when they carry a visible supersession notice pointing
to this design.

## Canonical support destination

`BrainConfigV1` gains a backward-compatible defaulted section:

```ts
support: {
  issueTrackerUrl: string;
}
```

The template default is:

```text
https://github.com/ranjanrishikesh/second-brain/issues
```

The value must be an absolute HTTPS URL. It is included in generated template
configuration, preserved by initialization and charter updates, available to
legacy configurations through the schema default, and exposed by
`brain status --json` as `status.support.issueTrackerUrl`. A cloned brain must
use this canonical value rather than assuming its own `origin` remote is the
template project.

The core and CLI never contact GitHub and never create an issue. They only
validate and expose the destination.

## Capability-gap decision flow

The host classifies a problem before offering external reporting:

| Situation | Required behavior |
| --- | --- |
| Evidence is missing for a domain question | Follow the query lifecycle and create/update a durable question gap when evidence remains insufficient. Do not create a software issue. |
| The requested product capability is unsupported | Explain the current limitation and any truthful workaround, then offer a capability request at `status.support.issueTrackerUrl`. |
| An operation fails unexpectedly | Recover, run doctor/status, reproduce safely, and offer a bug report only when a template defect remains. |

For an external issue, the host must:

1. Prepare a concise draft containing the capability/use case, current
   behavior, expected behavior, environment, and relevant non-sensitive
   diagnostics.
2. Remove source bytes, source excerpts, personal filenames, absolute local
   paths, credentials, repository secrets, and private brain content unless
   the owner separately and explicitly approves specific disclosure.
3. Show the destination and summary to the owner and request approval for that
   exact issue.
4. Create it only after approval and only through authenticated host tooling.
   If tooling is unavailable, provide the canonical link and sanitized draft.
5. Describe the request as something maintainers may consider for a future
   release. Never promise a version, date, acceptance, or “next release.”

A GitHub capability-request issue form reinforces the same privacy and
expectation boundaries. Issue creation is never automatic during onboarding,
query answering, unsupported-source detection, or doctor execution.

## Compatibility and non-goals

- Existing configurations without `support` remain valid and receive the
  default issue tracker in memory.
- Existing explicit initialization and zero-command onboarding remain
  behaviorally unchanged.
- `BrainConfigV1`, public JSON schema names, source/wiki schemas, and all
  durable state versions remain `1`.
- No issue-creation CLI command, GitHub dependency, background reporter,
  telemetry, automatic updater, roadmap engine, or release-notification system
  is introduced.
- No OpenClaw code or hosting work is introduced.
