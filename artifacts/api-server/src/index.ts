import app from "./app";
import { logger } from "./lib/logger";
import { dbErrorFields } from "./lib/dbError";
import { ensureRpodAlertSchema } from "./lib/rpod/ensureAlertSchema";
import { ensureLatestElsetTable } from "./lib/obc/latestElset";
import { startObcScheduler } from "./lib/obc/scheduler";

/**
 * Process-level safety net for transient infrastructure errors.
 *
 * Background workers catch their own failures, but a brief database socket
 * drop (ECONNRESET, "Client network socket disconnected before secure TLS
 * connection was established") can still surface as an unhandled rejection
 * or uncaught exception from deep inside driver internals. Crashing the
 * whole process over a blip turns a 2-second outage into a crash loop, so:
 *  - unhandled rejections are always logged and survived (nothing here
 *    depends on a rejected promise's continuation);
 *  - uncaught exceptions are survived only when recognizably transient
 *    network/DB errors; anything else still exits (state may be corrupt).
 */
const TRANSIENT_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "ENOTFOUND",
  "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH",
  // Postgres: admin shutdown / crash shutdown / cannot connect now
  "57P01", "57P02", "57P03",
]);
const TRANSIENT_PATTERNS = [
  /socket disconnected before secure TLS/i,
  /Connection terminated unexpectedly/i,
  /Client has encountered a connection error/i,
  /terminating connection/i,
  /timeout expired/i,
];

function isTransientInfraError(err: unknown): boolean {
  if (err == null || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && TRANSIENT_CODES.has(code)) return true;
  const msg = (err as { message?: unknown }).message;
  return typeof msg === "string" && TRANSIENT_PATTERNS.some((re) => re.test(msg));
}

process.on("unhandledRejection", (reason) => {
  logger.error({ err: String(reason), transient: isTransientInfraError(reason) }, "unhandled rejection (process kept alive)");
});

process.on("uncaughtException", (err) => {
  if (isTransientInfraError(err)) {
    logger.error({ err: String(err) }, "uncaught transient infra error (process kept alive)");
    return;
  }
  logger.fatal({ err }, "uncaught exception, exiting");
  process.exit(1);
});

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  // Create the review-queue tables before the first scan. A failure here
  // must not take down catalog or /api/rpod/status; the scan then refuses
  // to post when the queue insert fails.
  void (async () => {
    try {
      await ensureRpodAlertSchema();
      logger.info("rpod-alert: schema ensured");
    } catch (err) {
      logger.error({ err, ...dbErrorFields(err) }, "rpod-alert: schema ensure failed");
    }
    try {
      await ensureLatestElsetTable();
      logger.info("tle-archive: latest-elset table ensured");
    } catch (err) {
      logger.error({ err, ...dbErrorFields(err) }, "tle-archive: latest-elset table ensure failed");
    }
    startObcScheduler();
  })();
});
