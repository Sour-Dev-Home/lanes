# 0028: Pause and resume lanes with buttons in a GitHub workflow

Status: accepted

## Context

DDIA's operability chapter asks for self-healing where appropriate, but also manual control over system state. Lanes
self-heals (the queue resumes dead lanes, and ADR 0026 makes the queue restart itself), yet the owner has no way to say
"stop starting work" short of closing the queue's terminal, and `/start` or a restarted queue would launch again. The
owner wants the switch in GitHub (ADR 0027 already made the lanes-health issue the owner's inbox).

A first draft used a label on the lanes-health issue, with lanes reading the label's event log and trusting a removal
only from a write-access user (the ADR 0022 pattern). The owner chose buttons instead: a `workflow_dispatch` workflow is
how GitHub-native tools usually expose operator actions, and it moves the authorization check from code lanes would
write to GitHub itself.

Facts this decision relies on:

- Only users with write access to the repository can run a `workflow_dispatch` workflow, and GitHub records who ran it
  and when in the Actions history. Triggering one through the API needs `actions: write`, which the lanes App does not
  have (ADR 0019), so a lane cannot press the buttons.
- The App has no `actions` permission (ADR 0019): it can neither trigger, re-run nor delete a workflow run. A workflow's
  run history, with each run's title, triggering actor and conclusion, is therefore a record no lane can change. The App
  does have `issues: write`, so any state kept in an issue or comment could be deleted or replaced by a lane (found by the
  security review of PR #726, which first kept the state in a comment).
- A `workflow_dispatch` run uses the workflow file from the branch the person picks. The App cannot push workflow files
  (ADR 0023), and a person with write access can already change any branch, so the job runs only on the default branch.

## Decision

1. **The buttons.** A new workflow, `.github/workflows/lanes-control.yml`, runs on `workflow_dispatch` with inputs
   `action` (`pause` or `resume`) and an optional `reason` (at most 200 characters). The owner opens Actions,
   lanes-control, Run workflow, picks the action and presses Run. Its `run-name` is `<action>: <reason>`. Its only
   permission is `contents: read`. Its job runs only when `github.ref` is `refs/heads/main`, checks out the default branch, and runs
   `node scripts/lanes/control.mjs`, passing the action, the reason and `github.triggering_actor` as environment
   variables, never interpolated into a `run:` line.
2. **The state is the run history.** `scripts/lanes/control.mjs` only validates the action and the reason (at most 200
   characters, no control character) and fails the run on anything else, so an invalid press never counts. The newest
   successful `lanes-control` run is the state: its title gives the action and reason, GitHub's `triggering_actor` gives
   who, and its start time gives since. Nothing is written to an issue or a comment.
3. **The rule** is one pure helper, `controlState(runs)` in `scripts/lanes/lib.mjs`, with a reader,
   `readControlState(api, repo)`, that lists the workflow's runs through the Actions API, newest first:
   - Failed, cancelled and unfinished runs are skipped.
   - No successful run means running: nothing has been paused.
   - The newest successful run decides, when it is a `workflow_dispatch` run on `main` with a title that parses.
   - A read error, a title that does not parse, or a newest successful run from another event or branch means paused,
     fail closed, with a `reason` naming which.
4. **The queue** (`scripts/lanes/queue.mjs`) reads the state first on each poll. While paused it launches nothing and
   resumes no dead lane (#444), prints one line on each change (`paused since <time> by <who>: <reason>`, and
   `resumed`), and keeps polling. Lanes in flight are untouched and finish. The ADR 0026 self-restart still happens,
   because it starts no lane. Dead lanes found while paused are resumed after the pause lifts. The heartbeat (#630)
   carries `paused`.
5. **/start** is retired by ADR 0030, so the queue is the only launch path the switch has to hold.
6. **The health issue** (`scripts/lanes/health.mjs`) shows `Paused since <time> by <who>: <reason>`. A pause posts no
   alert comment, and the `no-progress` alert is suppressed while paused; other alerts still fire. A heartbeat without
   `paused` reads as not paused.
7. **Adopters.** `install.mjs` ships the workflow and `control.mjs`. The workflow file reaches this repository through
   the ADR 0023 hand-over.
8. **Docs.** `docs/OPERATIONS.md` (pausing and resuming, what keeps running, the fail-closed behaviour) and
   `docs/USING.md` describe it.

## Decisions for the owner

Decided by the owner on 2026-10-02 in /plan-issues and on review of the first draft: a pause switch used from GitHub,
as Pause and Resume buttons in a workflow rather than a label; in-flight lanes finish; the pause shown in the health
issue. Approved with this plan: the heartbeat reports `paused`; `no-progress` is suppressed while paused; a fresh install reads as
running. Amended on 2026-10-02 with the approval of ADR 0030's plan: `/start` is retired, so it no longer refuses while
paused (part 5). Amended on 2026-10-04 by the owner, on the security review of PR #726: the state is the lanes-control
run history, not a comment the lanes App could delete or replace (parts 1 to 3).

## Consequences

- The owner pauses all new launches with one button, and GitHub enforces and records who pressed it. No new account,
  credential or App permission is needed, and a lane can neither press the button nor lift a pause.
- Lanes no longer need their own check of who changed a label: the authorization is GitHub's.
- Fail closed means a GitHub outage, a rate limit or an unreadable run history pauses lanes. That is safe but can look like a
  hang, so the one-line message names the reason.
- The queue makes one more API read per poll, and the pause is only as live as the poll
  interval: a lane that starts a second before the button is pressed finishes.
- The workflow is a new file with no write permission, run only from the default branch.
- The state survives the lanes-health issue being closed or deleted. Deleting the workflow's runs needs `actions: write`,
  which only people with write access have; if every run were deleted, lanes would read as running, and
  `docs/OPERATIONS.md` says so.

## Governs

- .github/workflows/lanes-control.yml
- scripts/lanes/control.mjs
- scripts/lanes/lib.mjs
- scripts/lanes/queue.mjs
- scripts/lanes/health.mjs
- scripts/lanes/install.mjs
- lanes.config.json
- docs/OPERATIONS.md
- docs/USING.md
