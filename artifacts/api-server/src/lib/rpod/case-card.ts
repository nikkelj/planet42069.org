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

/** Deterministic star field so the card looks "space" without randomness. */
function stars(): string {
  const out: string[] = [];
  for (let i = 0; i < 90; i++) {
    const x = ((i * 137.508) % 1) * 0 + ((i * 379) % W);
    const y = (i * 211) % H;
    const r = 0.6 + ((i * 7) % 10) / 9;
    const o = 0.25 + ((i * 13) % 10) / 18;
    out.push(`<circle cx="${x}" cy="${y}" r="${r.toFixed(1)}" fill="#cdd6f4" opacity="${o.toFixed(2)}"/>`);
  }
  return out.join("");
}

export function renderCaseCardSvg(
  ev: NewRpodEvent,
  metaFor: (norad: number) => AlertMeta | undefined,
): string {
  const names = ev.members.map((n) => metaFor(n)?.name?.trim() || `NORAD ${n}`);
  const shown = names.slice(0, 3).map((n) => truncate(n, 34));
  const extra = names.length > 3 ? `+${names.length - 3} more` : null;
  const kindLine = ev.kind === "coplanar"
    ? "SUSTAINED CO-PLANAR SHADOWING"
    : "UNSCHEDULED PROXIMITY OPERATION";

  const nameLines = [...shown, ...(extra ? [extra] : [])]
    .map((n, i) => `<text x="80" y="${368 + i * 46}" font-family="DejaVu Sans" font-size="34" font-weight="bold" fill="#e6edf3">${esc(n)}</text>`)
    .join("");

  // Simple geometry diagram: two craft, dashed closest-approach line.
  const gx = 830, gy = 300;
  const diagram = `
    <g>
      <circle cx="${gx}" cy="${gy}" r="150" fill="none" stroke="#30405c" stroke-width="1.5"/>
      <circle cx="${gx}" cy="${gy}" r="100" fill="none" stroke="#30405c" stroke-width="1" stroke-dasharray="3 5"/>
      <line x1="${gx - 95}" y1="${gy + 70}" x2="${gx + 95}" y2="${gy - 70}" stroke="#f38ba8" stroke-width="2" stroke-dasharray="7 6"/>
      <circle cx="${gx - 95}" cy="${gy + 70}" r="10" fill="#89b4fa"/>
      <circle cx="${gx + 95}" cy="${gy - 70}" r="10" fill="#f9e2af"/>
      <text x="${gx}" y="${gy + 8}" text-anchor="middle" font-family="DejaVu Sans Mono" font-size="26" fill="#f38ba8">${esc(fmtRange(ev.minRangeKm))}</text>
    </g>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0b1120"/>
      <stop offset="1" stop-color="#161d31"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  ${stars()}
  <rect x="24" y="24" width="${W - 48}" height="${H - 48}" fill="none" stroke="#f38ba8" stroke-width="3"/>
  <rect x="34" y="34" width="${W - 68}" height="${H - 68}" fill="none" stroke="#45475a" stroke-width="1"/>

  <text x="80" y="110" font-family="DejaVu Sans" font-size="30" font-weight="bold" letter-spacing="6" fill="#f38ba8">SPACE POLICE · CITATION</text>
  <text x="80" y="196" font-family="DejaVu Sans Mono" font-size="72" font-weight="bold" fill="#e6edf3">CASE ${esc(caseNumber(ev.eventId))}</text>
  <text x="80" y="248" font-family="DejaVu Sans" font-size="26" letter-spacing="2" fill="#f9e2af">${kindLine}</text>

  <text x="80" y="322" font-family="DejaVu Sans" font-size="22" letter-spacing="3" fill="#8b96ab">CITED CRAFT</text>
  ${nameLines}

  ${diagram}

  <text x="80" y="560" font-family="DejaVu Sans" font-size="22" letter-spacing="3" fill="#8b96ab">PREDICTED CLOSEST APPROACH</text>
  <text x="80" y="600" font-family="DejaVu Sans Mono" font-size="32" fill="#e6edf3">${esc(fmtRange(ev.minRangeKm))} at ${esc(fmtUtc(ev.tcaMs))}</text>

  <text x="${W - 80}" y="600" text-anchor="end" font-family="DejaVu Sans" font-size="20" fill="#566078">planet42069.org/rpod</text>
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
