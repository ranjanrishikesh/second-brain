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
Each brain has one primary domain. Related material is added automatically;
unrelated or uncertain material requires approval. Approval applies once to
that item and never broadens scope.
Each question then follows:

`wiki → raw sources → approved web research → cited wiki update`

If the wiki already supports the answer, the agent uses it without creating a
duplicate page. Otherwise it reads the raw sources, or asks before researching
the web, and saves reusable knowledge with citations and meaningful links. It
reconciles the affected graph, validates it, and commits the managed changes.
Used downloadable web documents are preserved in their original supported format, while ordinary pages are stored as textual snapshots.
The wiki becomes deeper and more interconnected as you ask questions.

## Original idea

This project implements [Andrej Karpathy's original LLM Wiki idea](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f):
use an LLM to build and maintain a persistent wiki that compounds instead of
re-deriving the same knowledge from raw documents for every question.
