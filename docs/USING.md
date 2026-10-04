# Using lanes

## The daily loop

1. **Write tasks as issues** with the Task form. Every field is the contract a lane works from: a one-sentence goal,
   checkbox acceptance criteria, the interface contract (a file, or none), scope in and out, blocked-by links, and a
   tier. The `issue-contract` check labels a complete issue `tier:*` and `ready`, or comments what is missing.
   Faster: `/plan-issues "<your idea in 1-4 sentences>"` drafts up to 6 such issues (the contract issue first) into
   `.lanes/plans/`; edit or approve the draft, and only then are they created.
2. **Start up to 8 lanes**: the queue (below) is the only launcher. It checks each issue the way `/lane` does and
   launches the rest as background sessions named `lane-<issue>` with `claude --bg --name lane-<issue> "/lane <issue>"`,
   for `claude attach` or `claude logs`. It skips, with the reason, an issue that is not open, lacks `ready` or one
   `tier:*` label, carries `needs-owner`, is assigned to anyone (see below), has an open blocker or is already in
   flight; one of a pair whose paths overlap (the other starts once the first merges); and anything past
   `start.maxLanes` in `lanes.config.json` (8) lanes in flight, counting open `issue-*` PRs and running sessions. The
   paths in `start.softPaths` (this file and `README.md` by default) never count as overlaps. To hold an issue back,
   remove its `ready` label or press Pause; there is no command to launch a chosen issue by hand. A lane or a
   schedule never launches lanes: the deny rules in `.claude/settings.json` (`claude --bg`, `queue.mjs`, `start.mjs`
   and the release-tag commands, in every permission mode) and the scripts' own refusals inside Claude hold that line
   ([ADR 0030](adr/0030-retire-start-guard-and-start.md)).
   Claiming an issue (#522): when the owner session files a Task issue it will do itself, it assigns it in the same
   call (`gh issue create --assignee @me ...`). The queue skips an issue
   with any assignee, with the reason `assigned to <login>`, so no lane races the owner session. Removing `ready`
   does not claim it: the gate refuses a PR whose issue is not `ready`.
   `start.models` (optional) picks each lane's model by its issue's tier: it maps `skip`, `quick` and `full` to a
   model name, and the queue adds `--model <name>` to that tier's launches. A tier left
   out runs on your default model. This repository sets all three tiers to `sonnet`: issues are scoped
   tightly enough for it, and three independent reviewers check every full-tier lane. Any other key, or a value that is not one word (or starts
   with `-`), refuses the whole run with nothing launched.
   An issue labelled `model:opus` launches on Opus whatever its tier's model, in the queue (a resumed lane as well). Use it for the issues
   where a subtle bug is a security hole: security-critical parsing, guards, and contracts the reviewers found hard.
   Any other `model:*` label is ignored and logged as `#N: ignored label model:<x>`.
   Lanes run without MCP servers: `start.mjs` launches them with `--strict-mcp-config`
   and the lane's settings deny `mcp__github` and `mcp__*` (a best-effort backstop behind `--strict-mcp-config`:
   `mcp__<server>` is the documented permission form, the bare wildcard is not). A user-level MCP server (a GitHub one, say) holds your own token, so a lane
   that loaded it could open PRs or review as you and defeat the bot identity.
   The deny rules in `.claude/settings.json` keep a lane from launching others: they refuse `claude --bg`, `queue.mjs`
   and `start.mjs` (and their PowerShell and `./` spellings) in every session and permission mode, and `queue.mjs` and
   `start.mjs` exit 2 with `lanes are launched only by the owner's queue in their own terminal (ADR 0030)` when the
   script's file is under `.claude/worktrees/` or `CLAUDECODE` or `CLAUDE_CODE_CHILD_SESSION` is set. The same deny list
   refuses the release-tag commands (`git tag`, `git push --tags`, `git push --follow-tags`, a push of a `v*` ref;
   `git ls-remote --tags` still works). They are best-effort, not a barrier around a determined lane (ADR 0030, ADR 0007).
   **Keep the queue running.** Review in GitHub about twice a day, in one or two batches: the queue prints
   each waiting PR with how long it has waited, oldest first.
   `node scripts/lanes/queue.mjs` in your own terminal (never from Claude: it exits 2
   inside Claude, and the deny rules refuse it in every session). It takes no arguments. Every 3 minutes
   it cleans up merged lanes, re-reads every open `ready` issue, the open PRs and the sessions, and launches the
   unblocked, unassigned ones, under `start.maxLanes`, `start.softPaths` and `start.models`; an issue made
   `ready` mid-run joins on the next tick, and one skipped for an overlap or the cap is tried again. Each line is
   time-stamped. The PRs waiting on you (a code-owner review, a failing check or review, a failing gate) print as one block,
   oldest first, in each tick where one started waiting, stopped or changed its reason and in no other: each line has the
   PR's number, title, how long it has waited and what you must decide. The queue keeps working the rest. A failed launch is printed and that issue is not tried
   again until you restart the queue. A GitHub read that fails is retried after 1, 2, 4, 8 and then at most 15
   minutes (one line names the delay; a success resets it), and never ends the queue. After three idle ticks in a row
   (nothing in flight, nothing to launch) the tick lengthens from 3 to 15 minutes and the queue keeps polling, printing
   nothing new; picked work returns it to 3 minutes (ADR 0026). Ctrl-C stops it at any time (exit 0). Each lane it
   launches gets a detached reaper (ADR 0010, logged to `.lanes/reap/<N>.log`), so a lane that
   merges after the queue exits is still cleaned up; a reaper that fails to start prints one line and the queue goes on.
   **The queue acts as the App bot**: it reads the App's key from `~/.lanes/<slug>.pem` (or `LANES_APP_KEY_FILE`) and launches
   each lane through `launchLane` in `start.mjs`, so a queued team lane gets its own
   minted token, the settings file, `--strict-mcp-config`, the bot commit identity and the token refresher, and never
   your credentials. When that preparation fails (no key file, a mint failure, no bot user id) the queue
   prints `#N: launch failed: team profile: <reason>`, launches nothing for that issue and does not try it again.
   **The queue restarts itself after a lanes merge (ADR 0026).** The command you type is a thin supervisor that runs
   the queue as one child process (`LANES_QUEUE_CHILD=1`); never more than those two processes exist. The child records
   the commit its scripts came from at startup; each tick it fetches `origin/main`, and when `scripts/lanes/` or
   `lanes.config.json` differ from that commit it launches nothing and, if the branch is `main`, the checkout is clean,
   `git pull --ff-only` succeeds and `HEAD` then equals `origin/main`, pulls and exits 10, and the supervisor starts
   the next child. Each restart prints one line: `queue: lanes scripts changed (<old> -> <new>), pulled, restarting
   (#N)`. Otherwise it stops and names the failed precondition: exit 3 for not on `main`, uncommitted changes or a
   `HEAD` that is not `origin/main`; exit 4 when the pull cannot fast-forward. Fix the checkout, then start the queue
   again. The other exits are 0 (Ctrl-C) and 2 (an argument, a bad `lanes.config.json`, or run inside Claude); exit 1
   no longer exists. Every script the queue loads is an owner path, so a PR changing one waits for your code-owner
   review in GitHub before the queue can restart into it. A change to the supervisor part itself takes effect at your
   next manual start. A failed fetch prints a line and launches nothing
   that tick; the queue keeps running and tries again. The queue runs on your machine, so it stops when the machine
   sleeps; what to do about that and other stops is in [docs/OPERATIONS.md](OPERATIONS.md).
