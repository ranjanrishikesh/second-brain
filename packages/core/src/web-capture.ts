import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { stringify } from "yaml";
import { z } from "zod";
import {
  readQuerySession,
  refreshQueryBootstrap,
  writeQuerySession,
  type QuerySessionV1,
} from "./query.js";
import { scanAndRegisterSources } from "./source-transaction.js";
import { sourceRecordV1Schema, type SourceRecordV1 } from "./sources/types.js";

const webCaptureInputSchema = z.object({
  url: z.url(),
  title: z.string().trim().min(1),
  captureKind: z.enum(["page", "snippet"]),
  content: z.string().trim().min(1),
  retrievedAt: z.iso.datetime().optional(),
});

export type WebCaptureInput = z.infer<typeof webCaptureInputSchema>;

export interface WebCaptureResult {
  source: SourceRecordV1;
  session: QuerySessionV1;
  created: boolean;
}

export interface WebCaptureTestOptions {
  /** Deterministic fault injection; never use outside tests. */
  simulateSessionWriteFailure?: boolean;
}

function slugify(value: string): string {
  return (
    value
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 64) || "web-evidence"
  );
}

async function readSources(root: string): Promise<SourceRecordV1[]> {
  const manifest = JSON.parse(
    await readFile(path.join(root, ".brain", "source-manifest.json"), "utf8"),
  ) as { sources?: unknown[] };
  return (manifest.sources ?? []).map((source) =>
    sourceRecordV1Schema.parse(source),
  );
}

export async function captureWebEvidence(
  root: string,
  queryId: string,
  rawInput: WebCaptureInput,
  testOptions: WebCaptureTestOptions = {},
): Promise<WebCaptureResult> {
  const input = webCaptureInputSchema.parse(rawInput);
  const protocol = new URL(input.url).protocol;
  if (protocol !== "https:" && protocol !== "http:") {
    throw new Error("Web evidence URL must use HTTP or HTTPS");
  }
  const session = await readQuerySession(root, queryId);
  if (session.status !== "open" || session.currentTier !== "web") {
    throw new Error(
      "Web evidence can only be captured for an open query at the web tier",
    );
  }

  const evidenceDigest = createHash("sha256")
    .update(`${input.url}\0${input.content}`)
    .digest("hex");
  const sources = await readSources(root);
  const duplicate = sources.find(
    (source) =>
      source.provenance.kind === "web" &&
      source.provenance.url === input.url &&
      source.path.endsWith(`-${evidenceDigest.slice(0, 12)}.md`),
  );
  if (duplicate) {
    if (!session.webEvidenceSourceIds.includes(duplicate.id)) {
      session.webEvidenceSourceIds.push(duplicate.id);
    }
    await refreshQueryBootstrap(root, session);
    await writeQuerySession(root, session);
    return { source: duplicate, session, created: false };
  }

  const retrievedAt = input.retrievedAt ?? new Date().toISOString();
  const retrievedDate = new Date(retrievedAt);
  const year = String(retrievedDate.getUTCFullYear());
  const month = String(retrievedDate.getUTCMonth() + 1).padStart(2, "0");
  const relativePath = path.posix.join(
    "sources",
    "web",
    year,
    month,
    `${slugify(input.title)}-${evidenceDigest.slice(0, 12)}.md`,
  );
  const previous = sources
    .filter(
      (source) =>
        source.provenance.kind === "web" && source.provenance.url === input.url,
    )
    .sort((left, right) =>
      (right.provenance.retrievedAt ?? right.discoveredAt).localeCompare(
        left.provenance.retrievedAt ?? left.discoveredAt,
      ),
    )[0];
  const metadata = {
    brainWebCapture: 1,
    url: input.url,
    retrievedAt,
    query: session.question,
    captureKind: input.captureKind,
    title: input.title,
    contentSha256: createHash("sha256").update(input.content).digest("hex"),
    ...(previous ? { supersedes: previous.id } : {}),
  };
  const absolutePath = path.join(root, relativePath);
  const captureMarkdown = `---\n${stringify(metadata).trimEnd()}\n---\n\n# ${input.title}\n\n${input.content.trim()}\n`;
  await mkdir(path.dirname(absolutePath), { recursive: true });
  try {
    await writeFile(absolutePath, captureMarkdown, {
      encoding: "utf8",
      flag: "wx",
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const prepared = await readFile(absolutePath, "utf8");
    if (prepared !== captureMarkdown) {
      throw new Error(
        `Prepared web evidence bytes do not match the requested capture: ${relativePath}`,
      );
    }
  }
  // A prepared capture is immutable source input. If registration or session
  // linkage is interrupted, preserve it for a later scan instead of racing a
  // concurrent canonical writer with cleanup.
  const scan = await scanAndRegisterSources(root);
  const addedSource = scan.added.find(
    (candidate) => candidate.path === relativePath,
  );
  const source =
    addedSource ??
    scan.unchanged.find((candidate) => candidate.path === relativePath);
  if (!source)
    throw new Error(`Captured source was not registered: ${relativePath}`);
  session.webEvidenceSourceIds.push(source.id);
  session.bootstrap.required = true;
  if (!session.bootstrap.pendingSourceIds.includes(source.id)) {
    session.bootstrap.pendingSourceIds.push(source.id);
    session.bootstrap.pendingSourceIds.sort();
  }
  if (testOptions.simulateSessionWriteFailure) {
    throw new Error("Simulated query session write failure");
  }
  await writeQuerySession(root, session);
  return { source, session, created: Boolean(addedSource) };
}
