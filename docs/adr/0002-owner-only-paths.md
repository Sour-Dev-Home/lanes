# 0002: Owner-only paths decide what needs /approve; sensitive paths only add the security review

Status: accepted

*Amended 2026-10-02 by ADR 0025 part 11: the owner approval this ADR names is the GitHub code-owner review; `/approve` no longer exists.*

## Context

Since #27, a PR merges unattended only if it touches no *sensitive* path. In this repo nearly every PR touches
`scripts/lanes/` or `.claude/`, so nearly every PR waits on `/approve`, and the owner can't tell when one is ready.

## Decision

- "Sensitive" keeps one job: it requires the security-reviewer. It no longer forces `/approve`.
- A new **owner-only** path class does force `/approve`, at every tier. It covers the files that decide what gets
  checked and who can approve.
- A PR merges unattended when all of these hold:
  - its required reviews pass, with verdicts for the head commit;
  - no critical or important finding is unfixed;
  - "Needs the owner" says "nothing";
  - its contract change is not breaking;
  - it touches no owner-only path.
- The gate reads the path lists from the default branch, so a PR can't change its own rules.

The owner-only paths are `paths.owner` in `lanes.config.json`, a list of regex strings like the other path lists.
`compileConfig` reads it (an absent key is `[]`, so older installed configs still load), `classifyFiles` returns
`owner: boolean`, and `gateDecision` waits with `waiting on owner (/approve) (owner-only path)` when it is true and
there is no `review/owner` success. It waits, never fails: a `tier:skip` PR adding an ADR is valid, it just needs the
owner. `requiredReviewers` ignores it, so owner-only adds no reviewer.

The list:

- The gate and trust code, with their tests: `scripts/lanes/(gate|lib|approve-guard|post-review|issue-contract)(.test)?.mjs`,
  `scripts/lanes/gate-decision.test.mjs`, `scripts/lanes/workflow.test.mjs`.
- `scripts/gate-workflow.test.mjs` (amendment, #207): it pins `lanes-gate.yml`'s permissions, `STATUS_STATE` env entry
  and default-branch checkout, the same kind of security pin as `workflow.test.mjs`.
- `scripts/lanes/(install|setup-repo|new-project)(.test)?.mjs`: they write settings and rulesets into other repos.
- `.claude/settings.json`, `.github/`, `.githooks/`, `lanes.config.json`.
- The lane and reviewer instructions: `.claude/agents/`, `.claude/commands/(lane|night|approve).md`.
- `docs/adr/`, `package.json` and lockfiles, `vendor/`, `CLAUDE.md`, `.gitattributes`, `scripts/preflight.mjs`.
- `.env*`, `auth/`, `secrets/`, `deploy/`: already sensitive; for installed projects these are the obvious major
  changes.

## Decisions for the owner

1. The owner-only list above, including the three additions beyond the first draft (`install`, `setup-repo` and
   `new-project`; the tests of owner-only modules; `.env*`, `auth/`, `secrets/`, `deploy/`). **Decided 2026-09-27:**
   approved as written.
2. Whether a `tier:quick` PR with an *additive* contract change may also merge unattended. Today only full may: full
   requires the architecture-advisor, and quick doesn't. **Decided 2026-09-27:** keep today's rule; a `tier:quick` PR
   with a contract change waits on the owner.

## Consequences

- In this repo, tooling work merges by itself once reviewed: `/status`, metrics, `blockers.mjs`, `/start`, cleanup,
  the notify hook's own script, and docs. Work on the gate, settings, workflows or the lane and reviewer
  instructions still comes to the owner.
- Unattended merges stay visible under MERGED in `/status`.
- An owner-only change is itself owner-only, so widening what merges unattended always needs `/approve`.
- A test of a module that is not owner-only (for example `contracts.test.mjs`) can be changed without the owner;
  its review is the test-hunter's and the security-reviewer's.

## Amendment (2026-09-30, #493)

The owner's `/approve` (a trusted `review/owner` success on a commit) carries to a later head of the same PR when that
commit's own diff is byte-identical to the head's own diff, under the same `diffFingerprint` the gate uses to reuse
reviewer verdicts (three-dot compare against the base branch, so a clean merge from main drops out). The owner then
does not type `/approve` again after a merge that changed none of the approved change. The rule:

- It applies only when the head has no trusted `review/owner` status of its own, and the gate uses the reuse rules'
  trust (a bot-posted status never counts) and "no newer status on the head wins" (any trusted `review/owner` status on
  the head, a failure included, decides instead).
- A carried approval covers byte-identical approved code only. Any change to the PR's own diff (a conflict resolution,
  a new commit, a whitespace change) stops it, and the gate says `owner approval was for <short sha>; the PR's own diff
  changed since: /approve <N>`. A diff that cannot be fetched or compared is never treated as identical.
- It replaces only the owner's approval. It never makes the gate skip a reviewer: each required reviewer must still
  have a success on the head (its own or a reused one under its own rules), and unfixed findings still block. Unlike
  reviewer reuse, it does not look at changes to a reviewer's brief or checklists, since the owner approved code.
- How the approval is posted (`/approve`, `approve-guard.mjs`, `post-review.mjs`) does not change.

## Amendment (2026-10-01, #562)

Amended by ADR 0021: under the `team` profile the owner stage is a native code-owner review on the head commit, read
by the gate; `/approve` and `review/owner` (and the carry above) are solo only.

## Governs

- lanes.config.json
- scripts/lanes/lib.mjs
