/**
 * Postgres (and drizzle-wrapped) failures hide the useful fields on `cause`.
 * Pull message, SQLSTATE, and detail off the chain so logs show 42P01 etc.
 */
export interface DbErrorFields {
  message: string;
  code?: string;
  detail?: string;
  cause?: string;
}

export function dbErrorFields(err: unknown): DbErrorFields {
  const messages: string[] = [];
  let code: string | undefined;
  let detail: string | undefined;
  let current: unknown = err;
  const seen = new Set<unknown>();
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const row = current as { message?: unknown; code?: unknown; detail?: unknown; cause?: unknown };
    if (typeof row.message === "string" && row.message.length > 0) messages.push(row.message);
    if (!code && typeof row.code === "string" && row.code.length > 0) code = row.code;
    if (!detail && typeof row.detail === "string" && row.detail.length > 0) detail = row.detail;
    current = row.cause;
  }
  if (messages.length === 0 && err != null) messages.push(String(err));
  return {
    message: messages[0] ?? "unknown error",
    ...(code ? { code } : {}),
    ...(detail ? { detail } : {}),
    ...(messages.length > 1 ? { cause: messages.slice(1).join(" | ") } : {}),
  };
}
