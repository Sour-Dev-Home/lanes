# Team identity trial: what the lane measured (ADR 0019 part 10)

Written by the lane for issue #500 while it ran under `identity.profile: "team"` (App `sour-dev-lanes[bot]`, ADR 0020).
It records what the lane could observe from the inside. What only the owner can observe (the native review and the
merge) is marked **not yet measured** and is for the owner to add after the merge. Nothing here is estimated: a figure
is either read from the repository or from the lane's own session, or it is marked as missing.

## Result in one table

| Question (ADR 0019 part 10) | Result |
| --- | --- |
| Do `gh auth status`, `git credential fill` and the environment show only the bot? | `gh auth status`: yes. Environment: yes. `git credential fill`: **not run, the session's permission classifier refused it** (see below). |
| Does a token refresh past 60 minutes work without a restart? | **Not measured**: the lane finished well inside the first token's lifetime. |
| Does GitHub refuse the bot's own approval of its PR? | **Not measured**: the lane did not try to approve its own PR (a native review on the owner's repository is outward-facing and not lane work). |
| Any missing App permission that made a step fail? | None seen up to the PR being opened. The steps after (gate, auto-merge) are in "Not yet measured". |
| Approval round trips and ready-to-merge time against a solo lane | **Not yet measured**: needs the owner's review time and the merge time. |
| Lines and tests that would retire | Sized below from line counts. Nothing retires while the `solo` profile stays supported. |

## What the lane saw from inside (step 0 of `/lane`)

