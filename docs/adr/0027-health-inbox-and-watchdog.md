# 0027: A GitHub-native health inbox and watchdog

Status: accepted

## Context

Lanes runs unattended, but the owner learns of trouble only by looking at the dashboard or the terminal. Several
failures are silent today: a PR removed from the merge queue and never re-queued (#620, #624), an approved PR that sits
unmerged, a failing `lanes/gate`, a stopped queue, a lane session idle with no PR, and a flaky test that passed on a
rerun and was forgotten. The owner wants these to reach a phone or inbox without a new account or app, and wants the
watchdog to work when the owner's machine is off. This is item 5 of the owner's reliability track (2026-10-02).

Forces:

- The scheduled dashboard workflow (ADRs 0012, 0014, 0024) runs every 5 minutes on default-branch code, with
  `contents: read` and `issues: read`. It publishes a public snapshot that promises no logins, emails, bodies or
  comments.
- GitHub token permissions cannot be scoped to one issue. `issues: write` is repository-wide, so "only the health issue"
  has to be enforced by the script and argued here.
- The App (ADR 0019) has contents, pull_requests, issues and statuses write. Adding a permission such as actions
  variables makes every adopter re-approve the App.
- The queue runs in the owner's terminal under team only (ADR 0025) and, once ADR 0026 lands, sustains itself. Lane
  sessions are local, so only the queue can see an idle or stalled lane.
- The repository is public: anyone can comment on an issue, so a comment's author is part of its meaning.
- `status.mjs` already exports `queueRemovals`, `mergeGroupFailures` and `queueFailedNote` (#621, #626).
- `review-metrics.mjs` counts `<!-- lanes:verdict <reviewer> -->` comments, but a lane re-runs a failed reviewer before
  posting, so failed rounds are never recorded (docs/history/2026-09-30-lane-size-and-cost.md).

## Decision

1. **One inbox issue.** Exactly one open issue labelled `lanes-health` is the owner's alert inbox. Its body is the
   current health: a status line (`healthy` or `N problems`), the active problems with first-seen time, and the last
   heartbeat time. Each new problem is posted as a comment, so GitHub notifies the owner. When all problems clear, the
   body says `healthy` and one recovery comment is posted.
2. **Heartbeat channel: a marker comment on the health issue, edited by the queue with the App token.** The queue edits
   one comment that starts `<!-- lanes:heartbeat -->`, holding the time, the queue version and its local findings (a
   lane session idle with no PR, a stalled lane, a stopped queue) as a JSON block. Edits do not notify, so the queue
   adds no comment per tick. The watchdog reads it with the `issues: read` it already has, and trusts only a heartbeat
   comment whose author is the lane bot (`isLaneBot`, ADR 0020); any other comment with the marker is ignored. Rejected
   alternatives: a repository variable needs a new App permission and is not visible in the inbox; a commit status
   belongs to a SHA, not to a standing fact.
3. **Watchdog: new `scripts/lanes/health.mjs`.** A pure `evaluate(inputs, now)` returns the active problem set; a thin
   `run` reads GitHub and applies it, as a step of a separate job in the dashboard workflow. Problems:
   - `queue-removed`: a PR removed from the merge queue and not re-queued (`queueRemovals`).
   - `approved-stuck`: approved and gate-green but not merged after the threshold.
   - `gate-failure`: a `lanes/gate` failure, or a merge-group failure (`mergeGroupFailures`).
   - `no-progress`: ready issues, nothing in flight, and the heartbeat older than the threshold.
   - `flake`: a check run that failed and then passed under the same name on the same head SHA.
   - The queue's local findings, copied from a trusted heartbeat.
   The two thresholds (30 minutes each by default) live in `lanes.config.json`.
4. **Keying, so each problem is commented once and recovery once.** A problem key is its kind plus its subject
   (`queue-removed:PR 412`, `approved-stuck:PR 412`, `no-progress`, `flake:<check>@<sha7>`). The open keys are stored in
   the issue body in a `<!-- lanes:health {"open":[...]} -->` block, the only persistent state, trusted only when the
   body was last written by `github-actions[bot]`. Each run compares the evaluated set with the stored one: a new key
   gets one comment and is added; a key that is gone is removed, and when the set becomes empty one recovery comment
   is posted; a key already present gets nothing, however long it lasts. A flake key clears after 7 days, since it has
   no recovery signal. A problem that recurs after clearing is new and gets a new comment.
5. **Write boundary enforced in the script.** `health.mjs` uses one injected GitHub client with only these operations:
   list issues by label, create the health issue if none exists (find-or-create by label `lanes-health`, creating the
   label if missing), edit that issue's body, reopen it, and comment on it. It keeps the number find-or-create returns,
   and no function accepts another number; a test asserts the client is only ever called with that number. The
   workflow's new health job gets `issues: write` and nothing else, runs default-branch code on schedule only, never on
   `pull_request` events, and the snapshot-publishing job stays at `contents: read`. The residual risk, a compromised
   default branch using `issues: write` repository-wide, is the same exposure default-branch workflow code already has.
   *Amendment (2026-10-02, #631, approved by the owner in the operability item 1 plan):* no other write; the read
   permissions it needs.
6. **Health issue closed or edited by hand.** If the issue is closed, the watchdog reopens it only when there is an
   active problem; it never creates a second one while a closed one carries the label. If the `lanes:health` block is
   missing, unparseable or not written by `github-actions[bot]`, the stored set is empty: the next run rewrites the body
   and re-comments the problems still active (one duplicate at most). Text outside the markers is rewritten on each
   change; the owner's comments are never touched. With several open `lanes-health` issues, the lowest number wins.
7. **Trend metrics: aggregates only, per ISO week.** `snapshot.json` gains `trends`: weekly rows with counts
   `queueRemovals`, `gateFailures`, `flakes` and `reviewRounds` (failed rounds). No PR numbers, titles, logins or check
   names appear in the public snapshot, and it never carries the health issue's text or the heartbeat's findings.
   `contracts/snapshot.schema.json` adds the field as optional, and the dashboard renders it.
8. **Review rounds in the verdict.** The `metrics` object of a reviewer verdict gains an optional integer `rounds` (1 or
   more: the runs of that reviewer for this verdict, failed ones included). `lane.md` tells lanes to record it;
   `post-review.mjs`'s validation and `contracts/review-metrics.schema.json` change together. Failed rounds are
   `rounds - 1` per verdict, summed by `review-metrics.mjs`; older verdicts without `rounds` count as 1.
9. **The workflow change goes through the ADR 0023 hand-over.** The `dashboard.yml` edit (the health job with
   `issues: write`) is committed by the owner in GitHub's web editor from the lane's hand-over comment. The code is safe
   to merge before it: nothing calls the watchdog until the workflow changes.

## Decisions for the owner

Decided by the owner on 2026-10-02 in /plan-issues: the lanes-health inbox issue, the watchdog in the scheduled
dashboard workflow, the queue's heartbeat and local findings, weekly trend metrics, review rounds in verdicts, and the
hand-over for the workflow change. Approved with this plan: the heartbeat as a lane-bot comment on the health issue;
`issues: write` on a separate health job, limited to the one issue in code and tested; 30-minute thresholds in
`lanes.config.json`; trusting the heartbeat only from the lane bot and the health state only from
`github-actions[bot]`.

## Consequences

- Alerts reach the owner through GitHub's own email and mobile notifications, with no new account, app or App
  permission. The watchdog does not depend on the owner's machine, so a dead queue is itself reported.
- Failed review rounds, queue removals, gate failures and flakes become weekly trends, which is the number the issue-size
  decision said it lacked.
- The dashboard workflow gains a write permission, argued above and limited in code. A hand-edit of the issue body can
  cause one duplicate comment.
- While the queue is not running, heartbeat age is the only signal for local problems, and `no-progress` fires only
  when ready issues exist.
- The dashboard cron is every 5 minutes and GitHub may delay scheduled runs, so the thresholds are approximate.
- Chat notifications (Slack, Discord) are not covered; that would be its own decision.

## Governs

- .github/workflows/dashboard.yml
- scripts/lanes/health.mjs
- scripts/lanes/status.mjs
- scripts/lanes/snapshot.mjs
- scripts/lanes/review-metrics.mjs
- scripts/lanes/queue.mjs
- scripts/lanes/post-review.mjs
- contracts/snapshot.schema.json
- contracts/review-metrics.schema.json
- .claude/commands/lane.md
- lanes.config.json
- docs/USING.md
