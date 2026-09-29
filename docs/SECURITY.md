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
| A lane or model **approving itself**, and **forged owner approvals** | `approve-guard.mjs` denies commands that would post `review/owner`; `post-review.mjs owner` refuses without an unused `/approve` grant for that exact PR; every recorded owner approval produces a PR comment, so the owner is notified | [0004](adr/0004-approve-guard-accepted-risk.md) |
| **Weakened gates**, and a PR changing its own rules | `lanes/gate` is a required status; it reads its path lists and configuration from the default branch, and verdicts and approvals count only for the PR's current head SHA (a new push invalidates them); the merge queue re-decides the gate from live inputs ([USING.md](USING.md)) | [0002](adr/0002-owner-only-paths.md) |
| **Unreviewed changes to the files that decide what is checked and who approves** | Owner paths (`paths.owner`): any PR touching them waits for the owner's `/approve`, at every tier. Only a fail-closed structural check may waive that, and only for additive `paths.owner` entries and new whole test blocks | [0002](adr/0002-owner-only-paths.md), [0003](adr/0003-owner-only-amendment.md), [0015](adr/0015-owner-input.md) |
| **Untrusted issue text steering a lane** | Invariant I4: an issue a lane filed carries `lane-filed` and never becomes `ready` until the owner removes the label; auto-release was considered and rejected | [0015](adr/0015-owner-input.md), [0008](adr/0008-module-map.md) |
| **Secrets or personal data in published files** | The `PII_PATTERNS` repository secret feeds a scan (the `security` check and the pre-push `preflight`) for personal data and absolute local paths; the dashboard publisher runs the same check on what it publishes ([ADR 0012](adr/0012-endgame-workflow.md), [0013](adr/0013-lane-metrics.md)); setup is in [USING.md](USING.md) | [0012](adr/0012-endgame-workflow.md), [0013](adr/0013-lane-metrics.md) |

Also in force: required reviews chosen by tier and diff (test-hunter, security-reviewer, ui-reviewer,
architecture-advisor, each a fresh session), a security reviewer that cites a vendored OWASP source
([0009](adr/0009-owasp-cheatsheets.md)), CodeQL, a ruleset with no bypass and no force push (both set up as described in [USING.md](USING.md)), and module boundaries
([0008](adr/0008-module-map.md)). Token budgets ([0016](adr/0016-release-readiness.md)) cap spend, not access.

## Accepted risks

These are decided, not overlooked:

- **One shared GitHub identity.** Lanes run as the owner's own GitHub account, with no second account, GitHub App or
  restricted token, so adopting lanes needs no extra setup. A determined lane could therefore forge the owner's
  approval by calling the GitHub API directly. The grant check and the visible approval comment shrink the window;
  they do not close it ([0004](adr/0004-approve-guard-accepted-risk.md)).
- **The guards parse command text on a best-effort basis.** The approve guard and the start guard defend against
  accident and casual misuse, not a determined lane: a shell can build a command in more ways than any parser
  covers. A newly found bypass is a `minor` follow-up; a regression is `critical`
  ([0004](adr/0004-approve-guard-accepted-risk.md), [0007](adr/0007-start-guard-accepted-risk.md)).
- **Playwright's on-demand download.** The dashboard visual check runs Playwright through `npx --yes` at a pinned
  version and downloads a browser on first use, on the owner's machine, never in CI
  ([0014](adr/0014-dashboard-running-overlaps-visual.md)).
- **Label staleness.** The `lane:running` label can outlive a lane that hangs; its bound is the reaper's give-up
  ([0014](adr/0014-dashboard-running-overlaps-visual.md), [0010](adr/0010-lane-reaper.md)).

## What lanes does not protect against

- A malicious or compromised **owner**, or anyone holding the owner's GitHub credentials or machine.
- A determined lane using the owner's credentials directly (see the shared identity above).
- **Vulnerabilities in the code lanes write.** Reviews and CodeQL reduce them; they do not certify them.
- Flaws in your own project's tests, dependencies or CI beyond what the gate and reviewers see.
- **Public exposure you choose.** The dashboard's GitHub Pages site is public even for a private repository; it is
  disabled for private repositories unless you turn it on ([USING.md](USING.md)).
- Personal data the `PII_PATTERNS` list does not name: the scan finds only what you list.
- Prompt injection into a session outside the gates above, or a model that ignores its instructions; the gates check
  results, not intent.
- Spend beyond the budget's granularity: a lane over its budget is reported, not killed.

See [USING.md](USING.md) for how the pieces are set up and run day to day.
