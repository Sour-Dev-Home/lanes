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

1. `gh issue view $ARGUMENTS --json title,body,labels,state`. Stop and report if it is not open, lacks the `ready`
   label, or lacks exactly one `tier:*` label.
2. For each issue under "Blocked by": `gh issue view <N> --json state`. Stop and report if any is OPEN. A refusal in
   step 1 or 2 notifies `lanes #$ARGUMENTS: cannot start: <reason>`.
3. `git fetch origin`, then work in a new worktree on branch `issue-$ARGUMENTS-<short-slug>` from `origin/main`
   (use the EnterWorktree tool when available, otherwise `git worktree add`). Run `npm run setup` in it.
4. Read the issue's Interface contract and Scope. Touch nothing out of scope. If the contract is wrong or missing,
   stop and file a new task issue for the contract instead of inventing one.
4b. Practice (the project skills, agent-skills): build in thin vertical slices with `incremental-implementation` and
    `test-driven-development`; a contract issue follows `api-and-interface-design`; an unexpected failure goes through
    `debugging-and-error-recovery`; UI work follows `frontend-ui-engineering` and the project's design tokens.
    Hand reviewers the matching checklist from `vendor/agent-skills/references/`: the test-hunter gets
    `definition-of-done.md` and `testing-patterns.md`, the security reviewer `security-checklist.md`, the ui-reviewer
    `accessibility-checklist.md`.
5. Tests first: one failing test per acceptance criterion. Run it narrowly (`node --test <file>` or the project's
   equivalent) and watch it fail, then implement until it passes. Run the full suite once at the end.
6. `node scripts/lanes/reviewers.mjs <tier>` lists the reviewers this diff needs. Spawn each as a fresh subagent,
   never a fork, with model sonnet: test-hunter (FULL for tier full, QUICK for tier quick), ui-reviewer,
   security-reviewer, architecture-advisor. Give each the issue's numbered acceptance criteria and require its final
   message to end with a JSON verdict: `{ "reviewer", "verdict": "success"|"failure", "summary", "criteria":
   [{ "index", "result": "pass"|"fail"|"not-applicable", "evidence" }], "findings": [{ "severity":
   "critical"|"important"|"minor", "file", "line", "summary", "fixed" }] }`. The test-hunter and ui-reviewer assess
   every criterion by its 1-based index. Fix what they find (one more round only if they found real bugs), set
   `fixed` truthfully, and save each verdict to `.lanes/verdicts/<reviewer>.json`. After the final push, post each:
   `node scripts/lanes/post-review.mjs --file .lanes/verdicts/<reviewer>.json`. A refused verdict prints why; fix the
   JSON or the code, never the facts. Never post a verdict for a review you did not run.
7. `npm run preflight`, push, then `gh pr create` with the PR template filled in completely: "Closes #$ARGUMENTS",
   every acceptance criterion mapped under "What changed", "Contract changes" starting with none, additive or
   breaking, and "Needs the owner" saying exactly what he must decide, or "nothing". Then `gh pr merge <N> --auto`.
   Once its checks settle (`gh pr checks <N> --watch`), notify once: `lanes #<N>: queued to merge` if `lanes/gate`
   passed, else `lanes #<N>: needs /approve: <the lanes/gate reason>` (the status's description).
8. Follow-up work becomes new issues from the Task form: write the body to a file in the form's layout (`### Goal`,
   `### Acceptance criteria`, `### Interface contract`, `### Scope`, `### Blocked by`, `### Tier`, every field
   filled), then `gh issue create --title "<title>" --label lane-filed --body-file <file>` (not `--template`, which
   cannot take scripted answers). The `lane-filed` label means the owner must remove it before the issue can become
   `ready`. Never leave follow-ups only in the PR text.
9. If CI fails twice on the same cause, stop: comment the cause on the PR, file an issue, and notify
   `lanes #<PR>: CI failed twice: <cause>, see #<PR>`. Do not loop.
10. End with the PR URL, the lanes/gate state and a two-sentence summary.
