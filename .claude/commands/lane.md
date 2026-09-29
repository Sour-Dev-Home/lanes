---
description: Work one task issue end to end as a lane (worktree, tests first, reviewers by tier, PR with the return contract)
argument-hint: <issue-number>
---
You are a lane for issue #$ARGUMENTS. You own this one issue until its PR is open with auto-merge on. Do not work on
anything else, and never message other sessions: everything you need is in the issue and the files it links.

Notify: load the `PushNotification` tool via ToolSearch (`select:PushNotification`) and send one notification, under
200 characters, starting `lanes #<PR or issue>: ` (the PR number once it exists, the issue number before), at each
stop named below. Any other stop where you write that you need the owner sends one notification with that reason.
Never send one for routine progress. If the tool is unavailable, say so in your final message and carry on.
A notification leaves the machine: write the reason as short plain words and issue/PR numbers only, never a file
path, command or CI output, secret, token or personal data (point to the PR or issue for detail instead).

Working economically (fewer turns and less tool output to re-read; no review step is dropped): make independent tool
calls in one turn; read the issue once (step 1) and reuse it rather than calling `gh issue view` again; find lines with
`grep -n` or Grep and read only that range instead of whole files; run only the changed test file while iterating
(`node --test <file>`) and the full suite once at the end; wait for CI or reviewers with one blocking command
(`gh run watch <id>`), never a polling loop (step 7 explains why `lanes/gate` is never watched); change existing
files with Edit, not Write.

1. `gh issue view $ARGUMENTS --json title,body,labels,state`. Stop and report if it is not open, lacks the `ready`
   label, or lacks exactly one `tier:*` label. An issue labelled `spike` is findings, not code (ADR 0012): it skips
   test-first (step 5), and its PR adds only a findings file or an ADR draft, no other code.
2. Run `node scripts/lanes/blockers.mjs $ARGUMENTS`, and stop and report its line on any non-zero exit (1: a
   blocker is open; 2: the blockers cannot be checked, which also stops the lane). A refusal in
   step 1 or 2 notifies `lanes #$ARGUMENTS: cannot start: <reason>`.
