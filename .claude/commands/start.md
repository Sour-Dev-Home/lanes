---
description: Launch ready task issues as background lanes (checks each, refuses overlaps, caps at 8). Owner only; never run from a lane.
argument-hint: <issue-number> [<issue-number> ...]
---
If you are a lane or were started by a schedule, stop now. This is the owner starting lanes for issues $ARGUMENTS.
The start guard (`scripts/lanes/start-guard.mjs`, hooks in `.claude/settings.json`) enforces this: it allows the
command below once, only in the turn where the owner typed `/start` with these same issue numbers, and denies a
direct `claude --bg` in every session. Never work around a denial; report it.

1. Run `node scripts/lanes/start.mjs $ARGUMENTS`, exactly in this form (nothing chained or wrapped). It checks each
   issue the way `/lane` does (open, `ready`, one `tier:*` label, no open blocker), refuses a pair whose paths
   overlap (the `/status` overlap check) and anything past 8 lanes in flight, counting open `issue-*` PRs and running
   background sessions in `issue-<N>-` worktrees. It launches the rest from the repository root with
   `claude --bg "/lane <N>"`, one attempt each.
2. Report its output as it prints it: `#<N> → <id>` for each launched lane, `#<N>: refused: <reason>` and
   `#<N>: launch failed: ...` for the rest. Do not relaunch a failed or refused issue yourself. For `overlaps #M`,
   say the owner picks one and runs `/start` again. A launched lane is followed with `claude attach <id>` or
   `claude logs <id>`.
