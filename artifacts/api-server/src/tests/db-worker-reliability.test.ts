import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { createWorkerGuard } from "../lib/obc/workerGuard";
import { runLockedSession, waitForLockRecovery, type LockClient } from "../lib/obc/advisorySession";

// Production heartbeats are deliberately unref'd; keep this standalone test
// process alive while awaiting injected heartbeat activity.
const watchdog = setTimeout(() => { throw new Error("reliability tests timed out"); }, 10_000);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

// No DB connection or worker imports: all failures are injected in memory.
const guard = createWorkerGuard();
{
  const retrySleep = deferred();
  let calls = 0;
  const first = guard("rpod", async () => { calls++; await retrySleep.promise; });
  assert.equal(await guard("rpod", async () => { calls++; }), false);
  assert.equal(calls, 1, "retry sleep retains tick ownership");
  assert.equal(await guard("backfill", async () => {}), true, "other workers remain independent");
  retrySleep.resolve();
  assert.equal(await first, true);
  assert.equal(await guard("rpod", async () => { calls++; }), true);
  assert.equal(calls, 2, "next tick may run after completion");
  await assert.rejects(guard("rpod", async () => { throw new Error("async failure"); }));
  await assert.rejects(guard("rpod", () => { throw new Error("sync failure"); }));
  assert.equal(await guard("rpod", async () => {}), true, "failure clears ownership");
}

class FakeClient extends EventEmitter implements LockClient {
  locked = true;
  dead = false;
  _queryable?: boolean;
  destroyed: boolean | undefined;
  released = 0;
  queries: string[] = [];
  heartbeat?: () => Promise<void>;
  acquireError?: Error;
  unlockError?: Error;
  async query(config: { text: string; values?: number[]; query_timeout: number }) {
    assert.equal(config.query_timeout, 10_000, "all lock-session queries are bounded");
    // pg Client.query short-circuits once `_queryable` is false. The message
    // is produced locally; the socket is not used. Live 2026-10-21 22:56Z.
    if (this.dead) throw new Error("Client has encountered a connection error and is not queryable");
    this.queries.push(config.text);
    if (config.text.includes("pg_try")) {
      if (this.acquireError) throw this.acquireError;
      return { rows: [{ locked: this.locked }] };
    }
    if (config.text.includes("pg_advisory_unlock") && this.unlockError) throw this.unlockError;
    if (config.text === "select 1") await this.heartbeat?.();
    return { rows: [] };
  }
  release(destroy = false) {
    this.released++;
    this.destroyed = destroy;
  }
}

