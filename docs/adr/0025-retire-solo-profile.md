# 0025: Retire the solo identity profile; team is the only profile

Status: accepted

## Context

Lanes has two identity profiles. Under solo, lanes run as the owner's own GitHub account, the owner approves with
`/approve`, and `approve-guard.mjs` plus `post-review.mjs owner` try to keep a lane from forging that approval (ADR
0004, accepted risk; ADR 0015, owner input). Under team (ADRs 0019 to 0024), lanes act as a GitHub App bot and the
owner approves with a native code-owner review on GitHub.

The owner decided on 2026-10-01 in /plan-issues to retire solo. In the owner's words, solo "introduces many unneeded
bugs and ideally I should be working from the github page instead. I do not want to maintain it."

The evidence agrees. `approve-guard.mjs` is 1,310 lines and its test 2,102. ADR 0004 records that no amount of command
parsing was ever complete, because a direct `gh api` call can post a `review/owner` status without running
`post-review.mjs` at all. The solo path also shows up as profile branches in `lib.mjs` (`parseIdentity`, `isLaneBot`,
`gateDecision`), `gate.mjs`, `post-review.mjs`, `start.mjs`, `queue.mjs`, `status.mjs`, `snapshot.mjs`,
`identity-check.mjs`, `handover.mjs` and `dashboard/app.js`. Every one of those is a place a bug can hide.

Two constraints matter. Lanes must still never launch lanes or run the queue (CLAUDE.md rule 6), and `start-guard.mjs`
enforces that with `shell-lex.mjs`. Adopters today have no way to create the App: `install.mjs` writes no `identity`,
`docs/USING.md` has no App steps, and `start.mjs` needs `LANES_APP_KEY_FILE` set in the owner's shell.

## Decision

1. **One profile.** `identity.profile` must be `"team"`. `parseIdentity` in `scripts/lanes/lib.mjs` is the single check.
   It returns an error for a missing `identity`, a missing profile, or any profile other than `"team"`. There is no
   solo branch anywhere after the removal.
2. **One refusal, one message, one place.** `start.mjs`, `queue.mjs` and `gate.mjs` each call `parseIdentity` first and
   stop on its error. The message is a constant exported from `lib.mjs`: `lanes needs the team identity profile (a
   GitHub App). Run: node scripts/lanes/app-setup.mjs`. It names the config path and the profile it found, if any. The
   gate prints it as its failure reason and fails closed, as it does for every other unreadable config. The status
   and dashboard readers do not refuse; they show the same line in place of data.
3. **What the removal covers.**
   - `/approve` (`.claude/commands/approve.md`) and `/approvals` (`.claude/commands/approvals.md`).
   - The grant, the owner-post machinery, and the WMI, runtime-program, depth and unparsed denials in
     `approve-guard.mjs`. These existed only to protect the owner post. The file is deleted along with its test and its
     two hook entries in `.claude/settings.json`.
   - The owner path of `post-review.mjs`. The reviewer path stays.
   - The gate's solo owner stage: `review/owner`, the owner carry (`carriedOwnerApproval`), the ADR 0015 exemption, and
     `owner-diff.mjs`.
   - The solo launch environment in `launchLane`, the solo `/approve` line in the queue digest, the solo copy line in
     `dashboard/app.js`, and the solo outputs of `status.mjs`, `snapshot.mjs`, `identity-check.mjs` and `handover.mjs`.
   - The tests of everything above.
4. **What stays.** `start-guard.mjs` and `shell-lex.mjs` stay. `start-guard.mjs` imports `isAutomatedInput`,
   `powershellAsBash` and `preToolUseOutput` from `approve-guard.mjs`; the implementing issue moves those three helpers
   into `shell-lex.mjs` or `start-guard.mjs`, whichever the diff finds smaller, with their tests, before deleting
   `approve-guard.mjs`.
5. **The App boundary replaces ADR 0004's accepted risk.** ADR 0004 accepted that a lane could forge the owner's
   approval because it acted as the owner. Under team the boundary is the App of ADR 0019. Lanes hold only an
   installation token with contents, pull_requests, issues and statuses write, and checks and metadata read, never
   workflows write (ADR 0023). They never hold the owner's token, so they cannot post a code-owner review as the owner.
   The code-owner ruleset is enforced by GitHub, not by text parsing in a hook. The residual risk is a stolen App
   private key, which ADR 0019 already covers (key file outside the repo).
6. **Release tags.** The rule stays in `start-guard.mjs` (`releaseTagCommand`); it never depended on
   `approve-guard.mjs`. Adopters may also add a GitHub tag ruleset restricting tag creation to the owner;
   `app-setup.mjs` prints the settings link and says so, and does not create it.
7. **Setup is one click, not zero.** A new `scripts/lanes/app-setup.mjs` uses GitHub's App manifest flow.
   - It serves a form on 127.0.0.1 that POSTs a manifest to `https://github.com/settings/apps/new` (or
     `/organizations/<org>/settings/apps/new` with `--org`). The manifest is `public:false`, has
     `hook_attributes {active:false}`, and carries the ADR 0019 permissions and nothing else.
   - The owner presses GitHub's single "Create GitHub App" button.
   - GitHub redirects to the local `redirect_url` with `?code=`. The script calls `POST /app-manifests/{code}/conversions`
     within the hour to get the App id, slug and private key.
   - The script saves the key to `~/.lanes/<slug>.pem` with owner-only permissions, never in the repo. It then sends the
     owner to `https://github.com/apps/<slug>/installations/new`, and the `setup_url` callback returns
     `?installation_id=`.
   - The script writes `identity {profile:"team", app:{id, installationId, botLogin:"<slug>[bot]"}}` into
     `lanes.config.json`. It makes no admin call.
   - With `LANES_APP_KEY_FILE` unset, `start.mjs` and the queue read the key from `~/.lanes/<slug>.pem`, the slug taken
     from `botLogin`, so the owner sets no environment variable.
   - The script needs nothing beyond Node and a browser: no new account, token or dependency.
