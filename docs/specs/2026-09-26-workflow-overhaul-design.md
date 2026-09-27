# Workflow overhaul: parallel lanes, contracts, unattended nights

Status: draft for the owner's review (2026-09-26). Pilot project: this repository, `lanes`.

## Why

The current multi-agent setup (five long-running sessions and a coordinator that relays
messages) works, but the owner cannot see status at a glance, too many things need his
attention, and it costs a lot of usage and time. This design replaces standing sessions
and cross-session messages with short-lived task sessions that coordinate through GitHub,
written contracts at every handoff, required checks as the only gatekeeper, and an
unattended mode so that work continues while the owner is away (for example overnight).

`lanes` is the pilot: it builds the progress dashboard (a separate spec) while running
this workflow, and it packages the workflow as a reusable template for later projects.
`satisfactory-dash` keeps its current setup during the pilot.

## Requirements (from the owner)

1. See the state of every task at a glance, including what is waiting on him.
2. Parallel speed, without having to track long-running sessions.
3. Every task handoff is clear and uses contracts wherever possible: written, checkable
   agreements, not prose the receiver has to interpret.
4. Decent progress continues while he is unavailable for a stretch, such as overnight.
5. Validation stays: CI, tests first, fresh-eyes reviewers by tier, his final review for
   anything risky.
6. It is reusable: a new project adopts it by copying a template.

## 1. Roles

| Role | What it is | Lifetime |
| --- | --- | --- |
| Owner (director) | Opens or approves issues, starts lanes, reviews a PR's summary and diff, approves | — |
| Lane | A fresh Claude Code session for exactly one issue, in its own git worktree | Ends when its PR merges |
| Reviewers | Fresh subagents: test-hunter, ui-reviewer, security-reviewer, architecture-advisor | One run per PR |
| `/status` | The progress dashboard (terminal and web) | Always available |
| `/health` | A weekly check: stale issues, flaky tests, usage, stuck chains | Weekly |

- Normally **3 lanes** run at once.
- Lanes never message each other. A dependency between tasks is a GitHub "blocked by"
  link, resolved when the blocking PR merges.
- There is no coordinator session. Its jobs move to required checks (gating), the merge
  queue (merging), `/status` (visibility) and `/health` (upkeep).

## 2. Task lifecycle and contracts

### The issue is the task contract

A required issue form with these fields; an issue is not `Ready` until all are filled:

- **Goal**: one sentence.
- **Acceptance criteria**: a checklist; each item must be testable and becomes a test.
- **Interface contract**: the exact type, schema, endpoint or CLI shape the task produces
  or consumes, as a link to the contract file, or "none".
- **Scope**: files and areas in scope, and explicitly out of scope.
- **Blocked by**: issue links, or none.
- **Tier**: `full`, `quick` or `skip` (section 3).

### Contracts between tasks are code

When two tasks meet at an interface, the interface lands first, in its own small PR:
a TypeScript type with a runtime schema (zod), or an OpenAPI / JSON Schema file, plus a
contract test. Downstream issues list that PR's issue under "Blocked by". Lanes agree
through a merged, validated file, never through messages.

### A lane's steps

1. `/lane <issue>` checks the issue's contract fields, creates the branch
   `issue-<N>-<slug>` and its worktree.
2. It reads the issue and the files it links, nothing else by default.
3. It writes the acceptance criteria as failing tests, then implements until they pass.
4. It runs the reviewers its tier requires and posts their verdicts (section 3).
5. It opens the PR with the return contract below and enables auto-merge.
6. Follow-up work it discovers becomes new issues in the same form, not notes.

### The PR is the return contract

A required PR template, checked by the `pr-contract` job:

- **What changed**, mapped item by item to the issue's acceptance criteria.
- **Contract changes**: none / additive / breaking. Breaking fails unless the issue says so.
- **Tests added.**
- **Reviewer results** (also posted as commit statuses).
- **Needs the owner**: anything he must decide, or "nothing".
- **Not done**: anything left out, with the follow-up issue links.

The dashboard reads the same fields, so a task's contract is also its status.

## 3. Review gates

Everything that blocks a merge is a required check on `main`.

| Tier | Reviewers the lane must run | Typical work |
| --- | --- | --- |
| `full` | test-hunter FULL; security-reviewer when auth, secrets or input handling change; architecture-advisor when a contract or persistent state changes | backend logic, data, APIs |
| `quick` | test-hunter QUICK (one round, changed files only); ui-reviewer if the change is visible | UI, small fixes |
| `skip` | none; the status says `skipped: <reason>` | docs, config, tests only |

Cost rules carry over: the test-hunter runs on Sonnet, once per PR, never re-run after a
merge from main or a rebase when the PR's own code did not change, and a second round
only if the first found real bugs.

Required checks: `verify` (types, lint, unit tests), `e2e` where the project has one,
`security` (the PII and local-path scan: patterns from a repository secret, output
`file:line` only), CodeQL (high and above blocks), `pr-contract`, the `review/*` statuses
the tier requires, and `merge-approval` (below).

