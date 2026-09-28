---
description: List every PR waiting on your /approve, with what you must decide, and a ready /approve line
---
First bring the lanes scripts up to date: if `git branch --show-current` prints `main` and `git status --porcelain`
prints nothing, run `git pull --ff-only`. Otherwise print one line, `lanes scripts may be stale: this checkout is not a
clean main`, and carry on. If the pull fails, report its error in one line and carry on.

Then run `node scripts/lanes/status.mjs --waiting` and show its output as is. If it lists PRs, end with one line,
`/approve N M K`, holding every listed PR number in the order listed (at most 10; say how many were left out if more).
If it prints `none`, print nothing after it. Do not approve anything yourself.
