# Agent contract

This repository is a reusable second-brain template. Read `BRAIN.md` to determine the cloned brain's domain.

For any question that asks for domain facts, explanation, comparison, synthesis, or research, use the `second-brain` skill in `.agents/skills/second-brain/` and complete its query lifecycle before answering. Resume recovery and bootstrap work first.

For code, test, CI, documentation, deployment, or template-maintenance requests, use the normal engineering workflow. Do not create wiki knowledge from that work unless the domain charter explicitly includes it.

Canonical knowledge and state are write-protected by contract: never edit `wiki/`, `.brain/source-manifest.json`, `.brain/state.json`, or `.brain/operations.jsonl` directly. Submit changes through `brain apply`, source, audit, recovery, and query commands. `sources/` bytes are immutable after registration; add a replacement and use source supersession.

Before a final domain answer, require source-backed citations, explicit uncertainty, preserved contradictions, real reconciliation review, a healthy structural graph, completed recovery/bootstrap, and successful managed Git commits. Never auto-push.

Read `idea.md` for design rationale. Run `pnpm brain --help` for commands.
