# ADR 0018 phase 2 deferred: per-module locks (2026-09-30)

ADR 0018 set five phases for restructuring lanes into a core with per-project profiles. Phase 2 was to replace the
Scope-path overlap scheduler (`pick.mjs`, used by `start.mjs`, `queue.mjs`, `status.mjs` and `snapshot.mjs`) with
per-module locks from the module map. The owner deferred it on 2026-09-30, before filing any issue, after the
architecture advisor's draft ADR showed what it would cost here.

## Why it was deferred

- **This repo's map would serialize almost everything.** The `queue` module holds `pick`, `status`, `paths`, `start`,
  `start-guard`, `queue`, `cleanup`, `reap`, `lifecycle`, `snapshot`, `lane-cost` and `consolidate`. Locking it whole
  would run nearly every lane one at a time; issues #448 and #465 ran in parallel only because their files did not
  overlap. The map would have to be split first.
- **Locks are coarser than path overlap.** Two lanes editing different files of one module would wait for each other.
- **Little would retire.** Files the map does not claim, and repositories with no map, still need the path check, so
  `paths.mjs`, `start.softPaths` and `consolidate.mjs` would all stay. The phase would add a lock layer beside the path
  check rather than replace it.
- **The rollout was large for no gain here.** One module per issue, after the split, made it about eight issues (over
  `/plan-issues`' six), for a scheduler no better than today's in this repository.

The restructure's aim is less machinery; this phase mostly added some. That is the same Conway's-law pattern recorded
in the v0.1.0 snapshot: the process splitting work finer than it needs.

## The drafted design, kept for later

The advisor's ADR 0019 draft (not filed) decided:

- A lock is derived from what is in flight (open `issue-*` PRs, lane sessions, running issues), never stored, so a dead
  lane cannot leak one. A dead lane with an open PR keeps its locks, and its resume takes none. A lane that died before
  its PR keeps the issue in flight while its worktree exists, so unpushed commits are never raced.
- A path resolves to its module's lock; an unclaimed path locks at file granularity as today, with `softPaths` kept for
  unclaimed paths only. With no module map, behaviour is exactly today's.
- An issue spanning modules (only through ADR 0008's contract exception) takes all its locks or none, so there is no
  deadlock.
- The ranking, the lane cap and the "scope names no paths" skip stay; `consolidate.mjs` stays keyed on files; the
  snapshot's `overlaps` keeps its shape and means "shares a lock".
- It would supersede ADR 0005 decision 3 and amend ADRs 0006, 0014 and 0017; security review stays keyed on
  `paths.sensitive` and `paths.contract`.

## What would reopen it

- Evidence that path overlap blocks starts often: a count of `overlaps …` skips from `/start` and the queue over a few
  weeks.
- A module map that covers the whole repository at a useful granularity, drawn first as part of phase 1's follow-up
  (filling lanes' own map with owners, risk and reviewers).
- Adopters whose maps are complete, where module locks would replace, not sit beside, the path check.

## What comes instead

Finish phase 1 (#460 to #463), fill lanes' own module map, then plan phase 3: CODEOWNERS generated from the map, branch
protection and the native merge queue, where platform features replace custom code.
