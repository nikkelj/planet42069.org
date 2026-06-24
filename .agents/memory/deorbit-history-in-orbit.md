---
name: Deorbit simulation must include in-orbit objects
description: Why the orbital-decay animation includes still-in-orbit satellites, not just decayed ones
---

The deorbit-history endpoint and the DeorbitAnimation simulation must include objects
that are STILL IN ORBIT (no catalogued decay date), not only objects that have already
re-entered.

**Why:** An earlier version filtered to `e.decayDate` only. Because every historical
decayed object has re-entered by present day, the animation plot emptied completely at
the end of the timeline — which looks wrong (there are obviously thousands of satellites
still up there). User flagged this twice.

**How to apply:** In-orbit objects use a `dday === -1` sentinel. They appear at their
launch day and stay FIXED at their catalogued altitude (no draining), persisting to the
end of the timeline. Decayed objects (`dday >= 0`) interpolate altitude → 0 over their
real lifetime and drop off the plot at their actual decay date. `buildActive` and the
RAF removal filter must treat `dday < 0` as "always persist". `dayMax` extends to today
(`Date.now()`), not just the max decay day, so the timeline reaches present.
