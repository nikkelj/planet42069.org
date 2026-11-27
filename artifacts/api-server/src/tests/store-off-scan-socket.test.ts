/**
 * The catalog TTL refresh must not run on the RPOD scan's advisory-lock socket.
 *
 * doScan runs inside runWithDbClient(lockClient) and calls
 * Promise.all([getLatestElsetsOrSkip(...), loadCatalogMeta()]). The catalog
 * cache TTL is 10 minutes and the scan is hourly, so loadCatalogMeta almost
 * always starts primeCache() from inside the scan. AsyncLocalStorage carried
 * the scan binding into loadCatalog, so `select * from obc_objects` (~72k
 * wide rows) and obc_launches were queued on the same pg client as the
 * latest-elset BEGIN/SET/SELECT. node-pg runs one query per client at a time;
 * the elset read's 30s client deadline was counting the wait behind the
 * catalog load, destroyed the lock socket, and the retry on the rebound lock
 * client queued behind the retried catalog load again. Live: lastScanError
 * "latest-elset fetch skipped: latest-elset fetch exceeded 30000ms client
 * deadline" from 2026-11-26 17:25Z through 2026-11-27 15:42Z.
 *
 * Run with: pnpm --filter @workspace/api-server exec tsx ./src/tests/store-off-scan-socket.test.ts
 */
import assert from "node:assert/strict";

process.env.DATABASE_URL ??= "postgres://invalid:invalid@127.0.0.1:1/none";
process.env.LOG_LEVEL ??= "silent";

const { currentPoolClient, runWithDbClient, runOnSharedPool } = await import("@workspace/db");
const { primeCache, _resetStoreForTest, _setCacheForTest, _awaitLoadForTest, getSatcatFromStore } =
  await import("../lib/obc/store");

/**
 * Fake lock client. A class instance, not an object literal: drizzle()
 * treats a plain object with a `connection` key as a config and would open
 * its own Pool, which hides exactly the routing this test checks.
 */
class FakeLockClient {
  sent: string[] = [];
  _connected = true;
  _ending = false;
  _queryable = true;
  connection = { stream: { destroy: () => undefined } };
  async query(text: unknown) {
    const sqlText = typeof text === "string" ? text : String((text as { text?: string })?.text ?? text);
    this.sent.push(sqlText);
    // Answer the merge check so a load on this client would go on to the
    // full obc_objects / obc_launches selects, as it did live.
    const rows = /obc_sync_log/.test(sqlText) ? [[1]] : [];
    return { rows, rowCount: rows.length, fields: [], command: "SELECT" };
  }
  release() { return undefined; }
  on() { return this; }
  off() { return this; }
  removeListener() { return this; }
}
function fakeLockClient() {
  return new FakeLockClient();
}

let failures = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures++;
    console.error(`  ✗ ${name} — ${err instanceof Error ? err.message : String(err)}`);
  }
}

console.log("catalog refresh stays off the scan lock socket");

await check("runOnSharedPool drops the scan binding, including after awaits", async () => {
  const lock = fakeLockClient();
  await runWithDbClient(lock as never, async () => {
    assert.equal(currentPoolClient(), lock);
    const inner = await runOnSharedPool(async () => {
      const before = currentPoolClient();
      await new Promise((r) => setTimeout(r, 1));
      return { before, after: currentPoolClient() };
    });
    assert.equal(inner.before, null);
    assert.equal(inner.after, null);
    // The scan's own binding is untouched once the shared-pool work returns.
    assert.equal(currentPoolClient(), lock);
  });
});

await check("stale-cache refresh started inside a scan sends nothing on the lock client", async () => {
  _resetStoreForTest();
  // Stale (past the 10 min TTL) but non-empty: the scan path that serves the
  // stale cache and kicks off a background reload.
  _setCacheForTest({
    entries: [{ jcat: "T-1", satno: 1, name: "T" } as never],
    launchMap: new Map(),
    loadedAt: Date.now() - 60 * 60 * 1000,
  });
  const lock = fakeLockClient();
  await runWithDbClient(lock as never, async () => {
    const entries = await getSatcatFromStore();
    assert.equal(entries.length, 1, "stale cache still served immediately");
    // The reload hits the (unreachable) shared pool, fails, and falls back to
    // the stale cache. Wait for it so any query it would have sent is visible.
    await _awaitLoadForTest();
  });
  assert.deepEqual(lock.sent, [], `lock client received: ${lock.sent.join(" | ")}`);
});

await check("explicit primeCache inside a scan also stays off the lock client", async () => {
  _resetStoreForTest();
  const lock = fakeLockClient();
  await runWithDbClient(lock as never, async () => {
    primeCache();
    await _awaitLoadForTest().catch(() => undefined);
  });
  assert.deepEqual(lock.sent, [], `lock client received: ${lock.sent.join(" | ")}`);
});

_resetStoreForTest();
if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("store-off-scan-socket: ok");
process.exit(0);
