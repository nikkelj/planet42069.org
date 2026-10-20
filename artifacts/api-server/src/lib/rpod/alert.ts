import { db } from "@workspace/db";
import { obcSyncLog, rpodAlertQueue } from "@workspace/db/schema";
import { sql, and, eq, gt } from "drizzle-orm";
import { logger } from "../logger";
import { dbErrorFields } from "../dbError";
import { mayPostToX, rpodAlertMode } from "./alertMode";
import { provisionalAlertScore } from "./alertScore";

/**
 * X (Twitter) alerts for genuinely NEW RPOD events.
 *
 * Two milestones can be cited per case: the freshly INSERTED opening
 * (reported by persistEvents) and at most one escalation follow-up when an
 * ACTIVE case's min range tightens sharply. Routine updates and reopened
 * lapsed cases never cite. On top of that:
 *  - "docked" geometry (station stacks, visiting vehicles) never cites
 *  - co-launched formations (all members share one launch tag) never cite
 *  - a per-milestone ledger means an event id can only ever cite once
 *  - a daily cap keeps a noisy scan from flooding the timeline
 *
 * Default mode is review: each would-be citation is inserted into
 * rpod_alert_queue (status pending) and nothing is posted. A failed insert
 * is logged and still does not post. Set RPOD_ALERT_MODE=auto to restore
 * direct posting, but only after the queue insert succeeds — a missing
 * table must not tweet. Direct posts still only run in production (or with
 * RPOD_ALERTS_FORCE=1). An admin approve of a queued row posts regardless
 * of mode.
 */

export const DAILY_ALERT_CAP = 2;
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

/**
 * New-case citations only fire for genuinely interesting geometry: an
 * SGP4-verified close approach (kind "conjunction") predicted to come
 * within this range. Coplanar "shadowing" cases — the bulk of what the
 * scan files — are tracked on the site but never posted; if one later
 * tightens sharply, the escalation path covers it.
 */
export const NEW_CASE_ALERT_MAX_KM = 10;

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

/** "COSMOS 2542 (NORAD 44835)" — always carries both name and id. */
export function craftLabel(norad: number, metaFor: (n: number) => AlertMeta | undefined): string {
  const name = metaFor(norad)?.name?.trim();
  return name ? `${name} (NORAD ${norad})` : `NORAD ${norad}`;
}

/** All members share one non-null launch tag ⇒ co-launched formation, not RPOD. */
export function isCoLaunched(members: number[], metaFor: (norad: number) => AlertMeta | undefined): boolean {
  if (members.length < 2) return false;
  const tags = members.map((n) => metaFor(n)?.launchTag ?? null);
  const first = tags[0];
  return first != null && tags.every((t) => t === first);
}

/**
 * Baseline eligibility shared by every citation type: no docked stacks,
 * no co-launched formations.
 */
export function selectAlertableEvents(
  events: NewRpodEvent[],
  metaFor: (norad: number) => AlertMeta | undefined,
): NewRpodEvent[] {
  return events.filter((ev) => ev.kind !== "docked" && !isCoLaunched(ev.members, metaFor));
}

/**
 * Which freshly inserted events deserve a citation post. Stricter than the
 * baseline: only verified conjunctions predicted inside NEW_CASE_ALERT_MAX_KM
 * are newsworthy. Pure — DB dedupe/cap checks happen in postNewRpodEventAlerts.
 */
