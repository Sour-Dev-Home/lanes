---
description: The owner approves a PR (posts review/owner on its head). Owner only; never run from a lane.
argument-hint: <pr-number>
---
This is the owner's approval of PR #$ARGUMENTS. If you are a lane or were started by a schedule, stop now.

1. Show `gh pr view $ARGUMENTS --json title,body,headRefOid` (title, "Needs the owner", "Contract changes") and
   `gh pr diff $ARGUMENTS --name-only`. Note the `headRefOid` shown here.
2. Run `node scripts/lanes/post-review.mjs owner success "approved by owner" --pr $ARGUMENTS --sha <the headRefOid
   from step 1>`. This asks for permission on purpose: the owner's approval of the prompt is the approval. `--sha`
   closes the race where a push lands between step 1 and step 2: the script refuses if the PR's head has moved.
3. Run `gh pr merge $ARGUMENTS --auto` and report the lanes/gate state.
