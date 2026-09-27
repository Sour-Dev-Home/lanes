# Using lanes

## The daily loop

1. **Write tasks as issues** with the Task form. Every field is the contract a lane works from: a one-sentence goal,
   checkbox acceptance criteria, the interface contract (a file, or none), scope in and out, blocked-by links, and a
   tier. The `issue-contract` check labels a complete issue `tier:*` and `ready`, or comments what is missing.
   Faster: `/plan-issues "<your idea in 1-4 sentences>"` drafts up to 6 such issues (the contract issue first) into
   `.lanes/plans/`; edit or approve the draft, and only then are they created.
2. **Start up to 3 lanes**: open a fresh Claude Code session per issue and run `/lane <issue>`. Each lane works in its
   own worktree, writes the failing tests first, runs its reviewers, opens the PR and turns auto-merge on, then ends.
   Faster: `/start <issue> [<issue> ...]` checks each issue the way `/lane` does and launches the rest as background
   sessions with `claude --bg "/lane <issue>"`, printing `#<issue> → <id>` for `claude attach` or `claude logs`. It
   refuses, with the reason, an issue that is not open, lacks `ready` or one `tier:*` label, has an open blocker or is
   already in flight; both issues of a pair whose paths overlap (pick one and run `/start` again); and anything past 3
   lanes in flight, counting open `issue-*` PRs and running sessions. Owner only: a lane or a schedule never runs it.
3. **Watch with `/status`**: WAITING ON YOU, IN FLIGHT (each PR's stage), READY TO START, MERGED.
4. **Approve with `/approve <pr>`** when a PR waits on you: read its "Needs the owner" and the diff; typing the command
   is the approval, and the merge queue does the rest. The approve guard (`scripts/lanes/approve-guard.mjs`, two hooks
   in `.claude/settings.json`) lets `post-review.mjs owner` run without a prompt only for that PR, once, in the turn
   where you typed `/approve <pr>`. It denies that command everywhere else, including lanes and auto mode.
5. **At night** a scheduled cloud session runs `/night`: up to 3 skip or quick tasks, merged only if CI finds them
   unattended-eligible. In the morning read the digest comment on the "Lanes digest" issue, and `/approve` the rest.
6. **Weekly `/health`** files issues for stale work, a red main and flaky checks.

## What merges without you

`lanes.config.json` sorts the files a PR touches into three classes (ADR 0002). The gate reads the lists from the
default branch, so a PR can't change its own rules.

| Class | Paths (see `lanes.config.json`) | What it requires |
| --- | --- | --- |
| skip (`paths.skip`) | docs, `*.md`, tests | Allowed at `tier:skip`, with no reviewers, only if *every* file is a skip path and none is sensitive. |
| sensitive (`paths.sensitive`) | `.github/`, `.claude/`, `.githooks/`, `scripts/lanes/`, `lanes.config.json`, package and lock files, `vendor/`, `CLAUDE.md`, auth, secrets, deploy, `.env` | The security-reviewer, at quick and full; not allowed at `tier:skip`. It does not by itself need `/approve`. |
| owner-only (`paths.owner`) | the gate and trust code and their tests, `install`/`setup-repo`/`new-project`, `.claude/settings.json`, `.github/`, `.githooks/`, `lanes.config.json`, `.claude/agents/`, `.claude/commands/{lane,night,approve}.md`, `docs/adr/`, package and lock files, `vendor/`, `CLAUDE.md`, `.gitattributes`, `scripts/preflight.mjs`, `.env`, auth, secrets, deploy | `/approve`, at every tier, however clean the reviews. Adds no reviewer. |

A PR merges on green checks alone only when it touches no owner-only path, its "Needs the owner" says `nothing`,
and its tier's rule holds:

- `tier:skip`: it touches only skip paths;
- `tier:quick`: its required reviews pass and it touches no contract file;
- `tier:full`: its "Contract changes" is `none` or `additive`, and every required reviewer has both a success
  `review/*` status and a verdict comment for the PR's current head commit that says `success`, posted by someone
  with write access, with no critical or important finding left unfixed. A verdict for an older commit, or in the
  old format without a commit, does not count.

Everything else waits for `/approve`, and the `lanes/gate` status says why (for example
`waiting on owner (/approve) (owner-only path)`). CI decides this from the diff and the PR's
comments; a lane cannot grant it to itself.

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
    accident (the approve guard on `post-review.mjs owner`, below);
  - strangers: only issues opened by someone with write, maintain or admin permission on the repository ever become
    `ready`, and the gate rejects a PR linked to anyone else's issue, so outside text never reaches an unattended lane.
    Both checks read the author's permission from `repos/{repo}/collaborators/{login}/permission`, never
    `author_association`, so an owner or org member counts whether their org membership is public or private. Read or
    triage permission, or none, is never trusted, and a failed permission lookup counts as no permission;
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

A new project, in one command (owner), run from this lanes clone:

`node scripts/lanes/new-project.mjs <name> [--private] [--license mit] [--dry-run]`

It creates `<org>/<name>` in the organisation that owns this lanes clone (public by default), clones it next to lanes,
installs the template (including `.claude/skills/` and `vendor/agent-skills/`), writes a starter `lanes.config.json`,
`verify.yml` (pull_request, merge_group, push to main), `package.json` scripts and an MIT `LICENSE` naming the same
copyright holder as lanes' own LICENSE. It runs `npm run setup`, commits once (signed if your git config signs) and
pushes `main` before any ruleset exists. Then it stops and prints the exact `gh secret set PII_PATTERNS -R <org>/<name>`
command; type `done` once the secret is set and it checks the secret exists, then runs `setup-repo.mjs`. If you stop
there, run `node scripts/lanes/setup-repo.mjs <org>/<name>` from the new clone later. `--dry-run` prints every step
and changes nothing. `--private` is refused unless the org shows an Enterprise Cloud plan (the merge queue) and
Advanced Security for new repositories (CodeQL); unknown counts as missing. Afterwards, edit the new
`lanes.config.json` paths for its layout.

Prerequisites (for either route):

- An organisation-owned repository (the merge queue rule needs one).
- Public, or private with GitHub Advanced Security enabled (CodeQL default setup needs one or the other).
- Your own `verify` workflow's job must be named `verify`: a required status check matches the check run's name
  (the job name by default), not the workflow file's name.
- On Windows, git does not track the executable bit: after cloning, run
  `git update-index --chmod=+x .githooks/pre-push` so the pre-push hook can actually run (`new-project.mjs` does this
  for its own first commit).

An existing repository: `node scripts/lanes/install.mjs <target>` (it also copies `.claude/skills/` and
`vendor/agent-skills/`, which `lane.md` names directly), edit the target's `lanes.config.json`, add `setup` and
`preflight` npm scripts and a `verify` workflow for the project's own tests (with the push-to-main trigger above), push
to `main`, then (owner) set the `PII_PATTERNS` secret and run `node scripts/lanes/setup-repo.mjs <owner/repo>`.
