# 0019: A team identity profile: lanes act as a GitHub App, the owner approves with a native review

Status: accepted

*Amended 2026-10-02 by ADR 0025 part 11: team is the only profile, and `node scripts/lanes/app-setup.mjs` replaces the manual setup below.*

## Context

ADRs 0004 and 0007 accept that lanes run as the owner's single GitHub identity, so a determined lane can post
`review/owner` with `gh api` or launch lanes, and the guards are only best-effort. The owner decided on 2026-09-27 to
keep that model, and reopened it on 2026-09-30. ADR 0018 (phase 4) planned `solo` and `team` identity profiles and
said `team` needs its own ADR because it changes the security posture. This is that ADR.

Facts in the code:

- `launchEnv` in `scripts/lanes/start.mjs` only adjusts PATH on Windows. `start.mjs` and `queue.mjs` launch
  `claude --bg` with the whole owner environment, so a lane can reach the owner's stored `gh` login and git credential
  helper. A `GH_TOKEN` variable beats gh's stored login for gh, but a lane can unset it.
- The owner-approval gate is in `scripts/lanes/lib.mjs`: `review/owner` success passes, and an owner-only path returns
  `waitOwner("owner-only path")` unless ADR 0015's additive-diff exemption applies. Approval is a `review/owner`
  status written by `post-review.mjs owner` against a `/approve` grant (ADR 0004).
- `lanes.config.json` lists `requiredChecks`: `verify`, `security`, `lanes/gate`. The merge queue is in use.

Assumptions about GitHub, which the trial checks and this design depends on:

- A PR's author cannot approve it, so a bot-authored PR needs a human approval.
- A GitHub App installation token is limited to the installed repositories and the granted permissions, and expires
  after about an hour. An App token, unlike `GITHUB_TOKEN`, triggers workflows.
- Branch protection or rulesets can require an approving review, a CODEOWNERS review and status checks.

The owner's constraints are: security review is never narrowed, owner-only commands stay owner-only, creating and
installing the App and changing branch protection or rulesets are owner actions, and solo stays the default.

## Decision

**1. Profile selection.** `lanes.config.json` gains an optional `identity` object, `{ "profile": "solo" | "team",
"app": { "id": <number>, "installationId": <number> } }`. A missing key, or `"solo"`, behaves exactly as today. The key
is additive and optional, so it is not a breaking contract change. The App and installation ids are not secrets and
may be committed. The key file path is per machine and is never in the repo: it comes from the environment variable
`LANES_APP_KEY_FILE`. Team fails closed: `team` with a missing or unreadable key, or a failed mint, stops the launch
with a message. It never falls back to the owner's credentials. `lanes.config.json` is an owner-only path (ADR 0002),
so changing the key needs `/approve`, or under team a native review.

**2. Minting.** A new `scripts/lanes/app-token.mjs` signs an RS256 JWT with `node:crypto` (`iss` = the App id, `iat`
60 seconds back, `exp` at most 10 minutes out), posts it to `POST /app/installations/{id}/access_tokens` with
`repositories` set to this repo only and `permissions` set to the minimum: `contents`, `pull_requests` and `issues`
write, `statuses` write (for `review/*`), `checks` read. It asks for no `workflows` or `administration` permission, so a
lane can't edit workflow files or protection (confirmed, and the hand-over of a workflow change described, in
[ADR 0023](0023-workflow-changes-owner-web-editor.md)). It adds no npm dependency.

**3. Where the key lives.** Outside the repo, in a per-user file (owner-only mode 0600, or an owner-only ACL on
Windows) named by `LANES_APP_KEY_FILE`. Only the launcher side reads it: `start.mjs`, `queue.mjs` and the refresher
in part 4, which run in the owner's own shell. A lane's environment never holds the key, its path or the variable.
`launchEnv` removes `LANES_APP_KEY_FILE`, `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN` and the git credential
settings before it passes the environment on.

**4. Lane credentials and refresh.** Under team the launcher gives each lane a private gh config directory
(`GH_CONFIG_DIR`, outside the repo and the worktree) whose `hosts.yml` holds the current installation token. It also
sets `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM` to an empty file, `credential.helper` (through `GIT_CONFIG_COUNT`
variables) to `gh auth git-credential`, and `GIT_TERMINAL_PROMPT=0`. gh re-reads `hosts.yml` on each call, so a lane
needs no restart. A small owner-side refresher, started by the launcher beside the lane, re-mints the token about
every 45 minutes and rewrites that file. It exits when the lane's session ends (the ADR 0010 reaper treats it as part
of the lane). The lane never holds the key, so a lane longer than an hour keeps working and cannot mint tokens.

**5. Credential isolation.** The options:

- A. Scrubbed environment and separate config directory (parts 3 and 4) only. It stops accidents and casual fallback.
  The owner's stored login is still readable by a determined process running as the same OS user.
- B. Lanes run as a separate OS user, container or sandbox that holds no owner credential. It is the only real
  separation and a per-machine setup cost.
- C. Accept the residual risk, as solo does today.

