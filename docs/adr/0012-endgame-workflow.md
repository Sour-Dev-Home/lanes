# 0012: Batched approvals, a validation-loop task type, and a read-only public dashboard

Status: accepted

## Context

Three gaps in the endgame workflow (owner, 2026-09-28), each grounded in the code as it stands today:

**1. Batching the owner's approval.** `/approve <N>` (`.claude/commands/approve.md`) is one PR at a time.
`scripts/lanes/approve-guard.mjs` writes a grant `{ sessionId, pr, at }` to `.lanes/approve/<session>.json` only
when the prompt is exactly `/approve <N>`; `post-review.mjs`'s `requireOwnerGrant`/`findFreshGrant` locate a fresh
grant for a PR by scanning every file in `.lanes/approve/` and reading its `pr` field, not by a fixed file name. A
batch grant therefore needs no new grant shape: one ordinary `{ sessionId, pr, at }` object per approved PR, under
distinct file names, is found and claimed by the existing, unmodified `findFreshGrant`/`claimGrant` path. ADR 0004
already treats the guard as defence in depth and the script's own grant check as the real barrier; nothing here
changes that split.

**2. A validation-loop and a spike issue type.** `parseIssueForm` in `scripts/lanes/lib.mjs` requires exactly six
fields (`ISSUE_FIELDS`) from `.github/ISSUE_TEMPLATE/task.yml`, and "Acceptance criteria" is already defined there as
one checkable item per line, each becoming a test. `/lane` step 5 writes one failing test per criterion. A
validation-loop criterion (a command, a metric, a threshold, a cap of attempts) is a criterion whose test is a loop; it
needs no new form field. `test-hunter` and `ui-reviewer` cover every criterion once by 1-based index, so the loop must
still resolve to one index.

**3. The dashboard.** Issue #5's brief and the design spec (docs/specs/2026-09-26-workflow-overhaul-design.md) ask for
per-task status, per-criterion progress from the review JSON kept as a PR comment (`parseVerdictComment` in
`scripts/lanes/lib.mjs`), explained blocking, a dependency graph with the critical path, refresh within about a minute,
a "waiting on you" list, no PII or tokens, and cheap hosting. `scripts/lanes/status.mjs` already computes almost all
of this (`prStage`, `gateDescriptions`, `mergeQueueEntries`, `laneSessions`, `openBlockers`) from `gh` calls;
`lanes/gate`'s description already names the blocking reviewer or the owner. `package.json` has zero dependencies
(ADR 0008); `contracts/review-metrics.schema.json` is a JSON-Schema-shaped document checked by hand-written code in
`scripts/lanes/contracts.test.mjs`, the dependency-free pattern this ADR reuses.

### ADR triggers checked

- New persistent state: yes. `.lanes/validate/<N>.jsonl` (attempt log, git-ignored like `.lanes/approve/`) and a
  published `snapshot.json` deployed to GitHub Pages as an Actions artifact (no branch, no commits).
- New dependency or external service: no npm dependency and no account, app or token for adopters. GitHub Pages is a
  repository setting on GitHub itself; enabling it is a one-time owner action.
- Security or auth boundary: yes. Batching widens what one `/approve` prompt can grant (still one grant per PR, still
  checked by the unmodified script); the published page renders attacker-controllable GitHub text (issue and PR
  titles) with no server, a new XSS surface that must be closed by construction.
- Deployment: yes. A new publishing workflow and a Pages site.
- New or changed contract between modules: yes. `contracts/snapshot.schema.json` (new), the grant file layout in
  `.lanes/approve/` (additive), and the meaning of an acceptance-criteria line that opts into the validation loop.

## Decision

### 1. Batched approvals, additive to ADR 0004

- `/approve <N> [<N>...]` (`.claude/commands/approve.md`): for each PR listed, in order, it shows `gh pr view --json
  title,body,headRefOid` (title, "Needs the owner", "Contract changes") and `gh pr diff --name-only`, then runs the
  owner post for that PR with that PR's own `--sha`. A push racing any one PR fails closed for that PR only.
