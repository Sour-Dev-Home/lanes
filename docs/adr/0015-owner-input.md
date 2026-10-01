# 0015: A fail-closed structural checker retires /approve for additive-only config and test-pin diffs; I4 and the start guard hold

Status: accepted

## Context

Owner idea, 2026-09-29: reduce owner input without trading security. Today `classifyFiles` (`scripts/lanes/lib.mjs`)
marks a PR `cls.owner` when any changed file matches `paths.owner` in `lanes.config.json`, and `gateDecision` (same
file) sends every such PR to `waitOwner("owner-only path")` however small the diff. `paths.owner` lists
`^lanes\.config\.json$` and `^scripts/lanes/workflow\.test\.mjs$` whole: any edit to either waits on `/approve`.

`issue-contract.mjs`'s `issuePlan` enforces I4: a `lane-filed` issue never gets `ready` automatically, "even from
the owner". ADR 0004 and 0007 accept that lanes share the owner's GitHub identity and that a lane could file an issue
whose own text tries to steer a later lane; I4 is the boundary that keeps that text in front of a maintainer before
another lane reads it as instructions.

`queue.mjs` already launches lanes unattended, outside Claude, in the owner's own terminal (ADR 0005);
`start-guard.mjs` (ADR 0007) still refuses `start.mjs` and `claude --bg` from inside any Claude session.
`status.mjs`'s `stalledLanes` (`STALLED_MINUTES = 30`, #338) flags a busy session silent 30 minutes or more but takes
no action. `cleanup.mjs`'s `planCleanup` never touches a busy session and never deletes a dirty or unpushed worktree;
lane-290 sat stalled 4 hours with an unpushed commit in its worktree because nothing else acted.

Triggers: new persistent state (`.lanes/queue-recover/<issue>.json`, git-ignored, like `.lanes/reap/`); a security
boundary loosened (the structural checker and the stalled-session stop), which is why both are scoped tightly. No new
dependency and no new adopter setup.

## Decision

1. **Owner-path structural exemption, narrower than proposed.** Add `scripts/lanes/owner-diff.mjs`. It is consulted
   only when the PR's changed files are exactly `lanes.config.json` and/or `scripts/lanes/workflow.test.mjs`. It
   returns "additive" only when `lanes.config.json`'s base-versus-head JSON diff touches `paths.owner` alone, by
   appending entries (nothing removed, reordered or changed), and/or `workflow.test.mjs`'s diff consists solely of
   added lines forming whole new top-level `test(...)` blocks with no line removed or changed elsewhere. Anything it
   cannot fully classify this way (a parse error, a removed or edited entry, any other file, any `modules` key
   touched) is "needs owner", failing closed. When additive, every required reviewer already passed, and "Needs the
   owner" says nothing, `cls.owner` is false for that PR only; every other owner path is unaffected.
2. **`modules[].paths` and `modules[].imports` are excluded from the fast path.** Adding an import edge is the
   architecture call ADR 0008 reserves for the owner: it can let one module reach code it could not reach before, and
   a mechanical diff cannot tell a safe edge from a widened boundary.
3. **I4 is not relaxed; auto-release of lane-filed issues is rejected.** A lane-filed issue's text is what a later
   lane reads; a path, tier or label check bounds where code lands, not what the issue asks a lane to do, and that gap
   is the injection surface ADR 0004 and 0007 route through the owner.
4. **`queue.mjs` recovers a stalled lane once, only from its own tick** (outside Claude, ADR 0005; never in
   `gate.mjs`, a workflow or `start.mjs`, so ADR 0007's boundary is untouched). When an issue is in `stalledLanes` or
   its session ended with no open PR, `queue.mjs` runs `claude stop <id>`, waits for it to end, and removes the
   worktree only when `cleanup.mjs`'s own dirty and unpushed checks pass, reusing that rule, not overriding it. If the
   worktree holds uncommitted or unpushed work, it does not relaunch: it reports the lane to the owner and leaves the
   worktree intact. Otherwise it relaunches once through its normal launch path. `.lanes/queue-recover/<issue>.json`
   records the one attempt; a second stall or PR-less exit on the same issue is printed in `queue.mjs`'s output and
   never retried until the marker is cleared by hand.
5. **`queue.mjs` becomes the documented default driver**; its digest and `/approvals` group waiting PRs by age,
   reusing ADR 0012's batching and `status.mjs`'s data. No new state or decision beyond item 4's marker.

## Decisions for the owner

1. `modules[].paths` and `modules[].imports` never qualify for the fast path; only `paths.owner` growth in
   `lanes.config.json` and whole-new-`test()`-block growth in `workflow.test.mjs` do.
2. Auto-release of `lane-filed` issues is rejected; I4 is unchanged.
3. A stalled or PR-less lane is stopped and relaunched at most once per issue, tracked by a marker file; a lane with
   unpushed work is reported, never relaunched over.
4. Stalled-lane recovery runs only inside `queue.mjs`'s own tick, in the owner's terminal outside Claude.
5. The structural checker fails closed: anything it cannot prove purely additive is an owner path.

## Consequences

- Additive edits to `paths.owner` and new tests appended to `workflow.test.mjs` merge unattended once reviewers
  pass; every other owner path, and any module-map edit, still needs `/approve`.
- Lane-filed issues still always wait for a maintainer to drop the label.
- A stalled or PR-less lane loses at most one queue tick before recovery starts; a repeat failure surfaces once and
  stops rather than looping.
- New persistent state: `.lanes/queue-recover/<issue>.json`, git-ignored, no secrets.
- The new code in `lib.mjs`, `gate.mjs`, `owner-diff.mjs` and `queue.mjs` gets security and architecture review, as
  owner and gate paths already do.

## Amendment (2026-10-01, #562)

Amended by ADR 0021: under the `team` profile the owner stage is a native code-owner review on the head commit, read
by the gate; `/approve` and `review/owner` are solo only, and the additive exemption is solo only too (it stays off
under team).

## Governs

- lanes.config.json
- scripts/lanes/lib.mjs
- scripts/lanes/lib.test.mjs
- scripts/lanes/gate.mjs
- scripts/lanes/gate.test.mjs
- scripts/lanes/owner-diff.mjs
- scripts/lanes/owner-diff.test.mjs
- scripts/lanes/queue.mjs
- scripts/lanes/queue.test.mjs
- scripts/lanes/cleanup.mjs
- scripts/lanes/cleanup.test.mjs
- scripts/lanes/status.mjs
- scripts/lanes/status.test.mjs
