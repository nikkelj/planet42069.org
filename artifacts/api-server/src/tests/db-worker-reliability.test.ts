import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { createWorkerGuard } from "../lib/obc/workerGuard";
import { runLockedSession, type LockClient } from "../lib/obc/advisorySession";

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
  destroyed: boolean | undefined;
  released = 0;
  queries: string[] = [];
  heartbeat?: () => Promise<void>;
  acquireError?: Error;
  unlockError?: Error;
  async query(config: { text: string; values?: number[]; query_timeout: number }) {
    assert.equal(config.query_timeout, 10_000, "all lock-session queries are bounded");
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
  const client = new FakeClient();
  let losses = 0;
  const failed = deferred();
  client.heartbeat = async () => { failed.resolve(); throw new Error("heartbeat timeout"); };
  await assert.rejects(runLockedSession(client, 1, async () => {
    await failed.promise;
    await delay(5);
  }, () => { losses++; }, 2), /heartbeat timeout/);
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
console.log("DB worker reliability: all fault-injection checks passed");
clearTimeout(watchdog);
