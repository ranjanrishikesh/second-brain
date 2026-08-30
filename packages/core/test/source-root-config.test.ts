import { describe, expect, test } from "vitest";
import { z } from "zod";
import { brainConfigV1Schema, brainJsonSchemasV1 } from "../src/index.js";

const baseConfig = {
  version: 1,
  brain: { name: "Source root test" },
} as const;

const emittedBrainConfigSchema = z.fromJSONSchema(
  brainJsonSchemasV1.BrainConfigV1 as Parameters<typeof z.fromJSONSchema>[0],
);

function configWithSourceRoot(sourceRoot: string) {
  return {
    ...baseConfig,
    sources: { roots: [sourceRoot] },
  };
}

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
      brainConfigV1Schema.safeParse(configWithSourceRoot(sourceRoot)).success,
    ).toBe(false);
  });

  test.each([
    "sources",
    "documents/research",
    ".sources/private files",
    "research notes/星 系",
    "स्रोत/अनुसंधान सामग्री",
  ])("accepts canonical repository-relative root %j", (sourceRoot) => {
    expect(
      brainConfigV1Schema.parse(configWithSourceRoot(sourceRoot)).sources.roots,
    ).toEqual([sourceRoot]);
    expect(
      emittedBrainConfigSchema.safeParse(configWithSourceRoot(sourceRoot))
        .success,
    ).toBe(true);
  });

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
    expect(
      emittedBrainConfigSchema.safeParse(configWithSourceRoot(sourceRoot))
        .success,
    ).toBe(false);
  });

  test.each([
    ["LF traversal", "safe\n/../outside"],
    ["LF backslash traversal", "safe\n\\..\\outside"],
    ["LF drive", "safe\nC:/outside"],
    ["LF UNC", "safe\n\\\\server\\share"],
    ["CR traversal", "safe\r/../outside"],
    ["CR backslash traversal", "safe\r\\..\\outside"],
    ["CR drive", "safe\rC:/outside"],
    ["CR UNC", "safe\r\\\\server\\share"],
    ["CRLF traversal", "safe\r\n/../outside"],
    ["CRLF backslash traversal", "safe\r\n\\..\\outside"],
    ["CRLF drive", "safe\r\nC:/outside"],
    ["CRLF UNC", "safe\r\n\\\\server\\share"],
    ["line separator traversal", "safe\u2028/../outside"],
    ["line separator backslash traversal", "safe\u2028\\..\\outside"],
    ["line separator drive", "safe\u2028C:/outside"],
    ["line separator UNC", "safe\u2028\\\\server\\share"],
    ["paragraph separator traversal", "safe\u2029/../outside"],
    ["paragraph separator backslash traversal", "safe\u2029\\..\\outside"],
    ["paragraph separator drive", "safe\u2029C:/outside"],
    ["paragraph separator UNC", "safe\u2029\\\\server\\share"],
  ])("rejects a line-terminator escape: %s", (_label, sourceRoot) => {
    expect(
      brainConfigV1Schema.safeParse(configWithSourceRoot(sourceRoot)).success,
    ).toBe(false);
    expect(
      emittedBrainConfigSchema.safeParse(configWithSourceRoot(sourceRoot))
        .success,
    ).toBe(false);
  });

  test.each([...Array.from({ length: 32 }, (_, codePoint) => codePoint), 0x7f])(
    "rejects C0/DEL control code point %i",
    (codePoint) => {
      const sourceRoot = `safe${String.fromCodePoint(codePoint)}segment`;

      expect(
        brainConfigV1Schema.safeParse(configWithSourceRoot(sourceRoot)).success,
      ).toBe(false);
      expect(
        emittedBrainConfigSchema.safeParse(configWithSourceRoot(sourceRoot))
          .success,
      ).toBe(false);
    },
  );
});
