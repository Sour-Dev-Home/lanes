# 0023: Team lanes never get the workflows permission; a workflow change is committed by the owner in GitHub's web editor

Status: accepted

## Context

Under the team profile a lane pushes as the GitHub App (ADR 0019). ADR 0019 part 3 asks for no `workflows` permission,
and GitHub enforces it: a push that creates or updates a file under `.github/workflows/` is refused with "refusing to
allow a GitHub App to create or update workflow `.github/workflows/lanes-gate.yml` without `workflows` permission".
Issue #587 recorded it. The lane for #561 hit it, and its reviewed commit sits only on its local branch
`issue-561-review-ping`. GitHub checks every commit in a push, so a push whose range holds any commit that touches a
workflow file is refused, even if a later commit in it reverts the change.

Granting the App `workflows: write` would remove a control worth keeping.

- A workflow file pushed to a branch of this repository runs from that branch on `push` and `pull_request` triggers,
  before any review. This repository has no Actions secrets and `default_workflow_permissions` is `read`. But a branch
  workflow can raise its own `GITHUB_TOKEN` with a `permissions:` block (for example `statuses: write`) and post
  `lanes/gate=success` as `github-actions[bot]`. That is the same creator the real gate posts as. A lane could
  therefore forge its own gate and skip its reviewers.
- `lanes-gate.yml` runs `pull_request_target` from default-branch code only, so the gate's own code is safe from a PR's
  workflow edits. That protects the gate's logic, not the status it posts, and not the `push`-triggered workflows.

So the App never gets the permission. The owner prefers that owner actions happen in github.com, for a general
audience of adopters, so the hand-over does not use a terminal. The ruleset and the gate raise two further problems.

1. **Review reuse.** The lane's reviewers should review the whole intended change, including the workflow content,
   even though the lane cannot push it. After the owner commits the workflow file the PR head changes. Today the gate
   reuses a reviewer's earlier verdict only when that commit's own diff has the head's `diffFingerprint`
   (`reusableReviews` in `gate.mjs`, `reuseBlockedBy` in `lib.mjs`; the rule came from #25 and #154 under CLAUDE.md
   rule 2, with no ADR of its own). The head now carries one more file than the reviewed commit, so the reuse rule
   never matches. CLAUDE.md rule 2 allows a reused verdict only for byte-identical reviewed code, so the gate needs a
   way to prove the pending file is the reviewed content without loosening that rule.
