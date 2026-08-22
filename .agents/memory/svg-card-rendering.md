---
name: Server-side card image rendering
description: How social-card PNGs are rendered in the api-server without a browser
---
Social/case-card images are rendered as hand-built SVG strings, then rasterized with `@resvg/resvg-js` (`font: { loadSystemFonts: true }`).

**Why:** no headless browser or canvas lib in the api-server; resvg is a fast native dep and the container ships DejaVu fonts (`/usr/share/fonts/truetype/dejavu`), so `font-family="DejaVu Sans"` / `"DejaVu Sans Mono"` render reliably. Emoji do NOT render — use shapes/text instead.

**How to apply:** keep the SVG builder pure (testable without native deps), escape all user-derived text for XML, and treat PNG rasterization as best-effort with a text-only fallback.

- SVG tspan collapses leading whitespace — use dx offset, not spaces, to gap inline segments.
- X citation text must fit 280 weighted chars (URLs=23, emoji=2); use a degradation ladder for craft-name lists rather than assuming names fit.