3. **Watch with `/status`**: WAITING ON YOU, IN FLIGHT (each PR's stage), READY TO START, MERGED.
   A `Notification` hook (`scripts/lanes/notify-hook.mjs`) pops a notification when a lane stops at a permission
   prompt or needs input (with the `claude attach <id>` to reach it), or finishes with its PR waiting on you or failing.
   It is a desktop notification on the machine running the lane only, never a phone or external push.
4. **Approve in GitHub** when a PR waits on you: read its "Needs the owner" and the diff, then review it as a user
   listed in `.github/CODEOWNERS` ([ADR 0021](adr/0021-team-native-code-owner-review.md)). The gate reads that review
   and counts it only if it is on the PR's current head commit and is not by the PR author or the lane bot, so any push
   after the review needs a fresh one. It waits for a review when the diff touches an owner-only path, the "Needs the
   owner" is non-empty, a full-tier blocker is open or a quick-tier contract changes. Owner work goes through lanes, so
   the bot is the author and you approve natively; a PR you push yourself cannot be approved by you.
5. **At night** a scheduled cloud session runs `/night`: up to 3 skip or quick tasks, merged only if CI finds them
   unattended-eligible. In the morning read the digest comment on the "Lanes digest" issue, and review the rest in GitHub.
6. **Weekly `/health`** files issues for stale work, a red main and flaky checks. When the queue or a lane misbehaves,
   [docs/OPERATIONS.md](OPERATIONS.md) has one "if X happens, do Y" page per situation.
7. **Clean up merged lanes** with `node scripts/lanes/cleanup.mjs` (`--dry-run` to see the plan first). It removes
   three kinds: merged lanes, closed-issue lanes (no PR, nothing unpushed) and empty orphan folders under
   `.claude/worktrees`. For each `issue-<N>-…` lane whose PR merged at exactly its local branch tip and whose worktree
   has no uncommitted or untracked changes, it runs `claude rm <id>` for its background session, `git worktree remove` and `git branch -D`,
   never with a force or discard flag; anything else is skipped with the reason, and a failed step stops only that
   lane. `/health` runs it; `/status` prints `N lanes or folders to clean up` when some are waiting. Every queue tick runs
   the same cleanup first, so merged lanes no longer count as in flight. Remote branches are left to GitHub's delete-on-merge, and
   lanes with an open PR or unpushed commits are never touched.

## What merges without you

`lanes.config.json` sorts the files a PR touches into three classes (ADR 0002). The gate reads the lists from the
default branch, so a PR can't change its own rules.

| Class | Paths (see `lanes.config.json`) | What it requires |
| --- | --- | --- |
| skip (`paths.skip`) | docs, `*.md`, tests | Allowed at `tier:skip`, with no reviewers, only if *every* file is a skip path and none is sensitive. |
| sensitive (`paths.sensitive`) | `.github/`, `.claude/`, `.githooks/`, `scripts/lanes/`, `lanes.config.json`, package and lock files, `vendor/`, `CLAUDE.md`, auth, secrets, deploy, `.env` | The security-reviewer, at quick and full; not allowed at `tier:skip`. It does not by itself need the owner's review. |
| owner-only (`.github/CODEOWNERS`) | the gate and trust code and their tests, `install`/`setup-repo`/`new-project`, `.claude/settings.json`, `.github/`, `.githooks/`, `lanes.config.json`, `.claude/agents/`, `.claude/commands/{lane,night}.md`, `docs/adr/`, package and lock files, `vendor/`, `CLAUDE.md`, `.gitattributes`, `scripts/preflight.mjs`, `.env`, auth, secrets, deploy | A code-owner review in GitHub, at every tier, however clean the reviews. Adds no reviewer. |

Adopters keep owner paths in `.github/CODEOWNERS` and set `risk` in the module map: a module with `risk: "sensitive"`
adds its paths to the sensitive set, on top of `paths.sensitive` ([ADR 0031](adr/0031-owner-paths-from-codeowners.md)).
`paths.owner` is deprecated but still honoured as extra owner patterns, so an existing config keeps working.

A PR merges on green checks alone only when it touches no owner-only path, its "Needs the owner" says `nothing`,
and its tier's rule holds:

- `tier:skip`: it touches only skip paths;
- `tier:quick`: its required reviews pass and it touches no contract file;
- `tier:full`: its "Contract changes" is `none` or `additive`, and every required reviewer has both a success
  `review/*` status and a verdict comment for the PR's current head commit that says `success`, posted by someone
  with write access, with no critical or important finding left unfixed. A verdict for an older commit, or in the
  old format without a commit, does not count.

One exception (#25, #154): when the head has no status for the test-hunter, the security-reviewer or the
architecture-advisor, the gate reuses that reviewer's most recent success from an earlier commit of the PR if the PR's
own diff is unchanged since (so merging main in needs no new review). The status says `reused <reviewer> from <sha7>`,
or `reused <a>+<b> from <sha7>` when several reviewers are reused from one commit. A failure is never reused, and
neither is the ui-reviewer or the owner's approval. A reuse is blocked by any change since the review to the
reviewer's brief (`.claude/agents/<reviewer>.md`), the test-hunter's two checklists (`definition-of-done.md` and
`testing-patterns.md`), or the security checklist or `vendor/owasp-cheatsheets/`, or for the architecture-advisor an ADR
governing the PR's files, and by a changed-file list of 300 or more files. A rebase or force-push drops the earlier commits, so it always needs a
fresh review.

Everything else waits for your code-owner review, and the `lanes/gate` status says why (for example
`waiting for a code-owner review in GitHub (owner-only path)`). CI decides this from the diff and the PR's
comments; a lane cannot grant it to itself.

## Contracts, in one place

| Handoff | Contract | Enforced by |
| --- | --- | --- |
| Owner → lane | The Task issue form | `issue-contract` (labels `ready`) |
| Lane → lane | A contract file (type + schema + contract test) merged first; "Blocked by" | `/lane` refuses open blockers; `lanes/gate` enforces "Blocked by" (stays pending while a blocker is open, fails if one cannot be read, re-runs when one closes) and requires "Contract changes" to match the diff |
| Lane → owner | The PR template | `lanes/gate` (all sections, `Closes #N`, contract word) |
| Idea → issues | `/plan-issues` draft in `.lanes/plans/`, approved by the owner | Nothing is created on GitHub before approval |
| Reviewer → gate | A JSON verdict (pass or fail per acceptance criterion, findings with `fixed`), posted as `review/<name>` | `post-review.mjs --file` refuses invalid or dishonest-looking verdicts; `lanes/gate` requires the reviewers per tier and diff |
| Owner → merge | code-owner review in GitHub | `lanes/gate`; stops counting after any new push |

## Metrics

`node scripts/lanes/lane-metrics.mjs [--days N] [--split YYYY-MM-DD] [--public] [--json|--markdown] [--out file]`
reports how lanes perform over the merged lane PRs: rework, scope drift, owner time, PRs open at once and CI
friction, with the `delivery-metrics` and `review-metrics` summaries embedded. Everything is a median or a count, and
the JSON follows `contracts/lane-metrics.schema.json`. Locally it also reads `.lanes/costs.jsonl` for tokens per tier
and model, relaunches and lane-hours; `--public` leaves those out. `--split` gives a before and after block at a
date, so a change such as a model switch or a new required check can be compared without a per-PR list. The figures
are a comparison, not a proof of cause, and GitHub keeps only each status's latest state, so a failure fixed by a later
green status is not counted as rework. Every spread carries a median and a p90, and a `byTier` breakdown repeats rework,
scope drift, owner time and friction per tier label of each PR's closing issue. Minutes in the merge queue come from
the merge-queue events' own times (added to removed, or to the merge when nothing removed the PR).

For the portfolio, export by hand and commit the file yourself: `node scripts/lanes/lane-metrics.mjs --public --split
<date> --out docs/metrics/<date>.json`. `--out` refuses to write when the output holds an email, an @-mention, your
GitHub login or a local path, and says which kind, never the text.

The public dashboard also shows weekly trends (ADR 0027 part 7): per ISO week, the merge-queue removals, failed or
errored statuses on merged PRs (gate failures), CI re-attempts (flakes) and failed reviewer rounds, for the last 8
weeks. `snapshot.mjs` reads them from GitHub on every run and publishes only the counts: no PR number, title, login or
check name, and never the health issue's text. If GitHub cannot be read, the snapshot is published without them.

## The lanes-health issue

One open issue labelled `lanes-health` is your alert inbox (ADR 0027). A job in the dashboard workflow runs
`scripts/lanes/health.mjs` and keeps it current. It runs within minutes of a finished `verify`, `lanes-gate` or
`security` run and of an issue change, on the cron as a backstop, and by hand: open the Actions tab, choose
`dashboard`, then Run workflow (only the health job runs). It keeps it current: the body says `healthy` or `N problems`, lists each active problem
with when it was first seen and the last heartbeat time, and each new problem is posted once as a comment, so GitHub
notifies you. When every problem clears, the body says `healthy` and one recovery comment is posted.

**Watch it for notifications.** Open the issue and choose Watch, then Custom, then Issues (or subscribe to the issue
itself) so GitHub emails you and sends mobile notifications for each comment. Nothing else is needed: no account, app
or chat integration. The body is rewritten on each change; your own comments are never touched.

**What each problem means:**

| Problem | Meaning | What to do |
| --- | --- | --- |
| `queue-removed` | A PR left the merge queue and was not re-queued | Find why in the PR's checks, fix it, and re-queue it |
| `approved-stuck` | Approved and gate-green, but not merged after `approvedStuckMinutes` | Look at the PR's merge-queue state and its required checks |
| `gate-failure` | `lanes/gate` is failing, or a merge-group check failed | Open the PR and read the gate's reason |
| `no-progress` | Issues are ready, nothing is in flight and the queue has not reported in `noProgressMinutes` | Check that the queue is running (`/status`); start it again if it stopped |
| `flake` | A check failed and then passed on the same commit (shown for 7 days) | Nothing unless it recurs; then follow the runbook |
| `stalled:<id>` and other queue findings | The queue's own heartbeat reports a stopped or idle lane session | Run `/status` and follow its recovery line |

[docs/OPERATIONS.md](OPERATIONS.md) has the step-by-step page for each.

**The heartbeat.** The queue keeps one comment on the issue that starts `<!-- lanes:heartbeat -->`, with the time, the
queue version and its local findings. It edits that comment on each tick (an edit sends no notification). The watchdog
trusts it only when the lane bot wrote it, and `no-progress` fires when it is older than `noProgressMinutes`. While the
queue is not running the heartbeat age is the only signal for local problems.

**Thresholds.** `approvedStuckMinutes` and `noProgressMinutes` are in `lanes.config.json` under `health` (30 each by
default; a value that is not a positive number falls back to its default). The dashboard cron is set to every 5 minutes,
but GitHub throttles scheduled runs (here they start 4 to 7 hours apart), so the event triggers above do the real
work and the times are approximate.

**When you close the issue.** The watchdog reopens it only when a problem is active, and never creates a second one
while a closed `lanes-health` issue exists. If you edit the body by hand, the next run rewrites it and may repeat the
comment for a problem that is still active, once. With several open `lanes-health` issues the lowest number is used.

## Pausing and resuming lanes (ADR 0028)

To stop new lanes from starting, open Actions in GitHub, pick **lanes-control**, press Run workflow, choose `pause` (or
`resume`), add an optional reason of up to 200 characters, and press Run. GitHub decides who may: only people with write
access can run the workflow, and the Actions history records who did. A lane cannot press it, or read the state, because the lanes App has no
`actions` permission. The workflow runs only from `main`.

- **What stops:** the queue launches no new lane and resumes no dead lane, prints `paused since <time> by <who>:
  <reason>` once, and keeps polling. **What keeps running:** lanes already in flight finish and their PRs merge, the
  queue still restarts itself when the lanes scripts change (ADR 0026), and the watchdog and the heartbeat keep
  writing. The health issue shows `Paused since <time> by <who>: <reason>`, and `no-progress` is not raised while paused.
- **Resuming:** run lanes-control with `resume`. The queue prints `resumed` on its next poll and picks up dead lanes then.
- **Where the state lives:** in the run history of lanes-control itself. The newest successful run decides, through its
  title (`<action>: <reason>`), GitHub's record of who pressed it, and its start time. A press with a bad action or an
  over-long or control-character reason fails the run and never counts. Nothing is written to an issue.
- **Fail closed:** if the run history cannot be read, or the newest successful run did not come from `workflow_dispatch`
  on `main` or has a title that does not parse, lanes read as paused and the queue's line says why. Run lanes-control
  from `main` to settle it. A repository with no successful run reads as running.
- **Adopters:** `install.mjs` copies the workflow and `scripts/lanes/control.mjs`.

The runbook is [OPERATIONS.md#paused](OPERATIONS.md#paused).

## When a team lane changes a workflow file

A lane cannot push `.github/workflows/` (the App has no `workflows` permission; see
[ADR 0023](adr/0023-workflow-changes-owner-web-editor.md) and `docs/SECURITY.md`). The steps are all
in the browser:

1. **The note.** The queue prints `#N: Scope names .github/workflows/: the lane opens its PR without the
   workflow change and hands it over in a PR comment` and still launch the lane.
2. **The PR comment.** The lane opens its PR without the workflow files and posts one comment (by
   `node scripts/lanes/handover.mjs <pr>`) with each file's full content. It reads the `lanes-workflow-apply`
   environment first, and the comment is in one of two modes: **Approve and deploy** when the environment has a required
   reviewer (the one-click path below), otherwise **copy-paste**, with a link to GitHub's web editor on the PR branch
   (`edit/` for a changed file, `new/` for a new one) and a warning to read it first.
3. **Commit the files.** Read each file. In the one-click mode, open the `lanes-workflow-apply` run the comment links
   (Actions tab) and press **Approve and deploy**: the workflow commits exactly the reviewed files to the PR branch, or
   refuses with a reason if the comment was edited, a newer hand-over exists or the branch moved. In the copy-paste mode,
   open each file's link, paste the content, choose "Commit directly to the branch" and click **Commit changes**.
   Committing runs any push-triggered workflow in the file, so do not commit what you did not read. The PR stays the
   bot's.
4. **The gate's message.** Until the gate reuses reviews by file hash, the reviewers run again on the new head. When a
   committed file differs from the reviewed copy the gate says `workflow file <path> differs from the reviewed copy`,
   or `workflow file <path> is not committed yet` while it is missing.
5. **Deleting a workflow file.** A lane never hands over a deletion: it stops and asks you to delete the file in the
   browser (the file's page, the trash icon, commit to the PR branch), after which its reviewers run on the head.

### The one-click path (ADR 0029)

Setup is two steps, done once:

1. **Merge the apply workflow.** `.github/workflows/lanes-workflow-apply.yml` cannot apply itself, so it reaches the
   repository through the copy-paste hand-over, the last one you do by hand. Until the next step, every hand-over is
   copy-paste.
2. **Run `node scripts/lanes/app-setup.mjs --workflows`.** It creates the second App (`lanes-workflows`), then, after
   listing what it will create and a `y/N`, the `lanes-workflow-apply` environment (you as the required reviewer,
   deployment branches `main` only) with the App's key as a secret. The key is never written to your disk.

After that, a workflow change reaches you as an **Approve and deploy** button on the `lanes-workflow-apply` run. Never add
`lanes-workflows` to a ruleset bypass list, to CODEOWNERS or to another repository. On a private repository on GitHub
Free, environments have no required reviewers: skip both steps and keep the copy-paste flow, which loses nothing.

## Common pitfalls

- **Vague issues make vague PRs.** If an acceptance criterion cannot be written as a test, rewrite it before the lane
  starts. "Works well" is not a criterion; "returns 409 for a duplicate name" is.
- **Two lanes on one interface.** Land the contract first as its own small PR; list it under "Blocked by" in both
  issues. Never let two lanes each invent their half of an interface.
- **Overlapping files.** Two ready issues that edit the same files will conflict in the queue. Put one under the
  other's "Blocked by", or merge them into one issue.
- **Wrong tier.** A `tier:skip` issue whose PR touches code fails the gate. Fix the issue's tier label, then re-run
  the gate: `gh workflow run lanes-gate -f pr=<N>` (label changes on the issue do not re-trigger it by themselves).
- **Pushing after approval.** Any new commit drops your code-owner review and the reviewer statuses (they are per commit).
  Reviewers post after the final push; if you asked for a change, approve again after it lands.
- **The first run of a new check.** A required check that has never run blocks every PR. After adding a workflow,
  land it on `main` before adding its name to `requiredChecks`.
- **Required checks must also run on `merge_group`.** A workflow without that trigger never reports in the merge queue,
  and the queue times out.
- **Lanes are trusted; the gate stops mistakes and strangers, not a hostile lane.** Lanes and schedules act as the App
  bot and the owner as their own account, and a lane can push branches and run code (tests, workflows). What the gate
  does stop:
  - honest mistakes: a missing review, a wrong tier, an incomplete contract, a lane approving its own work (only a
    code-owner review in GitHub counts);
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
  any PR that adds or changes a workflow. Never review as the owner from a lane or a schedule.
- **Silenced errors.** Never `2>/dev/null` a git, gh, npm or test command; use `set -o pipefail` with `tail`.
- **Local servers.** Lanes run tests, not dev servers. A lane that needs a running server (UI review) asks the owner.
- **Updating vendored skills.** Never pull agent-skills from upstream main. Pick a commit, re-read the diff for anything that fetches, installs, handles secrets or overrides rules, and change it in a tier-full PR the owner approves.
- **A lane's own follow-up issues.** `/lane` step 8 files them with the label `lane-filed`; `issue-contract` never adds
  `ready` to one, however complete its contract, even when the owner opened it. Remove `lane-filed` to approve one
  (the check then adds `ready` on its next run). Under `team` it works the same way for an issue the lane bot opened:
  once a write-access actor (not the bot) removes `lane-filed`, the check adds `ready` and the gate accepts a PR that
  closes it. A later edit of its body by anyone without write access withdraws that: the next run removes `ready` and
  the gate rejects the PR ([0022](adr/0022-release-lane-filed-bot-issues.md)).
- **"Blocked by" is the source of truth.** On every open or edit of a task issue, `issue-contract` makes the issue's
  native GitHub blocked-by relationships a mirror of its "Blocked by" field: it links what the field lists and unlinks
  everything else, including a relationship you added by hand in GitHub's UI. To change an issue's blockers, edit the
  field; a hand edit to the native relationships is overwritten on the issue's next run. A field that is empty or has
  no `#N` leaves them alone, and so does an issue whose author lacks write access (the same trust rule as `ready`) or
  that lists more than 20 blockers. A blocker it cannot link (a PR, a missing issue, `owner/repo#N` in another repository) or
  a failing dependencies API is named in the contract comment; the labels are set either way. `/lane`, `/status` and
  the gate keep reading the field, not the mirror. Existing issues are mirrored the next time they are edited.
- **Dependabot PRs.** With `dependabot.actionBumps` set to `true` in `lanes.config.json` (this repository does; absent
  or `false` is the old behaviour), `lanes/gate` takes a narrow path for a Dependabot PR that only re-pins GitHub
  Actions (ADR 0032). It qualifies when the PR author is `dependabot[bot]` and every changed file is a workflow or
  action manifest whose only changes are `uses:` lines moving from one full commit SHA to another of the same action.
  The branch name, title and body are never read. The owner still approves: the gate waits for your approval like any
  other PR, and the PR merges only after it. Nothing is handed over: no task issue, lane or reviewer agent is involved,
  and there is no `Closes #N`. Every other Dependabot PR (a tag-pinned action, a dependency file, any other changed
  line) still fails `lanes/gate` as before: open a matching Task issue, let a lane recreate the bump on its own
  `issue-<N>-<slug>` branch, and close the Dependabot PR with a link to the lane's PR. On the first real bump PR, check
  that `lanes/gate` posted a status; if it did not, re-run it with the gate workflow's `workflow_dispatch` trigger.

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

## Setting up the lanes GitHub App (once per owner)

Lanes act as a GitHub App, not as you (ADR 0019, 0025). `node scripts/lanes/init.mjs <path-to-your-repo>` creates it as
one of its steps, so start there. Re-running init is safe: it runs only the steps `setup-state` reports missing, never
repeats a finished one, and never creates a second App when `lanes.config.json` already has an `identity`. It asks you
to do four things: set the `PII_PATTERNS` secret in another terminal and type `done`, press **Continue to GitHub**
and then the two GitHub buttons below, and add CODEOWNERS and the code-owner ruleset in GitHub's UI (it prints the
links). Run it again afterwards to see the checklist clear.

### What init runs

From the repository's root, the App step is:

`node scripts/lanes/app-setup.mjs [--org <org>]`

1. It prints a `http://127.0.0.1:<port>/` address; open it and press **Continue to GitHub**. `--org` creates the App
   in that organisation instead of your account.
2. **Button one**: GitHub's "Create GitHub App". The script receives the key, saves it to `~/.lanes/<slug>.pem` (owner
   only, outside every repository) and sends you on to the install page.
3. **Button two**: install the App on this repository. The script then writes `identity` into `lanes.config.json`,
   keeping every other key. It prints no key or token, and refuses a callback whose `state` it did not generate.
4. It then runs the read-only checks (`node scripts/lanes/identity-check.mjs --setup-checks` repeats them any time) and
   prints, for each missing item, the GitHub settings link and the line to add. Do those in GitHub's UI:
   - **CODEOWNERS**: commit `.github/CODEOWNERS` in a PR with the printed line (`* @<you>`).
   - **The ruleset**: from the printed settings link, add a branch ruleset on `main` that requires a pull request with
     **Require review from Code Owners**. Optionally add a tag ruleset restricting tag creation to you.
   - **The install**: if the App is not on this repository, use the printed install link.

The queue finds the key at `~/.lanes/<slug>.pem` (the slug is `botLogin` without `[bot]`), so no environment
variable is needed. Setting `LANES_APP_KEY_FILE` still overrides it. A missing key file stops the launch with a message
naming the path.

## Adopting it in another repository

Run `node scripts/lanes/init.mjs <path-to-your-repo>` from this lanes clone, or
`node scripts/lanes/init.mjs --new <name> [--private] [--license mit] [--org <org>] [--dry-run]` for a new project. It
installs the template, waits while you set the `PII_PATTERNS` secret (type `done`), creates the labels and the `main`
ruleset, creates the App, and ends with a checklist. Re-run it any time: finished steps are skipped, so it is safe
after a stop or a fix. It asks you to click only in GitHub (the App's two buttons, CODEOWNERS and the code-owner
ruleset) and prints each link.

### What init runs

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

### The dashboard workflow and private repositories

A GitHub Pages site is public even when its repository is private, and the dashboard publishes the PR and issue
snapshot to one (ADR 0012). So `install.mjs` copies the dashboard workflow as `.github/workflows/dashboard.yml.disabled`,
which GitHub ignores, unless the target repository is public. It asks `gh` whether the repository is public; when that
is unknown it treats the repository as private. To turn the dashboard on, either run
`node scripts/lanes/install.mjs <target> --public` (`--private` forces the disabled copy), or rename the file to
`dashboard.yml` yourself. Do that only when you accept that the snapshot's contents are readable by anyone.

### Turning the dashboard page on

The page itself is `dashboard/` (`index.html`, `app.js`, `style.css`), which `install.mjs` copies and the workflow
publishes next to `snapshot.json`. Enable Pages once per repository: Settings, Pages, Source "GitHub Actions". After
the next run of the `dashboard` workflow the page is at `https://<owner>.github.io/<repo>/`.

**The site is public**, even for a private repository: anyone with the URL can read every task title, stage and
blocker reason in the snapshot. The page only reads, and its "waiting on you" list shows each waiting PR ([ADR 0024](adr/0024-dashboard-review-links-under-team.md)):
each one shows a "Review in GitHub" link to its files, the gate's reason, and whether your review covers
the current head, with the note "Approve in GitHub; the gate re-runs on your review." Task cards link to their issue and
PR, and a failing check links to its run. The snapshot carries the profile, the repository name, one yes/no per PR for
your review (never a login) and only check links inside this repository; the page checks every link again before it
makes one, and shows anything else as plain text.
