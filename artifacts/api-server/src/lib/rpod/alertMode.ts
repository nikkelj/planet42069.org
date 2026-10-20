import { timingSafeEqual } from "node:crypto";

/**
 * Where a would-be RPOD citation goes.
 *
 *  - "review" (default): queue the text, do not call X.
 *  - "auto": RPOD_ALERT_MODE=auto restores the direct post path.
 */
export type RpodAlertMode = "review" | "auto";

export function rpodAlertMode(env: NodeJS.ProcessEnv = process.env): RpodAlertMode {
  return env.RPOD_ALERT_MODE?.trim().toLowerCase() === "auto" ? "auto" : "review";
}

/**
 * Direct X posts require auto mode AND a queue row already on disk.
 * Review mode never posts. A failed queue insert never posts, including
 * when RPOD_ALERT_MODE=auto — the scan degrades to "hold" instead.
 * Human approve is a separate path and does not use this gate.
 */
export function mayPostToX(mode: RpodAlertMode, queueWriteOk: boolean): boolean {
  return mode === "auto" && queueWriteOk;
}

/** Bearer token or the dedicated header. Empty string is treated as absent. */
export function presentedAdminToken(
  authorization: string | undefined | null,
  headerToken: string | undefined | null,
): string | null {
  const header = headerToken?.trim();
  if (header) return header;
  const auth = authorization?.trim();
  if (!auth) return null;
  const m = /^bearer\s+(\S+)/i.exec(auth);
  return m ? m[1] : null;
}

/** Constant-time compare against RPOD_ADMIN_TOKEN. Missing config never matches. */
export function adminTokenMatches(
  presented: string | null | undefined,
  expected: string | null | undefined = process.env.RPOD_ADMIN_TOKEN,
): boolean {
  if (!presented || !expected) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
