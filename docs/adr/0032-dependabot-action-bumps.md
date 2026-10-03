# 0032: A Dependabot PR that only re-pins actions takes a narrow gate path: no issue, no lane reviewers, the owner still approves

Status: accepted

## Context

`.github/dependabot.yml` has watched the `github-actions` ecosystem weekly, in one grouped PR, since c2ccda5. Dependabot
is enabled on the repository and has not yet opened a PR. Every workflow here pins its actions by 40-hex SHA with a
`# vN` comment, so each Dependabot PR will change only those lines.

Today `lanes/gate` fails any PR without "Closes #N" (`gateDecision` in `scripts/lanes/lib.mjs`), and the branch, the
tier, the `ready` label and the reviewers all hang off that issue. `docs/USING.md` says there is no exemption for a
`dependabot/` head, because one would be a way around the branch-to-issue check (I4), and tells the owner to have a
lane recreate the bump. Under the team profile that cannot work for a workflow file. A lane pushes as the App, and the
App has no `workflows` permission, so ADR 0023 refuses the push. ADR 0023 is about lane pushes, and its web-editor
hand-over is for them. Dependabot pushes its own branch and may change workflow files, so no hand-over applies to its
PRs: the owner reviews and approves the PR in GitHub and it merges through the queue.

Other facts:

- `.github/` is an owner path, so GitHub's code-owner rule and the gate's native approval (ADR 0021, 0025) both ask for
  the owner. The author is `dependabot[bot]`, not an owner, so there is no self-approval problem.
- `lanes-gate.yml` runs on `pull_request_target`. GitHub gives such a run a read-only token and no secrets only when
  the base ref was created by Dependabot. The base here is `main`, so the gate keeps its permissions (`statuses:
  write`). This must be checked on the first real PR.
- The other required checks, `verify` and `security`, run on `pull_request`, so a Dependabot run gets the Dependabot
  secret store. `PII_PATTERNS` is an Actions secret and is absent there. `security.yml` then warns and checks local
  paths only. It already excludes `.github/` from the scan, so nothing is lost for this class of change.
- `merge_group` and `workflow_run` re-decide through `decideForPr` and `carry`, so a rule added to the pure decision
  holds for the queue too.
- The gate reads the PR's files with `--jq` on filenames only. The files API's `patch` field is absent or cut for
  large or binary files.
- "The security reviewer" in the idea is the `security` required check. A workflow path is sensitive, so the normal
  path would also run the security-reviewer agent. This ADR drops that agent for the narrow class.

## Decision

**1. A switch, off by default.** `lanes.config.json` gains `dependabot.actionBumps` (boolean). Absent or `false` is
today's behaviour, so an adopter's Dependabot PRs still fail as USING.md says. This repository sets it `true`. The gate
reads it from the default-branch checkout, so a PR cannot enable it for itself.

**2. A pure function `dependabotActionBump({ author, files })` in `lib.mjs` decides whether the PR qualifies.** Every
condition must hold, and anything else, including an unreadable input, returns "not a bump" and the PR goes through the
normal rules unchanged:

- `author.login` is exactly `dependabot[bot]` and `author.type` is `Bot`, from the PR API at decision time. The branch
  name, title, body, labels and commit authors are never read.
- The file list is complete (not at the API's 3000-file cap) and every file has `status: "modified"`, no
  `previous_filename`, and a string `patch`. A missing, empty or truncated patch fails: each hunk header's line counts
  must equal the lines actually present, and any `\` line (no newline at end of file) fails.
- Every filename matches `^\.github/workflows/[^/]+\.ya?ml$` or `^\.github/actions/.+/action\.ya?ml$`. No other file,
  `dependabot.yml` and CODEOWNERS included.
- Within each change block the removed and added lines are equal in number and pair in order. Each line, apart from
  its `-` or `+`, matches `^(\s*(?:-\s+)?uses:\s+)(<owner>/<repo>(?:/<path>)?)@([0-9a-f]{40})(\s+#\s*[\w.+ /-]{1,64})?$`.
  A pair must share the same prefix text and the same action reference, and differ only in the SHA or the comment.
  Local `./` actions, `docker://`, `${{`, a tag or branch ref, an added or removed `uses:` line, and any other changed
  line all fail. Context lines are not inspected: they are unchanged.

A tag-pinned action (`@v4`) is not covered. It takes the normal rules.

**3. The narrow decision is made early and cannot succeed without the owner.** `gateDecision` calls
`dependabotActionBump` when the switch is on, after `moduleMapProblem` and before the "Closes #N" check, and on a
match returns the owner stage: success only when `nativeApproval.approved === true` for the head, otherwise `pending`
with stage `owner` and a description such as "waiting for a code-owner review in GitHub (dependabot action bump)". No
issue, tier, label, branch, PR-template, reviewer or verdict check applies. A human push onto the Dependabot branch is
safe: the diff against the base is judged afresh at every head, and a non-conforming one falls back to the normal
rules and fails.

**4. How the gate gets the patch.** `gate.mjs` makes this extra call only when the PR author is `dependabot[bot]` and
the switch is on: `pulls/{n}/files` with `--paginate`, reading `filename`, `status`, `previous_filename` and `patch`
as JSON lines. Any API error, parse error or short page returns "not a bump". The existing filename call is unchanged.

**5. Nothing else changes.** `verify`, `security` and `lanes/gate` stay required by the ruleset. The code-owner rule
stays. No new workflow, no new permission and no PR code is run. A Dependabot PR that does not qualify still fails the
gate, as today.

**6. Residual risk, stated.** The gate checks the form of the change, not that the new SHA is the upstream release. A
SHA from outside the upstream repository, or a moved tag, passes the form check. The controls are Dependabot taking the
SHA from the upstream tag, and the owner reading the PR, whose body links the release notes. A check that the SHA is a
commit of the named repository is a possible later addition, not part of this decision.

## Decisions for the owner

1. A narrow path for Dependabot action re-pins: approved with this ADR, on the owner's idea.
2. Opt-in switch, on in this repository: approved with this ADR.
3. No lane reviewers and no linked issue for the narrow class; the `security` check and the owner stay: approved with
   this ADR.
4. The "handed over like any workflow change" in the idea is dropped: ADR 0023's hand-over is for lane pushes, and
   Dependabot pushes its own change. Approved with this ADR.
5. Tag-pinned actions are out of scope: approved with this ADR.

## Consequences

- The first grouped Dependabot PR can merge after one owner approval and green checks, with no issue to file and no
  web-editor step. The USING.md instruction to recreate the bump through a lane is replaced for qualifying PRs.
- The I4 rule still holds. The path never reads the branch name and never lets a PR without an issue skip a check
  except in this one class, which is bounded by the author, the file set and the line shape.
- `lib.mjs`, `gate.mjs` and `lanes.config.json` are owner paths, so every issue needs owner approval.
- Dashboards, `status.mjs` and `post-review.mjs` read `Closes #N`. They must tolerate a PR with no issue. The
  implementing issue checks this and adds a test.
- If the gate cannot post its status on a Dependabot-run event (a read-only token), the required check stays missing
  and the PR does not merge. That is safe, not a bypass. The owner re-runs `workflow_dispatch` with the PR number.
- A false negative costs the owner the existing manual route. A false positive is bounded to a re-pin the owner
  approves, so the table tests for the line shape are the main safeguard.

## Governs

- .github/dependabot.yml
- lanes.config.json
- docs/USING.md
- scripts/lanes/lib.mjs
- scripts/lanes/lib.test.mjs
- scripts/lanes/gate.mjs
- scripts/lanes/gate.test.mjs
- scripts/lanes/gate-decision.test.mjs
