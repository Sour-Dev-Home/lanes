# Security

This page restates the threat model that the accepted ADRs already decided. It decides nothing new: when it and an ADR
disagree, the ADR wins ([ADR 0016](adr/0016-release-readiness.md) says why this page exists).

## Reporting a vulnerability

Report it privately through GitHub private vulnerability reporting: open the repository's **Security** tab and choose
**Report a vulnerability**. Please do not open a public issue or PR for it, and do not include real secrets or personal
data in the report. If the tab shows no such button, the repository owner has not turned the feature on; ask for a
private channel in a public issue that contains no details.

## What lanes protects against

| Threat | How | ADRs |
| --- | --- | --- |
| A lane or model **launching lanes** (itself or others) | `start-guard.mjs` allows `start.mjs` only in the turn the owner typed a matching `/start`; `start.mjs` itself refuses without that single-use, short-lived grant; `queue.mjs` exits when it runs inside Claude | [0005](adr/0005-owner-run-lane-queue.md), [0007](adr/0007-start-guard-accepted-risk.md) |
| A lane or model **approving itself**, and **forged owner approvals** | Lanes act as the App bot and hold only an installation token, never the owner's; the approval is a GitHub code-owner review the bot cannot post, enforced by the ruleset | [0025](adr/0025-retire-solo-profile.md), [0019](adr/0019-team-identity-profile.md), [0021](adr/0021-team-native-code-owner-review.md) |
| **Weakened gates**, and a PR changing its own rules | `lanes/gate` is a required status; it reads its path lists and configuration from the default branch, and verdicts and approvals count only for the PR's current head SHA (a new push invalidates them); the merge queue re-decides the gate from live inputs ([USING.md](USING.md)) | [0002](adr/0002-owner-only-paths.md) |
| **Unreviewed changes to the files that decide what is checked and who approves** | Owner paths (`paths.owner`): any PR touching them waits for the owner's code-owner review in GitHub, at every tier | [0002](adr/0002-owner-only-paths.md), [0003](adr/0003-owner-only-amendment.md) |
| **Untrusted issue text steering a lane** | Invariant I4: an issue a lane filed carries `lane-filed` and never becomes `ready` until the owner removes the label; auto-release was considered and rejected | [0015](adr/0015-owner-input.md), [0008](adr/0008-module-map.md) |
| **Secrets or personal data in published files** | The `PII_PATTERNS` repository secret feeds a scan (the `security` check and the pre-push `preflight`) for personal data and absolute local paths; the dashboard publisher runs the same check on what it publishes ([ADR 0012](adr/0012-endgame-workflow.md), [0013](adr/0013-lane-metrics.md)); setup is in [USING.md](USING.md) | [0012](adr/0012-endgame-workflow.md), [0013](adr/0013-lane-metrics.md) |

**Who counts as a trusted author.** Three cases ([0020](adr/0020-gate-trusts-the-lane-app-bot.md),
[0022](adr/0022-release-lane-filed-bot-issues.md)): a human with write permission on
the repository, or the configured App bot (`identity.app.botLogin`, matched exactly). The bot counts for reviewer
output alone: a `review/<reviewer>` status or a verdict comment for a configured reviewer, never an approval. Any
other bot, such as `github-actions[bot]`, counts for nothing. The third case is a
lane-bot issue released by a write-access actor (not the bot) removing `lane-filed`: the issue check and the gate trust
it as an author until someone without write access edits its body.

**Approving** ([0021](adr/0021-team-native-code-owner-review.md)). The owner approves the PR in GitHub. The gate counts a review only if it is `APPROVED` on the PR's
current head commit, by a user listed in the default branch's `.github/CODEOWNERS`, and not by the PR author or the lane
bot; a read failure or a CODEOWNERS file with no user entries means pending. Owner work under team goes through lanes,
so the bot is the author and the owner is the approver.

Also in force: required reviews chosen by tier and diff (test-hunter, security-reviewer, ui-reviewer,
architecture-advisor, each a fresh session), a security reviewer that cites a vendored OWASP source
([0009](adr/0009-owasp-cheatsheets.md)), CodeQL, a ruleset with no bypass and no force push (both set up as described in [USING.md](USING.md)), and module boundaries
([0008](adr/0008-module-map.md)). Token budgets ([0016](adr/0016-release-readiness.md)) cap spend, not access.

