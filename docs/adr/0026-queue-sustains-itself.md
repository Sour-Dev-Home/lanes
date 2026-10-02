# 0026: The owner queue sustains itself

Status: accepted

## Context

The owner queue (ADR 0005) runs in the owner's own terminal and, under team (ADRs 0019, 0025), holds the App key,
mints installation tokens and launches `claude --bg` lanes. ADR 0006 part 4 makes it exit after three idle ticks, and
#535 makes it exit 3 once `scripts/lanes` changes after it started ("git pull --ff-only, then restart the queue"). In
this repository nearly every merge touches `scripts/lanes`, so the owner relaunches the queue by hand all day. Three
consecutive failed GitHub reads also exit it (exit 1), though such outages are usually transient.

Making it self-restarting has a security consequence. `lanes.config.json` `paths.owner` (mirrored by
`.github/CODEOWNERS`) does not cover the queue's runtime: `queue.mjs`, `start.mjs`, `app-token.mjs`, `reap.mjs`,
`cleanup.mjs`, `lifecycle.mjs`, `paths.mjs`, `pick.mjs`, `blockers.mjs` and the like. A lane's PR changing them merges
after the AI reviewers and the gate, with no code-owner review. Today the owner restarts by hand, so a bad merge still
waits for a human act, although the owner does not read the code. A queue that pulls and re-executes runs that code
automatically, in the process holding the App key. Three options: (a) make every script the queue imports at runtime
an owner path; (b) restart automatically only when every changed lanes file is an owner path, otherwise stop as today;
(c) accept the risk.

## Decision

1. **Security: option (a).** Every script the queue loads at runtime becomes an owner path: it is added to
   `paths.owner` in `lanes.config.json` and to `.github/CODEOWNERS`, kept identical as `workflow.test.mjs` requires,
   with its `.test.mjs` file. Merging such a change then needs the owner's one-click code-owner review in GitHub, the
   same check that already protects `gate.mjs` and `lib.mjs`. The set is the transitive import closure of `queue.mjs`
   plus the scripts it spawns. A test computes that closure from the source and fails if any file in it is not matched
   by `paths.owner`, so a new import cannot silently escape review. Option (b) is rejected because nearly every merge
   changes a non-owner runtime file, so it would leave the queue stopping on most merges, which is the owner's
   complaint. Option (c) would put unreviewed code next to the App key.
2. **Stale scripts.** On detecting that `scripts/lanes` changed since start (the #535 check), the queue restarts only
   when all of these hold: the branch is `main`; `git status --porcelain` is empty; `git pull --ff-only` succeeds; and
   the new `HEAD` equals `origin/main`. Otherwise it stops, names the failed precondition, and exits 3. A pull that
   cannot fast-forward exits 4, so it can be told apart from a dirty checkout.
3. **Re-exec.** Node has no `exec()` on Windows, so the queue runs as a thin supervisor loop. The first process
   supervises: it spawns `node scripts/lanes/queue.mjs <same args>` with inherited stdio and `LANES_QUEUE_CHILD=1`,
   waits, and exits with the child's code, except for the restart code 10. A child that detects stale scripts and
   pulls successfully does not spawn anything: it exits 10, and the supervisor spawns the next child. There are never
   more than two processes, however many restarts happen. Both processes refuse to run inside Claude (exit 2) before
   anything else. Ctrl+C reaches both through the shared console and ends the run.
4. **Idle.** After three idle ticks (ADR 0006 part 4's count, kept) the queue lengthens its tick from 3 to 15 minutes
   and keeps polling; it does not exit. Any picked work returns it to the 3-minute tick. Idle polling prints nothing
   new.
5. **Read failures.** A failed GitHub read backs off 1, 2, 4, 8 and more minutes, capped at 15, and retries; it never
   exits for that. One line per failure names the delay; a success resets the delay.
6. **Restart output.** Each restart prints one line: `queue: lanes scripts changed (<old short sha> -> <new short sha>),
   pulled, restarting (#N)`, where N counts restarts in this run.
7. **Exit codes.** 0 on Ctrl+C (or SIGINT/SIGTERM); 2 on an argument, config or Claude-session error; 3 when scripts
   are stale but the restart preconditions do not hold; 4 when the pull cannot fast-forward; 10 only between child and
   supervisor. Exit 1 is retired.
8. **ADR 0006 amendment.** Part 4 is replaced by this ADR; an amendment note goes under it, and its Consequences line
   "A queue left running idles out instead of polling forever" points here. `docs/USING.md` documents the new exits,
   the idle tick, the backoff and the restart line.

## Decisions for the owner

Decided by the owner on 2026-10-02 in /plan-issues: the queue sustains itself, stopping only on a config error, a pull
it cannot fast-forward, or Ctrl+C. Approved with this plan: option (a), the queue's runtime scripts become owner paths
with an import-closure test; a 15-minute idle tick and a 15-minute backoff cap; the exit codes in part 7.

## Consequences

- The owner stops relaunching the queue after every merge. A queue left running polls until Ctrl+C, about one round of
  GitHub reads per 15 minutes when idle.
- The process holding the App key only restarts into code the owner approved in GitHub, so the self-restart adds no
  unreviewed path. Cost: more owner-path files, and one more owner review on PRs that change queue code.
- A failed pull or a dirty checkout stops the queue loudly, so there is never a silently stale queue.
- The import-closure test keeps the owner-path list complete: adding a runtime import without covering it fails CI.
- The supervisor keeps the code it started with, so a change to the supervisor part itself takes effect at the next
  manual start; everything else takes effect at the next restart.
- Exit 1 disappears; anything that matched it uses 3 and 4.

## Governs

- scripts/lanes/queue.mjs
- scripts/lanes/queue.test.mjs
- docs/USING.md
- docs/adr/0006-queue-every-ready-issue.md
- lanes.config.json
- .github/CODEOWNERS
- scripts/lanes/workflow.test.mjs
