# Agent contract

This repository is a reusable second-brain template. Read `BRAIN.md` to determine the cloned brain's domain.

For any question that asks for domain facts, explanation, comparison, synthesis, or research, use the `second-brain` skill in `.agents/skills/second-brain/` and complete its query lifecycle before answering. Resume recovery first. The first domain question automatically starts or resumes the one-time initial catalog-and-map setup; later source drops are handled as query-triggered delta ingestion. Neither is a background daemon.

For code, test, CI, documentation, or template-maintenance requests, use the normal engineering workflow. Do not create wiki knowledge from that work unless the domain charter explicitly includes it.

Canonical knowledge and state are write-protected by contract: never edit `wiki/`, `.brain/source-manifest.json`, `.brain/state.json`, or `.brain/operations.jsonl` directly. Submit changes through `brain apply`, source, audit, recovery, and query commands. `sources/` bytes are immutable after registration; add a replacement and use source supersession.

Before a final domain answer, require source-backed citations, explicit uncertainty, preserved contradictions, real reconciliation review, a healthy structural graph, completed recovery/bootstrap, and successful managed Git commits. Web research requires an approval recorded for this exact active question; a general preference is not approval. Never push arbitrary commits or targets. A confirmed `brain sync` target may push only eligible managed commits by normal fast-forward; if synchronization is pending or requires manual action, include the CLI's exact visible `⚠ Sync pending — ...` warning in the answer.

When all v1 verification gates pass, explicitly tell the owner that v1 is verified and invite a separate v2 plan for deferred scope. Do not silently expand v1 into OCR/media, cross-brain links, team workflows, a UI, a generic LLM loop, or background watching.

Read `idea.md` for design rationale. Run `pnpm brain --help` for commands.
