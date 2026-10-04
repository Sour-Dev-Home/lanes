---
area: queue
pattern: hold-skipped-issues-from-fresh-launch
severity: important
reviewer: test-hunter
source: "#724"
---

When the queue skips or defers an issue because a worktree for it already exists (several worktrees, over the cap,
already tried this run), the issue must also be held out of the ordinary launch plan. A `ready` issue with no session
and no PR looks like a fresh candidate, so it was launched from the repo root, where the lane stops at its worktree
check. Test the skip path and the "tried once, then the lane vanished" path through a whole queue run, not only the planner.
