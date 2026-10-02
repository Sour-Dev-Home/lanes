# 0029: Workflow changes are applied by a second App through an owner-approved GitHub Environment

Status: accepted

## Context

ADR 0023 keeps `workflows: write` away from the lanes App, because a branch workflow could raise its own
`GITHUB_TOKEN` and post `lanes/gate=success` as `github-actions[bot]`, the creator the ruleset pins (integration_id
15368). Its hand-over is a PR comment: the owner copies each file into GitHub's web editor and commits it. The owner
asked on #592 for one click instead of copy-paste, in GitHub's own UI.

GitHub offers a control built for this. A job that names an Environment waits for the environment's required reviewer
("Approve and deploy"), and the environment's secrets are readable only by jobs that pass its deployment branch policy.
With the policy set to `main` only, neither a lane nor any branch workflow can read the secret. An `issue_comment`
workflow always runs the default branch's copy, so a PR cannot alter the workflow that handles its own comments.

Two limits shape the design. Anyone may comment on a public repository, so the commenter must be checked. Environment
required reviewers exist on public repositories and on paid private ones, but not on private repositories on GitHub
Free, where the copy-paste hand-over must stay.

## Decision

The lanes App is unchanged: it never gets `workflows: write` (ADR 0023 part 1, ADR 0019 part 3).

**1. A second App, `lanes-workflows`.** Created by `app-setup.mjs --workflows` through the same manifest flow (ADR
0025 part 7). Its manifest is `public:false`, hook inactive, and permissions contents write, workflows write and
metadata read, nothing else. It is installed on this repository only. It is not a ruleset bypass actor and is never
added to CODEOWNERS.

**2. A new Environment, `lanes-workflow-apply`.** Required reviewer: the owner. Deployment branches: `main` only.
Prevent self-review: off, since the owner is the only reviewer. It holds the secret `LANES_WORKFLOWS_KEY` (the App's
private key) and the variable `LANES_WORKFLOWS_APP_ID`. The key never touches the owner's disk: `app-setup.mjs`
receives it from the manifest conversion and pipes it to `gh secret set LANES_WORKFLOWS_KEY --env
lanes-workflow-apply` on stdin, using the owner's own `gh`. It is never printed or logged. If the `gh` call fails the
script reports it and the owner reruns `--workflows`; the key is not retained.

**3. Setup makes an admin call, for the environment only (amends ADR 0025 part 8).** Creating an environment with
reviewers and a branch policy needs repository admin. `--workflows` prints exactly what it will create (environment
name, reviewer login, branch policy, secret and variable names), asks `y/N`, then calls the REST environment endpoints
with the owner's `gh`. CODEOWNERS and rulesets stay printed links. Nothing is created without the `y`.

**4. The workflow, `.github/workflows/lanes-workflow-apply.yml`.** Trigger `issue_comment: created`. It never checks
out the PR head; it checks out the default branch and runs `scripts/lanes/workflow-apply.mjs` from it. Comment and PR
fields reach the script through `env:` and API reads, never interpolated into shell. `concurrency` is per PR with
`cancel-in-progress`, so a newer hand-over cancels an older waiting deployment.
- Job `filter` (no environment, `contents: read`, `pull-requests: read`) runs `workflow-apply.mjs filter`. It outputs
  `go=true` only when the comment is on a PR, its author passes `isLaneBot` (ADR 0020, bot login from
  `lanes.config.json` on main), and its body starts with the hand-over marker. Otherwise nothing waits for approval.
- Job `apply` (`needs: filter`, `if: go`, `environment: lanes-workflow-apply`) starts only after the owner's "Approve
  and deploy". It mints a `lanes-workflows` installation token from the secret (reusing `app-token.mjs`, token masked)
  and runs `workflow-apply.mjs apply`.

**5. What `apply` checks, all before any write.** Any failure writes nothing and fails the run with the reason.
1. The comment is still by the lane bot, was not edited after the run started (GraphQL `lastEditedAt`), and is the
   newest hand-over comment on the PR.
2. The PR is open, its head is in this repository (no forks), its head SHA is the one the trusted verdict comments
   name, and it has not moved since the comment.
3. Each fenced file has a path matching `^\.github/workflows/[A-Za-z0-9._-]+\.ya?ml$`. The comment's file set equals the
   union of `pending` paths in the trusted verdict comments for that head, and for each path `pendingFileHash` (ADR 0023
   part 3) equals the recorded `sha256`. Two verdicts recording different hashes for one path refuse.
4. Then one commit holding all the files is made through the Git Data API with the installation token (blobs, tree,
   commit, then a non-forced ref update on the PR branch). A head that moved meanwhile fails the update. The App-token
   push triggers CI, unlike `GITHUB_TOKEN`. The gate's hash reuse (ADR 0023 part 3) then reuses the reviews, and the
   owner approves the PR as before. `gate.mjs`, `lib.mjs` and the hash rule are unchanged.

