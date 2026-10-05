# Changelog

## [0.2.0] - 2026-10-04

Lanes now runs as a GitHub App bot under one profile, team, and a code-owner review in GitHub is the approval. The queue
is the only launcher, and it, the health watchdog and the workflow hand-over keep the system moving without the owner's
terminal commands. The full account is in `docs/history/2026-10-04-lanes-v0.2.0.md`.

### Identity and review

- Lanes act as a GitHub App bot, never as the owner: team identity profile (ADR 0019, #496, #499, #553), the gate
  trusts the lane bot (ADR 0020, #525 to #528) and lanes load no MCP server holding the owner's credentials (#544).
- The gate needs a native code-owner review for owner paths (ADR 0021, #557 to #559, #575) and reuses reviews across the
  owner's workflow commit (#593, #594).
- The solo profile is removed; team is the only profile (ADR 0025, #611 to #614). `approve-guard`, `/approve` and
  `/approvals` are gone with it.
- A bot-authored `lane-filed` issue becomes trusted when a write-access actor removes the label (ADR 0022, #579, #580).
- Dependabot PRs that only re-pin actions take a narrow gate path, and owner approval is still required (ADR 0032,
  #704 to #707).
- Review rounds are recorded in verdicts, with a failed-round metric (#628).
- Reviewers can be configured per module (ADR 0018, #459 to #463, #480, #482).

### Launching

- `/start` and the start guard are retired; the queue (`node scripts/lanes/queue.mjs`, run in the project) is the only
  launcher and refuses to run inside Claude or a lane worktree (ADR 0030, #674 to #677).
- The queue sustains itself: it pulls and restarts when lanes' own scripts change, polls while idle and backs off on
  read errors (ADR 0026, #535, #632), and posts a heartbeat (#630).
- A queue resumes a stopped lane in its worktree once `needs-owner` is removed (#724, #739), a lane whose PR conflicts
  with main (#741), and a lane that died before its PR (#444, #476).
- The queue skips an issue the owner has claimed by assigning it (#522) and honours `model:opus` (#577).
- A lane that stops for the owner comments why on its issue (#666).

### Operations

- A health inbox and watchdog: `lanes-health` alerts carry their cause, the owner's fix and a runbook link; the watchdog
  runs on events and a button, lists issues a lane stopped on, and flags a lane PR stuck with no lane (ADR 0027, #629,
  #641, #679, #689, #745). `docs/OPERATIONS.md` is the runbook (#640).
- Pause and Resume buttons through the `lanes-control` workflow (ADR 0028, #645).
- One-click workflow apply: a second App and the `lanes-workflow-apply` environment commit workflow changes after the
  owner approves (ADR 0029, #646, #647, #649, #652, #660, #684).
- A flaky test is rerun once in the merge queue and reported (#637); a failing push for a workflow file the branch does
  not touch needs a merge of main (#694).
- Every process spawned by the scripts uses `windowsHide` (#651, #673); `cleanup` removes hand-over lanes and orphan
  sessions (#717).
- The dashboard shows review links under team (ADR 0024) and trend metrics (#631).

### Planning and Scope

- `/plan-issues` sizes issues at 100 to 300 lines and lets one issue span modules (#600); a scope-tests helper checks
  each drafted issue (#634).
- The gate notes PR files outside the issue's Scope and lanes explain them (#635).
- Owner paths come from `.github/CODEOWNERS`, unioned with the deprecated `paths.owner`; module risk widens sensitivity
  (ADR 0031, #701 to #703).
- `issue-contract` refuses tier `skip` when the Scope names a path that is not skip-safe.

### Adopters

- `node scripts/lanes/app-setup.mjs` creates the GitHub App with GitHub's buttons (#612, #729), and `--workflows` adds
  the second App and the environment (#652).
- `setup-state.mjs` reports which first-run steps are done and how to fix each missing one (#713).
- `init.mjs` runs each missing first-run step in order and ends with a checklist, including on an existing repository
  with starter config, npm scripts and CODEOWNERS before `setup-repo` (#714, #747); the README and `docs/USING.md` lead
  with it (#715).
- `install.mjs` copies the queue and its closure so adopters have a launcher (#736).

### Upgrading from 0.1.0

- The solo profile is removed and team (a GitHub App) is the only profile; a config that is not team is refused.
- `/start`, `/approve` and `/approvals` are gone. The queue (`node scripts/lanes/queue.mjs`, run in the project) is the
  only launcher, and approval is a code-owner review in GitHub.
- `.github/CODEOWNERS` is the owner list; `paths.owner` is deprecated but still honoured.
- Run `node scripts/lanes/init.mjs <path>` from the lanes clone, or `upgrade.mjs` for an existing install, then follow
  its checklist, including `app-setup.mjs --workflows` for one-click workflow changes.

## [0.1.0] - 2026-09-29

First tracked release. Lanes ships:

- Lane workflow: the `/lane`, `/start`, `/status`, `/approve`, `/approvals`, `/adr`, `/health`, `/night` and `/plan-issues` commands, with the reviewer agents (test-hunter, security-reviewer, ui-reviewer, architecture-advisor).
- The `lanes/gate` status check and its review, owner-approval and CI rules, with the issue-contract and security workflows.
- Guards: the approve and start guards, the pre-push hook and the shell lexer they share.
- Tooling: blockers, overlap picking, validation loops, lessons, cost and review metrics, cleanup, and the dashboard with its snapshot.
- Vendored agent skills and OWASP cheat sheets.
- `install.mjs`, which copies the workflow into another repository and records the version and the sha256 of each file it wrote in `lanes.lock.json` (contract: `contracts/lanes-lock.schema.json`).
