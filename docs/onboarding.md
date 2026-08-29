# Zero-command onboarding

The normal owner experience has two actions: open a fresh template clone in Codex or Claude Code and say **“Initialize this second brain.”** If the clone has no material yet, add files under `sources/` when asked. After that, say “sources added” or ask the first domain question. The agent operates the deterministic CLI; the owner does not need to type routine brain commands.

## What the agent does

The host checks Node.js and installs locked dependencies when needed, recovers any interrupted transaction, and reads doctor plus onboarding status. It then advances only through the next action reported by canonical state:

| Phase | Agent action |
| --- | --- |
| `needs-initialization` | Initialize identity from the Git repository name. |
| `awaiting-sources` | Pause and ask the owner to add supported source files. |
| `sources-unregistered` | Scan and immutably register source bytes. |
| `sources-blocked` | Report exact unsupported, extraction-required, and failed files. |
| `awaiting-charter` | Infer and persist a source-informed charter. |
| `ready-for-setup` | Start the cited shallow catalog and map. |
| `setup-in-progress` | Resume from the recorded checkpoint. |
| `ready` | Audit, rebuild, smoke-search, and report readiness. |

At least one source must extract successfully before setup can complete. Ready files are not held back merely because other files are unusable, but a corpus with no ready source remains blocked with file-level diagnostics.

## How identity and charter inference work

Bare initialization derives the display name from the Git common-directory repository name; a non-Git copy falls back to the root folder name. This avoids mistaking a Conductor worktree codename for the brain name and requires no GitHub account.

The host—not the CLI—infers semantic charter fields. It considers existing identity, optional authenticated repository metadata already available to the host, the Git repository name, every source title, and deterministic representative chunks from up to 50 evenly distributed ready sources. A mixed collection receives broad, inclusive purpose and boundaries. The inferred description, purpose, boundaries, domain conventions, and evidence preferences are shown to the owner after they are safely persisted and committed, so they can request a correction later.

## Interruption and resumption

Identity, source registration, charter persistence, setup batches, and audits are journaled or checkpointed. A new agent session begins with recovery and status; it does not depend on conversational memory or a special resume phrase. Adding sources and asking a normal domain question is enough to continue.

The agent may ask for help only when the environment cannot execute safely—for example, Node is absent or too old, permissions deny execution, dependency installation fails, every source is unusable, or immutable/transaction checks find a real conflict. It should report the exact blocker instead of handing routine CLI work to the owner.

## Human approval boundaries

Onboarding is not blanket approval for external access or arbitrary Git operations:

- Web research still requires approval for the exact active question before the host browses or captures evidence.
- A remote and branch must be explicitly owner-confirmed before the CLI stores a sync target. An already confirmed matching target may receive eligible managed commits automatically.
- The host must not broadly allowlist `pnpm brain *`; normal host permission prompts can still appear.

When synchronization cannot complete, local committed knowledge remains usable and the agent must reproduce the CLI's full visible `⚠ Sync pending — …` warning.

## Source support

Text PDFs and Word DOCX files are first-class v1 inputs alongside Markdown, text, HTML, EPUB, JSON/JSONL, CSV, and TSV. Image-only PDFs need extraction/OCR and are reported as such. Legacy `.doc`, images, audio, video, and unsupported Office formats are not silently skipped.

For command-level troubleshooting, run `pnpm brain --help` or ask the host agent to inspect the failing phase. The [recovery guide](recovery.md) documents canonical safety behavior; the [v1 exit checklist](V1_EXIT_CHECKLIST.md) separates deterministic verification from real Codex and Claude live smokes.