**6. Where the logic lives.** A new module `workflow-apply` (risk `sensitive`, imports `lib`) owns
`scripts/lanes/workflow-apply.mjs`: pure `filterDecision`, `parseHandoverFiles` and `applyChecks`, plus a `main` with
injected IO for the REST and GraphQL reads and the commit. It is neither `install` (setup time) nor `gate` (which runs on
`pull_request_target`, a different trust path). The module is registered in `lanes.config.json` with its `paths`, and
the sensitive paths gain it.

**7. Choosing the path; the hand-over comment says which.** `handover.mjs` gains a `mode`. The lane reads `GET
/repos/{repo}/environments/lanes-workflow-apply` with its App token. With a required reviewer present, the comment
tells the owner to open the Actions run and press "Approve and deploy", and still lists each file. Environment missing,
no reviewer, or the read fails: the comment is today's copy-paste text (ADR 0023 part 2), and the filter job never
fires. Copy-paste stays documented as the fallback for private repositories on GitHub Free.

**8. Bootstrap.** The workflow file cannot apply itself. It arrives through the copy-paste hand-over one last time.
After it merges, the owner runs `app-setup.mjs --workflows` once. Until then every hand-over is copy-paste.

**9. Amendments and documents.** ADR 0023 part 2 is amended: one click is primary, copy-paste the fallback; parts 1
and 3 stand. ADR 0025 part 8 is amended as in part 3 above. ADR 0019 part 3 gains a pointer. `docs/USING.md` gets the
owner's steps, `docs/OPERATIONS.md` gets key rotation, removing the App, and the fallback, and `docs/SECURITY.md` gets
the evidence below.

## Decisions for the owner

1. A second App holding contents and workflows write, behind an Environment reviewed by the owner and limited to
   `main`: decided by the owner in /plan-issues, 2026-10-02, after the request on #592.
2. `app-setup.mjs --workflows` may create the environment with the owner's own `gh`, after listing it and a `y/N`; the
   key goes straight into the secret and is never stored on disk: approved with this plan.
3. Copy-paste stays as the documented fallback, selected by the lane reading the environment: decided by the owner,
   2026-10-02.
4. The apply workflow arrives by the copy-paste hand-over one last time: decided by the owner, 2026-10-02.
5. The owner must never add `lanes-workflows` to a ruleset bypass list, CODEOWNERS or a second repository: stated here
   so it is a deliberate owner act to change.

## Consequences

- The owner's step becomes one click, in GitHub's UI, with no paste. The pasted-content risk of ADR 0023 shrinks: the
  committed bytes are exactly the files the reviewers hashed, so the owner's read is no longer the only control.
- The control that keeps ADR 0023's forged-gate scenario closed moves: the lanes App still cannot write workflows, and
  the key that can is readable only by a `main` job after the owner's approval. A lane or branch workflow cannot reach
  it. If the owner approves a deployment for content that is itself malicious but was reviewed, a push-triggered
  workflow runs once; that is ADR 0023's accepted residual risk, unchanged.
- The trust root now includes the main-branch `workflow-apply.mjs` and the lane's verdict comments (the lane bot posts
  both, as in ADR 0023). The Environment settings are checked by the owner, not by the repository; `app-setup.mjs`
  prints what it created and `identity-check.mjs` stays read-only.
- Anyone's comment creates a short skipped `filter` run in the Actions list; no pending deployment appears for it. Owner
  approval of a stale hand-over is refused with a reason, never applied.
- Setup gains one admin call (ADR 0025 part 8 amended). Adopters on private repositories on GitHub Free keep the old
  flow with no loss.
- A second App to install and rotate; `docs/OPERATIONS.md` covers it.
- `workflow-apply.mjs`, `lanes.config.json`, `app-setup.mjs` and the workflow are sensitive: the implementing lanes need
  security and architecture review and an owner-path native approval.

## Governs

- .github/workflows/lanes-workflow-apply.yml
- scripts/lanes/workflow-apply.mjs
- scripts/lanes/workflow-apply.test.mjs
- scripts/lanes/app-setup.mjs
- scripts/lanes/app-setup.test.mjs
- scripts/lanes/app-token.mjs
- scripts/lanes/handover.mjs
- scripts/lanes/handover.test.mjs
- scripts/lanes/install.mjs
- .claude/commands/lane.md
- lanes.config.json
- docs/adr/0019-team-identity-profile.md
- docs/adr/0023-workflow-changes-owner-web-editor.md
- docs/adr/0025-retire-solo-profile.md
- docs/USING.md
- docs/OPERATIONS.md
- docs/SECURITY.md