- `gh auth status` named one account on `github.com`, with its config file in a per-lane temporary directory
  (`lanes-gh-500-<random>`), active, git protocol `https`, and an installation token (the `ghs_` prefix, not the
  owner's keyring login). It showed no other account.
- `git remote get-url --push origin` returned the `https://github.com/...` URL, not the SSH remote that trial run 1 used
  (#540).
- The lane's environment carried: `GH_CONFIG_DIR` pointing at that per-lane directory; the four token variables `gh`
  and tools read (`GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN`) and
  `GITHUB_PERSONAL_ACCESS_TOKEN`, each set (values not recorded here); the commit identity (`GIT_AUTHOR_*` and
  `GIT_COMMITTER_*`) as the bot's name and its `users.noreply.github.com` address; `GIT_CONFIG_GLOBAL` and
  `GIT_CONFIG_SYSTEM` pointing at an empty file; `GIT_TERMINAL_PROMPT=0`; `GIT_SSH_COMMAND` replaced by a command that
  prints "ssh is disabled for a team lane" and exits 1; and four `GIT_CONFIG_KEY_n/VALUE_n` pairs that clear the
  credential helper, set it to `gh auth git-credential`, and rewrite `git@github.com:` and `ssh://git@github.com/` to
  `https://github.com/`.
- `LANES_APP_KEY_FILE` was present in the environment **with an empty value**, so the App's key path was not exposed to
  the lane. That is the intended result of ADR 0019 part 3; the empty variable is only noise.
- No `mcp__*` tool was in the tool list or the deferred-tool list (#544), so no MCP server could act as the owner.
- The lane's own commits and the first push are the check that the bot, not the owner, is the author; the PR and the
  statuses carry that evidence (PR body and the `lanes/gate` status), so this note does not repeat it.

### Findings

1. **`git credential fill` was refused by the permission classifier** as "Credential Materialization" when a lane tried
   to run it to see which identity git would use. The command prints the token on stdout, so the refusal is reasonable,
   but it means the ADR's "show only the bot" check cannot be done that way from inside a lane. The configuration
   evidence above (empty credential helper, then `gh auth git-credential`, with the `gh` config directory and token
   belonging to the bot) shows the same thing without printing a token. The owner should either run
   `git credential fill` themselves in a lane's environment, or accept the configuration evidence and reword
   ADR 0019 part 10.
2. **The classifier refused two further plain commands** in the same session, both read-only: one listing the
   repository's rulesets and the `credential.helper` configuration in one call, and one that searched `post-review.mjs`
   for the owner-grant function names and printed repository dates. Each was reported as credential exploration. They
   asked for no secret, so these look like false positives on the words "credential", "grant" or "owner" and should be
   reproduced and filed as a Task issue (CLAUDE.md rule 3). The lane did not work around them.
3. **A stale local branch named `issue-500-team-trial-note` already existed** when the lane tried to rename its
   worktree branch. It pointed at an old `main` commit, held no commits of its own and had no PR, so the lane deleted
   it with `git branch -d` (which refuses unmerged work) and renamed. Something from an earlier launch left it behind;
   the cleanup of a lane that did not reach a PR should remove its branch.

## Not yet measured (the owner adds these after the merge)

- The token refresh past 60 minutes, and whether it needed a restart. The lane started and finished inside one token's
  life.
- Whether GitHub refuses a review by the bot on its own PR. Under the `code owners (team trial)` ruleset the PR is
  authored by the bot, so the owner's native review counts as the most recent reviewable push's approval, which is the
  case trial run 1 could not reach (its PR was authored by the owner).
- Approval round trips: under `solo` the owner types `/approve <N>` and the lane posts `review/owner`, so one owner
  action and one lane action. Under `team` the owner's single native review replaces both. Record how many rounds this
  PR needed.
- Ready-to-merge time against a solo lane: the time from `lanes/gate` reporting the reviewers done to the merge, here
  and for a comparable `tier:skip` documentation PR on the `solo` profile.
- Any App permission that failed after the PR was opened (auto-merge, the gate status, comments).

## What would retire

Counted from the files on `main` at this commit (lines of the file, and the `test(`/`it(` cases in its test file). These are
upper bounds on the files, not on the lines that would actually go: none of it was deleted to prove the number.

| File | Lines | Test file: lines, cases | Owner-approval part |
| --- | --- | --- | --- |
| `scripts/lanes/approve-guard.mjs` | 1217 | `approve-guard.test.mjs`: 1950, 157 | The `/approve <N>` grant machinery (parsing the prompt, grant files, TTL, freshness) and the pre-tool-use refusals that name `post-review.mjs owner`. |
| `scripts/lanes/shell-lex.mjs` | 1472 | `shell-lex.test.mjs`: 902, 70 | Its job is to read a shell command well enough to find a `post-review.mjs owner` call. It exists only for that guard. |
| `scripts/lanes/post-review.mjs` | 305 | `post-review.test.mjs`: 743, 82 | `requireOwnerGrant` and the grant claim (about lines 199 to 260), and the `owner` reviewer path. The reviewer-verdict path stays. |
| `scripts/lanes/gate.mjs` | 478 | `gate.test.mjs`: 1398, 127, and `gate-decision.test.mjs`: 675, 93 | The owner stage: the trusted `review/owner` status, `carriedOwnerApproval`, `noteOwnerApproval`. `ownerDiffFor` and `owner-diff.mjs` (ADR 0015) decide whether a PR needs the owner at all and are not part of this. |

What can **not** retire, whichever way the trial goes:

- The `solo` profile. ADR 0019 part 9 keeps it, so every part above stays until the owner drops `solo` for the
  repository; with both profiles supported, the saving is zero lines and the team profile adds to the code.
- In `approve-guard.mjs`, the release-tag refusal (`TAG_REASON`, ADR 0017) is unrelated to approval and stays.
- In `gate.mjs`, the reviewer stages and the owner-diff classification stay, because the team profile still needs the
  reviewers' verdicts and the owner-only path list.
- `/approve`, `/plan-issues` and `/start` stay owner-only commands (CLAUDE.md rule 6); under `team` the native review
  replaces only the status that `/approve` posts.

If `solo` were dropped, the three scripts' owner-approval parts above are the candidates, roughly the whole of
`shell-lex.mjs` and `approve-guard.mjs` minus the tag guard, with their test files, plus the named functions in
`post-review.mjs` and the gate's owner stage. The retirement issue should be sized after reading those files for the
shared helpers, since this note did not.

## Privacy check

This note holds no personal data, no absolute local path, no key, no token and no App secret. Token and key values are
described by variable name only.
