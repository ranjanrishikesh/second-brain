import { describe, expect, test } from "vitest";
import { z } from "zod";
import { brainConfigV1Schema, brainJsonSchemasV1 } from "../src/index.js";

const baseConfig = {
  version: 1,
  brain: { name: "Source root test" },
} as const;

describe("sources.roots configuration", () => {
  test.each([
    "",
    "   ",
    "/private/sources",
    "C:/private/sources",
    "C:private/sources",
    "C:\\private\\sources",
    "\\\\server\\share\\sources",
    ".",
    "./sources",
    "documents/./research",
    "..",
    "../sources",
    "documents/../sources",
    "documents\\..\\sources",
    "documents\\research",
    "documents//research",
    "documents/research/",
  ])("rejects non-canonical or escaping root %j", (sourceRoot) => {
    expect(
      brainConfigV1Schema.safeParse({
        ...baseConfig,
        sources: { roots: [sourceRoot] },
      }).success,
    ).toBe(false);
  });

  test.each(["sources", "documents/research", ".sources/private files"])(
    "accepts canonical repository-relative root %j",
    (sourceRoot) => {
      expect(
        brainConfigV1Schema.parse({
          ...baseConfig,
          sources: { roots: [sourceRoot] },
        }).sources.roots,
      ).toEqual([sourceRoot]);
    },
  );

  test("keeps the default root for configurations that omit it", () => {
    expect(brainConfigV1Schema.parse(baseConfig).sources.roots).toEqual([
      "sources",
    ]);
    expect(
      brainConfigV1Schema.parse({
        ...baseConfig,
        sources: { maxFileBytes: 4_096 },
      }).sources.roots,
    ).toEqual(["sources"]);
  });

  test.each([
    "",
    "   ",
    "/private/sources",
    "C:/private/sources",
    "C:private/sources",
    "C:\\private\\sources",
    "\\\\server\\share\\sources",
    ".",
    "./sources",
    "documents/./research",
    "..",
    "../sources",
    "documents/../sources",
    "documents\\..\\sources",
    "documents\\research",
    "documents//research",
    "documents/research/",
  ])("emitted JSON schema rejects unsafe root %j", (sourceRoot) => {
    const emittedSchema = z.fromJSONSchema(
      brainJsonSchemasV1.BrainConfigV1 as Parameters<
        typeof z.fromJSONSchema
      >[0],
    );

    expect(
      emittedSchema.safeParse({
        ...baseConfig,
        sources: { roots: [sourceRoot] },
      }).success,
    ).toBe(false);
  });
});
