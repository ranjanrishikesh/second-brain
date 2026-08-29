# Portable Self-Maintaining Second Brain

A reusable repository template for one private, source-backed knowledge graph. Each clone is a completely independent brain: raw evidence stays immutable in `sources/`, durable knowledge compounds in an Obsidian-compatible `wiki/`, and the deterministic `brain` CLI validates every mutation, repairs derived graph files, logs the operation, and commits only managed paths.

The design rationale is preserved in [idea.md](idea.md).

## How it behaves

There is no file-watcher or always-on ingestion daemon. Drop supported files into `sources/`; the next domain question starts a query, detects new files, and automatically starts or resumes the one-time base catalog if it has not finished. The base setup creates a shallow, cited source page for every ready source plus the initial map; later source drops are ingested in shallow, query-triggered batches and become deep only when a question needs them.

```text
initial shallow catalog → wiki → raw sources → approved, captured web evidence
→ cited wiki mutation → graph reconciliation → validation → local Git commit → answer
```

If the wiki already supports the answer, the query is logged without creating a duplicate page. If raw or web evidence is used, the agent must persist cited, interconnected knowledge before answering. If evidence remains insufficient, it records an honest question/gap page instead of guessing.

The initial catalog is automatic agent work, not a surprise background process. An explicit onboarding request completes it as soon as usable sources are available; if onboarding was never requested, the first domain question remains the fallback trigger. Every stage is resumable.

## Start a brain without routine commands

The normal path is:

1. Create a new repository from this template, or clone it into a newly named folder.
2. Open that repository root in Codex or Claude Code.
3. Say “Initialize this second brain.”
4. If the agent reports that `sources/` is empty, add your PDF, DOCX, Markdown, text, HTML, EPUB, JSON/JSONL, CSV, or TSV files there. Then say “sources added” or simply ask your first domain question.

That is the entire routine user workflow. The agent checks Node and dependencies, recovers interrupted work, initializes from the repository name, scans sources, infers and persists a broad source-backed charter, completes the initial cited catalog and map, audits and rebuilds search, runs a smoke search, commits managed changes, and reports final readiness. If Node is missing or too old, installation is denied, or dependency installation fails, it reports that genuine environment blocker instead of pretending setup completed.

You may add sources before the first prompt; the agent then continues without the waiting step. A mixed corpus receives an inclusive charter that you can correct later. Scanned PDFs, legacy `.doc` files, and other unusable inputs are identified by filename and block readiness only when no source can be extracted successfully.

See [zero-command onboarding](docs/onboarding.md) for the lifecycle, interruption behavior, and approval boundaries.

## Use it locally with an agent

Codex reads `AGENTS.md`. Claude Code reads the one-line `CLAUDE.md`, which imports that same canonical contract, so the two hosts cannot drift. Both route onboarding and domain questions through `.agents/skills/second-brain/SKILL.md`; engineering requests remain ordinary code work and do not pollute the wiki.

Normally you speak to the agent in plain language. Onboarding handles the base setup; a domain question then drives `brain query begin`, tier expansion, evidence capture, reconciled persistence, audits, and `brain query finish`. Direct writes to canonical wiki/state files are forbidden by the agent contract.

## Manual CLI reference

These commands are for troubleshooting, automation, and template development—not the normal owner workflow. The Codex or Claude host should run them for you.

Requirements: Git, Node.js 22.13 or newer, and pnpm 10.9.

```bash
pnpm install --frozen-lockfile
pnpm brain init
pnpm brain doctor
pnpm brain status
pnpm brain source scan
```

Explicit initialization remains compatible when automation needs fixed identity values:

```bash
pnpm brain init --name "Growth and AI" --description "Marketing experiments, growth systems, and applied AI"
pnpm brain init --name "Fiction Worlds" --description "Characters, places, events, themes, and textual evidence"
pnpm brain init --name "Physics Notes" --description "Simple physics concepts, derivations, and worked explanations"
```

Each clone is one independent brain. Useful diagnostics include:

```bash
pnpm brain doctor
pnpm brain status
pnpm brain search --query "orbital resonance" --scope all
pnpm brain audit
```

