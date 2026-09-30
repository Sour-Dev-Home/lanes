---
description: Weekly health check (stale work, red main, flaky checks, stuck chains)
---
First bring the lanes scripts up to date: if `git branch --show-current` prints `main` and `git status --porcelain`
prints nothing, run `git pull --ff-only`. Otherwise print one line, `lanes scripts may be stale: this checkout is not a
clean main`, and carry on. If the pull fails, report its error in one line and carry on.

Report, in at most 15 lines:
1. `node scripts/lanes/status.mjs --since 168h`.
   Then `node scripts/lanes/status.mjs --starts 7` and include its lines: how often path overlap, the cap or another
   reason kept an issue from starting, and each overlap pair (the evidence for reopening or dropping ADR 0018 phase 2).
2. Ready issues older than 7 days and open PRs older than 3 days (`gh issue list` / `gh pr list` with `--json createdAt`).
3. `gh run list --branch main --workflow verify.yml --limit 5`: is main red right now (`verify` runs on every push).
   Then `gh run list --branch main --status failure --limit 10`: which workflows failed more than once this week.
4. PRs whose lanes/gate failed on the contract (stage `contract`): the fix is usually the PR body or the issue's tier.
5. `node scripts/lanes/delivery-metrics.mjs --days 7`: report lead time (median, p90, mean), merge-queue bounce rate, and change-failure rate; compare to the previous week.
6. `node scripts/lanes/review-metrics.mjs --days 7`: report, per tier, tokens per real finding and the share of runs with no real finding, plus how many runs had no metrics and how many verdict comments were unreadable.
   Then `node scripts/lanes/lane-cost.mjs --days 7`: report the lane sessions' own tokens per tier (lanes, median and
   total, and lanes with no transcript) on the line next to the reviewer tokens.
7. `node scripts/lanes/cleanup.mjs`: report which lanes it removed (merged lanes, closed-issue lanes and empty orphan folders), which it skipped and why, and any failed step.
8. `node scripts/lanes/structure-report.mjs --days 7 --jscpd`: report the module map's violation, cycle and unmapped
   counts, the top 3 lane hotspots, and the duplicate-code line (or `skipped`). Then, each weekly run, spawn the
   architecture-advisor as a fresh subagent with the full report and ADR 0008. It files at most 3 refactor issues
   for the worst structural problems it finds (none is a fine answer), each from the Task form's layout with
   `gh issue create --label lane-filed --body-file <file>`, and each Scope naming the file paths to change. Report
   the issues it filed.
   The same advisor run also checks ADR drift, replacing the per-PR ADR reviews: in the same spawn as the structural
   report (not a second subagent), also give it the files changed by lane PRs merged in the window
   (`gh pr list --state merged --json files`, merged within the last 7 days) with the accepted ADRs governing each
   (the ADR lookup `node scripts/lanes/reviewers.mjs` uses, from `docs/adr/`). It files at most 3 ADR-drift issues
   (tier skip or quick, `--label lane-filed`, same layout and `--body-file` rule) for ADR text that no longer matches
   the code, each naming the ADR and the file (none is a fine answer). Report the issues it filed.
9. `node scripts/lanes/lessons.mjs --recurring`: for each pattern with no open issue whose title carries
   `lesson:<area>/<pattern>`, file one `lane-filed` Task issue (tier quick) proposing a lint rule or test, from this
   session, not the architecture advisor. Report the issues filed.
10. `node scripts/lanes/consolidate.mjs`: report each group of open `ready` or `lane-filed` issues that share files, with
   a one-line merge proposal per group (which issue absorbs the others) for the owner. Merge nothing: the owner decides.
File one task issue per real problem (tier skip or quick). Do not fix anything in this session, with one exception:
step 7's cleanup of merged lanes, closed-issue lanes and empty orphan folders, which removes only finished lanes with a clean worktree and nothing unpushed.
