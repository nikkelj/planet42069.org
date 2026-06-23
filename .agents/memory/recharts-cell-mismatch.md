---
name: Recharts Cell children must match data array
description: Cell children inside Bar/Pie must map the exact same array used in the data prop.
---

When using `<Bar data={filteredArray}>` or `<Pie data={filteredArray}>`, the `<Cell>` children must also iterate over `filteredArray`, NOT the original unfiltered array. A mismatch causes cells to be applied to wrong segments or causes rendering errors.

**Why:** Recharts matches Cell children by index to data entries. If the data array is filtered/sorted but Cell children use the original array, the color assignments break.

**How to apply:** Always extract filtered/sorted data to a local variable and use it for both the data prop and the Cell children map.
