---
description: The owner approves a PR (posts review/owner on its head). Owner only; never run from a lane.
argument-hint: <pr-number>
---
This is the owner's approval of PR #$ARGUMENTS. If you are a lane or were started by a schedule, stop now.

1. Show `gh pr view $ARGUMENTS --json title,body,headRefOid` (title, "Needs the owner", "Contract changes") and
   `gh pr diff $ARGUMENTS --name-only`. Note the `headRefOid` shown here.
2. Run `node scripts/lanes/post-review.mjs owner success "approved by owner" --pr $ARGUMENTS --sha <the headRefOid
   from step 1>`, exactly in this form (nothing chained or wrapped). Run from `/approve <N>` this needs no permission
   prompt: typing `/approve <N>` is the approval, and `scripts/lanes/approve-guard.mjs` allows this one command for
   PR N, once, within 15 minutes; anywhere else, lanes and auto mode included, the hook denies it. `--sha` closes the
   race where a push lands between step 1 and step 2: the script refuses if the PR's head has moved.
3. Run `gh pr merge $ARGUMENTS --auto` and report the lanes/gate state. Then report where the PR stands: merged
   (`gh pr view $ARGUMENTS --json state`), in the merge queue with its position, or with auto-merge on
   (`autoMergeRequest` set). `node scripts/lanes/status.mjs` shows the queue as `in merge queue, position N`.
   `main` has a merge queue, and a PR that enters it has `autoMergeRequest: null`, so a null `autoMergeRequest`
   alone does not mean auto-merge failed; check the queue before calling it off.
