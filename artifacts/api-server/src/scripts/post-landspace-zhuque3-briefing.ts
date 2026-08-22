/**
 * One-off editorial post: Landspace Zhuque-3 Y2 orbital launch and
 * successful first-stage recovery, August 18, 2026.
 *
 *   RPOD_ALERTS_FORCE=1 npx tsx src/scripts/post-landspace-zhuque3-briefing.ts
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { TWEET_MAX_WEIGHTED, weightedTweetLength } from "../lib/rpod/alert";

const SITE_SHARE_URL = "https://www.planet42069.org/r/zq3-0002.html";
const SHARE_CARD = resolve(
  process.cwd(),
  "../../artifacts/space-report/public/r/zq3-0002.png",
);

function craftText(): string {
  return [
    "Landspace put Zhuque-3 in orbit and recovered its booster on flight two. Congrats: orbital-class legs earned.",
    "",
    "Rated 21t expendable / 18.3t recovered to LEO. My bet: 15–18t reusable upmass by 2028, if reflight data agree.",
    "",
    "Please file Form R-3: Reusable Hardware With Legs.",
  ].join("\n");
}

function craftStandaloneText(): string {
  return [
    "Landspace put Zhuque-3 in orbit and recovered its booster on flight two. Congrats: orbital-class legs earned.",
    "",
    "Rated 21t expendable / 18.3t recovered to LEO. My bet: 15–18t reusable upmass by 2028.",
    "",
    "Please file Form R-3: Reusable Hardware With Legs.",
    "",
    SITE_SHARE_URL,
  ].join("\n");
}

async function main(): Promise<void> {
  const enabled =
    process.env.NODE_ENV === "production" || process.env.RPOD_ALERTS_FORCE === "1";
  const creds = Boolean(
    process.env.X_API_KEY && process.env.X_API_SECRET &&
    process.env.X_ACCESS_TOKEN && process.env.X_ACCESS_TOKEN_SECRET,
  );
  const quoteText = craftText();
  const standaloneText = craftStandaloneText();

  console.log("\n--- QUOTE POST TEXT ---");
  console.log(quoteText);
  console.log(`--- (${weightedTweetLength(quoteText)} weighted chars / ${TWEET_MAX_WEIGHTED} max) ---\n`);

  if (!enabled) {
    console.warn("Posting disabled — set RPOD_ALERTS_FORCE=1 to post outside production.");
    return;
  }
  if (!creds) {
    console.warn("X credentials missing.");
    return;
  }
  if (weightedTweetLength(quoteText) > TWEET_MAX_WEIGHTED) {
    throw new Error("Quote post text exceeds X's 280-character limit.");
  }
  if (weightedTweetLength(standaloneText) > TWEET_MAX_WEIGHTED) {
    throw new Error("Standalone post text exceeds X's 280-character limit.");
  }

  const { TwitterApi, EUploadMimeType } = await import("twitter-api-v2");
  const client = new TwitterApi({
    appKey: process.env.X_API_KEY!,
    appSecret: process.env.X_API_SECRET!,
    accessToken: process.env.X_ACCESS_TOKEN!,
    accessSecret: process.env.X_ACCESS_TOKEN_SECRET!,
  });

  const image = await readFile(SHARE_CARD);
  const mediaId = await client.v1.uploadMedia(image, { mimeType: EUploadMimeType.Png });
  await client.v1.createMediaMetadata(mediaId, {
    alt_text: {
      text: "CASE ZQ3-0002: Zhuque-3 Y2 first stage descending above a desert landing pad after its August 18, 2026 recovery, with the Orbital Bureau's upmass forecast.",
    },
  }).catch(() => {});

  // This account's API tier rejects quote-posts of accounts that did not
  // mention it. The original post is therefore linked in this standalone
  // version rather than embedded as a native quote.
  const res = await client.v2.tweet({
    text: standaloneText,
    media: { media_ids: [mediaId] },
  });
  console.log(`\n✅ Linked standalone post published: https://x.com/i/status/${res.data.id}`);
}

main().catch((err) => {
  console.error("Quote post failed:", err);
  process.exit(1);
});