import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SITE = "https://www.planet42069.org";
const IMAGE = `${SITE}/opengraph.jpg`;

const cards = JSON.parse(readFileSync(join(__dirname, "share-cards.json"), "utf8"));

const esc = (s) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

for (const card of cards) {
  const title = `CASE #${card.caseNo} — ${card.title}`;
  const target = `/#${card.id}`;
  const pageUrl = `${SITE}/r/${card.id}.html`;
  const html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>${esc(title)}</title>
    <meta name="description" content="${esc(card.description)}" />
    <meta name="robots" content="index, follow" />
    <link rel="canonical" href="${SITE}/" />
    <meta property="og:title" content="${esc(title)}" />
    <meta property="og:description" content="${esc(card.description)}" />
    <meta property="og:type" content="article" />
    <meta property="og:url" content="${pageUrl}" />
    <meta property="og:image" content="${IMAGE}" />
    <meta property="og:image:width" content="1280" />
    <meta property="og:image:height" content="720" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${esc(title)}" />
    <meta name="twitter:description" content="${esc(card.description)}" />
    <meta name="twitter:image" content="${IMAGE}" />
    <meta http-equiv="refresh" content="0;url=${target}" />
    <script>window.location.replace("${target}");</script>
  </head>
  <body>
    <p>Retrieving case file&hellip; <a href="${target}">Proceed to ${esc(title)}</a></p>
  </body>
</html>
`;
  const dir = join(__dirname, "..", "public", "r");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${card.id}.html`), html);
  console.log(`wrote public/r/${card.id}.html`);
}
