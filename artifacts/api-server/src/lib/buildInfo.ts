import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Replaced with a quoted SHA by esbuild (artifacts/api-server/build.mjs).
 * Under tsx the identifier is absent; `typeof` on an unresolved binding is
 * "undefined" and does not throw.
 */
declare const __BUILD_COMMIT__: string | undefined;

const SHA = /^[0-9a-f]{7,40}$/i;

const ENV_KEYS = ["BUILD_COMMIT", "GIT_COMMIT", "COMMIT_SHA", "SOURCE_VERSION", "REPLIT_GIT_COMMIT"] as const;

function shaOrNull(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return SHA.test(trimmed) ? trimmed : null;
}

function fromBundle(): string | null {
  return typeof __BUILD_COMMIT__ === "string" ? shaOrNull(__BUILD_COMMIT__) : null;
}

function fromEnv(): string | null {
  for (const key of ENV_KEYS) {
    const sha = shaOrNull(process.env[key]);
    if (sha) return sha;
  }
  return null;
}

function fromGit(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const roots = [process.cwd(), join(here, "../../../.."), join(here, "../../..")];
  for (const cwd of roots) {
    try {
      const sha = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd,
        encoding: "utf8",
        timeout: 1000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      const parsed = shaOrNull(sha);
      if (parsed) return parsed;
    } catch {
      // This directory is not a git checkout. Try the next candidate.
    }
  }
  return null;
}

let cached: string | null = null;

/**
 * Git SHA of the running server, or "unknown".
 * Resolved once. No database query, no per-request git process.
 */
export function buildCommit(): string {
  if (cached) return cached;
  cached = fromBundle() ?? fromEnv() ?? fromGit() ?? "unknown";
  return cached;
}
