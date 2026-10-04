# lanes

A workflow for building software with parallel Claude Code sessions ("lanes"): one fresh
session per GitHub issue, contracts at every handoff, required checks as the only
gatekeeper, and unattended nights for low-risk work. The design is in [docs/specs/](docs/specs/).

- [docs/USING.md](docs/USING.md): the daily loop, pitfalls, and adopting lanes in another repository.
- [docs/SECURITY.md](docs/SECURITY.md): what lanes protects against, accepted risks, and how to report a vulnerability.

## Prerequisites

- [Claude Code](https://claude.com/claude-code), signed in.
- Node.js 22 or newer and git. Lanes has no npm dependencies.
- The GitHub CLI (`gh`), signed in as the repository owner.
- A GitHub repository owned by an **organisation** (the merge queue needs one), public, or private with GitHub
  Advanced Security. Your own `verify` workflow's job must be named `verify`.
- Permission to set repository secrets and rulesets.

## Quick start: zero to a first merged lane

1. **Get lanes.** Clone this repository next to your project.
2. **Install it into your project**, from the lanes clone:
   `node scripts/lanes/install.mjs <path-to-your-repo>`. Then edit your project's `lanes.config.json` paths for its
   layout, add `setup` and `preflight` npm scripts and a `verify` workflow, and push to `main`. (For a brand-new
   project, `node scripts/lanes/new-project.mjs <name>` does all of this.)
3. **Set the secret and the rules**, as the owner:
   `gh secret set PII_PATTERNS -R <owner/repo>` (one fixed string per line: your name, email, local paths), then
   `node scripts/lanes/setup-repo.mjs <owner/repo>` to create the labels and the `main` ruleset.
4. **Plan.** In a Claude Code session in your project, run `/plan-issues "<your idea in 1-4 sentences>"`. Review the
   draft; approving it creates the Task issues.
5. **Start.** Keep the queue running (step 7): it launches a lane for every `ready` issue, and each lane opens a PR
   with auto-merge on. To hold an issue back, remove its `ready` label or press Pause.
6. **Approve.** A PR that touches an owner path waits for your code-owner review in GitHub; the review notification
   and the lanes-health issue tell you it is waiting. Other PRs merge on their own once the gate passes.
7. **The queue.** The queue is the only launcher. From your own terminal (never from inside Claude),
   `node scripts/lanes/queue.mjs` works every ready issue. Install copies the queue into your project, so run it from
   your own repository's folder (not from the lanes clone), where it works on that repository; `/night` does low-risk work on a schedule. `/status` shows what waits on you.

The full detail, including the private-repository and dashboard notes, is in [docs/USING.md](docs/USING.md).

## Upgrading

From a newer lanes checkout, in your own terminal (it refuses to run inside Claude):
`node scripts/lanes/upgrade.mjs <path-to-your-repo>` prints a plan and writes nothing; run it again with `--apply` to
write. Files you edited are refused and listed, never overwritten, and `lanes.config.json` only gains new keys. Changes
per release are in [CHANGELOG.md](CHANGELOG.md).

## Budget settings

`lanes.config.json` has `budget: { perNightTokens, perLaneTokens }` (defaults 100 000 000 and 15 000 000). The queue
and `/night` stop launching once spend over a rolling 24 hours passes `perNightTokens`; a lane over `perLaneTokens` is
reported, not killed. Spend is read from local files and sent nowhere. Tune both for your repository.

## Honest limits

- It needs Claude Code and GitHub's merge queue; there is no other agent or host.
- It suits well-scoped issues (a goal, checkable criteria, named files) in small to medium repositories. Vague or
  sprawling work stalls or produces large, hard-to-review PRs.
- Token use is real: parallel lanes plus fresh reviewers cost more than a single session.
- Some actions stay with you by design: approvals, launching lanes, upgrades. It is not hands-off.
- The guards are best-effort; read [docs/SECURITY.md](docs/SECURITY.md) before adopting.
- **Windows:** git does not track the executable bit, so run `git update-index --chmod=+x .githooks/pre-push`
  after cloning. Scripts are Node, and the docs use Git Bash for shell examples.
- **macOS and Linux:** the scripts are plain Node and POSIX shell; no extra steps are known, but the primary
  development machine is Windows, so report differences.
