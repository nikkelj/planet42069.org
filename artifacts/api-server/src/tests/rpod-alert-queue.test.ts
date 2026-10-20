/**
 * Pure checks for the RPOD alert queue gate (no database):
 *  - default mode is review; only RPOD_ALERT_MODE=auto posts directly
 *  - a failed queue write never posts, including in auto mode
 *  - startup DDL is idempotent (IF NOT EXISTS) and names the queue objects
 *  - the admin approve route recognizes Bearer and X-RPOD-Admin-Token
 *  - a closer approach scores above a distant one (queue ordering)
 *
 * Run with: pnpm --filter @workspace/api-server run test:rpod-policy
 */
import { readFileSync } from "node:fs";
import { adminTokenMatches, mayPostToX, presentedAdminToken, rpodAlertMode } from "../lib/rpod/alertMode";
import { provisionalAlertScore } from "../lib/rpod/alertScore";
import { dbErrorFields } from "../lib/dbError";
import { ensureRpodAlertSchema, RPOD_ALERT_SCHEMA_STATEMENTS } from "../lib/rpod/ensureAlertSchema";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

console.log("alert mode");
{
  check("unset env is review", rpodAlertMode({} as NodeJS.ProcessEnv) === "review");
  check("empty env is review", rpodAlertMode({ RPOD_ALERT_MODE: "" } as NodeJS.ProcessEnv) === "review");
  check("explicit review", rpodAlertMode({ RPOD_ALERT_MODE: "review" } as NodeJS.ProcessEnv) === "review");
  check("auto restores direct posting", rpodAlertMode({ RPOD_ALERT_MODE: "auto" } as NodeJS.ProcessEnv) === "auto");
  check("AUTO is case-insensitive", rpodAlertMode({ RPOD_ALERT_MODE: "AUTO" } as NodeJS.ProcessEnv) === "auto");
  check("unknown value stays in review", rpodAlertMode({ RPOD_ALERT_MODE: "yes" } as NodeJS.ProcessEnv) === "review");
}

console.log("post gate");
{
  check("review + healthy queue does not post", !mayPostToX("review", true));
  check("review + failed queue does not post", !mayPostToX("review", false));
  check("auto + failed queue does not post", !mayPostToX("auto", false));
  check("auto + healthy queue may post", mayPostToX("auto", true));
}

console.log("db error fields");
{
  const wrapped = Object.assign(new Error("Failed query: select"), {
    cause: Object.assign(new Error('relation "rpod_alert_queue" does not exist'), {
      code: "42P01",
      detail: "missing table",
    }),
  });
  const fields = dbErrorFields(wrapped);
  check("keeps the outer message", fields.message.includes("Failed query"));
  check("walks cause for the SQLSTATE", fields.code === "42P01");
  check("walks cause for the detail", fields.detail === "missing table");
  check("includes the postgres message", fields.cause?.includes("does not exist") === true);
}

console.log("startup schema");
{
  const sql = RPOD_ALERT_SCHEMA_STATEMENTS.join("\n");
  check("every statement is IF NOT EXISTS", RPOD_ALERT_SCHEMA_STATEMENTS.every((s) => s.includes("IF NOT EXISTS")));
  check("creates the queue table", sql.includes("CREATE TABLE IF NOT EXISTS rpod_alert_queue"));
  check("creates the exercise table", sql.includes("CREATE TABLE IF NOT EXISTS rpod_exercise_flags"));
  for (const column of ["scan_count", "first_min_range_km", "max_range_km", "last_elset_epochs", "suspected_cross_tag"]) {
    check(`adds rpod_events.${column}`, sql.includes(`ADD COLUMN IF NOT EXISTS ${column}`));
  }
  check("queue ledger unique index", sql.includes("rpod_alert_queue_ledger_uq"));
  const ran: string[] = [];
  let continued = false;
  try {
    await ensureRpodAlertSchema(async (statement) => {
      ran.push(statement);
      if (statement.includes("rpod_exercise_flags_norad_idx")) {
        throw Object.assign(new Error("permission denied"), { code: "42501" });
      }
    });
  } catch (err) {
    continued = err instanceof AggregateError && err.errors.length === 1
      && ran.length === RPOD_ALERT_SCHEMA_STATEMENTS.length;
  }
  check("a statement failure still runs the rest", continued);
  let threw = false;
  try {
    await ensureRpodAlertSchema(async () => {
      throw Object.assign(new Error("relation missing"), { code: "42P01" });
    });
  } catch (err) {
    threw = err instanceof AggregateError && err.errors.length === RPOD_ALERT_SCHEMA_STATEMENTS.length;
  }
  check("failures reject after every statement was attempted", threw);
}

console.log("review path does not call X");
{
  const src = readFileSync(new URL("../lib/rpod/alert.ts", import.meta.url), "utf8");
  const review = src.slice(src.indexOf("export async function publishPolicyItems"), src.indexOf("export async function rejectQueuedAlert"));
  const reviewBranch = review.slice(review.indexOf('rpodAlertMode() !== "auto"'), review.indexOf("const posting"));
  check("review publish returns before postAlertItems", reviewBranch.includes("return;") && !reviewBranch.includes("postToX(") && !reviewBranch.includes("postAlertItems("));
  check("review failure log says it will not post", reviewBranch.includes("review mode will not post"));
  const poster = src.slice(src.indexOf("async function postAlertItems"), src.indexOf("export async function postNewRpodEventAlerts"));
  const gateAt = poster.indexOf("mayPostToX(");
  const tweetAt = poster.indexOf("postToX(");
  check("auto post is gated on mayPostToX", gateAt > 0 && tweetAt > gateAt);
  check("queue insert is attempted before the post gate", poster.indexOf("enqueueRpodAlert(") < gateAt);
}

console.log("admin token");
{
  check("bearer token is extracted", presentedAdminToken("Bearer secret-token", null) === "secret-token");
  check("header token wins over bearer", presentedAdminToken("Bearer other", "header-token") === "header-token");
  check("missing credentials are null", presentedAdminToken(null, "  ") === null);
  check("matching token accepted", adminTokenMatches("s3cret", "s3cret"));
  check("wrong token rejected", !adminTokenMatches("nope", "s3cret"));
  check("different length rejected", !adminTokenMatches("s3cret!", "s3cret"));
  check("unset expected token rejected", !adminTokenMatches("s3cret", undefined));
  check("empty presented token rejected", !adminTokenMatches("", "s3cret"));
}

console.log("provisional score");
{
  const close = provisionalAlertScore({ minRangeKm: 1.2, relVelKmS: 0.002 });
  const far = provisionalAlertScore({ minRangeKm: 18, relVelKmS: 0.08 });
  check("closer slower approach outranks a distant one", close > far, `close=${close} far=${far}`);
  check("score is finite and non-negative", close > 0 && Number.isFinite(close));
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll RPOD alert-queue checks passed");
