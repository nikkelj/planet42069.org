---
name: Recharts custom tooltip row lookup
description: How to reliably get the data row inside a custom Recharts tooltip
---
Rule: In a custom Recharts tooltip, read the row from `payload[0].payload` instead of matching `label` against your data array.

**Why:** Recharts can emit `label` as a string in some states, so strict `===` matching against numeric keys intermittently returns nothing and the tooltip silently renders null.

**How to apply:** Any custom `content={<Tooltip/>}` component — guard `active && payload?.length`, then use `payload[0]?.payload` directly.
