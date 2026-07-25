import { db, pool } from "@workspace/db";
import { obcGunterPages, obcObjects, obcSyncLog } from "@workspace/db/schema";
import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { logger } from "../logger";
import { invalidateStore } from "./store";

/**
 * Gunter's Space Page (space.skyrocket.de, © Gunter Dirk Krebs) fusion source.
 *
 * Scope is deliberately narrow: high-level domain awareness only — the
 * "Type / Application" enumeration, nation/operator/contractors, and a
 * cross-link to the full dossier. We never store or republish page prose or
 * images. Gunter's pages carry an explicit AI/usage policy: RAG and
 * summarization allowed WITH attribution and a link to the original URL —
 * which is exactly what we do (see the citation fields on obc_objects).
 *
 * Crawl etiquette (the site is a one-man labor of love on a Steady
 * subscription model):
 *  - identifying User-Agent
 *  - >= 4s between requests
 *  - hard per-run fetch budget; the historical backfill spreads over weeks
 *  - pages revisited at most once per revisit interval
 */

const BASE = "https://space.skyrocket.de";
const USER_AGENT =
  "planet42069-space-report/1.0 (parody fan site, licensed reader; https://www.planet42069.org)";
const FETCH_TIMEOUT_MS = 30_000;
const DELAY_MS = 4_000;

/** Total HTTP requests allowed per daily run (chronology + dossiers). */
const RUN_FETCH_BUDGET = 30;
/** How many not-yet-indexed chronology years to backfill per run. */
const CHRON_BACKFILL_PER_RUN = 2;
/** Refetch the current-year chronology when older than this. */
const CHRON_CURRENT_REVISIT_MS = 20 * 60 * 60 * 1000; // 20h
/** Refetch a dossier when older than this. */
const DOSSIER_REVISIT_MS = 45 * 24 * 60 * 60 * 1000; // 45 days
/** Retry errored pages after this long. */
const ERROR_RETRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const FIRST_CHRON_YEAR = 1957;

let gunterInFlight: Promise<void> | null = null;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchPage(url: string): Promise<string> {
  const headers: Record<string, string> = { "User-Agent": USER_AGENT };
  // ── Paywall hook ─────────────────────────────────────────────────────
  // Gunter's Space Page is moving to a Steady subscription with a limited
  // free-page quota. We hold a single-seat license; if the site starts
  // requiring login, set GUNTER_STEADY_COOKIE (the Steady session cookie
  // string) as a secret and it will be sent with every request. Login
  // automation is intentionally NOT implemented.
  const steadyCookie = process.env["GUNTER_STEADY_COOKIE"];
  if (steadyCookie) headers["Cookie"] = steadyCookie;

  logger.info({ url }, "gunter: fetching");
  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`gunter fetch failed: ${res.status} ${res.statusText} (${url})`);
  // Pages are served as iso-8859-1
  const buf = await res.arrayBuffer();
  return new TextDecoder("iso-8859-1").decode(buf);
}

// ── parsing ────────────────────────────────────────────────────────────────

const ENTITIES: Record<string, string> = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'",
  "&nbsp;": " ", "&auml;": "ä", "&ouml;": "ö", "&uuml;": "ü", "&szlig;": "ß",
  "&eacute;": "é", "&egrave;": "è", "&aacute;": "á", "&rarr;": "→",
};

