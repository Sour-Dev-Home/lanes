# Operating lanes: if X happens, do Y

One section per situation you can meet. Each says what you see, the likely causes and the fix, preferring a button or a
review in GitHub over a terminal command. How lanes works is in [USING.md](USING.md); why it is shaped as it is, in
[docs/adr/](adr/). Alerts reach you as comments on the `lanes-health` issue ([ADR 0027](adr/0027-health-inbox-and-watchdog.md)),
and `/status` shows the same facts on demand.

Lanes runs on your machine: the queue and every lane stop when it sleeps or shuts down
([the history note](history/2026-10-02-lanes-depends-on-the-owners-machine.md)). Many "stuck" situations are only that.

The incident numbers cited below are issues and pull requests in this repository.

- [merge-queue-removed](#merge-queue-removed)
- [approved-not-merged](#approved-not-merged)
- [gate-failure](#gate-failure)
- [no-progress](#no-progress)
- [stalled-lane](#stalled-lane)
- [flaky-test](#flaky-test)
- [workflow-hand-over](#workflow-hand-over)
- [chain-deadlock](#chain-deadlock)
- [scope-miss](#scope-miss)
- [paused](#paused)
- [needs-owner](#needs-owner)

<a id="merge-queue-removed"></a>
## merge-queue-removed

**What you see.** A PR that had your approval and a passing `lanes/gate` never merges. Its page shows
`github-merge-queue[bot]` removing it from the merge queue. A `queue-removed:PR <N>` problem may be on the health issue,
and `/status` and the queue report the removal.

**Likely causes.**
- A required check failed in the merge group, not on the PR (#620: `verify` failed on Windows in the merge group
  although it passed on the PR). Before #621 (fixed in #626) the removal was silent and the PR still looked ready.
- The branch fell behind `main` and the merge group no longer builds cleanly.
- A required workflow lacks the `merge_group` trigger, so its check never reports and the queue times out.

**Fix.**
1. Open the PR and read the merge-queue event, then the failed run it links.
2. A genuine failure: let the lane fix it, or file it as a task issue ([gate-failure](#gate-failure)).
3. A flake or a timeout: on the PR page choose **Merge when ready** (add to merge queue) again.
4. A missing `merge_group` trigger: file a task issue; the workflow change reaches you through
   [workflow-hand-over](#workflow-hand-over).

Incidents: #620, #621 (and its fix #626).

<a id="approved-not-merged"></a>
## approved-not-merged

**What you see.** You approved the PR in GitHub, yet it stays open with `lanes/gate` pending or failing, or it is
green and not queued. The health issue may carry `approved-stuck:PR <N>`.

**Likely causes.**
- The approval is not on the PR's current head commit: any push after your review makes it stale, and the gate counts
  only a review on the head (#573, the native code-owner review).
- The gate did not re-read the approval. A review does not re-run a commit status by itself; the review ping workflow
  re-runs the default-branch gate on a submitted review (#597), and until it ran, or when it did not, an unread
  approval is treated as pending (#590).
- You approved your own PR, or the bot's, or are not listed in `.github/CODEOWNERS`: those reviews do not count.
- Auto-merge is not on, or a reviewer verdict is still missing (the gate says `waiting for review/<name>`).

**Fix.**
1. Read the `lanes/gate` description on the PR: it names what it waits for.
2. If the approval is stale, open **Files changed** and submit a fresh **Approve** review on the current head.
3. If the review is current and the gate still waits, open the **Actions** tab, find the latest `lanes-gate` run for
   the PR and use **Re-run all jobs**.
4. If auto-merge is off, click **Enable auto-merge** on the PR.

There is no `/approve` any more: since #624 removed the solo branches, only a native code-owner review counts.

Incidents: #558 (the native code-owner review, merged as #573), #590, #597, #624.

<a id="gate-failure"></a>
## gate-failure

**What you see.** `lanes/gate` is red on a PR, or a `gate-failure` problem is on the health issue (a gate failure or a
merge-group failure).

**Likely causes.**
- A reviewer verdict failed (an unfixed critical or important finding), or a CI check failed.
- The PR touches an owner path or a contract and waits for your review: that is a pending gate, not a failure.
- A failure that shows only in the merge group (#620, #621): the PR's own CI ran the tests differently from the merge
  queue until #626 aligned them.

**Fix.**
1. Read the gate's description with the check's result on the PR (the **Checks** box at the bottom).
2. A failed check or verdict: the lane is expected to fix it; if it has stopped, see [stalled-lane](#stalled-lane).
3. A failure you cannot explain (a guard false positive, a stale checkout, missing data) is a defect: file it as a task
   issue with the evidence, do not work around it (rule 3 in `CLAUDE.md`).
4. Never bypass a hook or edit a verdict to turn the gate green.

Incidents: #620, #621, #626.

<a id="no-progress"></a>
## no-progress

**What you see.** A `no-progress` problem on the health issue: ready issues exist, nothing is in flight and the queue's
heartbeat is older than the threshold (30 minutes by default).

**Likely causes.**
- The queue is not running: the machine slept or shut down, the terminal was closed, or the queue exited after three
  idle ticks or after a lanes merge (`lanes scripts changed since the queue started`, exit 3).
- Every ready issue is skipped: they overlap on files, wait on a blocker or lack a Scope path.
- The token budget or `start.maxLanes` stops launches.

**Fix.**
1. Wake the machine and, in your own terminal, run `git pull --ff-only` then `node scripts/lanes/queue.mjs`.
2. If the queue runs, read its time-stamped lines: each skipped issue has a reason. Fix that on the issue in GitHub
   (its `Blocked by`, its Scope paths, or merge overlapping issues).
3. Nothing ready at all is not a fault: the health issue clears itself when work appears.

Incidents: none yet from the field; the rule is [ADR 0027](adr/0027-health-inbox-and-watchdog.md). The related release
of bot-filed issues is #586.

<a id="stalled-lane"></a>
## stalled-lane

**What you see.** A lane session is idle with no PR, or its PR has not moved for a long time. The queue's heartbeat
lists it as a local finding on the health issue.

**Likely causes.**
- The lane is blocked at a permission prompt or a question (the desktop notification names the `claude attach <id>`).
- It stopped on a refusal it must report (a hook refusal, a failed identity check, a broken shell PATH).
- The session died after its PR was open or before it.

**Fix.**
1. Read the issue and PR comments: a lane that stops comments the reason.
2. A prompt waiting for you: run the `claude attach <id>` the notification gave and answer it.
3. A dead session with an existing worktree: launch a session with that worktree as its cwd (the lane's resume
   step); it never makes a second worktree or PR.
4. A lane that keeps failing the same way: comment on the issue, remove `lane:running` and file the cause.

Incidents: none recorded in the cited PRs; the detection rule is [ADR 0027](adr/0027-health-inbox-and-watchdog.md).

<a id="flaky-test"></a>
## flaky-test

**What you see.** A `flake:<check>@<sha7>` problem: a check failed and then passed under the same name on the same
commit. A PR is red for a test it did not touch.

**Likely causes.**
- A timing, ordering or platform-specific test (#620: a Windows-only failure at `queue.test.mjs:942`).
- A shared resource such as a port, a temp path or a clock.

**Fix.**
1. In the **Actions** tab, **Re-run failed jobs** on the failed run to unblock the PR.
2. File a task issue naming the test file, the check and both run ids; a flake that is only re-run is never fixed.
3. The key clears itself after 7 days; a new flake raises a new comment.

Incidents: #620, #621.

<a id="workflow-hand-over"></a>
## workflow-hand-over

**What you see.** A lane PR carries a bot comment with the full text of one or more `.github/workflows/` files and
links to GitHub's web editor. The gate may say `workflow file <path> is not committed yet` or
`workflow file <path> differs from the reviewed copy`.

**Cause.** The App has no `workflows` permission ([ADR 0023](adr/0023-workflow-changes-owner-web-editor.md)), so a lane
cannot push a workflow file and hands it to you.

**Fix.** All in the browser; the longer steps are in [USING.md](USING.md#when-a-team-lane-changes-a-workflow-file).
1. Read each file in the comment first.
2. When the comment says **Approve and deploy** ([ADR 0029](adr/0029-one-click-workflow-apply.md)), open the
   `lanes-workflow-apply` run it links and press **Approve and deploy**. If the run refuses (the comment was edited, a
   newer hand-over exists, the branch moved), the reason is in its log: have the lane post a new hand-over.
3. Otherwise (the copy-paste fallback), open the `edit/` or `new/` link, paste the content, choose **Commit directly
   to the branch**, click **Commit changes**.
4. A deleted workflow file is never handed over: delete it from the file's page (trash icon) on the PR branch.
5. The reviewers run again on the new head; then review and approve as usual.

**The fallback.** The lane reads the `lanes-workflow-apply` environment on each hand-over. With no environment, no
required reviewer or a failed read, the comment is the copy-paste one. Private repositories on GitHub Free have no
required reviewers on environments, so they stay on copy-paste for good.

**Rotating the key.** In the `lanes-workflows` App's settings generate a new private key, then set it with your own
`gh`, reading from the downloaded file on stdin: `gh secret set LANES_WORKFLOWS_KEY --env lanes-workflow-apply < <file>`.
Delete the downloaded file and the old key in the App's settings. Or rerun `node scripts/lanes/app-setup.mjs --workflows`.

**Removing the App.** Delete the `lanes-workflow-apply` environment (Settings, Environments) and uninstall or delete the
`lanes-workflows` App. Every hand-over is then copy-paste again, with nothing else to change.

Incidents: #597 (the review ping workflow was delivered this way).

<a id="chain-deadlock"></a>
## chain-deadlock

**What you see.** Issues that wait on each other and none starts: A is `Blocked by` B and B is blocked by A, or the
blocker is a closed-but-unmerged issue, or a blocker is not `ready`. `blockers.mjs` exits 1 and the queue skips them.

**Likely causes.**
- A cycle in the `Blocked by` fields.
- The blocker was filed by a lane and still carries `lane-filed`, so it is never released to `ready` (#586 is the
  rule that releases bot-filed issues).
- The blocker's PR is waiting on you ([approved-not-merged](#approved-not-merged)).

**Fix.**
1. Open the blocked issue and each issue its `Blocked by` names; `node scripts/lanes/blockers.mjs <N>` prints the one
   that blocks.
2. Edit the issue body in GitHub to remove a wrong or circular entry, or remove `lane-filed` and add `ready` on the
   blocker once you have read it.
3. Approve the blocker's PR if that is what the chain waits on.

Incidents: #586.

<a id="scope-miss"></a>
## scope-miss

**What you see.** A lane stops because the change needs a file its issue's Scope does not name, or the
queue skips an issue because its Scope names no repository path. A PR may also be rejected because it touches files
outside its Scope.

**Likely causes.**
- The issue's Scope was written too narrowly, or names a directory that does not exist.
- The contract was missing or wrong, so the lane stopped rather than invent one.

**Fix.**
1. Edit the issue's **Scope** in GitHub to name the concrete paths (and in the Interface contract if it changed).
2. Keep `ready` on it; the queue picks it up on the next tick.
3. If the extra files belong to another goal, file a separate task issue instead of widening this one.

Incidents: none recorded in the cited PRs; the rules are `CLAUDE.md` rules 4 and 5 and the lane's step 4.

<a id="paused"></a>
## paused

**What you see.** Nothing launches and nothing is failing: lanes are paused, on purpose or not.

**Causes.**
- You stopped the queue (Ctrl-C), or the machine is asleep or off.
- `start.maxLanes` in `lanes.config.json` is reached, or the token budget is used up.
- You removed `ready` from the issues.

**To pause on purpose (ADR 0028).** In GitHub open Actions, then lanes-control, Run workflow, pick `pause`, add a reason
if you like, and press Run. Only people with write access can run it, and Actions records who did. The queue reads the
state on every poll: from then on it launches nothing and resumes no dead lane, prints one line
(`paused since <time> by <who>: <reason>`), and keeps polling. Lanes already running finish and their PRs still merge.
The health issue shows `Paused since <time> by <who>: <reason>`, a pause raises no alert, and
[no-progress](#no-progress) stays quiet while it lasts; other alerts still fire. The pause is as live as the poll
interval: a lane that starts a second before you press the button runs to the end. To stop a single issue, remove its
`ready` label. Stopping the queue with Ctrl-C also works, but the next queue start launches again.

**To resume.** Run lanes-control again with `resume`. The queue prints `resumed` on its next poll, and dead lanes that
were found during the pause are resumed then, as in [stalled-lane](#stalled-lane). If the queue is not running,
`git pull --ff-only`, then `node scripts/lanes/queue.mjs` in your own terminal.

**Paused and you did not press the button.** The switch fails closed. The queue's line names the reason:
- `the pause state cannot be read: ...`: GitHub was unreachable or rate limited. It clears on its own when the read works.
- `the control comment was written by <login>` or `was last edited by <login>`, or `is malformed`: something other than
  the lanes-control workflow wrote the comment on the `lanes-health` issue that starts `<!-- lanes:control -->`. Press
  Resume (or Pause) in lanes-control, which rewrites the comment. If the comment was *written* by another account,
  delete that comment in GitHub first, since the workflow only edits its own.

**A fresh install, or a deleted health issue, reads as running.** The state lives in a comment on the `lanes-health`
issue; with no issue or no comment, nothing has been paused. Deleting that issue therefore lifts a pause.

<a id="needs-owner"></a>
## needs-owner

**What you see.** A comment on the `lanes-health` issue: `#<N> needs you: a lane stopped or found nothing to build; see
its last comment`, linking the issue. The issue carries the `needs-owner` label and has lost `ready` and `lane:running`.

**What it means.** A lane stopped on that issue and left it for you: its contract was wrong or missing, a check refused
it, or every criterion was already met on `main`. The lane's own comment on the issue, the last one, says which.

**To fix.** Read that last comment, then either close the issue (nothing to build) or rewrite it (fix the contract, or
the Scope paths). Remove the `needs-owner` label when it is resolved: the issue goes back in the queue once it carries
`ready` again, and the alert clears on the next health run. Closing the issue clears it too.