3. `git fetch origin`, then create and enter the worktree with the EnterWorktree tool's `name` parameter set to
   `issue-$ARGUMENTS-<short-slug>` (this needs no permission prompt and makes the session's cwd the worktree). It
   creates branch `worktree-issue-$ARGUMENTS-<short-slug>`, so rename it in one command, before any other work:
   `git branch -m issue-$ARGUMENTS-<short-slug>`. Outside Claude Code (no EnterWorktree), create the worktree from
   `origin/main` instead with
   `git worktree add -b issue-$ARGUMENTS-<short-slug> .claude/worktrees/issue-$ARGUMENTS-<short-slug> origin/main`
   and `cd` into it. Run `npm run setup` in it.
   Then run `command -v head ls wc grep` as its own command. If any is missing, write the PATH shape (the number of PATH
   entries and whether `/usr/bin` and `/mingw64/bin` are present, never the full PATH) and the first three raw PATH entries as the shell sees them (shell built-ins only, e.g.
   `IFS=:; set -- $PATH; echo "$1" "$2" "$3"`; this tells a Windows-form `C:\...;C:\...` PATH that bash did not convert
   from a missing entry; the file is gitignored and its entries never go into a PR, issue or commit) to `.lanes/logs/path-$ARGUMENTS.txt`,
   notify `lanes #$ARGUMENTS: shell PATH broken`, report that line and stop. Never prefix commands with `export PATH=…` or
   change PATH to work around missing tools.
4. Read the issue's Interface contract and Scope. Touch nothing out of scope. If the contract is wrong or missing,
   stop and file a new task issue for the contract instead of inventing one.
4b. Practice (the project skills, agent-skills): build in thin vertical slices with `incremental-implementation` and
    `test-driven-development`; a contract issue follows `api-and-interface-design`; an unexpected failure goes through
    `debugging-and-error-recovery`; UI work follows `frontend-ui-engineering` and the project's design tokens.
    Hand reviewers the matching checklist from `vendor/agent-skills/references/`: the test-hunter gets
    `definition-of-done.md` and `testing-patterns.md`, the security reviewer `security-checklist.md`, the ui-reviewer
    `accessibility-checklist.md`. Run `node scripts/lanes/lessons.mjs --paths <the issue's Scope paths>` and give its
    output to the test-hunter and security reviewer with their checklists, as known patterns to look for.
4c. Already built: when every acceptance criterion is already met on `origin/main`, the lane comments the evidence
    (each criterion with the file, test or commit that meets it), then removes the `ready` label and adds
    `needs-owner`, and stops without a worktree change or PR. It never closes the issue: the owner closes or rewrites
    it. It runs `gh label create needs-owner` (description "A lane found nothing to build; the owner closes or
    rewrites it") only if it is missing. Notify `lanes #$ARGUMENTS: already met: close or rewrite it`.
5. Tests first: one failing test per acceptance criterion. Run it narrowly (`node --test <file>` or the project's
   equivalent) and watch it fail, then implement until it passes. The criteria are a minimum: after the
   per-criterion tests, add tests for the edge cases you found while implementing (empty, boundary, malformed and
   error inputs), and list each under "Tests added" as `edge: <case>`. Run the full suite once at the end.
   A `validate:` criterion is not a test: loop on `node scripts/lanes/validate.mjs --issue $ARGUMENTS --criterion <index>`
   (the 1-based criterion), making a fix and then a run, until it exits 0 or 2, and put the attempt table under that
   criterion in "What changed". Exit 0 means met, and exit 2 reports the best value and stops.
6. Commit your work first, so the reviewers listed match what the gate will see; then
   `node scripts/lanes/reviewers.mjs <tier> $ARGUMENTS` lists the reviewers this diff needs, counting the paths the
   issue's Interface contract names as the gate does (it refuses when there is no diff at all). Spawn each as a fresh subagent,
   never a fork, with model sonnet: test-hunter (FULL for tier full, QUICK for tier quick), ui-reviewer,
   security-reviewer, architecture-advisor. Give each the issue's numbered acceptance criteria and require its final
   message to end with a JSON verdict: `{ "reviewer", "verdict": "success"|"failure", "summary", "criteria":
   [{ "index", "result": "pass"|"fail"|"not-applicable", "evidence" }], "findings": [{ "severity":
   "critical"|"important"|"minor", "file", "line", "summary", "fixed" }] }`. The test-hunter and ui-reviewer assess
   every criterion by its 1-based index. When `reviewers.mjs` also prints `ADRs: NNNN, ...`, the diff touches files
   those accepted ADRs govern: give the architecture-advisor each one's path (`docs/adr/NNNN-*.md`) to review
   against. After each reviewer subagent returns, add `"metrics": { "tier", "minutes", "tokens" }` to its verdict,
   taking tokens and duration from the Agent tool's result (rounded to 0.1 minute), and the tier from the issue; for
   a second round, record the second run's figures in the second verdict. Never estimate: if the Agent tool reported
   no figures, leave `metrics` out (`post-review.mjs` then warns but still posts). Fix what they find (one more round
   only if they found real bugs), set `fixed` truthfully, and save each verdict to `.lanes/verdicts/<reviewer>.json`. After the final push, post each:
   `node scripts/lanes/post-review.mjs --file .lanes/verdicts/<reviewer>.json`. A refused verdict prints why; fix the
   JSON or the code, never the facts. Never post a verdict for a review you did not run. A verdict with an unfixed
   critical or important finding is still posted, as `failure`: never hold it back, so the gate reports the finding
   instead of waiting on a review that never arrives. For each posted finding with severity critical or important and
   `fixed: true`, write one fragment in the same PR, `docs/lessons.d/<area>-<pattern>-<issue>.md`, reusing an existing
   pattern slug when the lesson matches one `lessons.mjs` printed, and run `node scripts/lanes/lessons.mjs --check`
   before pushing. The gate does not require fragments.
7. `npm run preflight`, push, then `gh pr create` with the PR template filled in completely: "Closes #$ARGUMENTS",
   every acceptance criterion mapped under "What changed", "Contract changes" starting with none, additive or
   breaking, and "Needs the owner" saying exactly what he must decide, or "nothing". Then `gh pr merge <N> --auto`.
   Wait until the CI checks settle, and only those: `lanes/gate` can wait on the owner indefinitely, so never watch it
   (never give `gh pr checks` a `--watch`). The CI checks are workflow runs and `lanes/gate` is a status, so watch the runs, each
   as its own plain command (a worktree session refuses `gh` inside a loop or `bash -c`): take the head SHA from
   `gh pr view <N> --json headRefOid --jq .headRefOid`, list its runs with
   `gh run list --commit <sha> --json databaseId,workflowName,status --jq '.[] | select(.workflowName != "lanes-gate") | "\(.databaseId) \(.workflowName) \(.status)"'`
   (list again once if a check `gh pr checks` shows has no run yet), then for each run not yet completed
   `set -o pipefail; timeout 900 gh run watch <id> --exit-status --interval 20`, stopping at 15 minutes in all. Exit
   124 means the checks did not settle, which you report as such, never as passed. Then read `lanes/gate`'s state
   and description on the PR head once, with every check's result:
   `gh pr checks <N> --json name,bucket,description --jq '.[] | "\(.bucket) \(.name): \(.description)"'`. Act on it:
   - For a failed or cancelled CI check, report it by name (step 9 covers a second failure); never report success.
   - `waiting for review/<name>`: run that reviewer as in step 6, post its verdict with `post-review.mjs`, and read
     the gate again the same way.
   - `waiting on owner (/approve)`: stop right away, report "waiting on your /approve" with the gate's reason, and
     notify `lanes #<N>: needs /approve: <the lanes/gate reason>` (the status's description), instead of watching.
   - Any other `pending` or `failure`: report the gate's description as the lane's end state.
   - `pass`: done. A passing gate needs no notification.
   From Git Bash, prefix `gh pr create`, `gh pr edit` and `gh issue create` with `MSYS_NO_PATHCONV=1` when they pass `--title` or `--body`, or a leading `/` becomes a Windows path.
   Never push with `--no-verify`, or skip a git hook any other way: when a hook refuses a push or a commit, stop,
   comment the hook's output on the PR or issue, and notify `lanes #<N>: hook refused the push`, instead of bypassing it.
   Write every PR body, issue body, comment and commit message to a file with the Write tool and pass it with
   `--body-file <file>` or `git commit -F <file>`, never through a heredoc or a long quoted argument, so the guards
   never have to read the text.
   After merging main into the branch with no other change, do not re-run the test-hunter: check that `lanes/gate`
   says `reused`, and run the test-hunter again only if it does not.
8. Follow-up work becomes new issues from the Task form: write the body to a file in the form's layout (`### Goal`,
   `### Acceptance criteria`, `### Interface contract`, `### Scope`, `### Blocked by`, `### Tier`, every field
   filled), then `gh issue create --title "<title>" --label lane-filed --body-file <file>` (not `--template`, which
   cannot take scripted answers). The `lane-filed` label means the owner must remove it before the issue can become
   `ready`. Never leave follow-ups only in the PR text.
9. If CI fails twice on the same cause, stop: comment the cause on the PR, file an issue, and notify
   `lanes #<PR>: CI failed twice: <cause>, see #<PR>`. Do not loop.
10. End with the PR URL, the lanes/gate state and a two-sentence summary.
