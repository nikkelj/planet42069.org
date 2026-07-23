---
name: X API tier limits for @OrbitalBureau
description: What the X API credentials can and cannot do (replies/quotes blocked, reads OK)
---
The X API access tier for the Bureau account:
- CAN: post standalone tweets (incl. long >280 chars), upload media via v1.1 `uploadMedia` and attach, read user timelines (`userByUsername` + `userTimeline` with public_metrics works).
- CANNOT: reply to or quote-tweet posts by accounts that don't mention us — returns 403 "not-authorized-for-resource".

**Why:** confirmed by 403s on both a quote-tweet attempt and reply attempts to @SpaceX posts (July 2026).
**How to apply:** for engagement raids, either post standalone with the target tweet's URL inline, or hand the approved reply text + links to the user to post manually from the X app. Don't retry API replies.

**Media upload (Jul 2026):** `client.v2.uploadMedia(path, { media_category: 'tweet_image' })` repeatedly 503s; `client.v1.uploadMedia(path)` works and the returned media_id is accepted by `v2.tweet`. Use v1 upload + v2 tweet.
