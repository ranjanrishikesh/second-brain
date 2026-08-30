import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";

export const defaultSemanticModelV1 = {
  id: "Xenova/multilingual-e5-small",
  revision: "761b726dd34fb83930e26aab4e9ac3899aa1fa78",
  artifactSha256:
    "f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193",
} as const;

export const defaultIssueTrackerUrl =
  "https://github.com/ranjanrishikesh/second-brain/issues";

const absoluteHttpsUrlV1Schema = z
  .string()
  .url()
  .startsWith(
    "https://",
    "support.issueTrackerUrl must be an absolute HTTPS URL",
  );

const semanticModelV1Schema = z.object({
  id: z.literal(defaultSemanticModelV1.id).default(defaultSemanticModelV1.id),
  revision: z
    .literal(defaultSemanticModelV1.revision)
    .default(defaultSemanticModelV1.revision),
  artifactSha256: z
    .literal(defaultSemanticModelV1.artifactSha256)
    .default(defaultSemanticModelV1.artifactSha256),
});

const defaultPdfSourcePolicyV1 = {
  maxPages: 2_000,
  maxExtractedBytes: 104_857_600,
} as const;

const defaultEpubSourcePolicyV1 = {
  maxEntries: 1_000,
  maxExpandedBytes: 104_857_600,
  maxExtractedBytes: 104_857_600,
} as const;

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
  support: z
    .object({
      issueTrackerUrl: absoluteHttpsUrlV1Schema.default(defaultIssueTrackerUrl),
    })
    .default({ issueTrackerUrl: defaultIssueTrackerUrl }),
  sources: z
    .object({
      roots: z.array(z.string().trim().min(1)).min(1).default(["sources"]),
      maxFileBytes: z.number().int().positive().default(104_857_600),
      pdf: z
        .object({
          maxPages: z.number().int().positive().default(2_000),
          maxExtractedBytes: z.number().int().positive().default(104_857_600),
        })
        .default(defaultPdfSourcePolicyV1),
      epub: z
        .object({
          maxEntries: z.number().int().positive().default(1_000),
          maxExpandedBytes: z.number().int().positive().default(104_857_600),
          maxExtractedBytes: z.number().int().positive().default(104_857_600),
        })
        .default(defaultEpubSourcePolicyV1),
    })
    .default({
      roots: ["sources"],
      maxFileBytes: 104_857_600,
      pdf: defaultPdfSourcePolicyV1,
      epub: defaultEpubSourcePolicyV1,
    }),
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
    .object({
      capture: z.literal("evidence").default("evidence"),
      approvalTtlHours: z.number().int().positive().default(24),
    })
    .default({ capture: "evidence", approvalTtlHours: 24 }),
  graph: z
    .object({
      semanticAuditEvery: z.number().int().positive().default(25),
      relatedPageLimit: z.number().int().positive().default(20),
      semanticModel: semanticModelV1Schema.default(defaultSemanticModelV1),
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
      semanticModel: defaultSemanticModelV1,
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
      autoPush: z.boolean().default(false),
    })
    .default({ autoCommit: true, autoPush: false }),
});

export type BrainConfigV1 = z.infer<typeof brainConfigV1Schema>;

export async function loadBrainConfig(root: string): Promise<BrainConfigV1> {
  const configPath = path.join(root, "brain.config.yaml");
  const source = await readFile(configPath, "utf8");
  return brainConfigV1Schema.parse(parse(source));
}
