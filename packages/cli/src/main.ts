#!/usr/bin/env node
import { runCli } from "./program.js";

const exitCode = await runCli(process.argv.slice(2), {
  write: (value) => process.stdout.write(value),
});
process.exitCode = exitCode;
