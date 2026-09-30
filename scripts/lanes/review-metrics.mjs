#!/usr/bin/env node
// Reviewer metrics: per tier and reviewer, how many runs there were and what they cost and found, read from the
// `<!-- lanes:verdict <reviewer> -->` comments on PRs merged in the window. AGGREGATES ONLY, as in delivery-metrics.mjs:
// no login, PR title, SHA, file or finding text ever leaves the normalisers below.
//
//   node scripts/lanes/review-metrics.mjs                    # last 7 days, markdown on stdout
//   node scripts/lanes/review-metrics.mjs --days 30 --json   # JSON on stdout
//
// JSON shape (schemaVersion 1):
//   { schemaVersion, generatedAt, window: { days, from, to }, runs, runsWithoutMetrics, unreadable,
//     tiers: [{ tier, runs, runsWithMetrics, runsWithoutMetrics, realFindings, minorFindings, runsWithNoRealFinding,
//               noRealFindingShare, totalTokens, tokensPerRealFinding,
//               reviewers: [{ reviewer, runs, runsWithMetrics, runsWithoutMetrics, minutes: { median, total },
//                             tokens: { median, total }, realFindings, minorFindings, runsWithNoRealFinding }] }] }
//
// Definitions:
// - Every posted verdict is one run (a second review round posts a second verdict).
// - A run's tier is its `metrics.tier` (contracts/review-metrics.schema.json); without metrics, the tier label of the
//   issue the PR closes; else "unknown".
// - Real findings are critical plus important; minor findings are counted apart.
// - Runs without `metrics` count toward runs and findings, not toward minutes or tokens. tokensPerRealFinding divides
//   the tier's tokens by the real findings of the runs that reported metrics, so both sides cover the same runs.
// - A comment that opens with the verdict marker but does not parse is counted as unreadable, never fatal.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { percentile } from "./delivery-metrics.mjs";
import { parseGraphql } from "./graphql-lib.mjs";
import { loadConfig, parseVerdictComment, REVIEWERS, reviewerNames } from "./lib.mjs";

export const SCHEMA_VERSION = 1;
const DAY_MS = 24 * 3_600_000;
const TIERS = ["full", "quick", "skip"];
const TIER_ORDER = [...TIERS, "unknown"];
const REAL = new Set(["critical", "important"]);
const MARKER_RE = /^<!-- lanes:verdict /;