The trial uses A, and the owner's write-capable `gh` login stays in the OS keyring, not in any environment variable, so
a lane can't reach it without deliberately searching for it. Residual risk under A is stated, not hidden: a determined
lane as the owner's OS user could use the owner's login to post an approval. B is the recommended posture for any
adopter who relies on team for its security value. A is an improvement over solo (a casual or automatic fallback no
longer works and the lane's identity is distinct and auditable), not a full barrier. The security review posture is not
narrowed: reviewers still treat a regression as `critical`.

**6. Approval under team.** The owner (or the team) approves with GitHub's native PR review. Branch protection or a
ruleset requires an approving review, with a CODEOWNERS file listing the owner-only paths (`paths.owner`) so those
paths need a code owner's approval. Whether every PR needs an approval or only owner-path PRs is the owner's choice;
the recommendation is CODEOWNERS paths only, which keeps today's meaning of "owner-only". Protection and ruleset
settings are owner actions, and lanes never change them. ADR 0015's additive-diff exemption does not apply under
team, because branch protection can't see it: an owner-path diff always needs the native review.

**7. The gate under team.** `lanes/gate` stays a required check and keeps everything it does for criteria, reviewers
and blockers. The owner-approval stage does not run: `gate-decision` skips `waitOwner` and ignores any `review/owner`
status, and native review is enforced by branch protection, not by the gate. `post-review.mjs owner` refuses outright
under team, because nothing consumes it. The ADR 0004 part 3 comment on `review/owner` is not posted under team.

**8. Which guards and scripts retire.** Under team, retired: the `/approve` grant write and check, the
`post-review.mjs owner` path, and ADR 0004's grant and visibility parts. `/approve` answers "under the team profile,
approve the PR in GitHub". The text-parsing half of `approve-guard.mjs` is left in place: it is harmless, and it is
not edited while #463, #477 and #492 are open. Removing dead code is a later issue, sized from the trial. Stays for
both profiles: the start guard and the `start.mjs`/`queue.mjs` grants (ADR 0007, since launching lanes is owner-only
whichever identity acts), the reviewers and `post-review.mjs` for non-owner reviewers, the hooks, `NON_OWNER_REVIEWERS`
and the security review rules. Solo runs every guard unchanged.

**9. Amendments.**

- ADR 0002: under team, owner-only paths are enforced by CODEOWNERS and native review instead of `/approve`; the
  config list (`paths.owner`) still defines them.
- ADR 0004: all decisions apply to solo only; under team the residual risk is part 5.
- ADR 0007: unchanged; it applies to both profiles.
- ADR 0015: applies to solo only.
- CLAUDE.md rule 7 becomes: "No extra setup for adopters by default. The solo profile needs no account, app or
  credential; acting as the owner's account is an accepted risk there (ADRs 0004 and 0007). The team profile
  (ADR 0019) is opt-in and needs a GitHub App." Rule 6 is unchanged: `/plan-issues`, `/start` and `/approve` stay
  owner-only commands.

**10. Plan: the ADR and a trial only.** One lane on this repo runs on the App's token (profile `team`, part 5 option
A), and the owner approves its PR with a native review. The owner creates and installs the App, stores the key, and
sets CODEOWNERS and protection; lanes do not. A short note, written after, measures:

- whether `gh auth status`, `git credential fill` and the lane's environment, from inside the lane, show only the bot;
- whether a token refresh past 60 minutes works without a restart;
- whether the bot's own approval of its PR is refused by GitHub;
- any missing App permission that made a step fail;
- the approval round trips saved, and the time from "ready" to merge against a solo lane;
- how many lines and tests in `approve-guard.mjs`, `shell-lex.mjs`, `post-review.mjs` and the gate's owner stage would
  retire, and which can't, so the retirement issue is sized from data.

## Decisions for the owner

1. Isolation: the trial uses A (scrubbed environment, separate config directory, the owner's login in the keyring).
   Whether to use B (a separate OS user or sandbox) for the trial or later is the owner's call; B is recommended
   before anyone relies on team as a security barrier.
2. Native review scope: CODEOWNERS paths only (recommended) or every PR.
3. Whether to run the trial, and when. It needs the owner to create and install the App and change protection.
4. Where the key file lives on the owner's machine, and whether the refresher is a background process of the launcher
   (recommended) or something else.

## Consequences

- Solo adopters see no change and need nothing new. Team adopters take on a GitHub App, a key file and a protection
  setting.
- Under team, a lane's identity is distinct, scoped to this repo and expires in about an hour. A bot-authored PR can't
  be self-approved. Under option A, a determined lane as the same OS user can still reach the owner's stored login.
- Approval moves from custom code to a platform feature, in line with ADR 0018 phases 3 and 4. The cost is that the
  ADR 0015 exemption is lost under team, and CODEOWNERS and `paths.owner` must be kept in agreement by hand until
  phase 3 generates one from the other.
- Implementation issues should be filed after #463, #477, #492, #480, #493 and #494 merge, since they touch the same
  files (`approve-guard.mjs`, `lib.mjs`, `gate.mjs`, `queue.mjs`).
- The `identity` key is additive, so it is not `contract:breaking`; `lib.mjs` must accept it.

## Amendment (2026-10-01, #562)

Amended by ADR 0021 (this ADR is amended, not superseded):

- Part 7 is replaced by ADR 0021 parts 1 to 3: the gate reads a native code-owner approval on the head commit
  instead of skipping the owner stage.
- Parts 3 and 4 include `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME` and `GIT_COMMITTER_EMAIL`, set to
  the bot's name and its `users.noreply.github.com` address (#553). They are not secrets.

## Amendment (2026-10-02, #649)

Part 3 stands: the lanes App never gets `workflows: write`. A workflow change now reaches the owner as one click through
a second App behind an owner-approved environment ([0029](0029-one-click-workflow-apply.md)).

## Governs

- lanes.config.json
- scripts/lanes/lib.mjs
- scripts/lanes/gate-decision.mjs
- scripts/lanes/app-token.mjs
- scripts/lanes/app-token.test.mjs
- scripts/lanes/approve-guard.mjs
- scripts/lanes/post-review.mjs
- scripts/lanes/start.mjs
- scripts/lanes/queue.mjs
- .github/workflows/lanes-gate.yml
- docs/SECURITY.md
- CLAUDE.md
