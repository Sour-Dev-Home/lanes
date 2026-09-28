# 0010: A detached per-lane reaper, spawned by start.mjs, finishes cleanup.mjs's job without the owner

Status: accepted

## Context

A lane's session never dies on its own: `lane.md` step 7 stops as soon as it opens its PR, or the moment the gate
waits on `/approve`, leaving an idle `claude --bg` process and a live worktree. Today only `cleanup.mjs`, run by hand
or by `/start` and `/health`, removes a merged lane's session, worktree and branch (#143 widens that same logic to
idle finished sessions, orphans and closed-issue lanes). The owner's goal, that a finished lane's session and
worktree disappear without the owner doing anything, needs something that runs between those owner-triggered
moments, for lanes the owner may not touch again for hours.

`queue.mjs` (ADR 0005/0006) cleans up merged lanes unattended, but only while the owner keeps it running in their own
terminal (its CLI is open issue #97). A `Stop` hook inside the lane's own session depends on that session firing it,
which fails exactly when a reaper is most needed: a lane stopped at `/approve`, hung, or killed. Windows Task
Scheduler or cron is rejected on the owner's standing constraint: no extra setup for adopters. #51 (ADR 0005/0007)
still forbids any automated path from calling `claude --bg` or `start.mjs` on its own; cleanup, unlike launching, is
not gated by `start-guard.mjs`, and any session may already run `cleanup.mjs`'s logic on a merged lane.

## Decision

1. Right after `start.mjs`'s `launchAll` gets a session id back from a launch, it spawns
   `node scripts/lanes/reap.mjs --issue N --session <id>` with `child_process.spawn` (`detached: true`, output to
   the reaper's own log) and calls `.unref()`, so it outlives the owner's session and `start.mjs`'s own exit.
   Spawning from `start.mjs`, not from `lane.md` or a hook inside the lane, means it does not depend on the lane
   reaching step 7, following instructions, or surviving at all.
2. `reap.mjs` polls every 5 minutes: the issue's state and the `issue-N-*` PR's state (`gh`), and the session's status
   (`claude agents --json`). Once the PR merged or the issue closed, it waits until the session is not busy, then
   removes exactly that one lane by calling `cleanup.mjs`'s own exported logic and its existing rules (the log saved
   first, never a busy session, never a dirty worktree, unpushed commits kept). It adds no deletion rule of its own.
   It gives up after 48 hours or 3 consecutive read failures and exits, leaving the lane for the next `/start` or
   `/health`, exactly as today.
3. One reaper per lane: a lock file `.lanes/reap/<issue>.json` (pid, session, started) prevents a second one and lets
   `status.mjs` report "reaper watching". The reaper appends one line per event (started, waiting, removed, gave up,
   error) to `.lanes/reap/<issue>.log`, so a crash or give-up is never silent. `.lanes/` stays git-ignored; the lock
   and log are bookkeeping, not deletion rules.
4. No new guard entry. `reap.mjs` never launches a lane and never posts a review, so it is not a `start-guard.mjs` or
   `approve-guard.mjs` case, and `claude rm`/`claude stop` are not launches. Because `cleanup.mjs` is already callable
   by any session, a `reap.mjs` run with another lane's `--issue`/`--session` pair grants nothing new; `reap.mjs` still
   refuses to act unless the target session's cwd is an `issue-N` worktree for that `N`, as a correctness check
   against a mismatched pair.
5. A single long-lived daemon covering every lane is rejected: it needs its own supervision story and is a single
   point of failure for every lane's cleanup. One reaper per lane needs no supervisor, exits on its own within 48
   hours, and its failure affects only its own issue.

## Decisions for the owner

- The 5-minute poll interval and the 48-hour and 3-failure limits are defaults the owner may tune later without
  another ADR.
- The reaper logs one line per event to `.lanes/reap/<issue>.log` instead of discarding its output, so failures are
  visible (owner decision, 2026-09-28: odd errors must never be silent in a tool meant for release).

## Consequences

- A merged or closed lane's session, worktree and branch disappear on their own within one poll after the session goes
  idle; `/start` and `/health` remain the fallback, not the only path.
- Up to `maxLanes` small `node` background processes exist at once, each polling `gh` and `claude` every 5 minutes.
- `.lanes/reap/` joins `.lanes/start/` as git-ignored bookkeeping; losing it on a crash only risks a duplicate reaper,
  which the lock's pid and session check catches on the next launch.
- No new security boundary: `reap.mjs`'s authority is exactly `cleanup.mjs`'s existing authority, scoped to one issue.

## Governs

- scripts/lanes/reap.mjs
- scripts/lanes/reap.test.mjs
- scripts/lanes/start.mjs
- scripts/lanes/start.test.mjs
- scripts/lanes/cleanup.mjs
- scripts/lanes/cleanup.test.mjs
