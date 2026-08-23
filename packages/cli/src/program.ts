import {
  doctorBrain,
  initBrain,
  rebuildSearchIndex,
  scanSources,
  searchBrain,
  type SearchScope,
} from "@second-brain/core";
import { Command, CommanderError, Option } from "commander";

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

  const source = program
    .command("source")
    .description("Manage immutable raw sources");
  source
    .command("scan")
    .option("--root <path>", "brain repository root", process.cwd())
    .option("--json", "emit machine-readable JSON")
    .action(async (options: { root: string; json?: boolean }) => {
      const result = await scanSources(options.root);
      if (options.json) output.write(`${JSON.stringify(result, null, 2)}\n`);
      else {
        output.write(
          `Sources: ${result.added.length} added, ${result.unchanged.length} unchanged, ${result.modified.length} modified, ${result.deleted.length} deleted.\n`,
        );
      }
    });

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

  try {
    await program.parseAsync(args, { from: "user" });
    return 0;
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode;
    throw error;
  }
}
