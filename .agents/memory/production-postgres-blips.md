---
name: Production Postgres blips
description: Observed production behavior when managed PostgreSQL connections are recycled or temporarily unavailable
---

Managed production PostgreSQL has emitted `terminating connection due to administrator command`, `Connection terminated unexpectedly`, and `Authentication timed out`. These events did not indicate an API process exit: the autoscale worker stayed up and continued serving HTTP, while a database-dependent RPOD scan failed and the pool established fresh connections later.

**Why:** observed production incidents included server-terminated sessions and connection timeouts while HTTP remained available. Process health alone is not evidence that database-dependent workers are healthy.

**How to apply:** compare live DB-backed HTTP responses, deployment errors, and worker completion records. Do not assume failures are harmless idle-socket recycling or attribute them to pool exhaustion without evidence.

Production SQL inspection uses a read replica, not the application's primary connection path.

**Why:** a successful replica query, its connection count, or its recent postmaster start cannot establish primary availability, primary pool pressure, or a primary restart.

**How to apply:** label replica observations explicitly and avoid diagnosing the primary from replica-only statistics.