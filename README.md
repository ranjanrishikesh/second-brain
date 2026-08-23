# Portable Self-Maintaining Second Brain

A reusable repository template for one private, source-backed knowledge graph. Each clone is a completely independent brain: raw evidence stays immutable in `sources/`, durable knowledge compounds in an Obsidian-compatible `wiki/`, and the deterministic `brain` CLI validates every mutation, repairs derived graph files, logs the operation, and commits only managed paths.

The design rationale is preserved in [idea.md](idea.md).

## How it behaves

There is no file-watcher or always-on ingestion daemon. Drop supported files into `sources/`; the next domain question starts a query, detects new files, resumes catalog bootstrap, and follows this enforced ladder:

```text
wiki → raw sources → captured web evidence → cited wiki mutation
     → graph reconciliation → validation → local Git commit → answer
```

If the wiki already supports the answer, the query is logged without creating a duplicate page. If raw or web evidence is used, the agent must persist cited, interconnected knowledge before answering. If evidence remains insufficient, it records an honest question/gap page instead of guessing.

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

Normally you ask the agent a question in plain language. The agent drives `brain query begin`, tier expansion, evidence capture, reconciled `brain apply`, audits, and `brain query finish`. Direct writes to canonical wiki/state files are forbidden by the agent contract.

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

Configuration is documented in [docs/configuration.md](docs/configuration.md), data contracts in [docs/contracts.md](docs/contracts.md), and backups/recovery in [docs/recovery.md](docs/recovery.md).

## Development

```bash
pnpm verify
pnpm test:e2e
pnpm brain doctor
```

Conductor users get shared modern run commands from `.conductor/settings.toml`, including test watch, verification, doctor, and a workspace-port-isolated OpenClaw gateway. No legacy `conductor.json` is used.