function stripHtml(s: string): string {
  const text = s
    .replace(/<br\s*\/?>/gi, ", ")
    .replace(/<[^>]+>/g, "")
    .replace(/&[a-zA-Z#0-9]+;/g, (m) => ENTITIES[m] ?? " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^,\s*|,\s*$/g, "");
  return text;
}

export function chronUrl(year: number): string {
  return `${BASE}/doc_chr/lau${year}.htm`;
}

/** Extract dossier URLs (doc_sdat/*.htm) referenced by a chronology page. */
export function parseChronology(html: string): string[] {
  const urls = new Set<string>();
  const re = /href="(?:\.\.\/)?doc_sdat\/([^"#?]+\.htm)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    urls.add(`${BASE}/doc_sdat/${m[1]}`);
  }
  return [...urls];
}

export interface GunterDossier {
  title: string | null;
  gunterType: string | null;
  nation: string | null;
  operator: string | null;
  contractors: string | null;
  cosparIds: string[];
}

/**
 * Parse a doc_sdat dossier page: the satdata facts table (cells carry stable
 * ids: sdnat/sdtyp/sdope/sdcon) and the satlist launch table whose
 * class="cosid" cells hold the COSPAR ids — our join key to obc_objects.
 */
export function parseDossier(html: string): GunterDossier {
  const factById = (id: string): string | null => {
    const m = html.match(new RegExp(`<td[^>]*id="${id}"[^>]*>([\\s\\S]*?)</td>`, "i"));
    if (!m) return null;
    const v = stripHtml(m[1]);
    return v.length > 0 ? v : null;
  };

  const titleMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);

  const cosparIds = new Set<string>();
  const cosRe = /<td class="cosid"[^>]*>([\s\S]*?)<\/td>/g;
  let m: RegExpExecArray | null;
  while ((m = cosRe.exec(html)) !== null) {
    const raw = stripHtml(m[1]);
    // A cell can list several ids ("2023-026A, 2023-026B") or ranges we skip.
    for (const piece of raw.split(/[,\s]+/)) {
      if (/^\d{4}-\d{3}[A-Z]{1,3}$/.test(piece)) cosparIds.add(piece);
    }
  }

  return {
    title: titleMatch ? stripHtml(titleMatch[1]) : null,
    gunterType: factById("sdtyp"),
    nation: factById("sdnat"),
    operator: factById("sdope"),
    contractors: factById("sdcon"),
    cosparIds: [...cosparIds],
  };
}

// ── fusion ─────────────────────────────────────────────────────────────────

/**
 * Apply one dossier's annotations to matched catalog objects (by COSPAR).
 * Annotation-only: touches gunter_* columns exclusively, so GCAT/space-track
 * identity and physics fields are never overridden.
 */
async function annotateObjects(url: string, page: GunterDossier, retrievedAt: Date): Promise<number> {
  if (page.cosparIds.length === 0) return 0;
  const CHUNK = 1000;
  let matched = 0;
  for (let i = 0; i < page.cosparIds.length; i += CHUNK) {
    const ids = page.cosparIds.slice(i, i + CHUNK);
    const res = await db
      .update(obcObjects)
      .set({
        gunterType: page.gunterType,
        gunterUrl: url,
        gunterTitle: page.title,
        gunterRetrievedAt: retrievedAt,
      })
      .where(inArray(obcObjects.intlDes, ids));
    matched += res.rowCount ?? 0;
  }
  return matched;
}

/**
 * Re-apply all stored dossier annotations. Run after each catalog merge:
 * merges rebuild/replace rows (e.g. an ST-keyed row graduating to a GCAT
 * key), which can drop gunter_* values — this restores them from the crawl
 * store without any network traffic.
 */
export async function applyGunterAnnotations(): Promise<number> {
  const pages = await db
    .select()
    .from(obcGunterPages)
    .where(and(eq(obcGunterPages.kind, "dossier"), eq(obcGunterPages.status, "ok")));
  let matched = 0;
  for (const p of pages) {
    if (!p.cosparIds || p.cosparIds.length === 0) continue;
    matched += await annotateObjects(p.url, {
      title: p.title,
      gunterType: p.gunterType,
      nation: p.nation,
      operator: p.operator,
      contractors: p.contractors,
      cosparIds: p.cosparIds,
    }, p.retrievedAt ?? new Date());
  }
  return matched;
}

// ── sync run ───────────────────────────────────────────────────────────────

async function logSync(status: "success" | "error", startedAt: Date, rowCount: number | null, error?: string) {
  try {
    await db.insert(obcSyncLog).values({
      source: "gunter", status, rowCount,
      error: error ? error.slice(0, 2000) : null,
      startedAt,
    });
  } catch (err) {
    logger.error({ err }, "gunter: failed to write sync log");
  }
}

async function upsertChronRow(url: string, status: string, error?: string): Promise<void> {
  await db
    .insert(obcGunterPages)
    .values({ url, kind: "chron", status, error: error ?? null, retrievedAt: new Date() })
    .onConflictDoUpdate({
      target: obcGunterPages.url,
      set: { status, error: error ?? null, retrievedAt: new Date() },
    });
}