8. **CODEOWNERS and the ruleset are not written by the script.** They are repository-admin and ruleset actions, and
   committing CODEOWNERS to a protected default branch needs a PR anyway. After creating the App the script runs a
   read-only check (the existing `identity-check.mjs`, extended): is there a CODEOWNERS file, does a code-owner ruleset
   exist, is the App installed on the repository. For anything missing it prints the exact GitHub settings link and the
   CODEOWNERS line to add, and the owner does those steps in GitHub's UI.
   *Amended 2026-10-02 by ADR 0029 part 3: `app-setup.mjs --workflows` makes admin calls for the
   `lanes-workflow-apply` environment only (its creation, its secret and its variable), after listing them and a `y/N`. CODEOWNERS and rulesets stay as above.*
9. **Sequencing, so nobody is locked out.** The setup script, its docs and the adopter manifest ship first. The refusal
   lands only after that. Removal of the gate owner stage and the approve machinery lands after the refusal. Amendments
   to other ADRs and to CLAUDE.md land last, so no text describes a state the code is not in.
10. **Migration.**
    - This repository is already team (App id 5140388): nothing to do, and the refusal passes.
    - An adopter on solo, or with no identity, runs `node scripts/lanes/app-setup.mjs` once, adds CODEOWNERS and the
      ruleset from the printed links, then continues.
    - `install.mjs` ships `app-setup.mjs` and stops shipping `approve-guard.mjs`. It still writes no `identity`; the
      refusal message is the prompt to run setup.
11. **Documents amended or superseded.** ADRs 0004 and 0015 become `superseded by 0025`. ADR 0002 gets a note that its
    owner approval is the GitHub code-owner review; ADR 0007 a note that lanes act as the App bot and its start-guard
    risk stands; ADR 0019 a note that team is the only profile and that `app-setup.mjs` replaces its manual setup. The
    history record is `docs/history/2026-10-01-retire-solo-profile.md`. CLAUDE.md rules 1, 6, 7 and 9 are amended.
12. **Issue sizing.** Whole-file deletions (`approve-guard.mjs`, `approve-guard.test.mjs`, `owner-diff.mjs`,
    `owner-diff.test.mjs`, `approve.md`, `approvals.md`) count as 0 changed lines against the 100 to 300 rule, because
    they are mechanical. Edits to surviving files and new files count in full.

## Decisions for the owner

Decided by the owner on 2026-10-01 in /plan-issues: retire solo, team is the only profile; remove `/approve`, the
approve-guard grant and owner post, the post-review owner path and the gate's solo owner stage, with their tests; keep
`start-guard.mjs` and `shell-lex.mjs`; refuse any config without profile `"team"` in start, the queue and the gate,
pointing to setup; make App setup as close to one click as GitHub allows; supersede ADRs 0004 and 0015; amend ADRs
0002, 0007, 0019 and CLAUDE.md. Also approved with this ADR: `app-setup.mjs` checks CODEOWNERS and the ruleset
read-only and prints links instead of writing them; the key file defaults to `~/.lanes/<slug>.pem`; CLAUDE.md rule 9
changes with rules 1, 6 and 7; `/approvals` is removed; whole-file deletions count as 0 changed lines.

## Consequences

- About 3,800 lines of guard, gate and test code go away, along with the largest class of parser bugs. The approval
  boundary is GitHub's own: App permissions and rulesets.
- Owners approve on github.com, not in a terminal. There is no offline or API-less approval; this is accepted.
- Adopters need a GitHub account that can create and install an App and add a code-owner ruleset. One human is enough:
  the bot opens the PRs and the owner, a code owner, approves them.
- One App per owner or organisation is enough; setup can be rerun for another repository and reuses the App.
- If `app-setup.mjs` fails mid-flow, the one-hour conversion code is lost and the flow restarts; the script says so.
  The key is written before the config, so a failed config write never leaves a config pointing at a missing key.
- Rollback is a git revert of the removal issues; the solo code is not kept behind a flag.
- PRs open when the gate change lands are re-gated by the next event on them; none depends on `review/owner`, since
  the repository already runs team.

## Governs

- lanes.config.json
- CLAUDE.md
- .claude/settings.json
- .claude/commands/approve.md
- .claude/commands/approvals.md
- scripts/lanes/app-setup.mjs
- scripts/lanes/lib.mjs
- scripts/lanes/gate.mjs
- scripts/lanes/approve-guard.mjs
- scripts/lanes/owner-diff.mjs
- scripts/lanes/post-review.mjs
- scripts/lanes/start.mjs
- scripts/lanes/start-guard.mjs
- scripts/lanes/shell-lex.mjs
- scripts/lanes/queue.mjs
- scripts/lanes/status.mjs
- scripts/lanes/snapshot.mjs
- scripts/lanes/identity-check.mjs
- scripts/lanes/handover.mjs
- scripts/lanes/install.mjs
- dashboard/app.js
- docs/USING.md
- docs/SECURITY.md
- docs/history/
