import {
  applyChangeSetTransaction,
  attemptManagedSync,
  attachQueryChange,
  attachSetupChange,
  auditBrain,
  beginSetup,
  beginQuery,
  captureWebEvidence,
  changeSetV1Schema,
  configureSyncTarget,
  doctorBrain,
  expandQuery,
  finishSetup,
  finishQuery,
  formatSyncWarning,
  initBrain,
  nextBootstrapBatch,
  nextSetupBatch,
  planReconciliation,
  readBrainItem,
  readQueryItem,
  readQuerySession,
  recordSemanticAuditBatch,
  rebuildSearchIndex,
  recoverBrain,
  requestWebApproval,
  scanAndRegisterSources,
  resolveWebApproval,
  searchBrain,
  setBrainCharter,
  statusBrain,
  supersedeRegisteredSource,
  syncStatus,
  type BrainRuntimeServices,
  type BrainCharterV1,
  type SearchScope,
} from "@second-brain/core";
import { Command, CommanderError, Option } from "commander";
import { readFile } from "node:fs/promises";

export interface CliOutput {
  write(value: string): void;
}

export interface CliRuntimeOptions {
  runtimeServices?: BrainRuntimeServices;
}

export async function runCli(
  args: string[],
  output: CliOutput,
  runtimeOptions: CliRuntimeOptions = {},
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
  let commandStatus = 0;

  program
    .command("init")
    .option("--name <name>")
    .option("--description <description>")
    .option("--root <path>", "brain repository root", process.cwd())
    .option("--json", "emit machine-readable JSON")
    .action(
      async (options: {
        name?: string;
        description?: string;
        root: string;
        json?: boolean;
      }) => {
        const initialization = await initBrain(options.root, {
          ...(options.name !== undefined ? { name: options.name } : {}),
          ...(options.description !== undefined
            ? { description: options.description }
            : {}),
        });
        const status = await statusBrain(options.root);
        if (options.json) json({ initialization, status });
        else
          output.write(
            `Initialized ${initialization.name} at ${options.root}. Next: ${status.onboarding.nextAction}.\n`,
          );
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
      } else {
        for (const issue of report.issues)
          output.write(`[${issue.severity}] ${issue.code}: ${issue.message}\n`);
        if (report.ok) {
          output.write(
            report.issues.length > 0
              ? "Brain is healthy with warnings.\n"
              : "Brain is healthy.\n",
          );
        }
      }
      if (!report.ok) commandStatus = 1;
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
          `${status.brain.name}: ${status.sources.total} registered sources (${status.sources.ready} ready), ${status.wiki.pages} wiki pages. Onboarding: ${status.onboarding.phase}. Next: ${status.onboarding.nextAction}.\n`,
        );
      }
    });

  const charter = program
    .command("charter")
    .description("Manage the source-informed brain charter");
  charter
    .command("set <charter-json-file>")
    .option("--root <path>", "brain repository root", process.cwd())
    .option("--json", "emit machine-readable JSON")
    .action(
      async (
        charterFile: string,
        options: { root: string; json?: boolean },
      ) => {
        const result = await setBrainCharter(
          options.root,
          JSON.parse(await readFile(charterFile, "utf8")) as BrainCharterV1,
        );
        if (options.json) json(result);
        else output.write(`Set brain charter with ${result.operationId}.\n`);
      },
    );

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

  const setup = program
    .command("setup")
    .description("Build the one-time initial source catalog");
  setup
    .command("begin")
    .requiredOption("--purpose <text>")
    .option("--boundaries <text>")
    .option("--root <path>", "brain repository root", process.cwd())
    .option("--json", "emit machine-readable JSON")
    .action(
      async (options: {
        purpose: string;
        boundaries?: string;
        root: string;
      }) => {
        json(
          await beginSetup(
            options.root,
            {
              purpose: options.purpose,
              ...(options.boundaries ? { boundaries: options.boundaries } : {}),
            },
            runtimeOptions.runtimeServices,
          ),
        );
      },
    );
  setup
    .command("next <setup-id>")
    .option("--root <path>", "brain repository root", process.cwd())
    .option("--json", "emit machine-readable JSON")
    .action(async (setupId: string, options: { root: string }) => {
      json(await nextSetupBatch(options.root, setupId));
    });
  setup
    .command("finish <setup-id>")
    .requiredOption("--summary <text>")
    .option("--root <path>", "brain repository root", process.cwd())
    .option("--json", "emit machine-readable JSON")
    .action(
      async (setupId: string, options: { summary: string; root: string }) => {
        json(
          await finishSetup(options.root, setupId, {
            summary: options.summary,
          }),
        );
      },
    );

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
    .command("read <query-id> <reference>")
    .option("--locator <locator>", "source locator or wiki anchor")
    .option("--root <path>", "brain repository root", process.cwd())
    .option("--json", "emit machine-readable JSON")
    .action(
      async (
        queryId: string,
        reference: string,
        options: { locator?: string; root: string },
      ) => {
        json(
          await readQueryItem(
            options.root,
            queryId,
            reference,
            options.locator,
          ),
        );
      },
    );
  query
    .command("request-web <query-id>")
    .requiredOption("--reason <text>")
    .requiredOption("--host-session <id>")
    .option("--root <path>", "brain repository root", process.cwd())
    .option("--json", "emit machine-readable JSON")
    .action(
      async (
        queryId: string,
        options: { reason: string; hostSession: string; root: string },
      ) => {
        json(
          await requestWebApproval(options.root, queryId, {
            reason: options.reason,
            hostSessionId: options.hostSession,
          }),
        );
      },
    );
  query
    .command("approve-web <query-id>")
    .requiredOption("--approved <true|false>")
    .requiredOption("--decided-by <id>")
    .option("--denial-reason <text>")
    .option("--root <path>", "brain repository root", process.cwd())
    .option("--json", "emit machine-readable JSON")
    .action(
      async (
        queryId: string,
        options: {
          approved: string;
          decidedBy: string;
          denialReason?: string;
          root: string;
        },
      ) => {
        if (options.approved !== "true" && options.approved !== "false") {
          throw new Error("--approved must be true or false");
        }
        json(
          await resolveWebApproval(options.root, queryId, {
            approved: options.approved === "true",
            decidedBy: options.decidedBy,
            ...(options.denialReason
              ? { denialReason: options.denialReason }
              : {}),
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
          json?: boolean;
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
        const result = await finishQuery(options.root, queryId, {
          outcome: options.outcome,
          answerSummary: options.summary,
        });
        if (options.json) {
          json(result);
        } else {
          const warning = result.sync
            ? formatSyncWarning(result.sync)
            : undefined;
          output.write(
            warning ? `${warning}\n` : `Finished query ${queryId}.\n`,
          );
        }
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

  const reconcile = program
    .command("reconcile")
    .description("Plan whole-graph reconciliation before a wiki mutation");
  reconcile
    .command("plan <change-set-draft-file>")
    .option("--root <path>", "brain repository root", process.cwd())
    .option("--json", "emit machine-readable JSON")
    .action(async (changeSetFile: string, options: { root: string }) => {
      json(
        await planReconciliation(
          options.root,
          JSON.parse(await readFile(changeSetFile, "utf8")),
          runtimeOptions.runtimeServices,
        ),
      );
    });

  const sync = program
    .command("sync")
    .description("Safely synchronize confirmed managed brain commits")
    .option("--root <path>", "brain repository root", process.cwd())
    .option("--json", "emit machine-readable JSON")
    .action(async (options: { root: string }) => {
      json(await attemptManagedSync(options.root));
    });
  sync
    .command("configure")
    .requiredOption("--remote <name>")
    .requiredOption("--branch <name>")
    .requiredOption("--confirm", "confirm this existing Git target")
    .action(
      async (
        options: { remote: string; branch: string; confirm: boolean },
        command: Command,
      ) => {
        if (options.confirm !== true) {
          throw new Error("--confirm is required to configure synchronization");
        }
        const root = command.parent?.opts().root as string | undefined;
        json(
          await configureSyncTarget(root ?? process.cwd(), {
            remote: options.remote,
            branch: options.branch,
            confirm: true,
          }),
        );
      },
    );
  sync
    .command("status")
    .action(async (_options: Record<string, never>, command: Command) => {
      const root = command.parent?.opts().root as string | undefined;
      json(await syncStatus(root ?? process.cwd()));
    });

  program
    .command("apply <change-set-file>")
    .option("--query <query-id>", "attach the committed mutation to a query")
    .option("--setup <setup-id>", "attach the committed mutation to setup")
    .option("--root <path>", "brain repository root", process.cwd())
    .option("--json", "emit machine-readable JSON")
    .action(
      async (
        changeSetFile: string,
        options: {
          query?: string;
          setup?: string;
          root: string;
          json?: boolean;
        },
      ) => {
        if (options.query && options.setup) {
          throw new Error("Use either --query or --setup, not both");
        }
        const changeSet = changeSetV1Schema.parse(
          JSON.parse(await readFile(changeSetFile, "utf8")),
        );
        const query = options.query
          ? await readQuerySession(options.root, options.query)
          : undefined;
        const candidatePageIds = new Set(
          changeSet.reconciliation.candidatePageIds,
        );
        const reconciledChangeSet = query
          ? {
              ...changeSet,
              reconciliation: {
                ...changeSet.reconciliation,
                readReceipts: query.readReceipts.filter((receipt) =>
                  candidatePageIds.has(receipt.pageId),
                ),
              },
            }
          : changeSet;
        const runtimeServicesOption = runtimeOptions.runtimeServices
          ? { runtimeServices: runtimeOptions.runtimeServices }
          : {};
        const transactionOptions = options.query
          ? {
              queryId: options.query,
              ...runtimeServicesOption,
            }
          : options.setup
            ? {
                context: { kind: "setup" as const, id: options.setup },
                ...runtimeServicesOption,
              }
            : runtimeServicesOption;
        const result = await applyChangeSetTransaction(
          options.root,
          reconciledChangeSet,
          transactionOptions,
        );
        if (options.query) {
          await attachQueryChange(
            options.root,
            options.query,
            result.operationId,
          );
        }
        if (options.setup) {
          await attachSetupChange(
            options.root,
            options.setup,
            result.operationId,
          );
        }
        if (options.json) {
          json(result);
        } else {
          const warning = result.sync
            ? formatSyncWarning(result.sync)
            : undefined;
          output.write(
            warning ? `${warning}\n` : `Applied ${result.operationId}.\n`,
          );
        }
      },
    );

  const audit = program
    .command("audit")
    .description("Validate structural and semantic health");
  audit
    .option("--root <path>", "brain repository root", process.cwd())
    .option("--json", "emit machine-readable JSON")
    .action(async (options: { root: string }) => {
      const report = await auditBrain(options.root);
      json(report);
      if (!report.structural.ok) commandStatus = 1;
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
    return commandStatus;
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode;
    throw error;
  }
}