/** Register newly-discovered dossier URLs as pending (never downgrades fetched rows). */
async function registerDossiers(urls: string[]): Promise<number> {
  if (urls.length === 0) return 0;
  const CHUNK = 400;
  let added = 0;
  for (let i = 0; i < urls.length; i += CHUNK) {
    const chunk = urls.slice(i, i + CHUNK).map((url) => ({ url, kind: "dossier", status: "pending" }));
    const res = await db.insert(obcGunterPages).values(chunk).onConflictDoNothing();
    added += res.rowCount ?? 0;
  }
  return added;
}

/** Pick which chronology year pages this run should fetch. */
async function pickChronYears(now: Date): Promise<number[]> {
  const currentYear = now.getUTCFullYear();
  const chronRows = await db
    .select({ url: obcGunterPages.url, retrievedAt: obcGunterPages.retrievedAt, status: obcGunterPages.status })
    .from(obcGunterPages)
    .where(eq(obcGunterPages.kind, "chron"));
  const byUrl = new Map(chronRows.map((r) => [r.url, r]));

  const years: number[] = [];
  const current = byUrl.get(chronUrl(currentYear));
  if (!current || !current.retrievedAt || now.getTime() - current.retrievedAt.getTime() > CHRON_CURRENT_REVISIT_MS) {
    years.push(currentYear);
  }
  // Backfill: newest un-indexed (or error-retryable) years first.
  for (let y = currentYear - 1; y >= FIRST_CHRON_YEAR; y--) {
    if (years.length >= CHRON_BACKFILL_PER_RUN + 1) break;
    const row = byUrl.get(chronUrl(y));
    if (!row) { years.push(y); continue; }
    if (row.status === "error" && row.retrievedAt && now.getTime() - row.retrievedAt.getTime() > ERROR_RETRY_MS) {
      years.push(y);
    }
  }
  return years;
}

/** Pick the dossier pages this run should fetch, within `budget`. */
async function pickDossiers(budget: number, now: Date): Promise<string[]> {
  if (budget <= 0) return [];
  // Pending first — newest discoveries first (recent years are indexed first,
  // so this naturally prioritizes recently-launched objects).
  const pending = await db
    .select({ url: obcGunterPages.url })
    .from(obcGunterPages)
    .where(and(eq(obcGunterPages.kind, "dossier"), eq(obcGunterPages.status, "pending")))
    .orderBy(desc(obcGunterPages.discoveredAt))
    .limit(budget);
  const picked = pending.map((r) => r.url);
  if (picked.length >= budget) return picked;

  // Then stale or retryable pages, oldest retrieval first.
  const staleBefore = new Date(now.getTime() - DOSSIER_REVISIT_MS);
  const errorBefore = new Date(now.getTime() - ERROR_RETRY_MS);
  const stale = await db
    .select({ url: obcGunterPages.url })
    .from(obcGunterPages)
    .where(and(
      eq(obcGunterPages.kind, "dossier"),
      or(
        and(eq(obcGunterPages.status, "ok"), or(isNull(obcGunterPages.retrievedAt), lt(obcGunterPages.retrievedAt, staleBefore))),
        and(eq(obcGunterPages.status, "error"), or(isNull(obcGunterPages.retrievedAt), lt(obcGunterPages.retrievedAt, errorBefore))),
      ),
    ))
    .orderBy(asc(obcGunterPages.retrievedAt))
    .limit(budget - picked.length);
  return picked.concat(stale.map((r) => r.url));
}

/**
 * Postgres advisory-lock key for the Gunter crawl. Ensures the polite-crawl
 * budget (RUN_FETCH_BUDGET, DELAY_MS) holds system-wide even when multiple
 * server instances are running (e.g. autoscaled deployment): only one
 * instance may crawl at a time; others skip their run entirely.
 */
const GUNTER_ADVISORY_LOCK_KEY = 421069;

/**
 * Daily Gunter sync: index chronology pages (discovery), fetch a bounded
 * batch of dossiers (extraction), annotate matched catalog objects (fusion).
 * Concurrent callers in-process share the same run; concurrent instances
 * are excluded via a session-scoped Postgres advisory lock held on a
 * dedicated connection for the duration of the crawl.
 */
export function runGunterSync(): Promise<void> {
  if (gunterInFlight) return gunterInFlight;
  gunterInFlight = withGunterLock().finally(() => { gunterInFlight = null; });
  return gunterInFlight;
}