### Web research is per-question and approved

If the wiki and raw sources cannot answer a question, the agent records the exact missing evidence and asks once for approval to research the web for that active question. Approval covers the rest of that question (up to the configured expiry); it does not silently authorize future questions. A denial leaves the answer local and preserves an honest question/gap page when needed. Every approved external claim is captured in `sources/web/` before it can support a wiki page.

### Local semantic search

The first base setup downloads the pinned `Xenova/multilingual-e5-small` model into `.brain/cache/models/`, then verifies the `model_quantized.onnx` SHA-256 recorded in `brain.config.yaml`. Search and reconciliation embeddings run locally after that download. The model cache and semantic index are disposable; the next semantic reconciliation rebuilds the index and may need to download the model again. A missing or invalid model stops setup safely instead of producing an unverified graph.

### Optional safe remote synchronization

Every managed mutation commits locally. To permit syncing a particular clone, the owner must confirm an existing remote and branch once:

```bash
pnpm brain sync configure --remote origin --branch main --confirm
pnpm brain sync status
pnpm brain sync
```

The core then pushes only a normal fast-forward composed entirely of its own managed commits. It never force-pushes, pulls, rebases, stages unrelated work, or pushes an unconfirmed target. If a remote rejects the push, the answer may still be returned because the knowledge is safely committed locally, but it must visibly include `⚠ Sync pending — …` with the affected commit and target.

## Supported sources

| Input | Stable locator |
| --- | --- |
| Markdown | heading anchor |
| Plain text | line range |
| HTML | extracted heading/section |
| Text PDF | page |
| Word DOCX | heading/section |
| EPUB | spine chapter |
| JSON | JSON path |
| JSONL | line |
| CSV / TSV | row |

DOCX extraction preserves usable text structure from headings, paragraphs, lists, tables, footnotes, and text boxes; embedded images are not OCRed. Archive expansion and converted output share the configured source-size ceiling, including repeated note/comment content. Scanned PDFs, legacy `.doc` files, other Office formats, images/OCR, audio, and video are reported as unsupported or extraction-required; they are never silently ignored. To replace registered bytes, add a new file, scan it, then use `brain source supersede <old-id> <new-id>`.

## Verification and live-smoke handoff

The deterministic end-to-end suite uses a disposable source fixture, a fake local embedding provider, fake captured web content, and temporary Git remotes. It proves the template contracts without model or web credentials, including source setup, source-backed persistence, semantic-cache rebuilding, synonym candidates, reciprocal contradictions, denied/approved web paths, audit resumption, safe-sync warnings, and independent brains.

Run [the v1 exit checklist](docs/V1_EXIT_CHECKLIST.md) before calling a clone v1-verified. It separates the deterministic template gate from live agent checks in Codex and Claude Code. A successful build or unit test does not prove that an agent follows the full repository workflow. Only after those template checks should a personal-brain pilot begin, as a usefulness evaluation rather than a safety substitute.

## Repository map

```text
sources/                     immutable input and captured web evidence
wiki/                        canonical Obsidian Markdown graph
.brain/                      tracked manifests/logs plus ignored cache/runtime
packages/core/               schemas, extraction, search, graph, transactions
packages/cli/                deterministic brain executable
.agents/skills/second-brain/ host-neutral reasoning workflow
AGENTS.md / CLAUDE.md        Codex and Claude Code project instructions
schemas/v1/                  generated public JSON Schemas
```

Configuration is documented in [docs/configuration.md](docs/configuration.md), data contracts in [docs/contracts.md](docs/contracts.md), and backups/recovery in [docs/recovery.md](docs/recovery.md). Before treating a cloned brain as v1-ready, use the [v1 exit checklist](docs/V1_EXIT_CHECKLIST.md); after it is verified, plan the explicitly deferred v2 work rather than silently expanding v1.

## Development

```bash
pnpm verify
pnpm test:e2e
pnpm brain doctor
```

Conductor users get shared modern run commands from `.conductor/settings.toml` for test watch, verification, and doctor. No legacy `conductor.json` is used.
