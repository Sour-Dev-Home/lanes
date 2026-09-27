# 0003: contracts.test.mjs and the /start guard become owner-only; reviewers.mjs stays out

Status: accepted

## Context

ADR 0002 made a list of owner-only paths: a PR touching one waits on `/approve`. Its Consequences named
`contracts.test.mjs` as a test that a lane could change without the owner. The security review of #48 (PR #58)
looked again at three files in `scripts/lanes/` that are not on the list:

- `contracts.test.mjs` pins the parsers for the issue form, the PR body, verdict comments and ADRs, and fails on any
  ADR in `docs/adr/` that doesn't parse. It guards the ADR and verdict formats, so weakening it weakens what the gate
  trusts.
- `start-guard.mjs` (with its test) is the barrier between a session and launching lanes with `/start` (#51). It is
  the same kind of guard as
  `approve-guard.mjs`, which is already owner-only, and it didn't exist when ADR 0002 was approved.
- `reviewers.mjs` prints the reviewers a lane should spawn. The gate does not use it: it works out the required
  reviewers itself from `main`'s `lib.mjs` and `lanes.config.json`. Changing `reviewers.mjs` can only make a lane
  spawn the wrong reviewers, so the gate waits for verdicts that never come. It can stall a PR, never let one through.

## Decision

Amend ADR 0002's list. `paths.owner` in `lanes.config.json` gains:

- `^scripts/lanes/contracts\.test\.mjs$`
- `^scripts/lanes/start-guard(\.test)?\.mjs$`

`scripts/lanes/reviewers.mjs` is not added. Everything else in ADR 0002 stands, and ADR 0002 stays accepted.

## Decisions for the owner

1. Make `contracts.test.mjs` and the `/start` guard owner-only, and keep `reviewers.mjs` out. **Decided 2026-09-27**,
   after the security review of #48 (PR #58): approved as written.

## Consequences

- A PR that changes the ADR or verdict format checks, or the `/start` guard, waits on `/approve`, like one that
  changes the gate itself.
- ADR 0002's example of a test a lane may change alone (`contracts.test.mjs`) no longer holds; the principle does,
  for tests of modules that are not owner-only.
- `reviewers.mjs` changes still merge unattended once reviewed. A bad change there shows up as a PR stuck on a
  missing reviewer, which the owner sees in `/status`.
- `lib.test.mjs` keeps a sample and a near-miss for every owner regex, and asserts that `reviewers.mjs` is not
  owner-only, so dropping either addition or adding `reviewers.mjs` fails the tests.

## Governs

- lanes.config.json
