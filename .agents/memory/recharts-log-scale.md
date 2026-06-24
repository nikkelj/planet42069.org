---
name: Recharts log scale workaround
description: Reliable approach for log-scale X axes in Recharts LineChart/BarChart
---

Recharts' built-in `scale="log"` on XAxis can silently produce blank charts or misplace ticks, especially when the domain spans many orders of magnitude.

**The rule:** Pre-transform data values to `log10(x)` and render on a standard linear axis. Place ticks at integer log10 positions and format them with a custom `tickFormatter`.

**How to apply:**
- In the component: `const logM = Math.log10(rawMass)`; store this in chart data objects.
- XAxis: `type="number"`, `domain={[-2, 5]}`, `ticks={[-2,-1,0,1,2,3,4,5]}`, `tickFormatter={(v) => LABEL_MAP[v]}`.
- Tooltip `labelFormatter`: convert back with `Math.pow(10, v)` and format for display.
- This pattern is used in `MassCDFChart.tsx` (mass CDF log-scale axis).

**Why:** Avoids Recharts internal log-scale rendering bugs while giving identical visual output.
