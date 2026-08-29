import type { DocxOutputPolicyV1 } from "./types.js";

interface OutputBudget {
  maxBytes: number;
  usedBytes: number;
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === "object"
    ? (value as UnknownRecord)
    : undefined;
}

function outputLimitError(maxBytes: number): Error {
  return new Error(
    `Converted DOCX content exceeds configured maximum of ${maxBytes} bytes`,
  );
}

function addToBudget(budget: OutputBudget, bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw outputLimitError(budget.maxBytes);
  }
  if (bytes > budget.maxBytes - budget.usedBytes) {
    throw outputLimitError(budget.maxBytes);
  }
  budget.usedBytes += bytes;
}

function measureTree(
  value: unknown,
  budget: OutputBudget,
  references?: {
    notes: UnknownRecord[];
    comments: UnknownRecord[];
  },
): void {
  if (Array.isArray(value)) {
    for (const child of value) measureTree(child, budget, references);
    return;
  }
  const element = asRecord(value);
  if (!element) return;

  // Every parsed element can produce HTML structure even when it has no text.
  addToBudget(budget, 32);
  if (element.type === "text" && typeof element.value === "string") {
    addToBudget(budget, Buffer.byteLength(element.value, "utf8"));
  } else if (element.type === "tab" || element.type === "break") {
    addToBudget(budget, 1);
  } else if (element.type === "noteReference") {
    references?.notes.push(element);
  } else if (element.type === "commentReference") {
    references?.comments.push(element);
  }

  measureTree(element.children, budget, references);
}

function measureReferencedBody(
  reference: UnknownRecord,
  notes: UnknownRecord | undefined,
  budget: OutputBudget,
): void {
  const resolve = notes?.resolve;
  if (typeof resolve !== "function" || !notes) return;
  const note = asRecord(Reflect.apply(resolve, notes, [reference]));
  measureTree(note?.body, budget);
}

export function assertDocxSemanticOutputBudget(
  document: unknown,
  maxBytes: number,
  recordMeasuredBytes?: (bytes: number) => void,
): unknown {
  const root = asRecord(document);
  if (!root) throw new Error("DOCX converter returned an invalid document");
  const budget: OutputBudget = { maxBytes, usedBytes: 0 };
  const references = {
    notes: [] as UnknownRecord[],
    comments: [] as UnknownRecord[],
  };
  measureTree(root.children, budget, references);

  const notes = asRecord(root.notes);
  for (const reference of references.notes) {
    measureReferencedBody(reference, notes, budget);
  }

  const comments = Array.isArray(root.comments) ? root.comments : [];
  const commentsById = new Map<unknown, UnknownRecord>();
  for (const value of comments) {
    const comment = asRecord(value);
    if (comment) commentsById.set(comment.commentId, comment);
  }
  for (const reference of references.comments) {
    measureTree(commentsById.get(reference.commentId)?.body, budget);
  }

  recordMeasuredBytes?.(budget.usedBytes);
  return document;
}

export function assertDocxOutputSize(value: string, maxBytes: number): number {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > maxBytes) {
    throw outputLimitError(maxBytes);
  }
  return bytes;
}

export function assertDocxOutputPolicy(
  policy: DocxOutputPolicyV1,
  maxBytes: number,
): void {
  if (
    Math.max(
      policy.semanticBytes,
      policy.convertedBytes,
      policy.extractedBytes,
    ) > maxBytes
  ) {
    throw outputLimitError(maxBytes);
  }
}
