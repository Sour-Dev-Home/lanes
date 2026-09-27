# Using lanes

## The daily loop

1. **Write tasks as issues** with the Task form. Every field is the contract a lane works from: a one-sentence goal,
   checkbox acceptance criteria, the interface contract (a file, or none), scope in and out, blocked-by links, and a
   tier. The `issue-contract` check labels a complete issue `tier:*` and `ready`, or comments what is missing.
   Faster: `/plan-issues "<your idea in 1-4 sentences>"` drafts up to 6 such issues (the contract issue first) into
   `.lanes/plans/`; edit or approve the draft, and only then are they created.
2. **Start up to 3 lanes**: open a fresh Claude Code session per issue and run `/lane <issue>`. Each lane works in its
   own worktree, writes the failing tests first, runs its reviewers, opens the PR and turns auto-merge on, then ends.
3. **Watch with `/status`**: WAITING ON YOU, IN FLIGHT (each PR's stage), READY TO START, MERGED.
4. **Approve with `/approve <pr>`** when a PR waits on you: read its "Needs the owner" and the diff, then approve the
   permission prompt. The merge queue does the rest.
5. **At night** a scheduled cloud session runs `/night`: up to 3 skip or quick tasks, merged only if CI finds them
   unattended-eligible. In the morning read the digest comment on the "Lanes digest" issue, and `/approve` the rest.
6. **Weekly `/health`** files issues for stale work, a red main and flaky checks.

## What merges without you

A PR merges on green checks alone only when its issue is `tier:skip` and it touches only skip paths, or `tier:quick`
with no contract file and nothing under `.github/`, `.claude/`, `.githooks/`, `scripts/lanes/`, `lanes.config.json`,
auth, secrets, deploy or `.env` paths. Everything else waits for `/approve`. CI decides this from the diff; a lane
cannot grant it to itself.

## Contracts, in one place

| Handoff | Contract | Enforced by |
| --- | --- | --- |
| Owner → lane | The Task issue form | `issue-contract` (labels `ready`) |
| Lane → lane | A contract file (type + schema + contract test) merged first; "Blocked by" | `/lane` refuses open blockers; `lanes/gate` requires "Contract changes" to match the diff |
| Lane → owner | The PR template | `lanes/gate` (all sections, `Closes #N`, contract word) |
| Idea → issues | `/plan-issues` draft in `.lanes/plans/`, approved by the owner | Nothing is created on GitHub before approval |
| Reviewer → gate | A JSON verdict (pass or fail per acceptance criterion, findings with `fixed`), posted as `review/<name>` | `post-review.mjs --file` refuses invalid or dishonest-looking verdicts; `lanes/gate` requires the reviewers per tier and diff |
| Owner → merge | `review/owner` status | `lanes/gate`; dropped automatically by any new push |

## Common pitfalls

- **Vague issues make vague PRs.** If an acceptance criterion cannot be written as a test, rewrite it before the lane
  starts. "Works well" is not a criterion; "returns 409 for a duplicate name" is.
- **Two lanes on one interface.** Land the contract first as its own small PR; list it under "Blocked by" in both
  issues. Never let two lanes each invent their half of an interface.
- **Overlapping files.** Two ready issues that edit the same files will conflict in the queue. Put one under the
  other's "Blocked by", or merge them into one issue.
- **Wrong tier.** A `tier:skip` issue whose PR touches code fails the gate. Fix the issue's tier label, then re-run
  the gate: `gh workflow run lanes-gate -f pr=<N>` (label changes on the issue do not re-trigger it by themselves).
- **Pushing after approval.** Any new commit drops `review/owner` and the reviewer statuses (they are per commit).
  Reviewers post after the final push; if you asked for a change, approve again after it lands.
- **The first run of a new check.** A required check that has never run blocks every PR. After adding a workflow,
  land it on `main` before adding its name to `requiredChecks`.
- **Required checks must also run on `merge_group`.** A workflow without that trigger never reports in the merge queue,
  and the queue times out.
- **Lanes are trusted; the gate stops mistakes and strangers, not a hostile lane.** Lanes, schedules and the owner all
  act as one GitHub account, and a lane can push branches and run code (tests, workflows). What the gate does stop:
  - honest mistakes: a missing review, a wrong tier, an incomplete contract, a lane posting the owner's approval by
    accident (the permission prompt on `post-review.mjs owner`);
  - strangers: only issues opened by the owner, members or collaborators ever become `ready`, and the gate rejects a
    PR linked to anyone else's issue, so outside text never reaches an unattended lane;
  - stale or copied results: the merge queue re-decides the whole gate from live inputs instead of copying the head's
    last `lanes/gate` status, and reviewer statuses posted by bots are ignored.

  What it cannot stop: a lane that turns hostile (for example through prompt injection) can push a workflow that posts
  a GitHub Actions status. Required checks pinned to GitHub Actions accept a status from any workflow in the repo, so
  such a workflow can forge `lanes/gate: success`, including on the merge-group commit after the real gate has posted
  failure, and a lane can enable auto-merge itself. No check inside the repo can prevent this while the gate and the
  lanes share an identity. The fix is to post `lanes/gate` from a dedicated GitHub App and pin the ruleset's
  `integration_id` to that App; until then, treat every lane as trusted, keep untrusted text away from lanes, and read
  any PR that adds or changes a workflow. Never allow `post-review.mjs owner` in any settings file, and never run
  `/approve` from a lane or a schedule.
- **Silenced errors.** Never `2>/dev/null` a git, gh, npm or test command; use `set -o pipefail` with `tail`.
- **Local servers.** Lanes run tests, not dev servers. A lane that needs a running server (UI review) asks the owner.
- **Updating vendored skills.** Never pull agent-skills from upstream main. Pick a commit, re-read the diff for anything that fetches, installs, handles secrets or overrides rules, and change it in a tier-full PR the owner approves.
- **A lane's own follow-up issues.** `/lane` step 8 files them with the label `lane-filed`; `issue-contract` never adds
  `ready` to one, however complete its contract, even when the owner opened it. Remove `lane-filed` to approve one
  (the check then adds `ready` on its next run).
- **Dependabot PRs.** They have no linked task issue and their branch never matches `issue-<N>-*`, so `lanes/gate`
  always fails them — there is no exemption for `dependabot/` heads, since one would be a way around the branch-to-issue
  check (I4). Open a matching Task issue instead, let a lane recreate the dependency bump on its own `issue-<N>-<slug>`
  branch from that issue, and close the original Dependabot PR with a link to the lane's PR. (`lanes` has no
  dependencies today, so this has not come up yet.)

