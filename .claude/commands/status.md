---
description: Show what waits on the owner, what is in flight, what is ready and what merged
argument-hint: "[--since 12h]"
---
First bring the lanes scripts up to date: if `git branch --show-current` prints `main` and `git status --porcelain`
prints nothing, run `git pull --ff-only`. Otherwise print one line, `lanes scripts may be stale: this checkout is not a
clean main`, and carry on. If the pull fails, report its error in one line and carry on.

Then run `node scripts/lanes/status.mjs $ARGUMENTS` and show its output as is. Do not act on anything it lists.
