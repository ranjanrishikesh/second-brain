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

  test("reports status and reads a source locator as JSON", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-cli-status-"));
    await runCli(
      [
        "init",
        "--root",
        root,
        "--name",
        "Status",
        "--description",
        "Status CLI test",
      ],
      { write: () => undefined },
    );
    await writeFile(
      path.join(root, "sources", "stars.md"),
      "# Stars\n\nStars emit light.\n",
    );
    const scanOutput: string[] = [];
    await runCli(["source", "scan", "--root", root, "--json"], {
      write: (value) => scanOutput.push(value),
    });
    const sourceId = JSON.parse(scanOutput.join("")).added[0].id as string;
    const statusOutput: string[] = [];
    const readOutput: string[] = [];

    expect(
      await runCli(["status", "--root", root, "--json"], {
        write: (value) => statusOutput.push(value),
      }),
    ).toBe(0);
    expect(
      await runCli(
        [
          "read",
          sourceId,
          "--locator",
          "heading=stars",
          "--root",
          root,
          "--json",
        ],
        { write: (value) => readOutput.push(value) },
      ),
    ).toBe(0);

    expect(JSON.parse(statusOutput.join(""))).toMatchObject({
      sources: { total: 1, ready: 1 },
      bootstrap: { required: true },
    });
    expect(JSON.parse(readOutput.join(""))).toMatchObject({
      kind: "source",
      chunks: [{ locator: "heading=stars" }],
    });
  });

  test("does not allow the CLI to enter web without a core approval", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-cli-query-"));
    await runCli(
      [
        "init",
        "--root",
        root,
        "--name",
        "Queries",
        "--description",
        "Query CLI test",
      ],
      { write: () => undefined },
    );
    const beginOutput: string[] = [];
    await runCli(
      ["query", "begin", "What is a pulsar?", "--root", root, "--json"],
      { write: (value) => beginOutput.push(value) },
    );
    const session = JSON.parse(beginOutput.join("")) as { id: string };
    const sourceOutput: string[] = [];

    await runCli(
      [
        "query",
        "expand",
        session.id,
        "--tier",
        "sources",
        "--reason",
        "The wiki has no answer.",
        "--root",
        root,
        "--json",
      ],
      { write: (value) => sourceOutput.push(value) },
    );
    await expect(
      runCli(
        [
          "query",
          "expand",
          session.id,
          "--tier",
          "web",
          "--reason",
          "The sources have no answer.",
          "--root",
          root,
          "--json",
        ],
        { write: () => undefined },
      ),
    ).rejects.toThrow(/web approval/i);

    expect(JSON.parse(sourceOutput.join(""))).toMatchObject({
      currentTier: "sources",
      tiersUsed: ["wiki", "sources"],
    });
  });
});
