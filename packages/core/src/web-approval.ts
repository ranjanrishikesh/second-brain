import { createHash } from "node:crypto";
import { z } from "zod";
import { loadBrainConfig } from "./config.js";
import {
  readQuerySession,
  writeQuerySession,
  type QuerySessionV1,
} from "./query.js";

const queryIdV1Schema = z.string().regex(/^qry_[a-f0-9]{32}$/);
const questionHashV1Schema = z.string().regex(/^[a-f0-9]{64}$/);
const approvalIdentityV1Schema = z.object({
  version: z.literal(1),
  queryId: queryIdV1Schema,
  questionHash: questionHashV1Schema,
  hostSessionId: z.string().trim().min(1),
  requestedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
});

export const webApprovalRequestV1Schema = approvalIdentityV1Schema.extend({
  status: z.literal("requested"),
  reason: z.string().trim().min(1),
});

const approvedWebApprovalV1Schema = approvalIdentityV1Schema.extend({
  status: z.literal("approved"),
  reason: z.string().trim().min(1),
  decidedAt: z.string().datetime(),
  decidedBy: z.string().trim().min(1),
});

const deniedWebApprovalV1Schema = approvalIdentityV1Schema.extend({
  status: z.literal("denied"),
  reason: z.string().trim().min(1),
  decidedAt: z.string().datetime(),
  decidedBy: z.string().trim().min(1),
  denialReason: z.string().trim().min(1).optional(),
});

const expiredWebApprovalV1Schema = approvalIdentityV1Schema.extend({
  status: z.literal("expired"),
  reason: z.string().trim().min(1),
  decidedAt: z.string().datetime().optional(),
  decidedBy: z.string().trim().min(1).optional(),
  denialReason: z.string().trim().min(1).optional(),
});

export const webApprovalV1Schema = z.discriminatedUnion("status", [
  webApprovalRequestV1Schema,
  approvedWebApprovalV1Schema,
  deniedWebApprovalV1Schema,
  expiredWebApprovalV1Schema,
]);

export type WebApprovalRequestV1 = z.infer<typeof webApprovalRequestV1Schema>;
export type WebApprovalV1 = z.infer<typeof webApprovalV1Schema>;

const requestWebApprovalInputSchema = z.object({
  reason: z.string().trim().min(1),
  hostSessionId: z.string().trim().min(1),
});

export type RequestWebApprovalInput = z.infer<
  typeof requestWebApprovalInputSchema
>;

const resolveWebApprovalInputSchema = z.object({
  approved: z.boolean(),
  decidedBy: z.string().trim().min(1),
  denialReason: z.string().trim().min(1).optional(),
});

export type ResolveWebApprovalInput = z.infer<
  typeof resolveWebApprovalInputSchema
>;

function normalizedQuestion(question: string): string {
  return question
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("en");
}

export function calculateQuestionHash(question: string): string {
  return createHash("sha256")
    .update(normalizedQuestion(question))
    .digest("hex");
}

function assertMatchesSession(
  session: QuerySessionV1,
  approval: WebApprovalV1,
): void {
  if (
    approval.queryId !== session.id ||
    approval.questionHash !== calculateQuestionHash(session.question)
  ) {
    throw new Error("Web approval is not bound to the active question");
  }
}

function isExpired(approval: WebApprovalV1, now: Date): boolean {
  return now.getTime() >= new Date(approval.expiresAt).getTime();
}

async function expireApprovalIfNeeded(
  root: string,
  session: QuerySessionV1,
  now: Date,
): Promise<WebApprovalV1 | undefined> {
  const approval = session.webApproval;
  if (!approval) return undefined;
  assertMatchesSession(session, approval);
  if (approval.status !== "expired" && isExpired(approval, now)) {
    session.webApproval = webApprovalV1Schema.parse({
      ...approval,
      status: "expired",
    });
    await writeQuerySession(root, session);
  }
  return session.webApproval;
}

/** Requests one user decision covering all relevant web research for this query. */
export async function requestWebApproval(
  root: string,
  queryId: string,
  rawInput: RequestWebApprovalInput,
): Promise<WebApprovalRequestV1> {
  const input = requestWebApprovalInputSchema.parse(rawInput);
  const session = await readQuerySession(root, queryId);
  if (session.status !== "open" || session.currentTier !== "sources") {
    throw new Error(
      "Web approval can only be requested for an open sources-tier query",
    );
  }
  const now = new Date();
  const existing = await expireApprovalIfNeeded(root, session, now);
  if (existing?.status === "approved") {
    throw new Error("Web approval is already approved for this query");
  }
  const config = await loadBrainConfig(root);
  const approval = webApprovalRequestV1Schema.parse({
    version: 1,
    queryId: session.id,
    questionHash: calculateQuestionHash(session.question),
    hostSessionId: input.hostSessionId,
    status: "requested",
    reason: input.reason,
    requestedAt: now.toISOString(),
    expiresAt: new Date(
      now.getTime() + config.web.approvalTtlHours * 60 * 60 * 1000,
    ).toISOString(),
  });
  session.webApproval = approval;
  await writeQuerySession(root, session);
  return approval;
}

/** Records the owner's approval or denial without changing the query tier. */
export async function resolveWebApproval(
  root: string,
  queryId: string,
  rawInput: ResolveWebApprovalInput,
): Promise<QuerySessionV1> {
  const input = resolveWebApprovalInputSchema.parse(rawInput);
  const session = await readQuerySession(root, queryId);
  if (session.status !== "open" || session.currentTier !== "sources") {
    throw new Error(
      "Web approval can only be resolved for an open sources-tier query",
    );
  }
  const approval = await expireApprovalIfNeeded(root, session, new Date());
  if (approval?.status === "expired") {
    throw new Error("Web approval for this query has expired");
  }
  if (approval?.status !== "requested") {
    throw new Error("A pending web approval request is required");
  }
  const now = new Date().toISOString();
  session.webApproval = webApprovalV1Schema.parse({
    ...approval,
    status: input.approved ? "approved" : "denied",
    decidedAt: now,
    decidedBy: input.decidedBy,
    ...(!input.approved && input.denialReason
      ? { denialReason: input.denialReason }
      : {}),
  });
  await writeQuerySession(root, session);
  return session;
}

/** Rejects web activity unless the matching query has an unexpired approval. */
export async function assertWebApproval(
  root: string,
  queryId: string,
): Promise<WebApprovalV1> {
  const session = await readQuerySession(root, queryId);
  const approval = await expireApprovalIfNeeded(root, session, new Date());
  if (!approval) throw new Error("Web approval is required for this query");
  if (approval.status === "expired") {
    throw new Error("Web approval for this query has expired");
  }
  if (approval.status === "denied") {
    throw new Error("Web approval for this query was denied");
  }
  if (approval.status !== "approved") {
    throw new Error("Web approval is still pending for this query");
  }
  assertMatchesSession(session, approval);
  return approval;
}
