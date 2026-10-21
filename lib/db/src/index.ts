import { AsyncLocalStorage } from "node:async_hooks";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;
export type DbPoolClient = pg.PoolClient;
type PoolClient = DbPoolClient;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Retire idle connections after 60 s so the driver beats Postgres's own
  // idle-connection timeout to the punch. Without this, Postgres terminates
  // long-idle sockets with "terminating connection due to administrator
  // command", which surfaces as an unhandled error on the next query.
  idleTimeoutMillis: 60_000,
  // Fail fast if the DB is temporarily unreachable rather than hanging an
  // entire worker tick waiting for a connection that will never arrive.
  // Left at 10s after the 2026-10-14 flaps: those handshakes died at the
  // timeout twice in a row, so a longer checkout would only stall every
  // worker on a database that is actually down. Cheap sync-log writes and
  // freshness reads retry instead (retryTransientConnection).
  connectionTimeoutMillis: 10_000,
  // Notice a proxy that already RST an idle socket. Pool max stays the
  // driver default (10). The hourly scan reuses its advisory-lock client
  // instead of dialing again after the CPU stretch.
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
});

// Idle clients in the pool emit 'error' when the server drops the socket
// (e.g. "Client network socket disconnected before secure TLS connection was
// established", ECONNRESET). Without a listener, that error event crashes the
// whole process. Log and move on — the pool discards the dead client and
// dials a fresh connection on the next query.
pool.on("error", (err) => {
  console.error(`[db] idle client error (recovering): ${err.message}`);
});

type AppDb = NodePgDatabase<typeof schema>;
const rootDb: AppDb = drizzle(pool, { schema });

/**
 * The shared pool. Sync-log writes use this even while a scan has bound a
 * single client, so a dead scan socket can still record lastScanAt.
 */
export const poolDb: AppDb = rootDb;

const dbBinding = new AsyncLocalStorage<{ db: AppDb; client: PoolClient }>();

/** The advisory-lock client for the current scan, or null on the shared pool. */
export function currentPoolClient(): PoolClient | null {
  return dbBinding.getStore()?.client ?? null;
}

/**
 * Run `fn` with `db` pointed at an already-checked-out client.
 * The hourly scan uses its lock session so persist does not open a new
 * handshake after idle pool clients have been retired.
 */
export function runWithDbClient<T>(client: PoolClient, fn: () => Promise<T>): Promise<T> {
  return dbBinding.run({ db: drizzle(client, { schema }), client }, fn);
}

export const db: AppDb = new Proxy(rootDb, {
  get(target, prop) {
    const current = dbBinding.getStore()?.db ?? target;
    const value = Reflect.get(current, prop, current) as unknown;
    return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(current) : value;
  },
});

export * from "./schema";
