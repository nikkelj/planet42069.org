import { db } from "@workspace/db";
import { obcSyncLog } from "@workspace/db/schema";
import { sql, and, eq, gt } from "drizzle-orm";
import { logger } from "../logger";

/**
 * X (Twitter) alerts for genuinely NEW RPOD events.
 *
 * Two milestones can post per case: the freshly INSERTED opening (reported
 * by persistEvents) and at most one escalation follow-up when an ACTIVE
 * case's min range tightens sharply. Routine updates and reopened lapsed
 * cases never post. On top of that:
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

/**
 * Escalation follow-ups: an ACTIVE case whose predicted minimum range
 * tightens from "keeping their distance" (> ESCALATION_PRIOR_MIN_KM) to
 * "genuinely close" (< ESCALATION_TRIGGER_KM) posts ONE follow-up citation.
 * The ledger key is -eventId (new-case posts use +eventId), so each case can
 * escalate-post at most once, ever — no repeat posts as the range oscillates.
 */
export const ESCALATION_TRIGGER_KM = 5;
export const ESCALATION_PRIOR_MIN_KM = 15;

/** A freshly inserted event, as reported by persistEvents. */
export interface NewRpodEvent {
  eventId: number;
  kind: string; // "conjunction" | "coplanar" | "docked"
  members: number[];
  minRangeKm: number;
  relVelKmS: number;
  tcaMs: number;
}

/** An active case whose min range tightened sharply on this scan. */
export interface EscalatedRpodEvent extends NewRpodEvent {
  prevMinRangeKm: number;
}

