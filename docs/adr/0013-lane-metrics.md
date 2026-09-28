# 0013: Lane and portfolio metrics: local costs stay local, lane-metrics.mjs composes the rest

Status: accepted

## Context

Owner idea (2026-09-28): per-merged-lane-PR metrics across token use by tier and model, reviewer yield, rework,
scope drift, owner time, parallelism and friction, aggregates only, with dated before/after comparisons for #259
(all tiers on Sonnet), #241 (architecture-advisor narrowing) and the required Windows CI job, as medians and counts,
never causal claims.

Grounded in the code as it stands:

- `scripts/lanes/delivery-metrics.mjs` and `scripts/lanes/review-metrics.mjs` live in the `metrics` module
  (`lanes.config.json`), are aggregates-only at `schemaVersion` 1, and already cover throughput, lead time, PR size,
  merge-queue bounces and change failure (delivery) and reviewer runs, findings, minutes and tokens per
  `contracts/review-metrics.schema.json` (review). `review-metrics.mjs` already imports `percentile` from
  `delivery-metrics.mjs`: the module's composition pattern.
- `delivery-metrics.mjs` fetches every merged PR with one paginated GraphQL query (`PR_QUERY`, `fetchMergedPrs`),
  not a REST call per PR.
- Open issue #243 adds `scripts/lanes/lane-cost.mjs` and has `cleanup.mjs` append one line per removed lane to the
  git-ignored `.lanes/costs.jsonl` (issue, tier, session id, model, tokens, launch and removal time), read from the
  lane's local Claude Code transcript. CI cannot read it.
- Open issue #278 adds `contracts/snapshot.schema.json`, `scripts/lanes/snapshot.mjs` and
  `.github/workflows/dashboard.yml` per ADR 0012: one Pages artifact deploy, default-branch checkout only, a
  PII/local-path check before `upload-pages-artifact`, no commits from a workflow.
- A Pages site has one live deployment: every deploy replaces the whole site. A second workflow deploying Pages
  would erase the dashboard, and the dashboard's deploy would erase it.

Triggers: new persistent state (`docs/metrics/<date>.json`, committed by the owner by hand), a new contract
(`contracts/lane-metrics.schema.json`), a new edge in the `metrics` module. No new dependency, account or token.

## Decision

1. **Local stays local, by construction.** `lane-metrics.mjs`'s default and `--markdown` output read
   `.lanes/costs.jsonl` when present and show tokens by tier and model, relaunches and lane-hours. `--public` output
   omits every field sourced from a local file: the schema marks them optional, and they are absent, never zeroed or
   scrubbed. Tokens are reported as tokens per model; no price table (prices change and differ by plan).
2. **One more script, not an extension.** `scripts/lanes/lane-metrics.mjs` is a third script in `metrics`, importing
   `fetchMergedPrs` from `delivery-metrics.mjs` and the verdict summary from `review-metrics.mjs`. It computes only
   the axes neither owns: rework (gate failures by stage, pushes after the PR opened), scope drift, owner wait time
   and interventions, PRs open at once, CI friction (reruns, stuck merge-queue minutes). It does not recompute
   throughput, lead time, size or reviewer yield; its report embeds theirs.
3. **Richer per-PR fields ride the existing query.** `fetchMergedPrs` gains an opt-in richer node shape (changed
   files, commits with dates, status contexts with times, the closing issue's Scope and body edit times, check-run
   attempts) on the same paginated GraphQL call; no per-PR REST loop.
4. **Scope drift reuses `parseIssueForm` (`lib.mjs`) and `issuePaths` (`paths.mjs`)**; no second Scope parser. The
   `metrics` module's `imports` in `lanes.config.json` gains `queue` (no cycle: `queue` does not import `metrics`).
5. **`contracts/lane-metrics.schema.json`**, styled like `review-metrics.schema.json`: medians, counts and rates
   only. `--split <date>` output is two aggregate blocks (before, after), never a per-PR list, in the public shape.
   `scripts/lanes/contracts.test.mjs` cross-checks it.
6. **One Pages site, a daily metrics cadence.** `.github/workflows/dashboard.yml` (ADR 0012) also builds
   `lane-metrics.json --public`, at most once per UTC day: an `actions/cache` entry keyed by the date holds it between
   the 5-minute runs. The file goes through the same PII/local-path check and into the same Pages artifact. No second
   Pages workflow. `dashboard/` gains a metrics panel that reads it, `textContent` only.
7. **Portfolio exports are a manual, checked step.** `node scripts/lanes/lane-metrics.mjs --public --split <date>
   --out docs/metrics/<date>.json` runs the same PII/local-path check before writing; the owner commits it by hand.
   No workflow writes to `docs/metrics/`.

## Decisions for the owner

1. Tokens, relaunches and lane-hours never appear in the public JSON or on the dashboard; only your local output shows
   them. Tokens are shown per model, with no dollar prices.
2. `lane-metrics.mjs` is a third script in the `metrics` module, reusing `delivery-metrics.mjs` and
   `review-metrics.mjs` rather than recomputing their axes.
3. The richer per-PR fields extend `delivery-metrics.mjs`'s existing paginated query.
4. The public metrics are rebuilt at most once a day inside `dashboard.yml`, in the same Pages site as the dashboard.
5. `docs/metrics/` exports are committed by your own hand only, never by a workflow.

## Consequences

- The added GitHub API cost is extra fields on one existing paginated call, run at most daily in CI.
- The public page never carries a number CI could not compute itself, so ADR 0012's PII check needs no new rule.
- Before/after comparisons for #259, #241 and the Windows job are one `--split` flag.
- Local figures and portfolio exports depend on the owner running a command; nothing regresses if they never do.
- `snapshot.mjs` (live, `queue`) and `lane-metrics.mjs` (daily, `metrics`) differ in cadence and module on purpose.

## Governs

- contracts/lane-metrics.schema.json
- scripts/lanes/lane-metrics.mjs
- scripts/lanes/lane-metrics.test.mjs
- scripts/lanes/delivery-metrics.mjs
- scripts/lanes/delivery-metrics.test.mjs
- scripts/lanes/contracts.test.mjs
- .github/workflows/dashboard.yml
- scripts/dashboard-workflow.test.mjs
- dashboard/
- scripts/dashboard.test.mjs
- docs/metrics/
- lanes.config.json
