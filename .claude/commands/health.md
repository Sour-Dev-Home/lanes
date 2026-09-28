---
description: Weekly health check (stale work, red main, flaky checks, stuck chains)
---
First bring the lanes scripts up to date: if `git branch --show-current` prints `main` and `git status --porcelain`
prints nothing, run `git pull --ff-only`. Otherwise print one line, `lanes scripts may be stale: this checkout is not a
clean main`, and carry on. If the pull fails, report its error in one line and carry on.

Report, in at most 15 lines:
1. `node scripts/lanes/status.mjs --since 168h`.
2. Ready issues older than 7 days and open PRs older than 3 days (`gh issue list` / `gh pr list` with `--json createdAt`).
3. `gh run list --branch main --workflow verify.yml --limit 5`: is main red right now (`verify` runs on every push).
   Then `gh run list --branch main --status failure --limit 10`: which workflows failed more than once this week.
4. PRs whose lanes/gate failed on the contract (stage `contract`): the fix is usually the PR body or the issue's tier.
5. `node scripts/lanes/delivery-metrics.mjs --days 7`: report lead time (median, p90, mean), merge-queue bounce rate, and change-failure rate; compare to the previous week.
6. `node scripts/lanes/review-metrics.mjs --days 7`: report, per tier, tokens per real finding and the share of runs with no real finding, plus how many runs had no metrics and how many verdict comments were unreadable.
7. `node scripts/lanes/cleanup.mjs`: report which merged lanes it removed, which it skipped and why, and any failed step.
File one task issue per real problem (tier skip or quick). Do not fix anything in this session, with one exception:
step 7's cleanup of merged lanes, which removes only lanes whose PR merged and whose worktree is clean.