async function withGunterLock(): Promise<void> {
  // Advisory locks are session-scoped, so lock and unlock must run on the
  // same physical connection — check one out of the pool for the whole run.
  const client = await pool.connect();
  try {
    const res = await client.query<{ locked: boolean }>(
      "select pg_try_advisory_lock($1) as locked",
      [GUNTER_ADVISORY_LOCK_KEY],
    );
    if (!res.rows[0]?.locked) {
      logger.info("gunter: another instance holds the crawl lock, skipping run");
      return;
    }
    try {
      await doGunterSync();
    } finally {
      await client.query("select pg_advisory_unlock($1)", [GUNTER_ADVISORY_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

async function doGunterSync(): Promise<void> {
  const started = new Date();
  let fetches = 0;
  let dossiersOk = 0;
  let discovered = 0;
  let annotated = 0;
  let firstError: string | null = null;

  try {
    // ── 1. chronology indexing (discovery) ──────────────────────────────
    const years = await pickChronYears(started);
    for (const year of years) {
      if (fetches >= RUN_FETCH_BUDGET) break;
      const url = chronUrl(year);
      if (fetches > 0) await sleep(DELAY_MS);
      fetches += 1;
      try {
        const html = await fetchPage(url);
        const dossierUrls = parseChronology(html);
        discovered += await registerDossiers(dossierUrls);
        await upsertChronRow(url, "ok");
      } catch (err) {
        firstError = firstError ?? String(err);
        logger.warn({ err, url }, "gunter: chronology fetch failed");
        await upsertChronRow(url, "error", String(err));
      }
    }

    // ── 2. dossier extraction + fusion ──────────────────────────────────
    const dossierUrls = await pickDossiers(RUN_FETCH_BUDGET - fetches, new Date());
    for (const url of dossierUrls) {
      if (fetches > 0) await sleep(DELAY_MS);
      fetches += 1;
      const retrievedAt = new Date();
      try {
        const html = await fetchPage(url);
        const page = parseDossier(html);
        if (!page.title && page.cosparIds.length === 0) {
          throw new Error("dossier parse produced no title and no COSPAR ids — page layout changed?");
        }
        await db
          .update(obcGunterPages)
          .set({
            status: "ok",
            title: page.title,
            gunterType: page.gunterType,
            nation: page.nation,
            operator: page.operator,
            contractors: page.contractors,
            cosparIds: page.cosparIds,
            error: null,
            retrievedAt,
          })
          .where(eq(obcGunterPages.url, url));
        annotated += await annotateObjects(url, page, retrievedAt);
        dossiersOk += 1;
      } catch (err) {
        firstError = firstError ?? String(err);
        logger.warn({ err, url }, "gunter: dossier fetch/parse failed");
        await db
          .update(obcGunterPages)
          .set({ status: "error", error: String(err).slice(0, 2000), retrievedAt })
          .where(eq(obcGunterPages.url, url));
      }
    }

    const allFailed = fetches > 0 && dossiersOk === 0 && discovered === 0 && firstError != null;
    await logSync(allFailed ? "error" : "success", started, annotated, allFailed ? firstError ?? undefined : undefined);
    if (annotated > 0) {
      // The satcat API serves from the in-memory store; drop it so freshly
      // crawled annotations are visible immediately rather than at TTL expiry.
      invalidateStore();
    }
    logger.info({ fetches, dossiersOk, discovered, annotated }, "gunter: sync complete");
  } catch (err) {
    await logSync("error", started, null, String(err));
    throw err;
  }
}

/** Coverage stats for the sync-status surface. */
export async function getGunterCoverage(): Promise<{ dossiers: number; pending: number; matchedObjects: number }> {
  const [pageCounts] = await db
    .select({
      dossiers: sql<number>`count(*) filter (where kind = 'dossier' and status = 'ok')`,
      pending: sql<number>`count(*) filter (where kind = 'dossier' and status = 'pending')`,
    })
    .from(obcGunterPages);
  const [objCount] = await db
    .select({ matched: sql<number>`count(*)` })
    .from(obcObjects)
    .where(sql`${obcObjects.gunterUrl} is not null`);
  return {
    dossiers: Number(pageCounts?.dossiers ?? 0),
    pending: Number(pageCounts?.pending ?? 0),
    matchedObjects: Number(objCount?.matched ?? 0),
  };
}