- `approve-guard.mjs`'s `onUserPromptSubmit` recognizes `/approve <N> [<N>...]` and writes one ordinary
  `{ sessionId, pr, at }` grant per PR, each under its own file name. The grant shape, `GRANT_TTL_MS`, the
  scan-by-`pr` lookup and the claim-by-rename (#180) do not change; every invariant in ADR 0004 holds per PR. A prompt
  that is not a valid `/approve` list clears every grant file the session holds. At most 10 PR numbers per prompt;
  more is refused as a whole.
- Read-only listing: `status.mjs --waiting` lists the PRs waiting on the owner with their "Needs the owner" and
  "Contract changes" lines, from data `status.mjs` already fetches. `.claude/commands/approvals.md` runs it, as
  `status.md` does. It grants nothing, so it is not owner-only.

### 2. A validation-loop criterion and a spike pattern, inside the existing six fields

- No change to `ISSUE_FIELDS`, `task.yml` or the required-fields check. A validation-loop criterion is one
  "Acceptance criteria" line with a fixed prefix: `- [ ] validate: <command> — <metric-regex> <op> <threshold>
  (attempts: N)`, N from 1 to 10. Plain `- [ ]` lines are untouched.
- `scripts/lanes/validate.mjs --issue N --criterion I`: runs the command, extracts the metric from the regex's first
  capture group, appends `{ attempt, value, pass }` to `.lanes/validate/<N>.jsonl`, prints the best so far, and exits
  0 (threshold met), 1 (keep going) or 2 (cap reached without meeting it). `lane.md` step 5 loops on it for that
  criterion and puts the attempt table in the PR body.
- `issue-contract.mjs` validates a `validate:` line's syntax; a malformed one is a contract error.
- Spike: a `spike` label, not a tier; `TIERS` stays `skip`, `quick`, `full`. `lane.md` step 1 checks the label; a
  spike skips test-first, and its PR holds a findings file or an ADR draft only, under `tier:skip`'s docs-only rule.

### 3. The dashboard: a read-only publisher on top of `status.mjs`

- `contracts/snapshot.schema.json`, styled like `contracts/review-metrics.schema.json`. Per issue: `{ number, title,
  tier, stage, blockedBy: [{ kind: "issue"|"check"|"review"|"owner"|"queue", ref, reason }], pr?: { number, headSha,
  checks }, criteria?: [{ index, result }] }`, plus top-level `edges` ("Blocked by") and `generatedAt`. `stage` reuses
  `status.mjs`'s vocabulary; `blockedBy[].reason` is the gate description verbatim. No schema-validation library:
  `scripts/lanes/snapshot.mjs` builds the object, and `contracts.test.mjs` cross-checks it against the schema.
- `snapshot.mjs` composes `status.mjs`'s exported functions plus `parseVerdictComment`; it does not re-derive stage.
  `status.mjs --json` keeps its shape. In CI there is no `claude agents` data, so the snapshot cannot tell "a lane is
  writing" from "ready, unclaimed"; the page says so, and no lane gains a new write path to fix it.
- Aggregates only: the snapshot holds numbers, titles, stages, check and reviewer names, and times. No logins, emails,
  bodies or comments. The publishing job runs the repository's PII and local-path check on `snapshot.json` and fails
  instead of deploying when it matches.
- `.github/workflows/dashboard.yml`: triggers on `issues`, `status`, `merge_group`, `push` to the default branch, and a
  5-minute cron. No `pull_request` and no `pull_request_target`; the job checks out the default branch's own code only.
  It deploys with `actions/upload-pages-artifact` and `actions/deploy-pages`: `permissions: pages: write` and
  `id-token: write` in that job only, `contents: read` elsewhere. No branch receives commits.
  `concurrency: { group: dashboard-publish, cancel-in-progress: true }`, since only the freshest snapshot matters.
- `dashboard/` on `main`: one static page, no build step, no dependency, fetching `snapshot.json` every 60 s and
  showing its `generatedAt` (scheduled runs can be 10 to 20 minutes late). It renders every GitHub-sourced string with
  `textContent`/`createElement`, never `innerHTML` with interpolated text. The "waiting on you" list offers a
  copy-to-clipboard `/approve N M K` line; the page never posts `review/owner`.
- `lanes.config.json`: `paths.ui` and `paths.sensitive` gain `^dashboard/`, so a dashboard change always gets the
  ui-reviewer and the security reviewer; `modules.entries` gains `scripts/lanes/snapshot.` and
  `scripts/lanes/validate.` in their modules.
- Adopters: `install.mjs`'s `MANIFEST` ships every new file. GitHub Pages sites are public even for private
  repositories, so the installer leaves the dashboard workflow disabled for a private repository and `USING.md` says
  why; a public adopter enables Pages once.

## Decisions for the owner

1. One `/approve` line grants at most 10 PRs.
2. A validation-loop criterion allows at most 10 attempts.
3. The site deploys as a Pages artifact, not from a branch.
4. The public page does not distinguish "writing" from "ready"; no lane gets a new write path for it.
5. The validation-loop grammar is the single-line `validate:` form above.

## Consequences

- Every approval still needs the owner's own fresh per-PR grant, checked by the unmodified path ADR 0004 accepted;
  batching only changes how many grant files one prompt writes.
- The six required fields never change; old issues are unaffected.
- The dashboard adds one workflow and one static page and computes nothing `status.mjs` does not; per-lane token cost
  stays zero, and it can be turned off without touching any lane.
- `dashboard/` always gets a security review, even at tier quick.
- Private adopters get no public page unless they deliberately enable it.

## Governs

- scripts/lanes/approve-guard.mjs
- scripts/lanes/approve-guard.test.mjs
- .claude/commands/approve.md
- .claude/commands/approvals.md
- scripts/lanes/status.mjs
- scripts/lanes/status.test.mjs
- scripts/lanes/lib.mjs
- scripts/lanes/lib.test.mjs
- scripts/lanes/issue-contract.mjs
- scripts/lanes/issue-contract.test.mjs
- scripts/lanes/validate.mjs
- scripts/lanes/validate.test.mjs
- .claude/commands/lane.md
- contracts/snapshot.schema.json
- scripts/lanes/snapshot.mjs
- scripts/lanes/snapshot.test.mjs
- scripts/lanes/contracts.test.mjs
- .github/workflows/dashboard.yml
- dashboard/
- lanes.config.json
- scripts/lanes/install.mjs
- scripts/lanes/install.test.mjs
