---
name: GitHub sync
description: Where and how this project pushes to GitHub
---
Repo: https://github.com/nikkelj/planet42069.org (origin). User provided it previously — never re-ask.
**Why:** URL was lost in a memory compaction and the user was asked twice.
**How to apply:** gitPush cannot update the existing `main` (BRANCH_ALREADY_EXISTS); push to a side branch (e.g. `replit-sync`) and open a PR to main instead. Shell `git push` has no credentials; only the gitPush callback works.