## Rules and scripts to have in place before the first lane

| What | Where | Why |
| --- | --- | --- |
| The `main` ruleset (required checks, merge queue, CodeQL, no bypass, no force push) | `setup-repo.mjs` (owner) | The gate only works if it is required |
| Labels `tier:*`, `ready`, `contract:breaking`, `digest`, `lane-filed` | `setup-repo.mjs` | The issue check and the gate read them |
| The reviewer agents (`test-hunter`, `security-reviewer`, `ui-reviewer`, `architecture-advisor`) | `.claude/agents/` | `/lane` spawns each fresh, never a fork, by tier and diff |
| The `PII_PATTERNS` secret | `gh secret set PII_PATTERNS` (owner) | The security check and preflight |
| `npm run setup` (pre-push hook) in every clone and worktree | `package.json` | Leaks are caught before a push |
| `lanes.config.json` paths for this repo's layout | edit after `install.mjs` | Tiers and eligibility depend on them |
| `.claude/settings.json` narrow allow rules | committed | Lanes run without permission prompts, except the owner's |
| The practice layer: agent-skills, vendored at a pinned commit | `vendor/agent-skills/VENDORED.md` | Lanes follow its test-driven-development and incremental-implementation skills; update only by the documented reviewed procedure |
| The night schedule (`/night`, once a day) | a scheduled cloud session (owner, via `/schedule`) | Unattended progress |
| A test command that runs in under a minute locally | the project's `package.json` | Lanes run narrow tests constantly |
| `verify` also triggers on `push: branches: [main]` | the project's `verify.yml` | Otherwise nothing runs on main and `delivery-metrics`, `/night` and `/health` have no data to read |

## Adopting it in another repository

Prerequisites:

- An organisation-owned repository (the merge queue rule needs one).
- Public, or private with GitHub Advanced Security enabled (CodeQL default setup needs one or the other).
- Your own `verify` workflow's job must be named `verify`: a required status check matches the check run's name
  (the job name by default), not the workflow file's name.
- On Windows, git does not track the executable bit: after cloning, run
  `git update-index --chmod=+x .githooks/pre-push` so the pre-push hook can actually run.

`node scripts/lanes/install.mjs <target>`, copy `.claude/skills/` and `vendor/agent-skills/` too if `lane.md` is kept
as is (it names them directly; see `vendor/agent-skills/VENDORED.md`), edit the target's `lanes.config.json`, add
`setup` and `preflight` npm scripts and a `verify` workflow for the project's own tests (with the push-to-main trigger
above), push to `main`, then (owner) set the `PII_PATTERNS` secret and run `node scripts/lanes/setup-repo.mjs <owner/repo>`.
