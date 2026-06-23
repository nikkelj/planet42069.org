---
name: Recharts PieChart blank rendering
description: PieChart renders blank when inside a Card with overflow-hidden; use BarChart instead.
---

In this project's setup (Recharts + shadcn Card with overflow-hidden), PieChart/Pie renders a blank area even with valid data and no console errors. The nameKey prop and label function work correctly in isolation but the chart canvas appears empty.

**Why:** Likely interaction between Recharts SVG viewport calculation and CSS overflow-hidden clipping. The chart computes layout but clips the SVG viewBox.

**How to apply:** Use horizontal BarChart with `layout="vertical"` instead of PieChart for categorical distributions. This renders reliably and is more readable for orbital data anyway.
