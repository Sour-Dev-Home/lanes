# 0005: An owner-run queue launches a named stretch of issues, outside any Claude session

Status: accepted

## Context

`/start <N...>` and `/start --auto [--go]` pick and launch lanes once, from inside a Claude session, gated by
`start-guard.mjs` so that only the owner typing `/start` in that session can trigger a launch (#51, the security
review of #18). A lane, a scheduled run, or a later turn can never call `start.mjs` or `claude --bg` on its own. A
lane never cleans up after itself either: it ends after opening its PR, and the merge that makes cleanup safe happens
later in the merge queue, so only `cleanup.mjs`, run by hand, removes a merged lane's session, worktree and branch.

The owner wants to hand over a stretch of several issues at once, have the next ready, unblocked one start as capacity
and dependencies allow, and have merged lanes disappear, without being interrupted for either. Issue #5 (dashboard)
will later watch this; `status.mjs --json` already exists for that and needs no change here.

Standing constraints: no extra setup for adopters (no second account, GitHub App or special token); lanes share the
owner's identity as an accepted risk (owner decision, 2026-09-27); no automated path may call `claude --bg` or
`start.mjs` on its own (#51).

## Decision

Add `scripts/lanes/queue.mjs <N...>`, run by the owner in their own terminal: never as a Claude tool call, never
through `claude --bg`, never scheduled. It takes the exact list of issue numbers on its command line and holds that
stretch in process memory only; it adds no persistent state. Every 3 minutes it:

1. Removes merged lanes with the same cleanup logic as `cleanup.mjs` (factored out so both call it, not duplicated).
2. Re-reads issues, PRs and sessions and narrows to the stretch's issues that are open, `ready`, unblocked and not
   already in flight, with the same checks `start.mjs` makes. It never considers an issue outside the stretch.
3. Launches them through `pickStartable`, against the global `maxLanes` cap and every path claimed in flight, stretch
   or not. A queue has no private cap and no path exemption.
4. Prints one line per tick in `status.mjs`'s style.
5. Exits when every stretch issue is closed, or as soon as one needs the owner (refused for a reason that will not
   clear itself, a lane stopped or its PR has a failing check or review, a PR waiting on `review/owner`). It never
   polls with nothing left that can move without the owner.

`start-guard.mjs` always denies a `queue.mjs` run found in a Bash tool call, from any session, with no grant path.
`queue.mjs` launches with `claude --bg` through `execFileSync`, as `start.mjs` does, not through a tool call.

`start.mjs` (issue numbers and `--auto`) runs the same cleanup first, best-effort: a cleanup failure is reported and
never blocks a launch. `status.mjs` stays read-only.

## Consequences

- A stretch launches unattended over hours without repeated `/start`, and merged lanes disappear without a separate
  `cleanup.mjs` run.
- No new account, token or persistent state; the #51 boundary (only the owner, outside Claude or by typing `/start`,
  starts a lane) holds.
- The stretch is an explicit list, not the whole dependency graph; a longer, discovered plan belongs to the dashboard
  (#5).
- Every `/start` now also lists PRs and sessions for cleanup; a failure there never turns into a refused launch.

## Governs

- scripts/lanes/queue.mjs
- scripts/lanes/queue.test.mjs
- scripts/lanes/start-guard.mjs
- scripts/lanes/start-guard.test.mjs
- scripts/lanes/cleanup.mjs
- scripts/lanes/cleanup.test.mjs
- scripts/lanes/start.mjs
- scripts/lanes/start.test.mjs
