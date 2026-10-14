import { pool } from "@workspace/db";
import { logger } from "./logger";

let started = false;

/** Observability only: no new connections, queries, credentials, or pool tuning. */
export function startDbDiagnostics(): void {
  if (started) return;
  started = true;
  const held = new Map<object, number>();
  pool.on("acquire", (client) => held.set(client, Date.now()));
  pool.on("release", (_err, client) => { held.delete(client); });
  pool.on("remove", (client) => { held.delete(client); });
  let samples = 0;
  const timer = setInterval(() => {
    const now = Date.now();
    let longestCheckoutMs = 0;
    for (const since of held.values()) {
      longestCheckoutMs = Math.max(longestCheckoutMs, now - since);
    }
    const stats = {
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount,
      checkedOut: pool.totalCount - pool.idleCount,
      longestCheckoutMs,
    };
    if (stats.waiting > 0) logger.warn(stats, "db: pool checkout pressure");
    else if (++samples % 10 === 0) logger.info(stats, "db: pool snapshot");
  }, 30_000);
  timer.unref();
}
