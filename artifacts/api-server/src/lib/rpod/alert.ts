import { db } from "@workspace/db";
import { obcSyncLog } from "@workspace/db/schema";
import { sql, and, eq, gt } from "drizzle-orm";
import { logger } from "../logger";

/**
 * X (Twitter) alerts for genuinely NEW RPOD events.
 *
 * Only events freshly INSERTED by persistEvents qualify — updates to an
 * active case and reopened lapsed cases never re-post. On top of that:
 *  - "docked" geometry (station stacks, visiting vehicles) never posts
 *  - co-launched formations (all members share one launch tag) never post
 *  - a per-event dedupe ledger (obc_sync_log, source "rpod-alert") means an
 *    event id can only ever post once, even across restarts or kind flips
 *  - a daily cap keeps a noisy scan from flooding the timeline
 *
 * Posting is enabled in production only (or with RPOD_ALERTS_FORCE=1 for a
 * one-off manual verification) so the dev server can't double-post.
 */

export const DAILY_ALERT_CAP = 5;
const ALERT_LOG_SOURCE = "rpod-alert";
const SITE_BASE = "https://www.planet42069.org";

/** A freshly inserted event, as reported by persistEvents. */
export interface NewRpodEvent {
  eventId: number;
  kind: string; // "conjunction" | "coplanar" | "docked"
  members: number[];
  minRangeKm: number;
  relVelKmS: number;
  tcaMs: number;
}

export interface AlertMeta {
  name: string | null;
  launchTag: string | null;
}

export function caseNumber(eventId: number): string {
  return `RPOD-${String(eventId).padStart(4, "0")}`;
}

/** All members share one non-null launch tag ⇒ co-launched formation, not RPOD. */
export function isCoLaunched(members: number[], metaFor: (norad: number) => AlertMeta | undefined): boolean {
  if (members.length < 2) return false;
  const tags = members.map((n) => metaFor(n)?.launchTag ?? null);
  const first = tags[0];
  return first != null && tags.every((t) => t === first);
}

/**
 * Which of the freshly inserted events deserve a citation post.
 * Pure — DB dedupe/cap checks happen in postNewRpodEventAlerts.
 */
export function selectAlertableEvents(
  events: NewRpodEvent[],
  metaFor: (norad: number) => AlertMeta | undefined,
): NewRpodEvent[] {
  return events.filter((ev) => ev.kind !== "docked" && !isCoLaunched(ev.members, metaFor));
}

function fmtUtc(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

function fmtRange(km: number): string {
  if (km < 1) return `${Math.round(km * 1000)} m`;
  return `${km < 10 ? km.toFixed(2) : km.toFixed(1)} km`;
}

/** Deadpan bureaucratic citation text for a new case. */
export function formatCitation(ev: NewRpodEvent, metaFor: (norad: number) => AlertMeta | undefined): string {
  const names = ev.members.map((n) => metaFor(n)?.name?.trim() || `NORAD ${n}`);
  const kindLine = ev.kind === "coplanar"
    ? "Sustained co-planar shadowing detected."
    : "Unscheduled proximity operation detected.";
  return [
    `🚨 SPACE POLICE CITATION — Case ${caseNumber(ev.eventId)}`,
    kindLine,
    ``,
    `Cited craft: ${names.join(", ")}`,
    `Predicted closest approach: ${fmtRange(ev.minRangeKm)} at ${fmtUtc(ev.tcaMs)}`,
    ``,
    `Case file: ${SITE_BASE}/rpod?case=${ev.eventId}`,
  ].join("\n");
}

function credsAvailable(): boolean {
  return Boolean(
    process.env.X_API_KEY && process.env.X_API_SECRET &&
    process.env.X_ACCESS_TOKEN && process.env.X_ACCESS_TOKEN_SECRET,
  );
}

function postingEnabled(): boolean {
  return process.env.NODE_ENV === "production" || process.env.RPOD_ALERTS_FORCE === "1";
}

/** Successful alert posts in the last 24h (the daily cap window). */
async function postsInLastDay(): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(obcSyncLog)
    .where(and(
      eq(obcSyncLog.source, ALERT_LOG_SOURCE),
      eq(obcSyncLog.status, "success"),
      gt(obcSyncLog.finishedAt, sql`now() - interval '24 hours'`),
    ));
  return rows[0]?.n ?? 0;
}

/** Has this event id ever posted? (rowCount stores the event id.) */
async function alreadyPosted(eventId: number): Promise<boolean> {
  const rows = await db
    .select({ id: obcSyncLog.id })
    .from(obcSyncLog)
    .where(and(
      eq(obcSyncLog.source, ALERT_LOG_SOURCE),
      eq(obcSyncLog.status, "success"),
      eq(obcSyncLog.rowCount, eventId),
    ))
    .limit(1);
  return rows.length > 0;
}

async function postToX(text: string): Promise<string> {
  const { TwitterApi } = await import("twitter-api-v2");
  const client = new TwitterApi({
    appKey: process.env.X_API_KEY!,
    appSecret: process.env.X_API_SECRET!,
    accessToken: process.env.X_ACCESS_TOKEN!,
    accessSecret: process.env.X_ACCESS_TOKEN_SECRET!,
  });
  const res = await client.v2.tweet(text);
  return res.data.id;
}

/**
 * Post one standalone citation per alertable new event, honoring the daily
 * cap and the once-per-event ledger. Never throws — a posting failure must
 * not fail the scan.
 */
export async function postNewRpodEventAlerts(
  newEvents: NewRpodEvent[],
  metaFor: (norad: number) => AlertMeta | undefined,
): Promise<void> {
  const alertable = selectAlertableEvents(newEvents, metaFor);
  if (alertable.length === 0) return;
  if (!postingEnabled()) {
    logger.info({ events: alertable.map((e) => e.eventId) }, "rpod-alert: posting disabled outside production, skipping");
    return;
  }
  if (!credsAvailable()) {
    logger.warn({ events: alertable.map((e) => e.eventId) }, "rpod-alert: X credentials missing, skipping");
    return;
  }
  try {
    let remaining = DAILY_ALERT_CAP - (await postsInLastDay());
    for (const ev of alertable) {
      if (remaining <= 0) {
        logger.warn({ eventId: ev.eventId }, "rpod-alert: daily cap reached, skipping remaining new events");
        break;
      }
      if (await alreadyPosted(ev.eventId)) continue;
      const started = new Date();
      try {
        const tweetId = await postToX(formatCitation(ev, metaFor));
        await db.insert(obcSyncLog).values({
          source: ALERT_LOG_SOURCE, status: "success", rowCount: ev.eventId,
          error: null, startedAt: started,
        });
        remaining--;
        logger.info({ eventId: ev.eventId, tweetId }, "rpod-alert: posted citation for new event");
      } catch (err) {
        await db.insert(obcSyncLog).values({
          source: ALERT_LOG_SOURCE, status: "error", rowCount: ev.eventId,
          error: String(err).slice(0, 2000), startedAt: started,
        }).catch(() => {});
        logger.error({ err, eventId: ev.eventId }, "rpod-alert: failed to post citation");
      }
    }
  } catch (err) {
    logger.error({ err }, "rpod-alert: alert pass failed");
  }
}
