# Data and graph contracts

The public v1 contracts are exported as Zod schemas and checked-in JSON Schema 2020-12 files under `schemas/v1/`:

- `BrainConfigV1`
- `SourceRecordV1`
- `WikiPageV1`
- `RelationV1`
- `ChangeSetV1`
- `QuerySessionV1`
- `OperationRecordV1`
- `AuditReportV1`

Regenerate them with `pnpm schemas:generate`; CI rejects drift.

## Source identity

A source ID is derived from SHA-256 content. Once registered, the bytes at that path may not change or disappear. A replacement is a new source record linked through `supersedes`, leaving both versions inspectable.

Extracted chunks retain deterministic locators such as `page=4`, `chapter=2`, `heading=method`, `lines=10-18`, `$.results[0]`, or `row=7`.

## Wiki page identity

Canonical pages live under `wiki/pages/` with YAML frontmatter and authored Markdown. Stable page IDs survive renames; a revision hash covers identity, metadata, evidence, relations, and authored body. Updates must supply the expected revision and current catalog revision.

Factual or synthesized paragraphs cite immutable evidence inline:

```markdown
The observed period is 33 milliseconds. [@src_0123456789abcdef#page=4]
```

The same source and locator must be declared in frontmatter. Normal navigation uses Obsidian wikilinks; typed relations generate connection and backlink sections between protected markers.

## Change sets and reconciliation

Agents do not write canonical wiki/state files directly. `ChangeSetV1` carries page operations plus a reconciliation receipt. The receipt covers graph neighbors, shared evidence and tags, duplicates, and related search results. Every candidate needs a content-based `changed` or `no-change` decision after its body and targeted anchor are read.

Query-driven changes must be submitted with `brain apply --query <query-id>`. The core records the query's active evidence tier on the operation; an unbound historical mutation or a mutation from an earlier tier cannot satisfy raw/web persistence requirements.

The transaction validates all pages, citations, anchors, aliases, relation types, source IDs, revisions, duplicates, and the complete structural graph. It then regenerates index, map, backlinks, sources, health, state, and logs atomically.

Contradictory claims remain cited in a conflicts section and use `supports` or `contradicts` edges. Pages are archived, merged, renamed, or superseded rather than destructively erased.
