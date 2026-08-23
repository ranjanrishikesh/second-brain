import { access } from "node:fs/promises";
import path from "node:path";
import { ZodError } from "zod";
import { loadBrainConfig } from "./config.js";

export interface DoctorIssue {
  code: string;
  severity: "error" | "warning";
  message: string;
  path?: string;
}

export interface DoctorReport {
  ok: boolean;
  issues: DoctorIssue[];
}

const requiredPaths = [
  "sources",
  "wiki",
  ".brain/source-manifest.json",
  ".brain/state.json",
] as const;

export async function doctorBrain(root: string): Promise<DoctorReport> {
  const issues: DoctorIssue[] = [];
  try {
    await loadBrainConfig(root);
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    issues.push({
      code: missing ? "CONFIG_MISSING" : "CONFIG_INVALID",
      severity: "error",
      message: missing
        ? "brain.config.yaml is missing"
        : error instanceof ZodError
          ? error.issues.map((issue) => issue.message).join("; ")
          : String(error),
      path: "brain.config.yaml",
    });
  }

  for (const relativePath of requiredPaths) {
    try {
      await access(path.join(root, relativePath));
    } catch {
      issues.push({
        code: "LAYOUT_MISSING",
        severity: "error",
        message: `Required brain path is missing: ${relativePath}`,
        path: relativePath,
      });
    }
  }

  return { ok: issues.every((issue) => issue.severity !== "error"), issues };
}
