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

The initial catalog is automatic agent work, not a surprise background process: a clone still needs its identity and domain charter, and setup runs only in response to the first domain question. It is resumable if interrupted.

## Create a brain from the template

Requirements: Git, Node.js 22.22.3 or a compatible newer release, and pnpm 10.9.

```bash
git clone <your-template-repository> astronomy-brain
cd astronomy-brain
pnpm install --frozen-lockfile
pnpm brain init \
  --name "Astronomy Brain" \
  --description "My source-backed astronomy research and explanations"
```

Then edit `BRAIN.md` to define the domain, exclusions, terminology, and evidence preferences. Commit that identity once:

```bash
git add BRAIN.md brain.config.yaml wiki/home.md
git commit -m "chore: initialize astronomy brain"
```

`brain init` safely replaces the pristine template identity, is idempotent with the same identity, and refuses an accidental rename after initialization.

Example independent clones need no code changes:

```bash
pnpm brain init --name "Growth and AI" --description "Marketing experiments, growth systems, and applied AI"
pnpm brain init --name "Fiction Worlds" --description "Characters, places, events, themes, and textual evidence"
pnpm brain init --name "Physics Notes" --description "Simple physics concepts, derivations, and worked explanations"
```

Run each command in a separate clone. One repository always represents one brain.

## Use it locally with an agent

Open the repository in Codex or another instruction-aware coding agent. `AGENTS.md` routes domain questions through `.agents/skills/second-brain/SKILL.md`; engineering requests remain normal code work and do not pollute the wiki.

Useful checks:

```bash
pnpm brain doctor
pnpm brain status
pnpm brain search --query "orbital resonance" --scope all
pnpm brain audit
```

Normally you ask the agent a question in plain language. On the first question it completes the base setup, then drives `brain query begin`, tier expansion, evidence capture, reconciled `brain apply`, audits, and `brain query finish`. Direct writes to canonical wiki/state files are forbidden by the agent contract.

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
| EPUB | spine chapter |
| JSON | JSON path |
| JSONL | line |
| CSV / TSV | row |

Scanned PDFs, images/OCR, Office files, audio, and video are reported as unsupported or extraction-required; they are never silently ignored. To replace registered bytes, add a new file, scan it, then use `brain source supersede <old-id> <new-id>`.

## Hosted OpenClaw gateway

OpenClaw is only a hosting harness. The repository, CLI, schemas, and wiki remain canonical; the deployment does not enable OpenClaw Memory Wiki or create another knowledge database.

```bash
cp .env.example .env
# Fill OPENCLAW_GATEWAY_TOKEN and provider credentials.
docker compose -f deploy/openclaw/compose.yaml up --build
```

The gateway is exposed only on `127.0.0.1`. The repository is a writable bind mount and OpenClaw runtime state uses a separate disposable named volume. See [deploy/openclaw/README.md](deploy/openclaw/README.md) for remote access and multiple-brain hosting.

## Verification and live-smoke handoff

The deterministic end-to-end suite uses a disposable source fixture, a fake local embedding provider, fake captured web content, and temporary Git remotes. It proves the template contracts without model or web credentials, including source setup, source-backed persistence, semantic-cache rebuilding, synonym candidates, reciprocal contradictions, denied/approved web paths, audit resumption, safe-sync warnings, and independent brains.

Run [the v1 exit checklist](docs/V1_EXIT_CHECKLIST.md) before calling a clone v1-verified. It separates the deterministic template gate from two credential-gated live smokes: one through Codex and one through the hosted OpenClaw gateway. A successful build or unit test is not a hosted live smoke; OpenClaw verification remains pending until its real gateway sequence has been recorded as passed. Only after those template checks should a personal-brain pilot begin, as a usefulness evaluation rather than a safety substitute.

## Repository map

```text
sources/                     immutable input and captured web evidence
wiki/                        canonical Obsidian Markdown graph
.brain/                      tracked manifests/logs plus ignored cache/runtime
packages/core/               schemas, extraction, search, graph, transactions
packages/cli/                deterministic brain executable
adapters/openclaw/           thin typed OpenClaw tools
.agents/skills/second-brain/ host-neutral reasoning workflow
deploy/openclaw/             pinned reference container
schemas/v1/                  generated public JSON Schemas
```

Configuration is documented in [docs/configuration.md](docs/configuration.md), data contracts in [docs/contracts.md](docs/contracts.md), and backups/recovery in [docs/recovery.md](docs/recovery.md). Before treating a cloned brain as v1-ready, use the [v1 exit checklist](docs/V1_EXIT_CHECKLIST.md); after it is verified, plan the explicitly deferred v2 work rather than silently expanding v1.

## Development

```bash
pnpm verify
pnpm test:e2e
pnpm brain doctor
```

Conductor users get shared modern run commands from `.conductor/settings.toml`, including test watch, verification, doctor, and a workspace-port-isolated OpenClaw gateway. No legacy `conductor.json` is used.