{
  const client = new FakeClient();
  let worked = false;
  assert.equal(await runLockedSession(client, 1, async () => { worked = true; }, () => {}), true);
  assert.ok(worked);
  assert.equal(client.destroyed, false);
  assert.equal(client.released, 1);
  assert.ok(client.queries.some((q) => q.includes("unlock")));
  assert.equal(client.listenerCount("error"), 0);
}
{
  const client = new FakeClient();
  client.locked = false;
  assert.equal(await runLockedSession(client, 1, async () => assert.fail("must skip"), () => {}), false);
  assert.equal(client.queries.length, 1);
  assert.equal(client.destroyed, false);
}
{
  const client = new FakeClient();
  const failure = new Error("connection terminated");
  let losses = 0;
  const finish = deferred();
  const run = runLockedSession(client, 1, async () => {
    client.emit("error", failure);
    client.emit("error", failure);
    await finish.promise;
  }, () => { losses++; });
  // Attach a rejection handler immediately; only settle when work actually stops.
  const rejected = assert.rejects(run, (err) => err === failure);
  await delay(5);
  assert.equal(client.released, 0, "must not release while original work is active");
  finish.resolve();
  await rejected;
  assert.equal(losses, 1, "report session loss once");
  assert.equal(client.destroyed, true);
  assert.equal(client.released, 1);
  assert.ok(!client.queries.some((q) => q.includes("unlock")), "do not query a dead connection");
  assert.equal(client.listenerCount("error"), 0);
}
{
  const client = new FakeClient();
  const heartbeat = deferred();
  const entered = deferred();
  const finish = deferred();
  client.heartbeat = async () => { entered.resolve(); await heartbeat.promise; };
  const run = runLockedSession(client, 1, () => finish.promise, () => {}, 2);
  await entered.promise;
  await delay(15);
  assert.equal(client.queries.filter((q) => q === "select 1").length, 1, "no heartbeat queue");
  finish.resolve();
  heartbeat.resolve();
  await run;
  const count = client.queries.length;
  await delay(10);
  assert.equal(client.queries.length, count, "heartbeat stops on release");
}
{
  // pg 8.20 does not clear `_queryable` on Query read timeout, and this
  // backend still holds the advisory lock. Treat it as a slow round trip.
  const client = new FakeClient();
  let losses = 0;
  const failed = deferred();
  client._queryable = true;
  client.heartbeat = async () => { failed.resolve(); throw new Error("Query read timeout"); };
  const run = runLockedSession(client, 1, async () => {
    await failed.promise;
    await delay(5);
  }, () => { losses++; }, 2);
  assert.equal(await run, true);
  assert.equal(losses, 0, "a read timeout is not a lost session");
  assert.equal(client.destroyed, false);
  assert.ok(client.queries.some((q) => q.includes("unlock")));
}
{
  const client = new FakeClient();
  let losses = 0;
  const failed = deferred();
  client._queryable = false;
  client.heartbeat = async () => { failed.resolve(); throw new Error("Connection terminated unexpectedly"); };
  await assert.rejects(runLockedSession(client, 1, async () => {
    await failed.promise;
    await delay(5);
  }, () => { losses++; }, 2), /Connection terminated unexpectedly/);
  assert.equal(client.destroyed, true);
  assert.equal(losses, 1);
}
{
  const client = new FakeClient();
  client.acquireError = new Error("handshake dropped");
  await assert.rejects(runLockedSession(client, 1, async () => assert.fail(), () => {}), /handshake dropped/);
  assert.equal(client.destroyed, true);
  assert.equal(client.released, 1);
}
{
  const client = new FakeClient();
  client.unlockError = new Error("unlock dropped");
  await assert.rejects(runLockedSession(client, 1, async () => {}, () => {}), /unlock dropped/);
  assert.equal(client.destroyed, true);
}
{
  const client = new FakeClient();
  const original = new Error("worker failed");
  await assert.rejects(runLockedSession(client, 1, async () => { throw original; }, () => {}),
    (err) => err === original);
  assert.equal(client.destroyed, true, "failed work discards session and releases lock");
}
{
  // pg starts query_timeout when query() is called, even if the query is only
  // queued behind another one on the same socket. The lock session must not
  // hand the heartbeat to the driver until the in-flight query settles.
  const client = new FakeClient();
  const hold = deferred();
  const driver = client.query.bind(client);
  client.query = async (config: { text: string; values?: number[]; query_timeout: number }) => {
    if (config.text === "select pg_sleep") {
      await hold.promise;
      return { rows: [] };
    }
    return driver(config);
  };
  const run = runLockedSession(client, 1, async () => {
    const sleeping = client.query({ text: "select pg_sleep", query_timeout: 10_000 });
    await delay(40);
    assert.equal(
      client.queries.filter((q) => q === "select 1").length,
      0,
      "heartbeat must not reach the driver during the in-flight query",
    );
    hold.resolve();
    await sleeping;
  }, () => {}, 5);
  await run;
  assert.equal(client.destroyed, false);
}
{
  // SGP4 holds the process for minutes. The lock socket dies (proxy idle
  // kill, or a heartbeat Query read timeout that makes us drop the session).
  // pg then answers every later query with "not queryable" without touching
  // the network. Retrying that same client cannot persist. Reconnect, take
  // the advisory lock again, and run the post-SGP4 select on the replacement.
  const first = new FakeClient();
  const second = new FakeClient();
  let current: LockClient = first;
  let losses = 0;
  const run = runLockedSession(first, 421072, async () => {
    first.dead = true;
    first.emit("error", new Error("Connection terminated unexpectedly"));
    await waitForLockRecovery(first);
    assert.equal(current, second, "persist must use the replacement lock client");
    await assert.rejects(
      first.query({ text: "select id, status from rpod_events where status = $1", query_timeout: 10_000 }),
      /not queryable/,
    );
    await current.query({ text: "select id, status from rpod_events where status = $1", query_timeout: 10_000 });
  }, () => { losses++; }, 20_000, {
    connect: async () => second,
    onSwap: (client) => { current = client; },
  });
  assert.equal(await run, true);
  assert.equal(losses, 1, "one socket death, not one report per retry");
  assert.equal(first.destroyed, true, "dead client is discarded");
  assert.equal(first.released, 1);
  assert.ok(second.queries.some((q) => q.includes("pg_try_advisory_lock")), "replacement reacquires the lock");
  assert.ok(second.queries.some((q) => q.includes("rpod_events")), "persist select runs on the live client");
  assert.equal(second.destroyed, false, "healthy replacement returns to the pool");
  assert.ok(second.queries.some((q) => q.includes("pg_advisory_unlock")));
  assert.equal(second.listenerCount("error"), 0);
}
{
  // Another instance took the lock while the socket was dead. Do not persist
  // without it; fail so the scheduler retries.
  const first = new FakeClient();
  const second = new FakeClient();
  second.locked = false;
  let saw: unknown;
  const run = runLockedSession(first, 421072, async () => {
    first.dead = true;
    first.emit("error", new Error("Connection terminated unexpectedly"));
    try {
      await waitForLockRecovery(first);
    } catch (err) {
      saw = err;
      throw err;
    }
  }, () => {}, 20_000, {
    connect: async () => second,
  });
  await assert.rejects(run, /could not be reacquired/);
  assert.match(String(saw), /could not be reacquired/);
  assert.equal(second.released, 1);
  assert.equal(second.destroyed, false, "client that did not get the lock returns to the pool");
  assert.equal(first.destroyed, true);
  assert.ok(!second.queries.some((q) => q.includes("rpod_events")));
}
{
  // A heartbeat that dies with the socket (not a read timeout) must not
  // leave persist on the old client. The replacement reacquires the lock.
  const first = new FakeClient();
  const second = new FakeClient();
  const failed = deferred();
  let swapped = false;
  first._queryable = false;
  first.heartbeat = async () => {
    throw new Error("Connection terminated unexpectedly");
  };
  const run = runLockedSession(first, 1, async () => {
    await failed.promise;
    await waitForLockRecovery(first);
    assert.equal(swapped, true);
  }, () => { failed.resolve(); }, 2, {
    connect: async () => second,
    onSwap: () => { swapped = true; },
  });
  assert.equal(await run, true);
  assert.equal(first.destroyed, true);
  assert.ok(second.queries.some((q) => q.includes("pg_try_advisory_lock")));
  assert.equal(second.destroyed, false);
}
{
  const first = new FakeClient();
  await assert.rejects(runLockedSession(first, 1, async () => {
    first.emit("error", new Error("Connection terminated unexpectedly"));
    await waitForLockRecovery(first);
  }, () => {}, 20_000, {
    connect: async () => { throw new Error("Connection terminated due to connection timeout"); },
  }), /connection timeout/);
  assert.equal(first.destroyed, true);
}
console.log("DB worker reliability: all fault-injection checks passed");
clearTimeout(watchdog);