2. **Last-push approval.** The ruleset "code owners (team trial)" has `require_last_push_approval: true` ("Require
   approval of the most recent reviewable push"). The owner's commit becomes the last push on a workflow-touching PR,
   and the pusher cannot approve their own push. That already blocked #554 (ADR 0021 Context).

A later lane push whose new commits do not touch workflow files is accepted.

## Decision

Solo is unchanged: the owner's own identity pushes, and nothing below applies to it. Everything below applies only
when `identity.profile` is `team`.

**1. The App never gets `workflows: write`.** ADR 0019 part 3 is confirmed and gains a pointer to this ADR. A lane
never works around the refusal: no PAT, no deploy key, no owner credential, and no rewrite that hides the workflow
change inside another file.

**2. The hand-over is GitHub-native (lane.md step 7).**

- Before pushing, a team lane checks `git diff --name-only origin/main...HEAD` for paths under `.github/workflows/`.
  If there are none, it pushes as today.
- If there are some, the lane puts every workflow-file change into one final local commit, rewriting its unpushed
  history if an earlier commit touched a workflow file, so that no other commit changes `.github/workflows/`. It runs
  its reviewers and `npm run preflight` on the full intended change, the final commit included, then pushes only the
  commit before it (`git push origin HEAD~1:refs/heads/<branch>`). The final commit is never pushed. The reviewers'
  verdicts name the pushed head and list the pending files (part 3).
- The lane opens its PR as the bot with `gh pr create`.
- The lane posts one PR comment that holds, for each pending workflow file, its full new content in a fenced block,
  and a link to GitHub's web editor on the PR branch:
  - `https://github.com/<repo>/edit/<branch>/<path>` for an existing file;
  - `https://github.com/<repo>/new/<branch>?filename=<path>` for a new file.
  The comment says that the owner must read the content before clicking **Commit changes**, because committing it runs
  any push-triggered workflow in it.
- The owner pastes the content, chooses "Commit directly to the `<branch>` branch", and commits, in the browser. The PR
  stays bot-authored.
- A change that deletes a workflow file is not handed over this way: the lane stops and asks the owner to delete the
  file in the browser, and its reviewers run again on the head.
- The lane then watches the PR as step 7 does today. It posts nothing new for the owner's commit.

**3. Review reuse by hash.**

- Each verdict comment a lane posts on its pushed head gains an optional field in the verdict JSON, `pending`: a list
  of `{ path, sha256 }`, one per workflow file the head does not contain yet. `parseVerdictComment` already passes the
  verdict object through, and `post-review.mjs` validates the new field.
- The hash is the SHA-256 (hex) of the file's content after normalisation: every `\r\n` becomes `\n`, trailing
  newlines are removed, and exactly one `\n` is appended. The web editor's line endings or final newline therefore do
  not break a match. An empty file, or a file that is not valid UTF-8, has no hash and is never pending. Only paths
  under `.github/workflows/` are valid pending paths.
- On a later head the gate reuses a reviewer's verdict, and the reviewer status on that earlier commit, only when all
  of the following hold. Otherwise there is no reuse.
  1. The earlier commit's trusted verdict comment from that reviewer lists a non-empty, valid `pending`.
  2. Every file the head changed since that commit is one of the pending paths.
  3. Each pending path's blob at the head hashes to the recorded value.
  4. For the files that are not pending, the earlier commit's own diff has the same `diffFingerprint` as the head's
     own diff with the pending paths removed.
  5. The ordinary reuse checks still hold, and a verdict with no `pending` behaves exactly as today.
- When reuse is refused because of a pending file, the gate's pending description names the file:
  `workflow file .github/workflows/x.yml differs from the reviewed copy`, or
  `workflow file .github/workflows/x.yml is not committed yet` when it is absent at the head.
- Fail closed on any read error, an unreadable blob, a diff block whose file name cannot be parsed, or a malformed
  `pending`.
- Where the check lives: the pure checks are in `lib.mjs` (module `lib`), with no I/O: `pendingFileHash(text)`,
  `parsePending(verdict)`, `diffFingerprint(diffText, { omit })` (the existing function with an optional list of paths
  whose blocks are dropped before sorting), and
  `pendingReuseBlockedBy({ pending, changedSince, headHashes, earlierDiff, headDiff })`, which returns null or the
  reason string. `gate.mjs` (module `gate`) does the reads inside `reusableReviews`: the trusted verdict comments, each
  pending blob at the head through the contents API, and the raw compare diffs `ownDiff` already fetches. It then calls
  the lib check. `reuseBlockedBy` still applies to the changed files that are not pending.

**4. The ruleset.**

- `require_last_push_approval` is turned off by the owner in GitHub's ruleset settings. Lanes never change rulesets
  (ADR 0021 part 4).
- `dismiss_stale_reviews_on_push` stays on, `require_code_owner_review` stays on, and
  `required_approving_review_count` stays 0.
- The gate remains the check: it counts only an `APPROVED` review whose `commit_id` equals the head SHA, from a
  CODEOWNERS user who is neither the PR author nor the lane bot (ADR 0021 part 1). An approval on an older commit never
  counts, so an approval cannot cover content it did not see.

**5. /start and the queue.**

- Under team, when an issue's Scope names `.github/workflows/` or a file under it (`issuePaths` from `paths.mjs`),
  `launchLane` prints `#N: Scope names .github/workflows/: the lane opens its PR without the workflow change and hands
  it over in a PR comment`. `launchLane` in `start.mjs` is shared by `/start` and the queue, so one note covers both
  launchers. It needs a new input, the issue's Scope paths, passed by both callers.
- The note is informational and the issue still launches. It is not a check: a lane can touch workflow files without
  naming them in Scope, and the lane's own diff check (part 2) is what acts.

**6. Documentation and amendments.**

- `docs/USING.md` describes the owner's steps in the browser: the note, the PR comment, "Commit changes", and what the
  gate says when a file differs.
- `docs/SECURITY.md` records the evidence in Context, why the hash binds the committed file to the reviewed one, and
  that the owner's read of the comment is the control before the commit.
- ADR 0019 part 3 is confirmed and pointed here. ADR 0021 part 4 notes that `require_last_push_approval` is off. ADR
  0020 is unchanged: the bot is never trusted for `review/owner`.

## Decisions for the owner

1. Never grant `workflows: write`: decided by the owner, 2026-10-01, with the evidence in Context.
2. GitHub-native hand-over, no terminal step: decided by the owner, 2026-10-01.
3. Review reuse by normalised hash: decided by the owner, 2026-10-01, as in Decision part 3.
4. Turn `require_last_push_approval` off: decided by the owner, 2026-10-01, to be done in GitHub's ruleset settings.
5. Note in /start and the queue when Scope names `.github/workflows/`: decided by the owner, 2026-10-01.
6. Deleting a workflow file is handed over by asking the owner to delete it in the browser, with no deletion marker in
   `pending`; `pending` paths are only under `.github/workflows/`; a merge from main after the lane's push breaks
   pending reuse and the reviewers re-run: approved with this ADR.

## Consequences

- The App can never run code from a branch workflow, so a lane cannot forge `lanes/gate`. The one action that runs a
  workflow is the owner's commit, after the owner has read the content in the PR comment.
- The owner's read of the pasted content is a human control with no technical enforcement. A lane could post a comment
  whose content differs from what its reviewers saw. If the owner pastes it as is, the gate refuses reuse (`differs
  from the reviewed copy`) and the reviewers must run again on the head. If the owner pastes without reading, a
  push-triggered workflow in the content runs once, which is the residual risk.
- Verdicts stay valid for byte-identical reviewed code only. A web-editor change to line endings or the final newline
  does not break reuse, and any other change does. A merge from main after the lane's push also fails reuse (part 3,
  condition 2), which is accepted.
