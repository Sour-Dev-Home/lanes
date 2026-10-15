# 0034: Adopter fit: non-lane PRs, the ADR folder and opting out of shipped files

Status: accepted

## Context

The satisfactory-dash pilot (2026-10-14, its PRs #378, #379 and #399) was the first adoption of lanes by a project
with its own history. Lanes assumes the lanes repository's own layout in four places.

1. **Every PR is a lane PR.** `decideGate` in `scripts/lanes/lib.mjs` fails any PR whose body has no `Closes #N` for a
   ready Task issue ("PR body must say 'Closes #N' for its task issue"). Only Dependabot action re-pins have another
   path (ADR 0032). In the lanes repository this is intended: owner work goes through lanes (ADR 0021 part 4). In an
   adopter, the owner's own PRs, a normal Claude session's PRs (which run as the owner's account) and Dependabot npm
   PRs can never pass `lanes/gate`. On the pilot each one needed the `main (lanes)` ruleset disabled, the PR merged and
   the ruleset re-enabled. The owner's own PRs also meet the ruleset's code-owner rule, which GitHub never satisfies
   with the author's own review.
2. **ADRs live in `docs/adr/`.** `loadAdrs` defaults to `docs/adr` and both callers (`gate.mjs`, `reviewers.mjs`)
   use the default; `isArchitectureFile` hard-codes `docs/adr/`. satisfactory-dash keeps 39 ADRs in
   `docs-vault/wiki/decisions/`, not in lanes' `Governs` format, so lanes sees none (lanes#770). The shipped commands
   (`adr.md`, `health.md`, `lane.md`, `plan-issues.md`) and agents (`security-reviewer.md`, `test-hunter.md`,
   `architecture-advisor.md`) name `docs/adr/` and cite lanes' own ADRs by local path, which an adopter does not have.
3. **The main CI workflow is `verify.yml`.** `/night` and `/health` hard-code it (lanes#771); satisfactory-dash's is
   `ci.yml`. `metrics.mainWorkflow` in `lanes.config.json` already names it for `delivery-metrics.mjs`.
4. **Every shipped file is wanted.** `planUpgrade` in `scripts/lanes/upgrade.mjs` marks a missing `MANIFEST` file
   `add`, so `upgrade --apply` restores a file the adopter deleted on purpose. satisfactory-dash deleted lanes'
   `security.yml` because its own CI `security` job is the same leak scan with a repository-specific exemption, and
   two jobs named `security` both reported.

A malformed ADR already governs nothing (`loadAdrs` keeps it as `{ error }`), so an adopter's own ADR format is
tolerated once lanes can find the folder.

## Decision

**1. Non-lane PRs (opt-in per repository).** A new boolean `gate.nonLanePrs` in `lanes.config.json`, default
`false`, validated where `dependabot.actionBumps` is. The lanes repository leaves it off; `starterConfig` sets it
`true` for adopters. When it is on, a PR is a non-lane PR when all three hold: its body has no `Closes #N`, its author
is not the lane bot (`isLaneBot` with the configured identity), and its head branch does not match `issue-<N>-*`. A
non-lane PR skips the issue, template, tier and reviewer checks, as ADR 0032's path does, and its gate state is:

- success, "approved by code owner @x (non-lane PR)", once `nativeCodeOwnerApproval` reads an approval on the head
  SHA by a code owner who is not the author;
- success, "authored by code owner @x (non-lane PR)", when the author is a user listed in CODEOWNERS (ADR 0031);
- otherwise pending, "waiting for a code-owner review in GitHub (non-lane PR)".

A PR by the lane bot, or on an `issue-*` branch, without `Closes #N` still fails as today. The decision is in the
pure `decideGate`, after the Dependabot path and before the `Closes #N` check, so `merge_group` re-decides it the
same way.

**2. The owner's own PRs and the ruleset.** For a repository with `gate.nonLanePrs` on, `setup-repo.mjs` creates the
code-owner rule as its own ruleset, `main (lanes owner review)`, holding only the `pull_request` rule with
`require_code_owner_review: true`, with repository admins as a bypass actor in `pull_request` mode. The
`main (lanes)` ruleset keeps the required checks, merge queue and code scanning, with no bypass actor. The owner
merges an own PR by ticking GitHub's bypass box for the owner-review ruleset only; `lanes/gate`, the required checks
and the merge queue still apply. An existing ruleset is never changed (as #762 decided); for one, `setup-repo`
prints the steps and links. `identity-check`'s code-owner ruleset check accepts either shape. This needs one
verification run on an adopter before it is relied on: that a PR-mode bypass of one ruleset still leaves the other
ruleset's checks and merge queue in force.

**3. The ADR folder.** A new string `adr.dir` in `lanes.config.json`, a repository-relative directory, default
`docs/adr`. `loadAdrs`, `isArchitectureFile` and their callers read it; any file under it counts as an architecture
change. An ADR there that `parseAdr` cannot read governs nothing, as today; lanes never rewrites an adopter's ADRs.
`/adr` writes new ADRs into `adr.dir` in lanes' format. The shipped commands name "the ADR folder (`adr.dir`, default
`docs/adr`)", and the shipped agents cite lanes' own ADRs as "lanes ADR NNNN" with their one-line rule, never by a
local path.

**4. The main CI workflow.** `/night` and `/health` read `metrics.mainWorkflow` (default `verify.yml`), the setting
`delivery-metrics.mjs` already uses. No new key.

**5. Opting out of shipped files.** A new list `install.skip` in `lanes.config.json`. `install` and `upgrade --apply`
neither copy nor restore a listed file, and `upgrade` lists each as "skipped by install.skip". Only files in an
`OPTIONAL` list exported by `install.mjs` may be skipped: `.github/workflows/security.yml` and
`.github/workflows/dashboard.yml`. Any other entry stops install and upgrade with a message naming it; the gate,
its workflows and the lanes scripts can never be opted out. Skipping `security.yml` keeps `security` in
`requiredChecks`, so the adopter's own job must be named `security`; `upgrade` prints that reminder.

## Decisions for the owner

Decided by the owner on 2026-10-14, by approving this plan:

1. Non-lane PRs pass on a native code-owner review alone, with no lane reviewers, opt-in per repository and on by
   default for adopters only. Lane review coverage is unchanged: every lane PR still gets every reviewer its tier and
   paths require (standing rule 2), and the lane bot can never take this path.
2. The owner's own non-lane PRs pass the gate on authorship and merge through a PR-mode bypass of the owner-review
   ruleset only. This amends ADR 0021 part 4 for repositories with `gate.nonLanePrs` on; the lanes repository keeps
   "owner work goes through lanes". The alternative is no owner path: own PRs keep needing the ruleset disabled.
3. `adr.dir`, `metrics.mainWorkflow` for `/night` and `/health`, and `install.skip` limited to the `OPTIONAL` list.

## Consequences

- An adopter can merge its own, a collaborator's and Dependabot's PRs without disabling a ruleset, and lanes covers
  only the work planned for it.
- In an adopter, a normal session running as the owner can open a PR that merges with no automated review, only the
  owner's bypass click. That is the owner's own work, as in any repository; anything that should be reviewed goes
  through a lane.
- The ruleset split adds one ruleset and one bypass actor in adopters. A bypass is logged by GitHub, and the required
  checks ruleset has none.
- Satisfactory-dash's 39 ADRs are found but govern nothing until written in lanes' format; editing one still routes
  the architecture-advisor.
- `install.skip` is narrow on purpose; a new optional file needs a change to `OPTIONAL` under a new ADR.
- Existing adopters gain `gate.nonLanePrs` on their next `upgrade --apply` (a starter key, #747) and must split their
  ruleset by hand from `setup-repo`'s printed steps.

## Governs

- scripts/lanes/lib.mjs
- scripts/lanes/gate.mjs
- scripts/lanes/reviewers.mjs
- scripts/lanes/setup-repo.mjs
- scripts/lanes/identity-check.mjs
- scripts/lanes/install.mjs
- scripts/lanes/upgrade.mjs
- .claude/commands/adr.md
- .claude/commands/health.md
- .claude/commands/night.md
- .claude/agents/security-reviewer.md
- .claude/agents/test-hunter.md
- .claude/agents/architecture-advisor.md
