/**
 * One-off script: post a re-emergence citation for RPOD case 101
 * (VICTUS HAZE Puma + Jackal-0004 coplanar shadowing, reopened 2026-08-06).
 *
 * Run from the api-server package root:
 *   RPOD_ALERTS_FORCE=1 node --loader tsx/esm src/scripts/post-rpod-reemergence.ts
 * or via the dev workflow with env override.
 */

import { logger } from "../lib/logger";
import { renderCaseCardPng } from "../lib/rpod/case-card";
import { TWEET_MAX_WEIGHTED, weightedTweetLength, caseNumber } from "../lib/rpod/alert";
import type { NewRpodEvent, AlertMeta } from "../lib/rpod/alert";

// ── Case 101 data (queried from production DB) ──────────────────────────────
const EVENT_ID = 101;
const MEMBERS = [69012, 69646];
const META: Record<number, AlertMeta> = {
  69012: { name: "Jackal-0004",        launchTag: null },
  69646: { name: "VICTUS HAZE Puma",   launchTag: null },
};
const metaFor = (n: number): AlertMeta | undefined => META[n];

const ev: NewRpodEvent = {
  eventId:    EVENT_ID,
  kind:       "coplanar",
  members:    MEMBERS,
  minRangeKm: 215.707,
  relVelKmS:  0.2543,
  tcaMs:      new Date("2026-08-08T03:26:34.911Z").getTime(),
};

// ── Re-emergence post text ──────────────────────────────────────────────────
const SITE_BASE = "https://www.planet42069.org";

function craftReemergenceText(): string {
  const craft = `VICTUS HAZE Puma (NORAD ${69646}), Jackal-0004 (NORAD ${69012})`;
  const craftShort = `VICTUS HAZE Puma, Jackal-0004`;
  const link = `${SITE_BASE}/rpod?case=${EVENT_ID}`;

  const full = [
    `🚨 SPACE POLICE RE-EMERGENCE — Case ${caseNumber(EVENT_ID)}`,
    `Coplanar shadowing case reopened. Previously flagged pairing is back in track.`,
    ``,
    `Cited craft: ${craft}`,
    ``,
    `Case file: ${link}`,
  ].join("\n");

  if (weightedTweetLength(full) <= TWEET_MAX_WEIGHTED) return full;

  const short = [
    `🚨 SPACE POLICE RE-EMERGENCE — Case ${caseNumber(EVENT_ID)}`,
    `Coplanar shadowing reopened.`,
    ``,
    `Cited craft: ${craftShort}`,
    ``,
    `Case file: ${link}`,
  ].join("\n");

  return short;
}

async function main(): Promise<void> {
  const enabled =
    process.env.NODE_ENV === "production" || process.env.RPOD_ALERTS_FORCE === "1";
  const creds = Boolean(
    process.env.X_API_KEY && process.env.X_API_SECRET &&
    process.env.X_ACCESS_TOKEN && process.env.X_ACCESS_TOKEN_SECRET,
  );

  const text = craftReemergenceText();
  logger.info({ weightedLen: weightedTweetLength(text) }, "post text:");
  console.log("\n--- POST TEXT ---");
  console.log(text);
  console.log(`--- (${weightedTweetLength(text)} weighted chars) ---\n`);

  if (!enabled) {
    logger.warn("Posting disabled — set RPOD_ALERTS_FORCE=1 to post outside production.");
    return;
  }
  if (!creds) {
    logger.warn("X credentials missing — need X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET.");
    return;
  }

  // Render card image
  let image: Buffer | undefined;
  try {
    image = await renderCaseCardPng(ev, metaFor);
    logger.info({ bytes: image.length }, "case card rendered");
  } catch (err) {
    logger.warn({ err }, "case card render failed, posting text-only");
  }

  // Post
  const { TwitterApi, EUploadMimeType } = await import("twitter-api-v2");
  const client = new TwitterApi({
    appKey:       process.env.X_API_KEY!,
    appSecret:    process.env.X_API_SECRET!,
    accessToken:  process.env.X_ACCESS_TOKEN!,
    accessSecret: process.env.X_ACCESS_TOKEN_SECRET!,
  });

  let mediaId: string | null = null;
  if (image) {
    try {
      mediaId = await client.v1.uploadMedia(image, { mimeType: EUploadMimeType.Png });
      await client.v1
        .createMediaMetadata(mediaId, { alt_text: { text: "Space Police citation case card — RPOD-0101 re-emergence" } })
        .catch(() => {});
    } catch (err) {
      logger.warn({ err }, "media upload failed, posting text-only");
    }
  }

  const res = mediaId
    ? await client.v2.tweet(text, { media: { media_ids: [mediaId] } })
    : await client.v2.tweet(text);

  logger.info({ tweetId: res.data.id }, "✅ posted re-emergence citation for RPOD-0101");
  console.log(`\nTweet posted: https://x.com/i/status/${res.data.id}`);
}

main().catch((err) => {
  logger.error({ err }, "post script failed");
  process.exit(1);
});
