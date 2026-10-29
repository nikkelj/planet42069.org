/**
 * The latest-elset read must not query a pg client that has already errored.
 *
 * Live 2026-10-24: 19:12Z and 20:07Z stored "latest-elset fetch exceeded
 * 30000ms client deadline" (the socket was destroyed and the read was not
 * retried). 22:17Z stored "Client has encountered a connection error and is
 * not queryable" — pg's local rejection when query() is called on that same
 * client. The pointer SQL is a seq scan of obc_latest_elset (~30k rows), not
 * the 16.8M-row archive. A fresh connection answers it well under the 30s
 * deadline; the hung socket does not.
 *
 * Run with: pnpm --filter @workspace/api-server exec tsx ./src/tests/rpod-elset-client.test.ts
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { runLockedSession, type LockClient } from "../lib/obc/advisorySession";

process.env.DATABASE_URL ??= "postgres://invalid:invalid@127.0.0.1:1/none";

const { currentPoolClient, runWithDbClient } = await import("@workspace/db");
const {
  latestElsetsInWindowSql,
  pgClientIsQueryable,
  queryLatestElsetRows,
} = await import("../lib/obc/tleArchive");

const watchdog = setTimeout(() => {
  throw new Error("elset client tests timed out");
}, 10_000);

const ELSET_ROW = {
  norad: 25544,
  epoch: new Date("2026-10-24T20:00:00.000Z"),
  line1: "1 25544U 98067A   26297.50000000  .00000000  00000-0  00000-0 0  9992",
  line2: "2 25544  51.6400  10.0000 0001000  90.0000   0.0000 15.50000000000000",
  inc_deg: 51.64,
  raan_deg: 10,
  eccentricity: 0.0001,
  arg_perigee_deg: 90,
  mean_anomaly_deg: 0,
  mean_motion_rev_per_day: 15.5,
};

class FakePg extends EventEmitter {
  dead = false;
  _queryable = true;
  destroyed: boolean | undefined;
  released = 0;
  blocked = 0;
  queries: string[] = [];
  failReads = 0;
  /** Statement timeout leaves the socket up. A client deadline does not. */
  killOnFail = false;
  failMessage: string | null = null;
  async query(configOrText: { text: string; query_timeout: number } | string, _params?: unknown[]) {
    const text = typeof configOrText === "string" ? configOrText : configOrText.text;
    if (typeof configOrText !== "string") {
      assert.equal(configOrText.query_timeout, 10_000);
    }
    if (this.dead || this._queryable === false) {
      this.blocked += 1;
      throw new Error("Client has encountered a connection error and is not queryable");
    }
    this.queries.push(text);
    if (text.includes("pg_try")) return { rows: [{ locked: true }] };
    if (text.includes("obc_latest_elset") && this.failReads > 0) {
      this.failReads -= 1;
      if (this.killOnFail) {
        this.dead = true;
        this._queryable = false;
      }
      throw new Error(this.failMessage ?? "latest-elset fetch exceeded 30000ms client deadline");
    }
    if (text.includes("obc_latest_elset")) return { rows: [{ ...ELSET_ROW }] };
    return { rows: [] };
  }
  release(destroy?: boolean | Error) {
    this.released += 1;
    this.destroyed = Boolean(destroy);
  }
}

const since = new Date("2026-10-21T00:00:00.000Z");
const until = new Date("2026-10-24T23:00:00.000Z");

function readsPointer(client: FakePg): boolean {
  return client.queries.some((q) => q.includes("obc_latest_elset"));
}

async function withScanClient<T>(first: FakePg, reconnect: () => Promise<FakePg>, fn: () => Promise<T>): Promise<T> {
  return runWithDbClient(first as never, async () => {
    let result!: T;
    const locked = await runLockedSession(first as unknown as LockClient, 421072, async () => {
      result = await fn();
    }, () => {}, 60_000, {
      connect: async () => reconnect() as unknown as LockClient,
      // Production onSwap calls rebindDbClient from the socket error task,
      // which is not the scan's async context, so the binding stays put.
      onSwap: () => {},
    });
    assert.equal(locked, true);
    return result;
  });
}

{
  assert.equal(pgClientIsQueryable({ _queryable: true }), true);
  assert.equal(pgClientIsQueryable({}), true);
  assert.equal(pgClientIsQueryable({ _queryable: false }), false);
  assert.equal(pgClientIsQueryable({ connection: { stream: { destroyed: true } } }), false);
}

{
  // Client already not queryable before the pointer read. Do not send the
  // query. Discard it, take the replacement, read there.
  const first = new FakePg();
  const second = new FakePg();
  let connects = 0;
  const rows = await withScanClient(first, async () => {
    connects += 1;
    return second;
  }, async () => {
    first.dead = true;
    first._queryable = false;
    return queryLatestElsetRows(latestElsetsInWindowSql(since, until), false);
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.norad, 25544);
  assert.equal(connects, 1, "one fresh connection replaces the dead lock client");
  assert.equal(first.blocked, 0, "dead client was not queried");
  assert.equal(readsPointer(first), false);
  assert.equal(readsPointer(second), true);
  assert.equal(first.destroyed, true);
  assert.equal(pgClientIsQueryable(second), true);
  assert.equal(currentPoolClient(), null, "binding ends with the scan callback");
}

{
  // Deadline destroys the socket mid-read. The retry must use the replacement
  // and must not issue another query on the destroyed client.
  const first = new FakePg();
  const second = new FakePg();
  first.failReads = 1;
  first.killOnFail = true;
  first.failMessage = "latest-elset fetch exceeded 30000ms client deadline";
  let connects = 0;
  const rows = await withScanClient(first, async () => {
    connects += 1;
    return second;
  }, () => queryLatestElsetRows(latestElsetsInWindowSql(since, until), false));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.norad, 25544);
  assert.equal(connects, 1);
  assert.equal(first.blocked, 0, "destroyed client was not reused for the retry");
  assert.equal(readsPointer(second), true);
  assert.equal(first.destroyed, true, "deadline destroys and discards the lock client");
  assert.equal(second.destroyed, false);
}

{
  // A statement timeout is a live socket. Do not discard it and do not dial.
  const first = new FakePg();
  first.failReads = 1;
  first.failMessage = "canceling statement due to statement timeout";
  let connects = 0;
  let message = "";
  await withScanClient(first, async () => {
    connects += 1;
    throw new Error("should not dial");
  }, async () => {
    try {
      await queryLatestElsetRows(latestElsetsInWindowSql(since, until), false);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
  });
  assert.match(message, /statement timeout/);
  assert.equal(connects, 0, "statement timeout is not a fresh-connection retry");
  assert.equal(first.blocked, 0);
  assert.equal(first.destroyed, false, "live client returns to the pool");
  assert.equal(first.released, 1);
}

console.log("latest-elset client: dead sockets are discarded and the read is retried");
clearTimeout(watchdog);