## Accepted risks

These are decided, not overlooked:

- **One App, one key.** Lanes act as the GitHub App bot ([0019](adr/0019-team-identity-profile.md)) and hold only an
  installation token, never the owner's, so they cannot post the owner's review; GitHub enforces the code-owner
  ruleset. The residual risk is a stolen App private key, which stays in `~/.lanes/` outside the repository
  ([0025](adr/0025-retire-solo-profile.md)).
- **The start guard parses command text on a best-effort basis.** It defends against accident and casual misuse, not
  a determined lane: a shell can build a command in more ways than any parser covers. A newly found bypass is a
  `minor` follow-up; a regression is `critical` ([0007](adr/0007-start-guard-accepted-risk.md)).
- **The team App never gets `workflows: write`; the owner's read is the control.** A workflow file pushed to a branch
  of this repository runs on `push` before any review, and it can raise its own `GITHUB_TOKEN` with a `permissions:`
  block (for example `statuses: write`) to post `lanes/gate=success` as `github-actions[bot]`, the same creator the real
  gate posts as. The forged-gate evidence is in [0023](adr/0023-workflow-changes-owner-web-editor.md). So a team lane
  cannot push a workflow file, and hands it over in a PR comment for the owner to read and commit in the web editor.
  The owner reading the content before clicking Commit changes is the control: committing it runs its push-triggered
  workflows. The comment is posted by one fixed command (`node scripts/lanes/handover.mjs`), never free text.
- **One-click apply: a second App behind an owner-approved environment ([0029](adr/0029-one-click-workflow-apply.md)).**
  The lanes App is unchanged. A second App, `lanes-workflows`, holds `contents` and `workflows` write, and its key is
  the secret `LANES_WORKFLOWS_KEY` of the `lanes-workflow-apply` environment. Why a lane or a branch workflow cannot
  reach it: the environment's deployment branch policy is `main` only, so only a job on `main` reads the secret; the
  `issue_comment` trigger always runs the default branch's copy of the workflow, which checks out the default branch
  and never the PR head; the `apply` job waits for the owner's **Approve and deploy**; and the `filter` job, which
  holds no secret, starts that wait only for a lane-bot comment that starts with the hand-over marker. Before any
  write `workflow-apply.mjs` checks that the comment is unedited and the newest hand-over, the PR is open and in this
  repository, and each file's hash equals the one the reviewers recorded for the same head. The commit is a
  non-forced ref update, so a moved branch fails it. Residual risk, unchanged from ADR 0023: if the owner approves
  reviewed content that is itself malicious, its push-triggered workflows run once. The owner must never add
  `lanes-workflows` to a ruleset bypass list, to CODEOWNERS or to another repository.
- **Playwright's on-demand download.** The dashboard visual check runs Playwright through `npx --yes` at a pinned
  version and downloads a browser on first use, on the owner's machine, never in CI
  ([0014](adr/0014-dashboard-running-overlaps-visual.md)).
- **Label staleness.** The `lane:running` label can outlive a lane that hangs; its bound is the reaper's give-up
  ([0014](adr/0014-dashboard-running-overlaps-visual.md), [0010](adr/0010-lane-reaper.md)).

## What lanes does not protect against

- A malicious or compromised **owner**, or anyone holding the owner's GitHub credentials or machine.
- A lane that obtains the owner's credentials some other way, or the App's private key (kept outside the repository).
- **Vulnerabilities in the code lanes write.** Reviews and CodeQL reduce them; they do not certify them.
- Flaws in your own project's tests, dependencies or CI beyond what the gate and reviewers see.
- **Public exposure you choose.** The dashboard's GitHub Pages site is public even for a private repository; it is
  disabled for private repositories unless you turn it on ([USING.md](USING.md)).
- Personal data the `PII_PATTERNS` list does not name: the scan finds only what you list.
- Prompt injection into a session outside the gates above, or a model that ignores its instructions; the gates check
  results, not intent.
- Spend beyond the budget's granularity: a lane over its budget is reported, not killed.

See [USING.md](USING.md) for how the pieces are set up and run day to day.
