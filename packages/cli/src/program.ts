import { doctorBrain, initBrain } from "@second-brain/core";
import { Command, CommanderError } from "commander";

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

  try {
    await program.parseAsync(args, { from: "user" });
    return 0;
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode;
    throw error;
  }
}
