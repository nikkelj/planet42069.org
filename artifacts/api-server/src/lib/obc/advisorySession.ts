/** Structural interface keeps fault-injection tests independent of a database. */
export interface LockClient {
  query(config: { text: string; values?: number[]; query_timeout: number }): Promise<{ rows: { locked?: boolean }[] }>;
  on(event: "error", listener: (err: Error) => void): unknown;
  removeListener(event: "error", listener: (err: Error) => void): unknown;
  release(destroy?: boolean): void;
}

/**
 * pg starts a query_timeout when query() is called, even if that query is
 * only queued behind another one on the same socket. A heartbeat submitted
 * during the scan's elset read would fire "Query read timeout" at 10s and
 * mark the session broken. Hold later queries until the in-flight promise
 * settles so the timeout covers the heartbeat itself, not the query ahead of it.
 */
function installQuerySerializer(client: LockClient): () => void {
  const previous = client.query;
  const call = previous.bind(client) as (...args: unknown[]) => Promise<unknown>;
  let tail: Promise<unknown> = Promise.resolve();
  client.query = ((...args: unknown[]) => {
    const run = tail.then(() => call(...args));
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }) as LockClient["query"];
  return () => {
    client.query = previous;
  };
}

/**
 * A failed lock session must be destroyed, never returned for reuse.
 * Do not race work against connection loss: JS promises cannot cancel work,
 * and releasing early would allow retries while the original still runs.
 */
export async function runLockedSession(
  client: LockClient,
  key: number,
  work: () => Promise<void>,
  onLoss: (err: Error) => void,
  heartbeatMs = 20_000,
): Promise<boolean> {
  let broken: Error | undefined;
  let locked = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let pending: Promise<void> | undefined;
  const lose = (err: Error) => {
    if (!broken) {
      broken = err;
      onLoss(err);
    }
  };
  const restoreQueries = installQuerySerializer(client);
  const query = (text: string, values?: number[]) =>
    client.query({ text, values, query_timeout: 10_000 });
  client.on("error", lose);
  try {
    const result = await query("select pg_try_advisory_lock($1) as locked", [key]);
    locked = result.rows[0]?.locked === true;
    if (broken) throw broken;
    if (locked) {
      heartbeat = setInterval(() => {
        // A slow heartbeat cannot accumulate more queries on the same socket.
        if (pending || broken) return;
        pending = query("select 1")
          .then(() => undefined)
          .catch(lose)
          .finally(() => { pending = undefined; });
      }, heartbeatMs);
      heartbeat.unref();
      await work();
    }
  } catch (err) {
    // Conservatively discard after any failure, including an uncertain lock
    // acquisition outcome. Closing the session also releases its locks.
    broken ??= err instanceof Error ? err : new Error(String(err));
    throw err;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    try {
      if (pending) await pending;
      if (locked && !broken) {
        await query("select pg_advisory_unlock($1)", [key]).catch(lose);
      }
    } finally {
      // Restore the pool client's query method before it is reused.
      restoreQueries();
      // Keep the listener installed through release (the pool then owns idle errors).
      client.release(Boolean(broken));
      client.removeListener("error", lose);
    }
  }
  if (broken) throw broken;
  return locked;
}
