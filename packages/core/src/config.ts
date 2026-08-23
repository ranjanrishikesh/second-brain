import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";

export const brainConfigV1Schema = z.object({
  version: z.literal(1),
  brain: z.object({
    name: z.string().trim().min(1),
    description: z
      .string()
      .trim()
      .default("A self-maintaining personal knowledge base."),
    language: z.string().trim().min(2).default("en"),
  }),
  sources: z
    .object({
      roots: z.array(z.string().trim().min(1)).min(1).default(["sources"]),
      maxFileBytes: z.number().int().positive().default(104_857_600),
    })
    .default({ roots: ["sources"], maxFileBytes: 104_857_600 }),
  bootstrap: z
    .object({
      mode: z.literal("catalog-map").default("catalog-map"),
      batchSize: z.number().int().positive().default(10),
    })
    .default({ mode: "catalog-map", batchSize: 10 }),
  learning: z
    .object({ mode: z.literal("durable").default("durable") })
    .default({ mode: "durable" }),
  web: z
    .object({ capture: z.literal("evidence").default("evidence") })
    .default({ capture: "evidence" }),
  graph: z
    .object({
      semanticAuditEvery: z.number().int().positive().default(25),
      relatedPageLimit: z.number().int().positive().default(20),
      pageTypes: z
        .array(z.string().trim().min(1))
        .default([
          "source",
          "topic",
          "entity",
          "concept",
          "synthesis",
          "question",
        ]),
      relationTypes: z
        .array(z.string().trim().min(1))
        .default([
          "related-to",
          "part-of",
          "instance-of",
          "causes",
          "influences",
          "supports",
          "contradicts",
          "compares-with",
          "depends-on",
          "supersedes",
        ]),
    })
    .default({
      semanticAuditEvery: 25,
      relatedPageLimit: 20,
      pageTypes: [
        "source",
        "topic",
        "entity",
        "concept",
        "synthesis",
        "question",
      ],
      relationTypes: [
        "related-to",
        "part-of",
        "instance-of",
        "causes",
        "influences",
        "supports",
        "contradicts",
        "compares-with",
        "depends-on",
        "supersedes",
      ],
    }),
  git: z
    .object({
      autoCommit: z.boolean().default(true),
      autoPush: z.literal(false).default(false),
    })
    .default({ autoCommit: true, autoPush: false }),
});

export type BrainConfigV1 = z.infer<typeof brainConfigV1Schema>;

export async function loadBrainConfig(root: string): Promise<BrainConfigV1> {
  const configPath = path.join(root, "brain.config.yaml");
  const source = await readFile(configPath, "utf8");
  return brainConfigV1Schema.parse(parse(source));
}
