import {
  applyChangeSetTransaction,
  attachQueryChange,
  auditBrain,
  beginQuery,
  captureWebEvidence,
  doctorBrain,
  expandQuery,
  finishQuery,
  initBrain,
  nextBootstrapBatch,
  readBrainItem,
  recordSemanticAuditBatch,
  rebuildSearchIndex,
  recoverBrain,
  scanAndRegisterSources,
  searchBrain,
  statusBrain,
  supersedeRegisteredSource,
  type SearchScope,
} from "@second-brain/core";
import { Command, CommanderError, Option } from "commander";
import { readFile } from "node:fs/promises";

export interface CliOutput {
  write(value: string): void;
}

export async function runCli(
  args: string[],
  output: CliOutput,
): Promise<number> {
  const program = new Command()
    .name("brain")
    .description("Maintain a portable, compounding second brain")
    .showHelpAfterError()
    .exitOverride()
    .configureOutput({
      writeOut: (value) => output.write(value),
      writeErr: (value) => output.write(value),
    });

  const json = (value: unknown) =>
    output.write(`${JSON.stringify(value, null, 2)}\n`);

  program
    .command("init")
    .requiredOption("--name <name>")
    .requiredOption("--description <description>")
    .option("--root <path>", "brain repository root", process.cwd())
    .action(
      async (options: { name: string; description: string; root: string }) => {
        await initBrain(options.root, {
          name: options.name,
          description: options.description,
        });
        output.write(`Initialized ${options.name} at ${options.root}\n`);
      },
    );

  program
    .command("doctor")
    .option("--root <path>", "brain repository root", process.cwd())
    .option("--json", "emit machine-readable JSON")
    .action(async (options: { root: string; json?: boolean }) => {
      const report = await doctorBrain(options.root);
      if (options.json) {
        output.write(`${JSON.stringify(report, null, 2)}\n`);
      } else if (report.ok) {
        output.write("Brain is healthy.\n");
      } else {
        for (const issue of report.issues)
          output.write(`[${issue.severity}] ${issue.message}\n`);
      }
      if (!report.ok) process.exitCode = 1;
    });

  program
    .command("status")
    .option("--root <path>", "brain repository root", process.cwd())
    .option("--json", "emit machine-readable JSON")
    .action(async (options: { root: string; json?: boolean }) => {
      const status = await statusBrain(options.root);
      if (options.json) json(status);
      else {
        output.write(
          `${status.brain.name}: ${status.sources.total} sources, ${status.wiki.pages} pages, ${status.bootstrap.pendingSourceIds.length} pending bootstrap.\n`,
        );
      }
    });

  const source = program
    .command("source")
    .description("Manage immutable raw sources");
  source
    .command("scan")
    .option("--root <path>", "brain repository root", process.cwd())
    .option("--json", "emit machine-readable JSON")
    .action(async (options: { root: string; json?: boolean }) => {
      const result = await scanAndRegisterSources(options.root);
      if (options.json) json(result);
      else {
        output.write(
          `Sources: ${result.added.length} added, ${result.unchanged.length} unchanged, ${result.modified.length} modified, ${result.deleted.length} deleted.\n`,
        );
      }
    });
  source
    .command("supersede <previous-source-id> <replacement-source-id>")
    .option("--root <path>", "brain repository root", process.cwd())
    .option("--json", "emit machine-readable JSON")
    .action(
      async (
        previousSourceId: string,
        replacementSourceId: string,
        options: { root: string },
      ) => {
        json(
          await supersedeRegisteredSource(
            options.root,
            previousSourceId,
            replacementSourceId,
          ),
        );
      },
    );

  program
    .command("read <reference>")
    .option("--locator <locator>", "source locator")
    .option("--root <path>", "brain repository root", process.cwd())
    .option("--json", "emit machine-readable JSON")
    .action(
      async (
        reference: string,
        options: { locator?: string; root: string; json?: boolean },
      ) => {
        const result = await readBrainItem(
          options.root,
          reference,
          options.locator,
        );
        if (options.json) json(result);
        else if (result.kind === "wiki") output.write(`${result.page.body}\n`);
        else {
          output.write(
            `${result.chunks.map((chunk) => `[${chunk.locator}]\n${chunk.text}`).join("\n\n")}\n`,
          );
        }
      },
    );

  program
    .command("search")
    .requiredOption("--query <query>")
    .option("--root <path>", "brain repository root", process.cwd())
    .addOption(
      new Option("--scope <scope>", "search scope")
        .choices(["wiki", "sources", "all"])
        .default("all"),
    )
    .option("--limit <number>", "maximum results", "10")
    .option("--json", "emit machine-readable JSON")
    .action(
      async (options: {
        query: string;
        root: string;
        scope: SearchScope;
        limit: string;
        json?: boolean;
      }) => {
        const results = await searchBrain(options.root, {
          query: options.query,
          scope: options.scope,
          limit: Number.parseInt(options.limit, 10),
        });
        if (options.json) output.write(`${JSON.stringify(results, null, 2)}\n`);
        else {
          for (const result of results) {
            output.write(
              `${result.path}#${result.locator} — ${result.snippet}\n`,
            );
          }
        }
      },
    );

  program
    .command("rebuild")
    .option("--root <path>", "brain repository root", process.cwd())
    .action(async (options: { root: string }) => {
      await rebuildSearchIndex(options.root);
      output.write("Search index rebuilt.\n");
    });

  const query = program
    .command("query")
    .description("Run a tiered knowledge query");
  query
    .command("begin <question>")
    .option("--root <path>", "brain repository root", process.cwd())
    .option("--json", "emit machine-readable JSON")
    .action(async (question: string, options: { root: string }) => {
      json(await beginQuery(options.root, question));
    });
  query
    .command("expand <query-id>")
    .requiredOption("--tier <tier>", "next tier", "sources")
    .requiredOption("--reason <reason>")
    .option("--root <path>", "brain repository root", process.cwd())
    .option("--json", "emit machine-readable JSON")
    .action(
      async (
        queryId: string,
        options: { tier: "sources" | "web"; reason: string; root: string },
      ) => {
        if (options.tier !== "sources" && options.tier !== "web") {
          throw new Error(`Unknown query tier: ${options.tier}`);
        }
        json(
          await expandQuery(options.root, queryId, {
            tier: options.tier,
            reason: options.reason,
          }),
        );
      },
    );
  query
    .command("finish <query-id>")
    .requiredOption("--outcome <outcome>")
    .requiredOption("--summary <summary>")
    .option("--operation <ids...>", "durable wiki operation IDs")
    .option("--root <path>", "brain repository root", process.cwd())
    .option("--json", "emit machine-readable JSON")
    .action(
      async (
        queryId: string,
        options: {
          outcome: "answered" | "partial" | "unanswered";
          summary: string;
          operation?: string[];
          root: string;
        },
      ) => {
        if (
          !(["answered", "partial", "unanswered"] as const).includes(
            options.outcome,
          )
        ) {
          throw new Error(`Unknown query outcome: ${options.outcome}`);
        }
        for (const operationId of options.operation ?? []) {
          await attachQueryChange(options.root, queryId, operationId);
        }
        json(
          await finishQuery(options.root, queryId, {
            outcome: options.outcome,
            answerSummary: options.summary,
          }),
        );
      },
    );

  const bootstrap = program
    .command("bootstrap")
    .description("Build the shallow source catalog");
  bootstrap
    .command("next <query-id>")
    .option("--root <path>", "brain repository root", process.cwd())
    .option("--json", "emit machine-readable JSON")
    .action(async (queryId: string, options: { root: string }) => {
      json(await nextBootstrapBatch(options.root, queryId));
    });

  const web = program
    .command("web")
    .description("Capture immutable web evidence");
  web
    .command("capture <query-id>")
    .requiredOption("--url <url>")
    .requiredOption("--title <title>")
    .requiredOption("--kind <kind>")
    .option("--content <content>")
    .option("--content-file <path>")
    .option("--retrieved-at <timestamp>")
    .option("--root <path>", "brain repository root", process.cwd())
    .option("--json", "emit machine-readable JSON")
    .action(
      async (
        queryId: string,
        options: {
          url: string;
          title: string;
          kind: "page" | "snippet";
          content?: string;
          contentFile?: string;
          retrievedAt?: string;
          root: string;
        },
      ) => {
        if (options.kind !== "page" && options.kind !== "snippet") {
          throw new Error(`Unknown web capture kind: ${options.kind}`);
        }
        if (Boolean(options.content) === Boolean(options.contentFile)) {
          throw new Error("Provide exactly one of --content or --content-file");
        }
        const content = options.contentFile
          ? await readFile(options.contentFile, "utf8")
          : (options.content ?? "");
        json(
          await captureWebEvidence(options.root, queryId, {
            url: options.url,
            title: options.title,
            captureKind: options.kind,
            content,
            ...(options.retrievedAt
              ? { retrievedAt: options.retrievedAt }
              : {}),
          }),
        );
      },
    );

  program
    .command("apply <change-set-file>")
    .option("--query <query-id>", "attach the committed mutation to a query")
    .option("--root <path>", "brain repository root", process.cwd())
    .option("--json", "emit machine-readable JSON")
    .action(
      async (
        changeSetFile: string,
        options: { query?: string; root: string },
      ) => {
        const result = await applyChangeSetTransaction(
          options.root,
          JSON.parse(await readFile(changeSetFile, "utf8")),
        );
        if (options.query) {
          await attachQueryChange(
            options.root,
            options.query,
            result.operationId,
          );
        }
        json(result);
      },
    );

  const audit = program
    .command("audit")
    .description("Validate structural and semantic health");
  audit
    .option("--root <path>", "brain repository root", process.cwd())
    .option("--json", "emit machine-readable JSON")
    .action(async (options: { root: string }) => {
      json(await auditBrain(options.root));
    });
  audit
    .command("record")
    .requiredOption("--pages <ids>", "comma-separated reviewed page IDs")
    .requiredOption("--summary <summary>")
    .option("--root <path>", "brain repository root", process.cwd())
    .option("--json", "emit machine-readable JSON")
    .action(
      async (options: { pages: string; summary: string; root: string }) => {
        json(
          await recordSemanticAuditBatch(options.root, {
            pageIds: options.pages.split(",").map((value) => value.trim()),
            summary: options.summary,
          }),
        );
      },
    );

  program
    .command("recover")
    .option("--root <path>", "brain repository root", process.cwd())
    .option("--json", "emit machine-readable JSON")
    .action(async (options: { root: string }) => {
      json({ version: 1, outcome: await recoverBrain(options.root) });
    });

  try {
    await program.parseAsync(args, { from: "user" });
    return 0;
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode;
    throw error;
  }
}
