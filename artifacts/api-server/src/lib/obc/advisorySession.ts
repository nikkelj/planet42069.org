/** Structural interface keeps fault-injection tests independent of a database. */
export interface LockClient {
  query(config: { text: string; values?: number[]; query_timeout: number }): Promise<{ rows: { locked?: boolean }[] }>;
  on(event: "error", listener: (err: Error) => void): unknown;
  removeListener(event: "error", listener: (err: Error) => void): unknown;
  release(destroy?: boolean): void;
  /**
   * pg Client sets this false in `_handleErrorEvent` when the socket dies.
   * A query_timeout does not. Absent means the driver did not say.
   */
  _queryable?: boolean;
}

/**
 * How to replace a lock session whose socket has died.
 * `connect` must not call back into lock recovery (that waits on this).
 */
export interface LockReconnect {
  connect: () => Promise<LockClient>;
  /** Fired after the replacement holds the advisory lock. */
  onSwap?: (client: LockClient) => void;
}

/**
 * Postgres drops a session-level advisory lock when the socket dies. Another
 * instance can take it during SGP4. Persist must not continue without it.
 */
export const LOCK_LOST_REACQUIRE_FAILED =
  "advisory lock lost after connection error and could not be reacquired";

/** One scan can survive a few proxy drops. After this, the hour fails and the scheduler retries. */
const MAX_LOCK_RECONNECTS = 5;

interface Session {
  key: number;
  client: LockClient;
  generation: number;
  locked: boolean;
  closing: boolean;
  reconnects: number;
  heartbeatMs: number;
  reconnect?: LockReconnect;
  onLoss: (err: Error) => void;
  connectionBroken?: Error;
  recovering?: Promise<void>;
  pending?: Promise<void>;
  heartbeat?: ReturnType<typeof setInterval>;
  restoreQueries?: () => void;
  onError?: (err: Error) => void;
}

const sessions = new WeakMap<object, Session>();

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
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

function sessionReady(session: Session): Promise<void> {
  const pending = session.recovering;
  if (pending) {
    return pending.then(() => {
      if (session.connectionBroken) throw session.connectionBroken;
    });
  }
  if (session.connectionBroken) return Promise.reject(session.connectionBroken);
  return Promise.resolve();
}

/** Resolves when `client`'s lock session is usable again. Rejects if reconnect failed. */
export function waitForLockRecovery(client: object): Promise<void> {
  const session = sessions.get(client);
  if (!session) return Promise.resolve();
  return sessionReady(session);
}

/**
 * The connection the lock session is using now.
 * After a swap, `sessions` still has the dead client as a key, and
 * `session.client` is the replacement. Callers that captured the old
 * object must query this one.
 */
export function activeLockClient<T extends object>(client: T): T {
  const session = sessions.get(client);
  if (!session) return client;
  return session.client as T;
}

/**
 * The query failed on `client`. If that client is still the session's active
 * socket, reconnect. A query that was already in flight on a replaced client
 * must not take down the replacement.
 */
export function failLockClient(client: object, err: Error): void {
  const session = sessions.get(client);
  if (!session || session.client !== client) return;
  lose(session, err);
}

function lose(session: Session, err: Error): void {
  if (session.closing) {
    session.connectionBroken ??= err;
    return;
  }
  if (session.connectionBroken) return;
  session.connectionBroken = err;
  session.onLoss(err);
  stopHeartbeat(session);
  if (!session.reconnect || !session.locked) return;
  if (session.reconnects >= MAX_LOCK_RECONNECTS) return;
  if (session.recovering) return;
  session.recovering = recover(session).finally(() => {
    session.recovering = undefined;
  });
}

async function recover(session: Session): Promise<void> {
  const reconnect = session.reconnect;
  if (!reconnect) return;
  let next: LockClient | undefined;
  try {
    next = await reconnect.connect();
    const result = await next.query({
      text: "select pg_try_advisory_lock($1) as locked",
      values: [session.key],
      query_timeout: 10_000,
    });
    if (result.rows[0]?.locked !== true) {
      const rejected = next;
      next = undefined;
      rejected.release(false);
      session.connectionBroken = new Error(LOCK_LOST_REACQUIRE_FAILED);
      return;
    }
    swap(session, next);
    next = undefined;
    session.reconnects++;
    session.connectionBroken = undefined;
    reconnect.onSwap?.(session.client);
  } catch (err) {
    if (next) {
      try { next.release(true); } catch { /* socket already gone */ }
    }
    session.connectionBroken = asError(err);
  }
}

