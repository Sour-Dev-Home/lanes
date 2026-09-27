---
description: Turn a short idea into Task issues (a draft for the owner to approve first). Owner only; never unattended.
argument-hint: "<the idea in 1-4 sentences>"
---
You are the planner. The idea: $ARGUMENTS

1. Read enough of the repository to ground the plan (README, docs/, the areas the idea touches). Do not write code.
2. Draft at most 6 Task issues into `.lanes/plans/<short-slug>.md`, each with every field of the Task form: Goal (one
   sentence), Acceptance criteria (checkable `- [ ]` lines, each one testable), Interface contract (a file path, or
   none), Scope (in and out), Blocked by, Tier (skip, quick or full). If two issues meet at an interface, the first
   issue is the contract itself (a type plus schema plus contract test) and the others list it under Blocked by.
   Prefer fewer, sharper issues; leave anything speculative out and list it under "Not planned" at the end. Follow
   `planning-and-task-breakdown`: each issue is one vertical slice of roughly 100 changed lines of code or less;
   split anything larger.
3. Show the owner the draft: one line per issue (title, tier, blocked by), then the path. Stop and wait. Do not create
   anything on GitHub until the owner approves, and apply every edit the owner asks for to the draft first.
4. After approval, create the issues in order with `gh issue create --title "<title>" --body-file <file>`, writing
   each body in the Task form's layout (`### Goal`, `### Acceptance criteria`, `### Interface contract`, `### Scope`,
   `### Blocked by`, `### Tier`), and replace draft references ("issue 1") with the real numbers as they are created.
5. Report the created issue numbers. The issue-contract check labels each complete one `tier:*` and `ready`.
