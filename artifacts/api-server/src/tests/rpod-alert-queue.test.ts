/**
 * Pure checks for the RPOD alert queue gate (no database):
 *  - default mode is review; only RPOD_ALERT_MODE=auto posts directly
 *  - the admin approve route recognizes Bearer and X-RPOD-Admin-Token
 *  - a closer approach scores above a distant one (queue ordering)
 *
 * Run with: pnpm --filter @workspace/api-server run test:rpod-policy
 */
import { adminTokenMatches, presentedAdminToken, rpodAlertMode } from "../lib/rpod/alertMode";
import { provisionalAlertScore } from "../lib/rpod/alertScore";

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
