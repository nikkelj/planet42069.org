import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

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
  connectionTimeoutMillis: 10_000,
});

// Idle clients in the pool emit 'error' when the server drops the socket
// (e.g. "Client network socket disconnected before secure TLS connection was
// established", ECONNRESET). Without a listener, that error event crashes the
// whole process. Log and move on — the pool discards the dead client and
// dials a fresh connection on the next query.
pool.on("error", (err) => {
  console.error(`[db] idle client error (recovering): ${err.message}`);
});
export const db = drizzle(pool, { schema });

export * from "./schema";