export function selectNewCaseAlertableEvents(
  events: NewRpodEvent[],
  metaFor: (norad: number) => AlertMeta | undefined,
): NewRpodEvent[] {
  return selectAlertableEvents(events, metaFor).filter(
    (ev) => ev.kind === "conjunction" && ev.minRangeKm < NEW_CASE_ALERT_MAX_KM,
  );
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

/**
 * X counts URLs as 23 chars (t.co) and most emoji as 2. Approximate the
 * weighted length so citations never bounce off the 280 limit.
 */
export const TWEET_MAX_WEIGHTED = 280;
export function weightedTweetLength(text: string): number {
  const urlRe = /https?:\/\/\S+/g;
  let len = 0;
  const withoutUrls = text.replace(urlRe, () => { len += 23; return ""; });
  // Count astral-plane chars (emoji etc.) as 2, everything else as 1.
  for (const ch of withoutUrls) len += ch.codePointAt(0)! > 0xffff ? 2 : 1;
  return len;
}

/**
 * Craft list that fits the tweet budget: prefer "NAME (NORAD id)" for every
 * member, degrade to names only, then to the first two + "+N more".
 */
function craftListForBudget(
  members: number[],
  metaFor: (n: number) => AlertMeta | undefined,
  build: (list: string) => string,
): string {
  const name = (n: number) => metaFor(n)?.name?.trim() || `NORAD ${n}`;
  const shortName = (n: number) => {
    const s = name(n);
    return s.length > 20 ? `${s.slice(0, 19)}…` : s;
  };
  const variants = [
    members.map((n) => craftLabel(n, metaFor)).join(", "),
    members.map(name).join(", "),
    members.map(shortName).join(", "),
    [...members.slice(0, 2).map(shortName),
      ...(members.length > 2 ? [`+${members.length - 2} more`] : [])].join(", "),
    members.map((n) => `NORAD ${n}`).join(", "),
    [...members.slice(0, 2).map((n) => `NORAD ${n}`),
      ...(members.length > 2 ? [`+${members.length - 2} more`] : [])].join(", "),
  ];
  for (const list of variants) {
    const text = build(list);
    if (weightedTweetLength(text) <= TWEET_MAX_WEIGHTED) return text;
  }
  return build(variants[variants.length - 1]);
}

/** Deadpan bureaucratic citation text for a new case. */
export function formatCitation(
  ev: NewRpodEvent,
  metaFor: (norad: number) => AlertMeta | undefined,
  note?: string | null,
): string {
  const kindLine = ev.kind === "coplanar"
    ? "Sustained co-planar shadowing detected."
    : "Unscheduled proximity operation detected.";
  return craftListForBudget(ev.members, metaFor, (list) => [
    `🚨 SPACE POLICE CITATION — Case ${caseNumber(ev.eventId)}`,
    kindLine,
    ...(note ? [note] : []),
    ``,
    `Cited craft: ${list}`,
    `Predicted closest approach: ${fmtRange(ev.minRangeKm)} at ${fmtUtc(ev.tcaMs)}`,
    ``,
    `Case file: ${SITE_BASE}/rpod?case=${ev.eventId}`,
  ].join("\n"));
}

/** Deadpan bureaucratic follow-up text for a sharply tightening case. */
export function formatEscalationCitation(
  ev: EscalatedRpodEvent,
  metaFor: (norad: number) => AlertMeta | undefined,
): string {
  return craftListForBudget(ev.members, metaFor, (list) => [
    `🚨 SPACE POLICE ESCALATION — Case ${caseNumber(ev.eventId)}`,
    `Previously cited craft are now closing rapidly.`,
    ``,
    `Cited craft: ${list}`,
    `Predicted closest approach tightened: ${fmtRange(ev.prevMinRangeKm)} → ${fmtRange(ev.minRangeKm)} at ${fmtUtc(ev.tcaMs)}`,
    ``,
    `Case file: ${SITE_BASE}/rpod?case=${ev.eventId}`,
  ].join("\n"));
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

async function loadQueueStatus(ledgerKey: number): Promise<AlertQueueStatus | null> {
  const [row] = await db
    .select({ status: rpodAlertQueue.status })
    .from(rpodAlertQueue)
    .where(eq(rpodAlertQueue.ledgerKey, ledgerKey))
    .limit(1);
  if (!row) return null;
  return row.status as AlertQueueStatus;
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
  /** obc_sync_log rowCount / queue ledger: +eventId for new cases, -eventId for escalations. */
  ledgerKey: number;
  text: string;
  what: string; // for logs: "new event" | "escalation"
  score?: number;
  /** Kosmos pack vs an outsider posts even when the daily cap is full. */
  bypassCap?: boolean;
}

export type AlertQueueStatus = "pending" | "approved" | "rejected" | "posted";

/**
 * Insert a pending queue row. A milestone that is already queued (any
 * status) is left alone — rejecting or posting it sticks.
 */
export async function enqueueRpodAlert(item: PostItem): Promise<"queued" | "duplicate"> {
  const inserted = await db
    .insert(rpodAlertQueue)
    .values({
      eventId: item.ev.eventId,
      objects: [...item.ev.members].sort((a, b) => a - b),
      text: item.text,
      score: item.score ?? provisionalAlertScore(item.ev),
      status: "pending",
      ledgerKey: item.ledgerKey,
    })
    .onConflictDoNothing({ target: rpodAlertQueue.ledgerKey })
    .returning({ id: rpodAlertQueue.id });
  return inserted.length > 0 ? "queued" : "duplicate";
}

export type ApproveResult =
  | { ok: true; status: "posted"; tweetId: string }
  | { ok: false; status: AlertQueueStatus | "missing"; error: string };

/**
 * Mark a queued citation approved and post it. A failed post leaves the
 * row approved so the same call can be retried. Already-posted rows are
 * not posted again.
 */
export async function approveQueuedAlert(id: number): Promise<ApproveResult> {
  const [row] = await db.select().from(rpodAlertQueue).where(eq(rpodAlertQueue.id, id)).limit(1);
  if (!row) return { ok: false, status: "missing", error: "queue row not found" };
  if (row.status === "posted") return { ok: false, status: "posted", error: "already posted" };
  if (row.status === "rejected") return { ok: false, status: "rejected", error: "row was rejected" };
  if (await alreadyPosted(row.ledgerKey)) {
    await db.update(rpodAlertQueue).set({
      status: "posted",
      postedAt: row.postedAt ?? new Date(),
    }).where(eq(rpodAlertQueue.id, id)).catch((err) => {
      logger.error({ err, ...dbErrorFields(err), id }, "rpod-alert: failed to repair an already-posted queue row");
    });
    return { ok: false, status: "posted", error: "already posted" };
  }
  await db.update(rpodAlertQueue).set({ status: "approved" }).where(eq(rpodAlertQueue.id, id));
  if (!credsAvailable()) {
    return { ok: false, status: "approved", error: "X credentials missing; row left approved" };
  }
  const started = new Date();
  try {
    const tweetId = await postToX(row.text);
    await db.update(rpodAlertQueue).set({
      status: "posted",
      postedAt: new Date(),
      tweetId,
    }).where(eq(rpodAlertQueue.id, id));
    await db.insert(obcSyncLog).values({
      source: ALERT_LOG_SOURCE, status: "success", rowCount: row.ledgerKey,
      error: null, startedAt: started,
    }).catch(() => {});
    logger.info({ id, eventId: row.eventId, tweetId }, "rpod-alert: posted approved queue row");
    return { ok: true, status: "posted", tweetId };
  } catch (err) {
    const error = String(err).slice(0, 500);
    await db.insert(obcSyncLog).values({
      source: ALERT_LOG_SOURCE, status: "error", rowCount: row.ledgerKey,
      error: error.slice(0, 2000), startedAt: started,
    }).catch(() => {});
    logger.error({ err, id, eventId: row.eventId }, "rpod-alert: approved row failed to post");
    return { ok: false, status: "approved", error };
  }
}

export interface PreparedAlert extends PostItem {
  /** Cap-skipped. Queued pending even in auto mode. */
  hold?: boolean;
}

/**
 * Policy output. Review mode queues every row. Auto mode posts the ones
 * the cap (and the Kosmos bypass) selected, and queues the rest as pending.
 */
export async function publishPolicyItems(
  items: PreparedAlert[],
  metaFor: (norad: number) => AlertMeta | undefined,
): Promise<void> {
  if (items.length === 0) return;
  if (rpodAlertMode() !== "auto") {
    // Review is the default. Queue and return. Nothing here calls X,
    // including when the insert throws (missing table, missing column).
    for (const item of items) {
      await enqueueRpodAlert(item).catch((err) => {
        logger.error(
          { err, ...dbErrorFields(err), eventId: item.ev.eventId, ledgerKey: item.ledgerKey },
          "rpod-alert: queue insert failed; review mode will not post",
        );
      });
    }
    return;
  }
  const posting = items.filter((i) => !i.hold);
  const held = items.filter((i) => i.hold);
  await postAlertItems(posting, metaFor);
  for (const item of held) {
    await enqueueRpodAlert(item).catch((err) => {
      logger.error(
        { err, ...dbErrorFields(err), eventId: item.ev.eventId, ledgerKey: item.ledgerKey },
        "rpod-alert: queue insert failed for a held alert; not posting",
      );
    });
  }
}

/** pending or approved → rejected. Posted rows stay posted. */
export async function rejectQueuedAlert(id: number): Promise<{ ok: boolean; status: AlertQueueStatus | "missing"; error?: string }> {
  const [row] = await db.select().from(rpodAlertQueue).where(eq(rpodAlertQueue.id, id)).limit(1);
  if (!row) return { ok: false, status: "missing", error: "queue row not found" };
  if (row.status === "posted") return { ok: false, status: "posted", error: "already posted" };
  if (row.status === "rejected") return { ok: true, status: "rejected" };
  await db.update(rpodAlertQueue).set({ status: "rejected" }).where(eq(rpodAlertQueue.id, id));
  return { ok: true, status: "rejected" };
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
  if (rpodAlertMode() !== "auto") {
    try {
      let queued = 0;
      for (const item of items) {
        const result = await enqueueRpodAlert(item);
        if (result === "queued") queued++;
      }
      logger.info(
        { queued, skipped: items.length - queued, events: items.map((i) => i.ledgerKey) },
        "rpod-alert: review mode, queued citations instead of posting",
      );
    } catch (err) {
      logger.error(
        { err, ...dbErrorFields(err) },
        "rpod-alert: failed to queue citations; review mode will not post",
      );
    }
    return;
  }
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
      if (remaining <= 0 && !item.bypassCap) {
        // Held, not dropped: the citation stays pending for a later day or a human.
        await enqueueRpodAlert(item).catch((err) => {
          logger.error(
            { err, ...dbErrorFields(err), eventId: ev.eventId, ledgerKey: item.ledgerKey },
            "rpod-alert: queue insert failed while holding for the daily cap; not posting",
          );
        });
        logger.warn({ eventId: ev.eventId }, "rpod-alert: daily cap reached, holding remaining alerts");
        continue;
      }
      if (await alreadyPosted(item.ledgerKey)) continue;
      // The queue row has to exist before X is called. A missing table or
      // a failed insert skips the tweet entirely.
      let queueWriteOk = false;
      try {
        const queued = await enqueueRpodAlert(item);
        if (queued === "duplicate") {
          const status = await loadQueueStatus(item.ledgerKey);
          if (status === "posted" || status === "rejected") continue;
        }
        queueWriteOk = true;
      } catch (err) {
        logger.error(
          { err, ...dbErrorFields(err), eventId: ev.eventId, ledgerKey: item.ledgerKey },
          "rpod-alert: queue insert failed; not posting",
        );
      }
      if (!mayPostToX(rpodAlertMode(), queueWriteOk)) continue;
      const started = new Date();
      try {
        const image = await tryRenderCaseCard(ev, metaFor);
        const tweetId = await postToX(item.text, image);
        try {
          await db.update(rpodAlertQueue).set({
            status: "posted",
            postedAt: new Date(),
            tweetId,
          }).where(eq(rpodAlertQueue.ledgerKey, item.ledgerKey));
        } catch (markErr) {
          logger.error(
            { err: markErr, ...dbErrorFields(markErr), eventId: ev.eventId, ledgerKey: item.ledgerKey, tweetId },
            "rpod-alert: posted but failed to mark the queue row posted",
          );
        }
        try {
          await db.insert(obcSyncLog).values({
            source: ALERT_LOG_SOURCE, status: "success", rowCount: item.ledgerKey,
            error: null, startedAt: started,
          });
        } catch (logErr) {
          logger.error(
            { err: logErr, ...dbErrorFields(logErr), eventId: ev.eventId, ledgerKey: item.ledgerKey, tweetId },
            "rpod-alert: posted but failed to write the alert ledger",
          );
        }
        if (!item.bypassCap) remaining--;
        logger.info({ eventId: ev.eventId, tweetId }, `rpod-alert: posted citation for ${item.what}`);
      } catch (err) {
        await db.insert(obcSyncLog).values({
          source: ALERT_LOG_SOURCE, status: "error", rowCount: item.ledgerKey,
          error: String(err).slice(0, 2000), startedAt: started,
        }).catch(() => {});
        logger.error(
          { err, ...dbErrorFields(err), eventId: ev.eventId },
          `rpod-alert: failed to post citation for ${item.what}`,
        );
      }
    }
  } catch (err) {
    logger.error({ err, ...dbErrorFields(err) }, "rpod-alert: alert pass failed; not posting");
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
  const alertable = selectNewCaseAlertableEvents(newEvents, metaFor);
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
