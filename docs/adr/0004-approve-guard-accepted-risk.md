# 0004: The approve guard is defence in depth; the script checks the grant; owner approvals are made visible

Status: superseded by 0025

## Context

The owner keeps lanes running as their own single GitHub identity (decided 2026-09-27): no second account, GitHub
App or restricted token, so adopters need no extra setup, and the owner accepts that a determined lane could forge
the owner's approval. PR #73's review rounds showed that the text-parsing guard in `scripts/lanes/approve-guard.mjs`
can't be complete: each round found a new way to build the `post-review.mjs owner` command (quotes, pipes, eval,
another shell with the command split across small variables). A direct `gh api` call that posts a `review/owner`
status never runs `post-review.mjs` at all, so no parsing of the command closes that route. Today the owner also gets
no signal when a `review/owner` status is posted, by any route.

## Decision

1. **Accepted risk.** The approve guard is best-effort defence in depth against a lane or model approving itself by
   accident or casually, not a barrier to a determined lane. Reviewers stop treating a newly found way of building a
   command that reaches `post-review.mjs owner` as a blocker: it becomes a follow-up issue rated `minor`. A
   regression, where something the guard or the script check previously caught now passes, is still `critical`.
   `.claude/agents/security-reviewer.md` and `.claude/agents/test-hunter.md` each state this rule.
2. **The script checks the grant.** `node scripts/lanes/post-review.mjs owner ...` refuses unless an unused `/approve`
   grant for that exact PR, younger than `GRANT_TTL_MS`, exists in the grant directory the approve guard's
   `UserPromptSubmit` hook writes (`.lanes/approve/`, resolved relative to the script's own file, as
   `approve-guard.mjs` does). It deletes the grant only after the status post succeeds, so a failed post leaves it
   for a retry within the TTL. The `PreToolUse` hook still decides allow or deny on the command, but no longer deletes
   the grant itself. `/approve <N>` stays prompt-free and single-use. A grant exists only right after the owner typed
   `/approve N`, and only for PR N. So however a command reaching the script was built, it is refused unless the owner
   has just approved that same PR. This covers every route through `post-review.mjs`; it does not cover a direct API
   call or a forged grant file, which part 3 makes visible and part 1 accepts.
3. **Approvals are visible.** When `lanes/gate` runs on a `status` event with context `review/owner` and state
   `success`, `gate.mjs` comments on each open PR whose head is that SHA: "Owner approval recorded for `<sha7>` at
   `<time>`. If you didn't approve this, dismiss it and report it." GitHub notifies the owner, including for an
   approval posted by a direct API call. It reuses the `status` case's existing lookup (`commits/{sha}/pulls`, open PRs
   whose head matches). The workflow passes the event's state as a new `env:` entry and gains `issues: write` for the
   comment. It stays default-branch-only and runs no PR code, and a comment fires no `status` event, so there is no
   loop.

## Decisions for the owner

1. The accepted-risk rule above, with new command-building bypasses rated `minor` and regressions `critical`.
2. `gate.mjs` is not governed by this ADR, to avoid an architecture-advisor run on every gate change.

## Consequences

- Reviews of PRs touching `approve-guard.mjs` stop blocking on "another way to build the command". They file a
  follow-up instead, which unblocks PR #73 after one more review round. A regression still blocks.
- Every route through `post-review.mjs owner` needs the owner's fresh `/approve` for that PR, however the command was
  built.
- A `review/owner` status posted any other way (direct API call, forged grant) still counts, as accepted, but the
  owner is notified through the PR comment and can dismiss it.
- `.github/workflows/lanes-gate.yml` gains `issues: write`.

## Amendment (2026-10-01, #562)

Amended by ADR 0021: under the `team` profile the owner stage is a native code-owner review on the head commit, read
by the gate; `/approve` and `review/owner` are solo only, so this ADR's accepted risk applies to solo alone.

## Governs

- scripts/lanes/approve-guard.mjs
- scripts/lanes/post-review.mjs
- .github/workflows/lanes-gate.yml
- .claude/agents/security-reviewer.md
- .claude/agents/test-hunter.md