function swap(session: Session, next: LockClient): void {
  const old = session.client;
  stopHeartbeat(session);
  if (session.onError) {
    old.removeListener("error", session.onError);
    session.onError = undefined;
  }
  session.restoreQueries?.();
  session.restoreQueries = undefined;
  // The in-flight heartbeat captured the old generation. Its rejection must
  // not call lose() again after the replacement is healthy.
  session.generation++;
  session.pending = undefined;
  try { old.release(true); } catch { /* dead socket */ }
  session.client = next;
  sessions.set(next, session);
  bind(session, true);
}

function bind(session: Session, withHeartbeat: boolean): void {
  const gen = session.generation;
  session.restoreQueries = installQuerySerializer(session.client);
  const onError = (err: Error) => {
    if (gen !== session.generation) return;
    lose(session, err);
  };
  session.onError = onError;
  session.client.on("error", onError);
  if (withHeartbeat) startHeartbeat(session, gen);
}

function stopHeartbeat(session: Session): void {
  if (session.heartbeat) {
    clearInterval(session.heartbeat);
    session.heartbeat = undefined;
  }
}

/**
 * pg 8.20's query_timeout rejects the query and leaves `_queryable` true.
 * The old backend still holds the advisory lock, so opening another
 * connection and calling pg_try_advisory_lock fails. A real socket death
 * sets `_queryable` false (and usually emits 'error'); that one reconnects.
 */
function heartbeatFailureIsFatal(client: LockClient, err: Error): boolean {
  if (client._queryable === false) return true;
  return /not queryable|connection terminated|terminating connection|ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|\b57P01\b/i.test(err.message);
}

function startHeartbeat(session: Session, gen: number): void {
  stopHeartbeat(session);
  const timer = setInterval(() => {
    if (gen !== session.generation) return;
    if (session.pending || session.connectionBroken) return;
    const client = session.client;
    session.pending = query(session, "select 1")
      .then(() => undefined)
      .catch((err: unknown) => {
        if (gen !== session.generation || session.client !== client) return;
        const error = asError(err);
        if (!heartbeatFailureIsFatal(client, error)) return;
        lose(session, error);
      })
      .finally(() => {
        if (session.client === client) session.pending = undefined;
      });
  }, session.heartbeatMs);
  timer.unref();
  session.heartbeat = timer;
}

function query(session: Session, text: string, values?: number[]) {
  return session.client.query({ text, values, query_timeout: 10_000 });
}

/**
 * A failed lock session must be destroyed, never returned for reuse.
 * Do not cancel `work` on connection loss: SGP4 cannot be unwound, and
 * releasing early would let another instance run beside it. Reconnect
 * instead, reacquire the advisory lock, and let the next query use the
 * replacement. `work` keeps running on the in-memory screen result.
 */
export async function runLockedSession(
  client: LockClient,
  key: number,
  work: () => Promise<void>,
  onLoss: (err: Error) => void,
  heartbeatMs = 20_000,
  reconnect?: LockReconnect,
): Promise<boolean> {
  const session: Session = {
    key,
    client,
    generation: 0,
    locked: false,
    closing: false,
    reconnects: 0,
    heartbeatMs,
    reconnect,
    onLoss,
  };
  sessions.set(client, session);
  bind(session, false);
  let workError: unknown;
  try {
    const result = await query(session, "select pg_try_advisory_lock($1) as locked", [key]);
    if (session.connectionBroken) throw session.connectionBroken;
    session.locked = result.rows[0]?.locked === true;
    if (session.locked) {
      startHeartbeat(session, session.generation);
      await work();
    }
  } catch (err) {
    // Conservatively discard after any failure, including an uncertain lock
    // acquisition outcome. Closing the session also releases its locks.
    workError = err;
    session.connectionBroken ??= asError(err);
    throw err;
  } finally {
    session.closing = true;
    if (session.recovering) await session.recovering.catch(() => undefined);
    try {
      if (session.pending) await session.pending;
      if (session.locked && !session.connectionBroken && workError == null) {
        await query(session, "select pg_advisory_unlock($1)", [key]).catch((err: unknown) => {
          lose(session, asError(err));
        });
      }
    } finally {
      stopHeartbeat(session);
      session.restoreQueries?.();
      session.restoreQueries = undefined;
      // Keep the listener installed through release (the pool then owns idle errors).
      try {
        session.client.release(Boolean(session.connectionBroken || workError != null));
      } catch {
        // Replacement already returned the previous socket to the pool.
      }
      if (session.onError) {
        session.client.removeListener("error", session.onError);
        session.onError = undefined;
      }
    }
  }
  if (session.connectionBroken) throw session.connectionBroken;
  return session.locked;
}
