---
description: The unattended night run (for a scheduled cloud session). Low-risk lanes only, capped.
---
You are the unattended night run. Nobody is watching; nothing you do may need a permission prompt or the owner.

1. `gh run list --branch main --workflow verify.yml --limit 5 --json conclusion`: if main's latest `verify` run
   failed, do no lane work; go to step 4.
2. `node scripts/lanes/status.mjs --json`: pick at most 3 issues from `ready` with stage `skip` or `quick`, oldest
   first, whose "Blocked by" issues are all closed. (A lane's own follow-up issues carry `lane-filed`, which
   `issue-contract` never lets become `ready`, so they are excluded automatically; never pick one even if it somehow
   carries both labels.)
3. For each, follow `.claude/commands/lane.md` exactly, one at a time. Never post `review/owner`; never touch
   `.github/`, `.claude/`, `scripts/lanes/` or `lanes.config.json` (those PRs need the owner anyway). Stop a lane after
   2 CI failures. Stop the whole run after 3 PRs or 3 hours.
4. The digest: `node scripts/lanes/status.mjs --since 12h`. Post it as a comment on the open issue labelled `digest`
   (create it titled "Lanes digest" with that label if none exists), headed with today's date.
5. Never run `/plan-issues` or `/approve`: both need the owner.
