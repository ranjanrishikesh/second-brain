import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { runCli } from "../src/program.js";

describe("brain CLI", () => {
  test("initializes a brain from explicit arguments", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-cli-"));
    const output: string[] = [];

    const exitCode = await runCli(
      [
        "init",
        "--root",
        root,
        "--name",
        "Fiction",
        "--description",
        "Books and worlds",
      ],
      { write: (value) => output.push(value) },
    );

    expect(exitCode).toBe(0);
    expect(await readFile(path.join(root, "BRAIN.md"), "utf8")).toContain(
      "# Fiction",
    );
    expect(output.join("")).toContain("Initialized Fiction");
  });

  test("reports a healthy initialized brain", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-cli-doctor-"));
    await runCli(
      [
        "init",
        "--root",
        root,
        "--name",
        "Health",
        "--description",
        "Health test",
      ],
      { write: () => undefined },
    );
    const output: string[] = [];

    const exitCode = await runCli(["doctor", "--root", root, "--json"], {
      write: (value) => output.push(value),
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(output.join(""))).toMatchObject({ ok: true, issues: [] });
  });

  test("scans sources and emits machine-readable results", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-cli-scan-"));
    await runCli(
      [
        "init",
        "--root",
        root,
        "--name",
        "Sources",
        "--description",
        "Source CLI test",
      ],
      { write: () => undefined },
    );
    await writeFile(
      path.join(root, "sources", "note.md"),
      "# Note\n\nCLI source scan.\n",
    );
    const output: string[] = [];

    const exitCode = await runCli(
      ["source", "scan", "--root", root, "--json"],
      {
        write: (value) => output.push(value),
      },
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(output.join("")).added[0].path).toBe("sources/note.md");
  });

  test("searches a selected brain scope", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-cli-search-"));
    await runCli(
      [
        "init",
        "--root",
        root,
        "--name",
        "Search",
        "--description",
        "Search CLI test",
      ],
      { write: () => undefined },
    );
    await writeFile(
      path.join(root, "sources", "note.md"),
      "# Note\n\nQuasars are luminous.\n",
    );
    await runCli(["source", "scan", "--root", root], {
      write: () => undefined,
    });
    const output: string[] = [];

    const exitCode = await runCli(
      [
        "search",
        "--root",
        root,
        "--query",
        "quasars",
        "--scope",
        "sources",
        "--json",
      ],
      { write: (value) => output.push(value) },
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(output.join(""))[0].path).toBe("sources/note.md");
  });
});