- `scripts/post-review.sh <reviewer> <verdict> "<summary>"` is the only way statuses are
  posted, on the PR's current head, and it has its own narrow permission rule. The
  `review/*` check matches the posted reviewers against the issue's tier.
- `/approve N` is the owner's approval: it posts `owner-approved` on the head. Because it
  is a per-commit status, a later push drops it automatically.

### Reviewer verdicts are contracts too (amendment, 2026-09-26)

A reviewer's result is a JSON verdict, validated before it is posted, never free text:

```json
{
  "reviewer": "test-hunter",
  "verdict": "success",
  "summary": "4 tests added, 1 bug fixed",
  "criteria": [{ "index": 1, "result": "pass", "evidence": "test/foo.test.mjs: rejects a duplicate name" }],
  "findings": [{ "severity": "important", "file": "src/a.ts", "line": 12, "summary": "…", "fixed": true }]
}
```

- `criteria` covers the issue's acceptance criteria by 1-based index. The test-hunter and
  the ui-reviewer must cover every criterion exactly once (`pass`, `fail` or
  `not-applicable`); the security reviewer and the architecture-advisor may leave it empty.
- A verdict of `success` is refused if any criterion is `fail` or any `critical` or
  `important` finding is not `fixed`.
- The status description is derived from the JSON ("4/4 criteria pass, 1 fixed"), and the
  full JSON is kept as a PR comment so the dashboard can show per-criterion progress.

### `merge-approval`

Passes when either:

- `owner-approved` is on the head, or
- the PR is **unattended-eligible** and every other gate is green.

Unattended-eligible (decided by CI from the diff, never by the lane): tier `skip`, or
tier `quick` with no change to contract files and no change under auth, secrets, CI
(`.github/`), deployment or `.claude/` paths.

## 4. Configuration, tools and unattended mode

Committed in the repository:

- `.claude/commands/`: `/lane`, `/status`, `/approve`, `/adr`, `/health`, `/plan-issues`.
- `/plan-issues "<idea>"` (amendment, 2026-09-26) is the planner: from a 1-4 sentence idea it
  drafts at most six Task issues into a local file (contract issue first, "Blocked by" wired,
  a tier suggested for each). The owner edits and approves the draft; only then are the
  issues created. It never runs unattended.
- `.claude/settings.json`: narrow allow rules (`post-review.sh`, read-only `gh pr` and
  `gh issue` commands, `npm` scripts); no blanket `gh api`.
- A pre-push hook running `npm run preflight` (PII and path scan, conflict check).
- `.github/`: the issue form, the PR template, `pr-contract`, `merge-approval`, and a
  script that applies the ruleset.

### Unattended mode

- Scheduled cloud sessions act as lanes (at most 3 at once). Each run picks the oldest
  `Ready` issues of tier `skip` or `quick`, runs `/lane`, and works them to a PR. The
  tier only picks the work; whether the PR merges unattended is still decided by CI from
  its diff. Nothing runs on the owner's PC, so no local server starts without his OK.
- Unattended-eligible PRs merge on green gates. Everything else ends as a finished PR
  with its reviews done, listed under "waiting on you".
- A morning digest (on the dashboard and as a summary) lists what merged, what waits
  on the owner with each PR's summary, and what is stuck.
- Guards: a per-night cap on lanes and runs; a lane that fails CI twice stops and files an
  issue instead of retrying; nothing merges while `main` is red.

## 5. Rollout

1. The owner reviews this spec.
2. Build the reusable template in `workflow/`: the issue and PR templates, the
   `pr-contract` and `merge-approval` jobs, `post-review.sh`, the `.claude/` commands and
   settings, and the ruleset script. A later project adopts the workflow by copying it and
   running the ruleset script.
3. Publish `lanes` (public, under the organisation, AGPL like satisfactory-dash, with the
   PII check from the first commit) after the owner's go-ahead.
4. A dedicated session brainstorms the dashboard's own spec from a short brief. Its first
   issue is the contract: the snapshot schema.
5. Trial about two weeks, including a few unattended nights. Then `/health` and the
   owner's judgment decide whether satisfactory-dash moves over. At the end of the trial,
   test each gate by removing it for a while and watching the delivery metrics: every gate
   encodes an assumption about what the model cannot do on its own, and costs usage.

### Held until the trial shows a need (amendment, 2026-09-26)

- **A plan-and-tests negotiation before coding** (full tier): the lane proposes its plan and
  test list, an independent reviewer agrees before any code. Add it if full-tier PRs often
  go back for rework.
- **Cloud nights test the running app** (Playwright, as the evaluator in Anthropic's harness
  article): add it once the project has a UI.
- **Saved dynamic workflows** for `/review` (parallel reviewers with adversarial
  cross-checks) and `/health`: add them if the prose instructions prove inconsistent. A
  scheduled run must call a saved workflow by name (`Workflow(<name>)` allow rule); the
  `ultracode` keyword does not start one from a scheduled prompt.

## Out of scope

- Changing satisfactory-dash's workflow during the pilot.
- The dashboard's data model and UI (its own spec).