/** Does an old→new min-range change qualify as a newsworthy escalation? */
export function isEscalation(prevMinRangeKm: number, newMinRangeKm: number): boolean {
  return prevMinRangeKm > ESCALATION_PRIOR_MIN_KM && newMinRangeKm < ESCALATION_TRIGGER_KM;
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

/** Deadpan bureaucratic follow-up text for a sharply tightening case. */
export function formatEscalationCitation(
  ev: EscalatedRpodEvent,
  metaFor: (norad: number) => AlertMeta | undefined,
): string {
  const names = ev.members.map((n) => metaFor(n)?.name?.trim() || `NORAD ${n}`);
  return [
    `🚨 SPACE POLICE ESCALATION — Case ${caseNumber(ev.eventId)}`,
    `Previously cited craft are now closing rapidly.`,
    ``,
    `Cited craft: ${names.join(", ")}`,
    `Predicted closest approach tightened: ${fmtRange(ev.prevMinRangeKm)} → ${fmtRange(ev.minRangeKm)} at ${fmtUtc(ev.tcaMs)}`,
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

/**
 * Has this milestone ever posted? rowCount stores the ledger key:
 * +eventId for the new-case citation, -eventId for the escalation follow-up.
 */
async function alreadyPosted(ledgerKey: number): Promise<boolean> {
  const rows = await db
    .select({ id: obcSyncLog.id })
    .from(obcSyncLog)
    .where(and(
      eq(obcSyncLog.source, ALERT_LOG_SOURCE),
      eq(obcSyncLog.status, "success"),
      eq(obcSyncLog.rowCount, ledgerKey),
    ))
    .limit(1);
  return rows.length > 0;
}

async function postToX(text: string, image?: Buffer): Promise<string> {
  const { TwitterApi, EUploadMimeType } = await import("twitter-api-v2");
  const client = new TwitterApi({
    appKey: process.env.X_API_KEY!,
    appSecret: process.env.X_API_SECRET!,
    accessToken: process.env.X_ACCESS_TOKEN!,
    accessSecret: process.env.X_ACCESS_TOKEN_SECRET!,
  });
  let mediaId: string | null = null;
  if (image) {
    // v2 uploadMedia 503s on this tier; v1.1 upload + v2 tweet is the working combo.
    try {
      mediaId = await client.v1.uploadMedia(image, { mimeType: EUploadMimeType.Png });
      await client.v1
        .createMediaMetadata(mediaId, { alt_text: { text: "Space Police citation case card with case number, cited craft, and closest-approach geometry" } })
        .catch(() => {}); // alt text is best-effort
    } catch (err) {
      logger.warn({ err }, "rpod-alert: media upload failed, posting text-only");
    }
  }
  const res = mediaId
    ? await client.v2.tweet(text, { media: { media_ids: [mediaId] } })
    : await client.v2.tweet(text);
  return res.data.id;
}

/** Best-effort case-card render. Never throws — a bad render must not block the alert. */
async function tryRenderCaseCard(
  ev: NewRpodEvent,
  metaFor: (norad: number) => AlertMeta | undefined,
): Promise<Buffer | undefined> {
  try {
    const { renderCaseCardPng } = await import("./case-card");
    return await renderCaseCardPng(ev, metaFor);
  } catch (err) {
    logger.warn({ err, eventId: ev.eventId }, "rpod-alert: case-card render failed, falling back to text-only");
    return undefined;
  }
}

interface PostItem {
  ev: NewRpodEvent;
  /** obc_sync_log rowCount: +eventId for new cases, -eventId for escalations. */
  ledgerKey: number;
  text: string;
  what: string; // for logs: "new event" | "escalation"
}

/**
 * Shared posting loop: honors the daily cap and the once-per-milestone
 * ledger. Never throws — a posting failure must not fail the scan.
 */
async function postAlertItems(
  items: PostItem[],
  metaFor: (norad: number) => AlertMeta | undefined,
): Promise<void> {
  if (items.length === 0) return;
  if (!postingEnabled()) {
    logger.info({ events: items.map((i) => i.ledgerKey) }, "rpod-alert: posting disabled outside production, skipping");
    return;
  }
  if (!credsAvailable()) {
    logger.warn({ events: items.map((i) => i.ledgerKey) }, "rpod-alert: X credentials missing, skipping");
    return;
  }
  try {
    let remaining = DAILY_ALERT_CAP - (await postsInLastDay());
    for (const item of items) {
      const { ev } = item;
      if (remaining <= 0) {
        logger.warn({ eventId: ev.eventId }, "rpod-alert: daily cap reached, skipping remaining alerts");
        break;
      }
      if (await alreadyPosted(item.ledgerKey)) continue;
      const started = new Date();
      try {
        const image = await tryRenderCaseCard(ev, metaFor);
        const tweetId = await postToX(item.text, image);
        await db.insert(obcSyncLog).values({
          source: ALERT_LOG_SOURCE, status: "success", rowCount: item.ledgerKey,
          error: null, startedAt: started,
        });
        remaining--;
        logger.info({ eventId: ev.eventId, tweetId }, `rpod-alert: posted citation for ${item.what}`);
      } catch (err) {
        await db.insert(obcSyncLog).values({
          source: ALERT_LOG_SOURCE, status: "error", rowCount: item.ledgerKey,
          error: String(err).slice(0, 2000), startedAt: started,
        }).catch(() => {});
        logger.error({ err, eventId: ev.eventId }, `rpod-alert: failed to post citation for ${item.what}`);
      }
    }
  } catch (err) {
    logger.error({ err }, "rpod-alert: alert pass failed");
  }
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
  await postAlertItems(
    alertable.map((ev) => ({ ev, ledgerKey: ev.eventId, text: formatCitation(ev, metaFor), what: "new event" })),
    metaFor,
  );
}

/**
 * Post one follow-up citation per escalated ACTIVE case (min range tightened
 * from > ESCALATION_PRIOR_MIN_KM to < ESCALATION_TRIGGER_KM). Same filters
 * (no docked geometry, no co-launched formations), same daily cap, and a
 * once-ever ledger entry keyed on -eventId so a case can never escalate-post
 * twice. Never throws.
 */
export async function postEscalationAlerts(
  escalated: EscalatedRpodEvent[],
  metaFor: (norad: number) => AlertMeta | undefined,
): Promise<void> {
  const alertable = selectAlertableEvents(escalated, metaFor) as EscalatedRpodEvent[];
  await postAlertItems(
    alertable.map((ev) => ({ ev, ledgerKey: -ev.eventId, text: formatEscalationCitation(ev, metaFor), what: "escalation" })),
    metaFor,
  );
}
