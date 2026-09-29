---
description: The owner approves a PR (posts review/owner on its head). Owner only; never run from a lane.
argument-hint: <pr-number> [<pr-number>...]
---
This is the owner's approval of PR(s) $ARGUMENTS. If you are a lane or were started by a schedule, stop now.

`$ARGUMENTS` is 1 to 10 PR numbers separated by single spaces, at most 10 distinct ones: typing `/approve <N> [<N>...]`
exactly is the approval, and `scripts/lanes/approve-guard.mjs` writes one grant per PR. A list of 11 or more, or with
a duplicate, grants nothing; say so and stop.

For each PR number <N> in `$ARGUMENTS`, in order, do steps 1 to 3 for that PR alone. One PR that fails does not stop
the others: note its failure and go on to the next number.

1. Show `gh pr view <N> --json title,body,headRefOid` (title, "Needs the owner", "Contract changes") and
   `gh pr diff <N> --name-only`. Note the `headRefOid` shown here for this PR.
2. Run `node scripts/lanes/post-review.mjs owner success "approved by owner" --pr <N> --sha <that PR's headRefOid>`,
   exactly in this form (nothing chained or wrapped), with the SHA from this PR's own step 1, never another PR's.
   Run from `/approve`, this needs no permission prompt: `approve-guard.mjs` allows this one command for each PR the
   prompt listed, once, within 15 minutes; anywhere else, lanes and auto mode included, the hook denies it. `--sha`
   closes the race where a push lands between step 1 and step 2: the script refuses if the PR's head has moved, and
   that refusal fails this PR only.
3. Run `gh pr merge <N> --auto` and note the lanes/gate state. Then note where the PR stands: merged
   (`gh pr view <N> --json state`), in the merge queue with its position, or with auto-merge on
   (`autoMergeRequest` set). `node scripts/lanes/status.mjs` shows the queue as `in merge queue, position N`.
   `main` has a merge queue, and a PR that enters it has `autoMergeRequest: null`, so a null `autoMergeRequest`
   alone does not mean auto-merge failed; check the queue before calling it off.

The report lists each PR's outcome, one line per number: approved and where it stands, or which step failed and why
(for a refused owner post, the script's reason). A failed PR needs a fresh `/approve <N>` once its cause is fixed.
