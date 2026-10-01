# 0021: Under the team profile the gate requires a native code-owner review where it used to require /approve

Status: accepted

## Context

ADR 0019 part 7 said that under team the gate skips the owner stage and branch protection enforces the native review. Trial run 2 (PR #555) showed two problems.

1. **Double approval today.** The "code owners (team trial)" ruleset requires a code-owner review on owner-path PRs. The gate still runs `waitOwner`, and the "Needs the owner" text forces the owner stage, so the owner approves twice: once natively and once with `/approve`.
2. **The ADR 0019 design would fail open.** The ruleset requires 0 approvals, so a team PR that touches no owner path has no native approval requirement. If the gate stopped waiting, the cases that now wait on the owner would merge with no human approval. Those cases are a non-empty "Needs the owner", a full-tier blocker and a quick-tier contract change. Trusting that a ruleset exists is also not a check the gate can make, because it runs as `github-actions` and cannot read protection settings.

Also seen in practice:

- The ruleset's "approval of the most recent push" blocks PRs pushed from the owner's own account (#554, #542), because the pusher cannot approve their own push.
- #553 added the `GIT_AUTHOR_*` and `GIT_COMMITTER_*` variables, and ADR 0019 parts 3 and 4 do not list them.
- `docs/history/team-identity-trial.md` ("What would retire") sizes the owner-approval code at roughly 1217 lines in `approve-guard.mjs`, 1472 in `shell-lex.mjs`, 305 in `post-review.mjs` and the gate's owner stage. It also says that while solo is supported, zero lines retire.

ADR 0020 stays in force: the bot is never trusted for `review/owner`, and nothing here changes that.

## Decision

Solo is unchanged. Everything below applies only when `identity.profile` is `team`.

**1. The gate asks GitHub for the approval.**

- `gateDecision` gains an input `nativeApproval`: `{ approved: boolean, by: string | null }`, or null when it was not read. gate.mjs computes it. Under team, `gateDecision` ignores `review/owner` statuses and `ownerCarry`, and every place it would call `waitOwner` becomes "waiting for a code-owner review" with stage `owner`.
- The wait applies to the same four reasons as today:
  - an owner-only path;
  - a non-empty "Needs the owner";
  - a full-tier blocker;
  - a quick-tier contract change.
- It passes only when `nativeApproval.approved === true`. Null, an error reading reviews, or a missing CODEOWNERS file all mean pending. The gate never succeeds on a read failure.
- The approval check is one function in lib.mjs, `nativeCodeOwnerApproval(reviews, prAuthor, headSha, owners)`. It takes `pulls/{n}/reviews` (paginated) and uses the latest review per reviewer login. A review counts only if all of these hold:
  - its state is `APPROVED`;
  - its `commit_id` equals the PR's current head SHA;
  - the reviewer's login is a user entry in the default-branch `.github/CODEOWNERS`, compared exactly and case-sensitively;
  - the reviewer is not the PR author, and is not the lane bot (`isLaneBot`).
- Team entries (`@org/team`) and entries with a nonstandard format are ignored. A CODEOWNERS file that yields no user owners means pending.
- CODEOWNERS is read from the gate's own default-branch checkout, never from the PR. Who counts as an owner is "any user listed in CODEOWNERS", not per-path. Per-path matching would duplicate the CODEOWNERS pattern semantics for no gain, because the file is one owner today and `workflow.test.mjs` keeps it in step with `paths.owner`.
- **Stale approvals.**
  - An approval on an older commit never counts, because `commit_id` must equal the head SHA. The ruleset's dismiss-stale-approvals setting is a second layer, not the one relied on.
  - A later `CHANGES_REQUESTED` or `DISMISSED` review by the same login supersedes an earlier approval.
  - There is no carry of an approval across commits under team, since ADR 0002's `ownerCarry` is solo-only. Any push after approval needs a fresh review.
  - In `merge_group`, the gate reads the reviews of the PR against its head SHA again, so a dismissal after enqueue blocks the merge.
- Re-run on review: the gate must re-evaluate when a review is submitted or dismissed. The `pull_request_review` event runs the workflow file from the PR's merge ref, which would break the "default-branch gate only" rule (I3). So add a new workflow, `.github/workflows/lanes-review-ping.yml`, with `on: pull_request_review` and `permissions: {}`. It runs a single no-op step and has no secrets and no checkout. `lanes-gate.yml` gains `workflow_run: workflows: ["lanes-review-ping"], types: [completed]`, which runs the default branch's copy. The gate takes the PR number from `workflow_run.pull_requests[0].number` and falls back to scanning open PRs for the `head_sha`. If neither resolves, it does nothing and leaves the status as it is. The implementing lane must verify this on the real repository before relying on it. If it does not work, the fallback is `workflow_dispatch`, which the owner runs after reviewing.

**2. What replaces "Needs the owner" and owner-only paths.**

- Under team, the PR template's "Needs the owner" section and owner-only paths both mean "needs a native code-owner approval on the head commit", enforced by the gate (part 1). The ruleset still enforces owner paths separately, as a second layer.
- ADR 0015's additive-diff exemption stays off under team, as in ADR 0019 part 6.
- The `waitOwner` description under team says "waiting for a code-owner review in GitHub". It must not mention `/approve`.
- A team PR no longer needs `review/owner`, and the gate does not post one.

**3. What refuses, what stays.**

- `post-review.mjs owner` refuses under team with a message to approve in GitHub (ADR 0019 part 7, retained and confirmed).
- The `/approve <N>` grant writes nothing under team. It answers "under the team profile, approve the PR in GitHub", as ADR 0019 part 8 says.
- Zero lines are deleted. While solo is supported, `approve-guard.mjs`, `shell-lex.mjs`, the `requireOwnerGrant` code in `post-review.mjs` and the solo path of the gate's owner stage all stay. The sizing in `docs/history/team-identity-trial.md` is unchanged. Only if the owner drops solo for this repository (Decision for the owner 1) would the candidates there retire.
- This ADR changes the owner's workflow, not code size.

**4. Owner-session PRs under team.**

- The gate also refuses to count a review by the PR's author (part 1), so the PR-author exclusion is consistent with the ruleset.
- Owner work goes through lanes, so the bot is the author and the owner approves natively. This is the decided route: it needs no bypass actor and no second human.
- The owner may disable the ruleset temporarily for an emergency (as they did for #554 and #542). That is an owner action in settings, outside lanes, and the gate would still require an approval from someone who is not the author. So an owner-authored PR cannot reach green without a second approver or a lane.
- A bypass actor, or a second approver, are alternatives listed under Decisions for the owner. Lanes never change rulesets.
- `require_last_push_approval` is off (the owner turned it off, [ADR 0023](0023-workflow-changes-owner-web-editor.md) part 4), so the owner's web-editor commit of a workflow file does not need a second approver. The gate still counts only an approval on the head SHA.

**5. Amendments (ADR 0019 part 9, now concrete).**

- ADR 0002: under team, owner-only paths and the owner reasons of the gate are enforced by the gate reading a native code-owner approval, plus the ruleset. `/approve` and `review/owner` are solo only.
- ADR 0004: solo only. ADR 0015: solo only. ADR 0007: unchanged. ADR 0020: unchanged.
- CLAUDE.md rule 7 becomes: "No extra setup for adopters by default. The solo profile needs no account, app or credential; acting as the owner's account is an accepted risk there (ADRs 0004 and 0007). The team profile (ADR 0019, 0021) is opt-in and needs a GitHub App and a code-owner ruleset." Rule 6 is unchanged.
- ADR 0019 part 7 is replaced by this ADR's parts 1 to 3. ADR 0019 is amended, not superseded.
- ADR 0019 parts 3 and 4 gain the commit-identity variables from #553: `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME` and `GIT_COMMITTER_EMAIL`. They are set to the bot's name and its `users.noreply.github.com` address, and they are not secrets. `launchEnv` sets them under team so a lane's commits show as the App.

**6. Sequencing.**

- File the issues after #548 (`approve-guard.mjs`) merges, and consolidate with #556, #552 and #549 where Scope paths overlap. Proposed split by module, since the planning rule is one module per issue:
  - lib issue: `lib.mjs` (`gateDecision` input and `nativeCodeOwnerApproval`).
  - gate issue: `gate.mjs`, `post-review.mjs` and `approve-guard.mjs`.
  - docs and workflow issue: `.github/` and `docs/` (unmapped). It touches `lanes-gate.yml`, `lanes-review-ping.yml`, ADR amendments, CLAUDE.md and `docs/USING.md`.
- The lane that edits the workflows and `lib.mjs` is on owner-only paths, so it needs the owner's native review.

## Decisions for the owner

1. **Drop solo for this repository?** Only then does code retire: roughly all of `shell-lex.mjs` and `approve-guard.mjs` (minus the release-tag guard `TAG_REASON`), the named parts of `post-review.mjs`, and the gate's solo owner stage, with their tests. This ADR does not decide it. If it stays supported, the team profile adds code and retires none.
2. **Owner-authored PRs under team.** The ADR decides "route through lanes". Alternatives: (a) add the owner as a ruleset bypass actor, which weakens the control; (b) add a second approver, which needs a second human.
3. **Required approvals in the ruleset.** Keep 0 (the gate enforces approval wherever it used to require `/approve`) or raise it to 1 (every PR needs a human review, a larger workflow change).
4. **Review re-run trigger.** Accept the `workflow_run` ping workflow (recommended, needs one verification run) or accept `workflow_dispatch` only (the owner re-runs the gate by hand after reviewing).

## Consequences

- Native review becomes the single human approval under team: no second `/approve`, no `review/owner`, and the gate stays fail-closed (null, an error, or no owner means pending).
- A non-owner-path PR with a non-empty "Needs the owner", a full-tier blocker or a quick-tier contract change still needs a human approval, now a native one. Nothing merges unreviewed that did not already merge unreviewed.
- Every push after approval needs a new review under team, and ADR 0002's carry is gone there. A solo lane keeps the carry.
- The gate trusts the review author's login against CODEOWNERS user entries. Team entries do not count, and a CODEOWNERS file listing only teams blocks all gated PRs until a user is added.
- No code is deleted, and the solo guards and tests keep running and keep costing maintenance. Adopters on team gain the `workflow_run` ping workflow and a CODEOWNERS + ruleset requirement.
- `pull_request_review` cannot run the gate directly without weakening I3, hence the extra workflow. If `workflow_run` does not resolve the PR number reliably, stale gate statuses are possible until a manual re-run, which fails closed (pending).

## Governs

- scripts/lanes/lib.mjs
- scripts/lanes/lib.test.mjs
- scripts/lanes/gate.mjs
- scripts/lanes/gate.test.mjs
- scripts/lanes/gate-decision.test.mjs
- scripts/lanes/post-review.mjs
- scripts/lanes/post-review.test.mjs
- scripts/lanes/approve-guard.mjs
- scripts/lanes/approve-guard.test.mjs
- scripts/lanes/workflow.test.mjs
- scripts/gate-workflow.test.mjs
- .github/workflows/lanes-gate.yml
- .github/workflows/lanes-review-ping.yml
- docs/adr/0002-owner-only-paths.md
- docs/adr/0004-approve-guard-accepted-risk.md
- docs/adr/0015-owner-input.md
- docs/adr/0019-team-identity-profile.md
- docs/USING.md
- docs/SECURITY.md
- CLAUDE.md
