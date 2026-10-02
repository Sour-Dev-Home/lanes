# 2026-10-01: Lanes retires its solo profile

Lanes began with two identity profiles. Under solo, lanes ran as the owner's own GitHub account and the owner approved
a PR by typing `/approve` in a terminal. Under team, lanes act as a GitHub App bot and the owner approves with a native
code-owner review on github.com. On 2026-10-01 the owner retired solo. Team is now the only profile. The decision is
[ADR 0025](../adr/0025-retire-solo-profile.md).

## The decision, in the owner's words

Decided in the owner session on 2026-10-01: solo "introduces many unneeded bugs and ideally I should be working from
the github page instead. I do not want to maintain it."

## Why

Solo tried to stop a lane from forging the owner's approval, but a lane ran as the owner, so the only defence was a
command parser. [ADR 0004](../adr/0004-approve-guard-accepted-risk.md) recorded that no amount of parsing was complete:
a direct `gh api` call can post a status without running the lanes script at all. Team replaces that with a boundary
GitHub enforces. A lane holds only an installation token of the App and never the owner's, so it cannot post a
code-owner review, and the ruleset requires one.

The solo path also left profile branches in nearly every script (the gate, the review poster, launch, the queue,
status, the snapshot, the identity check, the hand-over and the dashboard). Each was a place for a bug to hide.

## What was removed

Line counts are from the commits that did the removal, as git reports them.

| Change | Commit | Lines |
| --- | --- | --- |
| `/approve`, `/approvals` and `approve-guard.mjs` with its test and hook entries (the helpers `start-guard.mjs` needed moved into `shell-lex.mjs`) | `e8de882` (#654) | 3,546 deleted, 700 added (the moved helpers and their tests) |
| The gate's solo owner stage, `review/owner`, the owner carry and `owner-diff.mjs`, and the owner path of `post-review.mjs` | `771ab9b` (#614) | 1,616 deleted, 217 added |
| The solo branches in launch, the queue, status, the snapshot, the hand-over and the dashboard | `312a754` (#624) | 303 deleted, 197 added |
| A refusal for any config that is not team, in start, the queue and the gate | `1d3f1dd` (#613) | 170 deleted, 425 added |

The removal lanes (#613, #614, #624, #654) deleted about 5,600 lines and added about 1,500, most of the additions being
the refusal, the moved helpers and the tests that pin them. This record and ADRs 0004, 0015, 0002, 0007 and 0019,
CLAUDE.md and the two docs (#617) finish the change. ADR 0025 part 11 lists CLAUDE.md rule 1 among the amended rules,
but by the time of this record rule 1 held no approve-guard text, so it is unchanged; rules 6, 7 and 9 were amended.

## What stayed

- `start-guard.mjs` and `shell-lex.mjs`: no lane may launch lanes or run the queue ([ADR 0007](../adr/0007-start-guard-accepted-risk.md)).
  `/plan-issues` and `/start` remain the owner's.
- The reviewer path of `post-review.mjs`, and every reviewer, tier and gate rule other than the owner stage.
- Owner-only paths ([ADR 0002](../adr/0002-owner-only-paths.md)): a PR touching them waits for the owner. The wait is
  now the code-owner review, not `/approve`.
- The release-tag rule in `start-guard.mjs`.

## The setup that replaces solo

Solo needed no account, app or credential. Team needs one GitHub App, and that is the one required setup, made as
close to one click as GitHub allows:

1. Run `node scripts/lanes/app-setup.mjs`. It serves a local form that sends GitHub an App manifest
   (permissions from [ADR 0019](../adr/0019-team-identity-profile.md), no webhook, never public).
2. Press GitHub's "Create GitHub App" button, then install the App on the repository.
3. The script saves the private key to `~/.lanes/<slug>.pem`, outside the repository, and writes the App's id, the
   installation and the bot login into `lanes.config.json`. No environment variable is needed.
4. It then checks, read-only, for a CODEOWNERS file, a code-owner ruleset and the installation, and prints GitHub's
   settings link and the exact CODEOWNERS line for anything missing. The owner adds those in GitHub's UI.

A config that is not team is refused by start, the queue and the gate, with a message pointing at that command.

## Consequences accepted

- Approval happens on github.com. There is no offline or API-less approval.
- An adopter needs a GitHub account that can create and install an App and add a code-owner ruleset. One human is enough.
- Rollback is a git revert of the removal changes; the solo code is not kept behind a flag.
- A stolen App private key is the residual risk, covered by keeping the key outside the repository.
