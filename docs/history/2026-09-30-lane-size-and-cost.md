# Lane cost and review findings by PR size, and the issue-size decision (2026-09-30)

Lanes splits work into Task issues, and each issue runs as one lane: a background Claude session that implements it,
runs two or three fresh-eyes reviewers, and opens a PR that the gate checks. Every lane pays a fixed cost before it
does anything useful. Planning so far split issues by module (ADRs 0008 and 0018): an issue whose files span two
modules had to be split, with a contract issue first. On 2026-09-30 that rule turned one coherent change of about 200
lines (letting the gate trust the lane App bot, ADR 0020) into four serial lanes, #525 to #528, and the owner asked
whether splitting by size would serve better, and why a 200-line ceiling. This note records the measurement that
answered it and the decision that followed.

## Method

- **Lanes measured:** the 76 lane PRs from #324 to #529 whose issue has a row in `.lanes/costs.jsonl`, the per-lane
  token record. They were launched between 2026-09-29 and 2026-09-30, which is all that record holds.
- **Size:** a PR's changed lines, additions plus deletions, tests included, since reviewers read the tests too.
- **Cost:** the lane session's total tokens from `costs.jsonl` (input, output and cache reads and writes), summed per
  issue. It includes the lane's own reviewer runs.
- **Findings:** the `<!-- lanes:verdict <reviewer> <sha> -->` comments the reviewers post on each PR, counting
  findings of severity important or critical. The owner's approval is not a reviewer and is not counted.

## Results

Cost by size:

| Changed lines | Lanes | Median tokens | Median tokens per changed line |
|---|---|---|---|
| 0-50 | 17 | 2.4M | 124k |
| 50-150 | 29 | 3.8M | 34k |
| 150-300 | 13 | 5.6M | 25k |
| 300-500 | 11 | 9.0M | 27k |
| 500-1000 | 6 | 17.1M | 20k |

Review findings by size (lanes with at least one verdict comment):

| Changed lines | Lanes | Reviewer runs per PR | Important or critical findings per PR | Per 100 changed lines |
|---|---|---|---|---|
| 0-50 | 17 | 2.9 | 0.1 | 0.25 |
| 50-150 | 23 | 3.1 | 0.2 | 0.22 |
| 150-300 | 12 | 3.8 | 0.5 | 0.22 |
| 300-500 | 11 | 3.0 | 0.6 | 0.18 |
| 500+ | 6 | 3.2 | 1.3 | 0.19 |

## What the numbers say

- **The floor matters more than the ceiling.** A lane under 50 changed lines costs four to five times more per line
  than one of 150 or more. The fixed cost of a lane (launch, reading context, reviewers, gate, merge) only spreads out
  past about 100 to 150 lines. 17 of the 76 lanes were under 50 lines.
- **Cost gives no ceiling.** Above about 150 lines, a lane costs roughly the same per line whatever its size.
- **Reviewers did not visibly degrade up to 500+ lines.** Important and critical findings stay near 0.2 per 100 changed
  lines in every bucket. The review literature's usual threshold, where defect detection drops, is about 400 lines.
- **Four serial lanes cost about twice one.** At these medians the #525 to #528 chain (one skip, two full, one quick
  lane) costs about 15M tokens and three merge waits; one lane doing the same change would be about 6 to 8M.

## Caveats

- **Small buckets.** The larger size buckets hold 6 to 13 lanes each, over two days of work on one repository.
- **Found, not missed.** The findings rate counts what reviewers reported; it cannot show what they missed on large
  diffs.
- **Failed review rounds are not recorded.** A lane fixes a failed review and re-runs it before posting, so only the
  final, passing verdict reaches the PR (#509 failed two rounds and shows three verdict comments, one per reviewer).
  The cost of a failed round is inside the lane's tokens, but how often bigger PRs fail review cannot be counted. That
  is the number that would settle the ceiling on evidence.

## Decision

The owner chose to split issues by size rather than by module, with:

- **A floor of about 100 changed lines.** Smaller related changes are merged into one issue.
- **A conservative ceiling of 300 changed lines**, below the literature's 400 and well inside the range where the
  findings rate held.
- **Guard and gate security changes kept near 200 lines**, since those fail review rounds most often and a failed
  round re-runs every reviewer on the whole diff. The most expensive review measured, 17.5M tokens on lane #477, was
  guard code.
- **Contracts are still split out when work outside the change consumes them**, and a small ADR may ship in the same
  PR as its implementation.

The rule itself changes ADRs 0008 and 0018, `/plan-issues` and `issue-contract.mjs`'s module check, and goes through
`/plan-issues`. The #526 to #528 chain stays as filed.

## What would revisit it

Recording failed review rounds per PR, then re-running this measurement over a longer window, would show whether PRs
between 200 and 300 lines fail review more often than smaller ones. If they do, the ceiling comes down; if they do
not, it could rise toward 400.