const round = (value, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;

function validMetrics(m) {
  return (
    m !== null && typeof m === "object" && !Array.isArray(m) && TIERS.includes(m.tier) &&
    typeof m.minutes === "number" && Number.isFinite(m.minutes) && m.minutes >= 0 && Number.isInteger(m.tokens) && m.tokens >= 0
  );
}

/**
 * One comment body -> a run, `{ unreadable: true }` for a verdict comment that does not parse, or null for any other
 * comment. Malformed findings or metrics make the verdict unreadable: post-review.mjs would have refused it.
 * @param {string} body
 * @param {string | null} prTier - the tier label of the issue the PR closes
 * @returns {{ tier: string, reviewer: string, verdict: object } | { unreadable: true } | null}
 */
export function readVerdict(body, prTier, names = REVIEWERS) {
  if (typeof body !== "string" || !MARKER_RE.test(body)) return null;
  const parsed = parseVerdictComment(body, names);
  if (parsed === null) return { unreadable: true };
  const { reviewer, verdict } = parsed;
  if (!Array.isArray(verdict.findings) || verdict.findings.some((f) => f === null || typeof f !== "object")) return { unreadable: true };
  if (verdict.metrics !== undefined && !validMetrics(verdict.metrics)) return { unreadable: true };
  return { tier: verdict.metrics?.tier ?? prTier ?? "unknown", reviewer, verdict };
}

/**
 * The ONLY place a GraphQL pull request node is read: the merge date, the closed issue's tier and the comment bodies.
 * Bodies go no further than readVerdict, which keeps only counts and numbers.
 * @returns {{ mergedAt: string, tier: string | null, bodies: string[] } | undefined}
 */
export function normalizePr(node) {
  if (!node || typeof node.mergedAt !== "string") return undefined;
  const labels = (node.closingIssuesReferences?.nodes ?? []).flatMap((issue) => issue?.labels?.nodes ?? []).map((label) => label?.name);
  const tier = labels.map((name) => /^tier:(full|quick|skip)$/.exec(name ?? "")?.[1]).find((t) => t !== undefined) ?? null;
  const bodies = (node.comments?.nodes ?? []).map((c) => c?.body).filter((body) => typeof body === "string");
  return { mergedAt: node.mergedAt, tier, bodies };
}

/** Every run and unreadable marker on the PRs merged in the window. */
export function collectVerdicts(prs, { now, days, names = REVIEWERS }) {
  const from = new Date(now.getTime() - days * DAY_MS);
  return prs
    .filter((pr) => pr !== undefined && new Date(pr.mergedAt) >= from && new Date(pr.mergedAt) <= now)
    .flatMap((pr) => pr.bodies.map((body) => readVerdict(body, pr.tier, names)))
    .filter((e) => e !== null);
}

const emptyCounts = () => ({ runs: 0, runsWithMetrics: 0, runsWithoutMetrics: 0, realFindings: 0, minorFindings: 0, runsWithNoRealFinding: 0 });

function count(target, verdict) {
  const real = verdict.findings.filter((f) => REAL.has(f.severity)).length;
  target.runs += 1;
  if (verdict.metrics === undefined) target.runsWithoutMetrics += 1;
  else target.runsWithMetrics += 1;
  target.realFindings += real;
  target.minorFindings += verdict.findings.filter((f) => f.severity === "minor").length;
  if (real === 0) target.runsWithNoRealFinding += 1;
  return real;
}

const statOf = (values) => ({
  median: values.length === 0 ? null : round(percentile(values, 0.5)),
  total: round(values.reduce((sum, v) => sum + v, 0)),
});

/**
 * Pure: groups runs by tier and reviewer. Unreadable markers are skipped (buildReport counts them).
 * @param {({ tier: string, reviewer: string, verdict: object } | { unreadable: true })[]} verdicts
 */
export function summarize(verdicts) {
  const tiers = new Map();
  for (const run of verdicts) {
    if (run.unreadable) continue;
    if (!tiers.has(run.tier)) tiers.set(run.tier, { ...emptyCounts(), meteredTokens: 0, meteredRealFindings: 0, reviewers: new Map() });
    const tier = tiers.get(run.tier);
    if (!tier.reviewers.has(run.reviewer)) tier.reviewers.set(run.reviewer, { ...emptyCounts(), minutes: [], tokens: [] });
    const reviewer = tier.reviewers.get(run.reviewer);

    const real = count(tier, run.verdict);
    count(reviewer, run.verdict);
    if (run.verdict.metrics !== undefined) {
      reviewer.minutes.push(run.verdict.metrics.minutes);
      reviewer.tokens.push(run.verdict.metrics.tokens);
      tier.meteredTokens += run.verdict.metrics.tokens;
      tier.meteredRealFindings += real;
    }
  }

  const rank = (tier) => (TIER_ORDER.includes(tier) ? TIER_ORDER.indexOf(tier) : TIER_ORDER.length);
  return {
    tiers: [...tiers.entries()]
      .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
      .map(([name, t]) => ({
        tier: name,
        runs: t.runs,
        runsWithMetrics: t.runsWithMetrics,
        runsWithoutMetrics: t.runsWithoutMetrics,
        realFindings: t.realFindings,
        minorFindings: t.minorFindings,
        runsWithNoRealFinding: t.runsWithNoRealFinding,
        noRealFindingShare: round(t.runsWithNoRealFinding / t.runs, 3),
        totalTokens: t.meteredTokens,
        tokensPerRealFinding: t.meteredRealFindings === 0 ? null : round(t.meteredTokens / t.meteredRealFindings),
        reviewers: [...t.reviewers.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([reviewer, r]) => ({
            reviewer,
            runs: r.runs,
            runsWithMetrics: r.runsWithMetrics,
            runsWithoutMetrics: r.runsWithoutMetrics,
            minutes: statOf(r.minutes),
            tokens: statOf(r.tokens),
            realFindings: r.realFindings,
            minorFindings: r.minorFindings,
            runsWithNoRealFinding: r.runsWithNoRealFinding,
          })),
      })),
  };
}

/** @param {{ entries: ReturnType<typeof collectVerdicts>, now: Date, days: number }} input */
export function buildReport({ entries, now, days }) {
  const from = new Date(now.getTime() - days * DAY_MS);
  const { tiers } = summarize(entries);
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    window: { days, from: from.toISOString(), to: now.toISOString() },
    runs: tiers.reduce((sum, t) => sum + t.runs, 0),
    runsWithoutMetrics: tiers.reduce((sum, t) => sum + t.runsWithoutMetrics, 0),
    unreadable: entries.filter((e) => e.unreadable).length,
    tiers,
  };
}

