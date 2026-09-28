---
description: Launch ready task issues as background lanes (checks each, refuses overlaps, caps at 8 by default). Owner only; never run from a lane.
argument-hint: <issue-number> [<issue-number> ...] | --auto [--go]
---
If you are a lane or were started by a schedule, stop now. This is the owner starting lanes for $ARGUMENTS.
The start guard (`scripts/lanes/start-guard.mjs`, hooks in `.claude/settings.json`) enforces this: it allows the
command below only in the turn where the owner typed `/start` with these same issue numbers or this same `--auto`
form (`/start --auto` never allows `--auto --go`), and denies a direct `claude --bg` in every session. `start.mjs`
checks the same grant itself, refuses with `nothing launched: <reason>` without it, and deletes it after its launches,
so it runs once per `/start`. Never work around a denial or a refusal; report it.

First bring the lanes scripts up to date: if `git branch --show-current` prints `main` and `git status --porcelain`
prints nothing, run `git pull --ff-only`. Otherwise print one line, `lanes scripts may be stale: this checkout is not a
clean main`, and carry on. If the pull fails, report its error in one line and carry on. Run each of these git
commands on its own, never chained to the `start.mjs` run below, which the guard allows only as the plain command.

1. With issue numbers, run `node scripts/lanes/start.mjs $ARGUMENTS`, exactly in this form (nothing chained or
   wrapped). It checks each issue the way `/lane` does (open, `ready`, no `needs-owner`, one `tier:*` label, no open
   blocker), refuses a
   pair whose paths overlap (the `/status` overlap check), refuses an issue whose paths overlap the files of running
   lanes and open PRs (as `--auto` does, ignoring `start.softPaths`) and anything past `start.maxLanes` lanes in flight (from
   `lanes.config.json`, 8 by default, at most 10), counting open `issue-*` PRs and running background sessions in
   `issue-<N>-` worktrees. It launches the rest from the repository root with `claude --bg --name lane-<N> "/lane <N>"`,
   one attempt each. An issue labelled `model:opus` launches with `--model opus` over its tier's model (use it for
   security-critical parsing, guards and contracts the reviewers found hard); any other `model:*` label is ignored
   and printed as `#N: ignored label model:<x>`.
2. With `--auto`, run `node scripts/lanes/start.mjs --auto`. It is a dry run: it checks every ready issue the same
   way, picks the ones that overlap neither each other nor the files open PRs and running lanes touch (paths in
   `start.softPaths` never count), up to the cap, and prints `#<N>: would start` or `#<N>: skipped: <reason>` for each.
   It launches nothing. Only when the owner typed `--auto --go`, run `node scripts/lanes/start.mjs --auto --go`
   instead: it recomputes the same plan and launches exactly its picks, as step 1 does.
3. Before its plan, the script removes merged lanes the way `cleanup.mjs` does, so it prints cleanup lines first
   (with `--auto` and no `--go`, only what it would remove). A `cleanup failed: <reason>` line never changes the plan
   or the exit code; report it as it is.
4. Report its output as it prints it: `#<N> → <id>` for each launched lane, `#<N>: refused: <reason>`,
   `#<N>: skipped: <reason>` and `#<N>: launch failed: ...` for the rest. Do not relaunch a failed, refused or skipped
   issue yourself. For `overlaps #M`, say the owner picks one and runs `/start` again. A launched lane is followed with
   `claude attach <id>` or `claude logs <id>`.
