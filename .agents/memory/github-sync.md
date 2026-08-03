---
name: GitHub sync
description: Where and how this project pushes to GitHub
---
Repo: https://github.com/nikkelj/planet42069.org (origin). User provided it previously — never re-ask.
**Why:** URL was lost in a memory compaction and the user was asked twice.
**How to apply:** gitPush cannot update ANY existing remote branch (BRANCH_ALREADY_EXISTS), even with force:true. Each sync needs a fresh branch name (e.g. `replit-sync-YYYY-MM-DD`) plus a new PR to main. Shell `git push` has no credentials; only the gitPush callback works. PR #1 (`replit-sync`) is stale.
