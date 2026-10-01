# lanes: standing rules for every session

These are the owner's standing decisions for this repository. They apply to the owner session, lanes, reviewers and
cloud sessions alike; a session that cannot follow one stops and says so. How lanes works is in `docs/USING.md`;
why it is shaped as it is, in `docs/adr/`.

## Current direction

Lanes v0.1.0 is tagged and recorded in `docs/history/2026-09-29-lanes-v0.1.0-snapshot.md`. The owner intends to
restructure lanes into a reusable core with per-project profiles; the decision goes through an ADR. Record each
restructure decision in `docs/adr/` or `docs/history/`, written so it can later be published as-is.

## Rules

1. **Never bypass a git hook.** No `--no-verify` or any other hook-skipping flag, from a lane or the owner session.
   When a hook refuses, stop, report its output, and file the root cause if the hook is wrong.
2. **Security review is never narrowed to save tokens.** Keep `paths.sensitive` and the reviewers' scope as they are;
   find savings in model choice, issue sizing and wasted runs instead. The security reviewer rests on the OWASP Cheat
   Sheet Series (ADR 0009). A reused verdict is valid only for byte-identical reviewed code.
3. **Odd errors are defects.** Lanes ships to other people, so a guard false positive, a silent stop, missing data or a
   stale checkout is reproduced, root-caused with evidence and filed as a Task issue, not worked around.
4. **Every Task issue's Scope names concrete repository paths**, at every tier; `/start` skips an issue whose Scope
   names none.
5. **Consolidate before starting.** Before releasing lane-filed follow-ups or starting a batch, compare Scope paths and
   propose merging issues that share files, keeping security fixes reviewable in size.
6. **Owner-only stays owner-only.** `/plan-issues`, `/start` and `/approve` are typed by the owner; never run, imitate
   or work around them from a lane, a schedule or another session. A denial or refusal is reported, never routed
   around.
7. **No extra setup for adopters by default.** The solo profile needs no account, app or credential; acting as the
   owner's account is an accepted risk there (ADRs 0004 and 0007). The team profile (ADR 0019, 0021) is opt-in and needs
   a GitHub App and a code-owner ruleset.
8. **No personal data and no absolute local paths** in any commit, issue or PR.
9. **Surface what waits on the owner.** The owner session names every PR waiting on the owner whenever it reports:
   under solo, name each PR waiting on `/approve` with the ready `/approve <N>` line; under team, name each PR waiting
   for a code-owner review with its URL.