- Owner commits made one file at a time leave the gate pending until every pending file is committed. A file committed
  with a typo is refused with its path named, and the owner fixes it in the same editor.
- `lib.mjs` and `gate.mjs` are on sensitive paths, so the implementing lanes need security and architecture review,
  and an owner-path native approval.
- The gate reads one more blob per pending file per reviewer candidate, bounded by the pending list the verdict
  states, plus raw compare diffs it already reads.
- Solo is unchanged and pays nothing.
- Sequencing: #561 is unblocked now by hand, before this lands. Its stopped lane re-does its push the new way
  (everything but the workflow file, then a PR comment), and its reviewers re-run on the final head, since no pending
  field exists yet to reuse their earlier verdicts.

## Governs

- .claude/commands/lane.md
- scripts/lanes/lib.mjs
- scripts/lanes/lib.test.mjs
- scripts/lanes/gate.mjs
- scripts/lanes/gate.test.mjs
- scripts/lanes/post-review.mjs
- scripts/lanes/post-review.test.mjs
- scripts/lanes/start.mjs
- scripts/lanes/start.test.mjs
- scripts/lanes/queue.mjs
- scripts/lanes/queue.test.mjs
- docs/adr/0019-team-identity-profile.md
- docs/adr/0021-team-native-code-owner-review.md
- docs/USING.md
- docs/SECURITY.md
