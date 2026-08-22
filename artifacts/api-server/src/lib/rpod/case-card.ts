import type { NewRpodEvent, AlertMeta } from "./alert";

/**
 * Case-card image for Space Police citation posts on X.
 *
 * renderCaseCardSvg is pure (testable without native deps); renderCaseCardPng
 * rasterizes it with @resvg/resvg-js using system fonts (DejaVu in this
 * environment). Callers must treat PNG rendering as best-effort — any failure
 * falls back to a text-only post.
 */

const W = 1200;
const H = 675;

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtUtc(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

function fmtRange(km: number): string {
  if (km < 1) return `${Math.round(km * 1000)} m`;
  return `${km < 10 ? km.toFixed(2) : km.toFixed(1)} km`;
}

function caseNumber(eventId: number): string {
  return `RPOD-${String(eventId).padStart(4, "0")}`;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Site palette (see artifacts/space-report/src/index.css):
 * near-black navy bg, neon cyan foreground, neon green primary, alarm red.
 */
const C = {
  bg0: "#04070f",
  bg1: "#081020",
  cyan: "#00ffff",
  cyanSoft: "#66ffff",
  cyanDim: "#0e8f8f",
  cyanFaint: "#0a3d4a",
  green: "#00ff66",
  red: "#ff3344",
  redDim: "#8f2430",
  muted: "#3f7f8f",
};

/** Deterministic star field so the card looks "space" without randomness. */
function stars(): string {
  const out: string[] = [];
  for (let i = 0; i < 90; i++) {
    const x = (i * 379) % W;
    const y = (i * 211) % H;
    const r = 0.5 + ((i * 7) % 10) / 11;
    const o = 0.15 + ((i * 13) % 10) / 28;
    const fill = i % 9 === 0 ? C.cyanSoft : "#9fd8e8";
    out.push(`<circle cx="${x}" cy="${y}" r="${r.toFixed(1)}" fill="${fill}" opacity="${o.toFixed(2)}"/>`);
  }
  return out.join("");
}

/** CRT scanlines — one faint cyan hairline every 6px. */
function scanlines(): string {
  const out: string[] = [];
  for (let y = 30; y < H - 30; y += 6) {
    out.push(`<line x1="24" y1="${y}" x2="${W - 24}" y2="${y}" stroke="${C.cyan}" stroke-width="1" opacity="0.025"/>`);
  }
  return out.join("");
}

/** Angular corner brackets, terminal-HUD style. */
function corners(): string {
  const s = 34, o = 40;
  const p = (d: string) => `<path d="${d}" fill="none" stroke="${C.cyan}" stroke-width="3"/>`;
  return [
    p(`M ${o} ${o + s} V ${o} H ${o + s}`),
    p(`M ${W - o - s} ${o} H ${W - o} V ${o + s}`),
    p(`M ${W - o} ${H - o - s} V ${H - o} H ${W - o - s}`),
    p(`M ${o + s} ${H - o} H ${o} V ${H - o - s}`),
  ].join("");
}

export function renderCaseCardSvg(
  ev: NewRpodEvent,
  metaFor: (norad: number) => AlertMeta | undefined,
): string {
  const craft = ev.members.map((n) => ({
    name: truncate(metaFor(n)?.name?.trim() || "UNIDENTIFIED OBJECT", 19),
    norad: n,
  }));
  const shown = craft.slice(0, 3);
  const extra = craft.length > 3 ? `+${craft.length - 3} MORE CRAFT ON FILE` : null;
  const kindLine = ev.kind === "coplanar"
    ? "SUSTAINED CO-PLANAR SHADOWING"
    : "UNSCHEDULED PROXIMITY OPERATION";

  const nameLines = shown
    .map((c, i) =>
      `<text x="96" y="${380 + i * 48}" font-family="DejaVu Sans Mono" font-size="30" font-weight="bold" fill="${C.cyanSoft}">&gt; ${esc(c.name)}<tspan dx="18" fill="${C.muted}" font-weight="normal" font-size="24">NORAD ${c.norad}</tspan></text>`)
    .join("");
  const extraLine = extra
    ? `<text x="96" y="${380 + shown.length * 48}" font-family="DejaVu Sans Mono" font-size="24" fill="${C.muted}">&gt; ${esc(extra)}</text>`
    : "";

  // Radar-style geometry diagram: two craft, dashed closest-approach vector.
  const gx = 880, gy = 330;
  const diagram = `
    <g>
      <circle cx="${gx}" cy="${gy}" r="160" fill="none" stroke="${C.cyanFaint}" stroke-width="2"/>
      <circle cx="${gx}" cy="${gy}" r="160" fill="none" stroke="${C.cyan}" stroke-width="1" opacity="0.35"/>
      <circle cx="${gx}" cy="${gy}" r="106" fill="none" stroke="${C.cyanFaint}" stroke-width="1.5" stroke-dasharray="3 6"/>
      <circle cx="${gx}" cy="${gy}" r="52" fill="none" stroke="${C.cyanFaint}" stroke-width="1" stroke-dasharray="2 7"/>
      <line x1="${gx - 160}" y1="${gy}" x2="${gx + 160}" y2="${gy}" stroke="${C.cyanFaint}" stroke-width="1" opacity="0.6"/>
      <line x1="${gx}" y1="${gy - 160}" x2="${gx}" y2="${gy + 160}" stroke="${C.cyanFaint}" stroke-width="1" opacity="0.6"/>
      <line x1="${gx - 100}" y1="${gy + 74}" x2="${gx + 100}" y2="${gy - 74}" stroke="${C.red}" stroke-width="6" stroke-dasharray="8 7" opacity="0.25"/>
      <line x1="${gx - 100}" y1="${gy + 74}" x2="${gx + 100}" y2="${gy - 74}" stroke="${C.red}" stroke-width="2" stroke-dasharray="8 7"/>
      <circle cx="${gx - 100}" cy="${gy + 74}" r="16" fill="none" stroke="${C.green}" stroke-width="2"/>
      <circle cx="${gx - 100}" cy="${gy + 74}" r="7" fill="${C.green}"/>
      <circle cx="${gx + 100}" cy="${gy - 74}" r="16" fill="none" stroke="${C.cyan}" stroke-width="2"/>
      <circle cx="${gx + 100}" cy="${gy - 74}" r="7" fill="${C.cyan}"/>
      <rect x="${gx - 78}" y="${gy - 22}" width="156" height="40" fill="${C.bg0}" opacity="0.85"/>
      <text x="${gx}" y="${gy + 7}" text-anchor="middle" font-family="DejaVu Sans Mono" font-size="27" font-weight="bold" fill="${C.red}">${esc(fmtRange(ev.minRangeKm))}</text>
    </g>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${C.bg0}"/>
      <stop offset="1" stop-color="${C.bg1}"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  ${stars()}
  ${scanlines()}

  <rect x="24" y="24" width="${W - 48}" height="${H - 48}" fill="none" stroke="${C.cyanDim}" stroke-width="2"/>
  <rect x="24" y="24" width="${W - 48}" height="${H - 48}" fill="none" stroke="${C.cyan}" stroke-width="1" opacity="0.35"/>
  ${corners()}

  <rect x="64" y="70" width="470" height="52" fill="${C.red}" opacity="0.12"/>
  <rect x="64" y="70" width="470" height="52" fill="none" stroke="${C.red}" stroke-width="2"/>
  <rect x="64" y="70" width="10" height="52" fill="${C.red}"/>
  <text x="96" y="106" font-family="DejaVu Sans Mono" font-size="26" font-weight="bold" letter-spacing="5" fill="${C.red}">SPACE POLICE // CITATION</text>
  <text x="${W - 80}" y="106" text-anchor="end" font-family="DejaVu Sans Mono" font-size="20" letter-spacing="2" fill="${C.muted}">ORBITAL BUREAUCRACY COMMAND</text>

  <text x="96" y="212" font-family="DejaVu Sans Mono" font-size="72" font-weight="bold" fill="${C.cyan}">CASE ${esc(caseNumber(ev.eventId))}</text>
  <text x="96" y="258" font-family="DejaVu Sans Mono" font-size="25" letter-spacing="3" fill="${C.green}">${kindLine}</text>
  <line x1="96" y1="286" x2="640" y2="286" stroke="${C.cyanDim}" stroke-width="1"/>

  <text x="96" y="334" font-family="DejaVu Sans Mono" font-size="20" letter-spacing="4" fill="${C.muted}">CITED CRAFT</text>
  ${nameLines}
  ${extraLine}

  ${diagram}

  <text x="96" y="562" font-family="DejaVu Sans Mono" font-size="20" letter-spacing="4" fill="${C.muted}">PREDICTED CLOSEST APPROACH</text>
  <text x="96" y="602" font-family="DejaVu Sans Mono" font-size="32" font-weight="bold" fill="${C.cyanSoft}">${esc(fmtRange(ev.minRangeKm))} <tspan fill="${C.muted}" font-weight="normal">at</tspan> ${esc(fmtUtc(ev.tcaMs))}</text>

  <text x="${W - 80}" y="602" text-anchor="end" font-family="DejaVu Sans Mono" font-size="20" fill="${C.cyanDim}">planet42069.org/rpod</text>
</svg>`;
}

/** Rasterize the case card to a PNG buffer. Throws on failure — callers catch. */
export async function renderCaseCardPng(
  ev: NewRpodEvent,
  metaFor: (norad: number) => AlertMeta | undefined,
): Promise<Buffer> {
  const { Resvg } = await import("@resvg/resvg-js");
  const svg = renderCaseCardSvg(ev, metaFor);
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: W },
    font: { loadSystemFonts: true },
    background: "#0b1120",
  });
  return resvg.render().asPng();
}
