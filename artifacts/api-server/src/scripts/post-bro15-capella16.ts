/**
 * One-off editorial post: BRO-15 + Capella-16 coplanar close pass today.
 *
 *   RPOD_ALERTS_FORCE=1 npx tsx src/scripts/post-bro15-capella16.ts
 */

import { TWEET_MAX_WEIGHTED, weightedTweetLength } from "../lib/rpod/alert";

const SITE_BASE = "https://www.planet42069.org";
const EVENT_ID = 2041;

function craftText(): string {
  return [
    `BRO-15 (RF maritime surveillance) and Capella-16 (SAR) passed within 2 km at 13:45 UTC today.`,
    ``,
    `Nearly identical SSO orbits: 97.75° vs 97.77°, ~590 km. They'll keep doing this.`,
    ``,
    `Not a collision risk. A reminder of how crowded the SSO corridor has become.`,
    ``,
    `${SITE_BASE}/rpod?case=${EVENT_ID}`,
  ].join("\n");
}

async function main(): Promise<void> {
  const enabled =
    process.env.NODE_ENV === "production" || process.env.RPOD_ALERTS_FORCE === "1";
  const creds = Boolean(
    process.env.X_API_KEY && process.env.X_API_SECRET &&
    process.env.X_ACCESS_TOKEN && process.env.X_ACCESS_TOKEN_SECRET,
  );

  const text = craftText();
  console.log("\n--- POST TEXT ---");
  console.log(text);
  console.log(`--- (${weightedTweetLength(text)} weighted chars / ${TWEET_MAX_WEIGHTED} max) ---\n`);

  if (!enabled) {
    console.warn("Posting disabled — set RPOD_ALERTS_FORCE=1 to post outside production.");
    return;
  }
  if (!creds) {
    console.warn("X credentials missing.");
    return;
  }

  if (weightedTweetLength(text) > TWEET_MAX_WEIGHTED) {
    console.error("TEXT TOO LONG — aborting.");
    process.exit(1);
  }

  const { TwitterApi } = await import("twitter-api-v2");
  const client = new TwitterApi({
    appKey:       process.env.X_API_KEY!,
    appSecret:    process.env.X_API_SECRET!,
    accessToken:  process.env.X_ACCESS_TOKEN!,
    accessSecret: process.env.X_ACCESS_TOKEN_SECRET!,
  });

  const res = await client.v2.tweet(text);
  console.log(`\n✅ Posted: https://x.com/i/status/${res.data.id}`);
}

main().catch((err) => {
  console.error("Post script failed:", err);
  process.exit(1);
});