const show = (value, suffix = "") => (value === null ? "n/a" : `${value}${suffix}`);
const percent = (value) => (value === null ? "n/a" : `${round(value * 100)}%`);

/** The markdown summary, derived from the JSON report alone. */
export function renderMarkdown(report) {
  const { window: w } = report;
  const lines = [`# Reviewer metrics (${w.days} days to ${w.to.slice(0, 10)})`, ""];
  if (report.runs === 0) lines.push("No reviewer runs on PRs merged in the window.", "");
  for (const t of report.tiers) {
    lines.push(
      `## Tier ${t.tier}`,
      "",
      `${t.runs} runs (${t.runsWithoutMetrics} without metrics); ${t.realFindings} real findings, ${t.minorFindings} minor; ` +
        `runs with no real finding ${percent(t.noRealFindingShare)}; tokens per real finding ${show(t.tokensPerRealFinding)}.`,
      "",
      "| Reviewer | Runs | With metrics | Minutes median / total | Tokens median / total | Real findings | Minor | Runs with no real finding |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
      ...t.reviewers.map(
        (r) =>
          `| ${r.reviewer} | ${r.runs} | ${r.runsWithMetrics} | ${show(r.minutes.median)} / ${r.minutes.total} | ${show(r.tokens.median)} / ${r.tokens.total} | ${r.realFindings} | ${r.minorFindings} | ${r.runsWithNoRealFinding} |`,
      ),
      "",
    );
  }
  lines.push(
    `${report.runsWithoutMetrics} of ${report.runs} runs without metrics (counted for runs and findings, not minutes or tokens); ${report.unreadable} unreadable verdict comments.`,
    "",
    "Aggregates only. Real findings are critical plus important. Tokens per real finding covers only the runs that reported metrics.",
    "",
  );
  return lines.join("\n");
}

// ---- GitHub access (not unit-tested: drives `gh`) ----

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

// comments(last: 100): verdicts are posted last, after the review rounds.
const PR_QUERY = `query($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: MERGED, first: 30, after: $cursor, orderBy: { field: UPDATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number mergedAt updatedAt
        closingIssuesReferences(first: 5) { nodes { labels(first: 20) { nodes { name } } } }
        comments(last: 100) { nodes { body } }
      }
    }
  }
}`;

export { parseGraphql };

function fetchMergedPrs(from) {
  const [owner, name] = gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]).trim().split("/");
  const prs = [];
  const seen = new Set();
  let cursor = null;
  for (;;) {
    const args = ["api", "graphql", "-f", `query=${PR_QUERY}`, "-F", `owner=${owner}`, "-F", `name=${name}`];
    if (cursor !== null) args.push("-F", `cursor=${cursor}`);
    const page = parseGraphql(gh(args));
    for (const node of page.nodes) {
      if (seen.has(node.number)) continue;
      seen.add(node.number);
      prs.push(normalizePr(node));
    }
    const stale = page.nodes.length > 0 && page.nodes.every((node) => new Date(node.updatedAt) < from);
    if (!page.pageInfo.hasNextPage || stale) return prs;
    cursor = page.pageInfo.endCursor;
  }
}

export function parseArgs(argv) {
  const options = { days: 7, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--json") options.json = true;
    else if (argv[i] === "--days") {
      const value = argv[i + 1] ?? "";
      if (!value.startsWith("--")) i += 1;
      options.days = /^\d+$/.test(value) ? Number(value) : Number.NaN;
    } else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!Number.isInteger(options.days) || options.days < 1 || options.days > 365) throw new Error("--days must be a whole number from 1 to 365");
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const now = new Date();
  const from = new Date(now.getTime() - options.days * DAY_MS);
  const report = buildReport({ entries: collectVerdicts(fetchMergedPrs(from), { now, days: options.days, names: reviewerNames(loadConfig()) }), now, days: options.days });
  console.log(options.json ? JSON.stringify(report, null, 2) : renderMarkdown(report));
}

/** An error for the terminal: a failed `gh` run (whose stderr can quote API text) becomes a generic line. */
export function errorMessage(error) {
  if (error && typeof error.status === "number") return `gh failed (exit ${error.status}): check gh auth status and the network`;
  return error instanceof Error ? error.message : "review-metrics failed";
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(errorMessage(error));
    process.exitCode = 1;
  }
}
