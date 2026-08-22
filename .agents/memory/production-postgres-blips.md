---
name: Production Postgres blips
description: Observed production behavior when managed PostgreSQL connections are recycled or temporarily unavailable
---

Managed production PostgreSQL has emitted `terminating connection due to administrator command`, `Connection terminated unexpectedly`, and `Authentication timed out`. These events did not indicate an API process exit: the autoscale worker stayed up and continued serving HTTP, while a database-dependent RPOD scan failed and the pool established fresh connections later.

**Why:** the API's pool and process-level handlers intentionally survive transient socket failures, but scheduled workers only retry on their next cadence. An hourly RPOD scan can therefore remain stale for up to an hour after a brief managed-database interruption.