#!/usr/bin/env node
// Lane metrics (ADR 0013): how lanes perform over the merged lane PRs, on the axes delivery-metrics.mjs and
// review-metrics.mjs do not cover, with their summaries embedded rather than recomputed. AGGREGATES ONLY, in the shape
// of contracts/lane-metrics.schema.json.
//
//   node scripts/lanes/lane-metrics.mjs                          # last 28 days, markdown on stdout
//   node scripts/lanes/lane-metrics.mjs --days 60 --split 2026-09-15 --json
//   node scripts/lanes/lane-metrics.mjs --public --split 2026-09-15 --out docs/metrics/2026-09-28.json
//
// Axes (per merged PR, then medians and counts):
// - rework: failed status contexts on the PR head by stage, and commits pushed after the PR opened.
// - scope drift: changed files outside the closing issue's Scope (parseIssueForm and issuePaths, via normalizeRichPr).
// - owner time: hours from the last reviewer success to review/owner success; edits to the closing issue after open.
// - concurrency: lane PRs open when each one opened.
// - friction: CI reruns (workflow run attempts above 1) and minutes from the PR's last status to its merge for PRs that
//   went through the merge queue.
// Without --public it also reads `.lanes/costs.jsonl` (lane-cost.mjs): tokens per tier and model, relaunches (more than
// one session for an issue) and lane-hours. With --public those fields are absent, never zeroed.
//
// Limits: GitHub keeps only the latest state of each status context, so a failure that was later fixed by a green
// status is not counted as rework; open PRs are not fetched, so concurrency counts merged lane PRs only.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildReport as buildDeliveryReport, fetchMergedPrs, metricsSettings, parseGraphql, percentile } from "./delivery-metrics.mjs";
import { mainCheckout } from "./lane-cost.mjs";
import { pathsOverlap } from "./paths.mjs";
import { buildReport as buildReviewReport, collectVerdicts, normalizePr as normalizeReviewPr } from "./review-metrics.mjs";

export const SCHEMA_VERSION = 1;
export const LOCAL_ONLY = ["tokensByTierAndModel", "relaunches", "laneHours"];
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
const DAY_MS = 24 * HOUR_MS;
const WIDE_DAYS = 36_500; // a window wide enough that the sub-reports' own date filters never drop a pre-filtered PR
const TIER_ORDER = ["full", "quick", "skip", "unknown"];
const MODEL_ORDER = ["fable", "opus", "sonnet", "haiku", "unknown"];
const STAGE_ORDER = ["gate", "review", "owner", "failing"];

/** An error whose message is this script's own text (safe to print); any other error may quote gh output or API text. */
export class UsageError extends Error {}

const round = (value, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;
const ms = (iso) => Date.parse(iso);
const stat = (values) => ({ count: values.length, median: values.length === 0 ? null : round(percentile(values, 0.5)) });
const rate = (numerator, denominator) => (denominator === 0 ? null : round(numerator / denominator, 3));

// ---- per-PR axes (each takes the normalizeRichPr shape) ----

/** The stage a failing status belongs to: an allowlist, so a status name never reaches the report. */
function stageOf(context) {
  if (context === "lanes/gate") return "gate";
  if (context === "review/owner") return "owner";
  return context.startsWith("review/") ? "review" : "failing";
}

const failed = (status) => status.state === "failure" || status.state === "error";

function rework(prs) {
  const byStage = new Map();
  let prsWithGateFailure = 0;
  for (const pr of prs) {
    const failures = pr.statuses.filter(failed);
    if (failures.length > 0) prsWithGateFailure += 1;
    for (const status of failures) byStage.set(stageOf(status.context), (byStage.get(stageOf(status.context)) ?? 0) + 1);
  }
  return {
    prs: prs.length,
    prsWithGateFailure,
    gateFailuresByStage: STAGE_ORDER.filter((stage) => byStage.has(stage)).map((stage) => ({ stage, count: byStage.get(stage) })),
    pushesAfterOpen: stat(prs.map((pr) => pr.commitDates.filter((date) => ms(date) > ms(pr.createdAt)).length)),
  };
}

function scopeDrift(prs) {
  const measured = prs.filter((pr) => pr.closingIssue !== null && pr.closingIssue.scopePaths.length > 0);
  const outside = measured.map((pr) => pr.files.filter((file) => !pathsOverlap([file], pr.closingIssue.scopePaths)).length);
  const withDrift = outside.filter((n) => n > 0).length;
  return { prs: measured.length, prsWithDrift: withDrift, driftRate: rate(withDrift, measured.length), filesOutsideScope: stat(outside) };
}

const isReviewer = (status) => status.context.startsWith("review/") && status.context !== "review/owner";

function ownerTime(prs) {
  const waits = [];
  for (const pr of prs) {
    const owner = pr.statuses.find((s) => s.context === "review/owner" && s.state === "success");
    const reviewers = pr.statuses.filter((s) => isReviewer(s) && s.state === "success").map((s) => ms(s.at));
    if (owner === undefined || reviewers.length === 0) continue;
    waits.push(Math.max(0, ms(owner.at) - Math.max(...reviewers)) / HOUR_MS);
  }
  const edits = prs.map((pr) => (pr.closingIssue?.editedAt ?? []).filter((at) => ms(at) > ms(pr.createdAt)).length);
  return { prsWaited: waits.length, waitHours: stat(waits), interventions: stat(edits) };
}

function concurrency(prs) {
  const open = prs.map((pr) => prs.filter((other) => ms(other.createdAt) <= ms(pr.createdAt) && ms(pr.createdAt) < ms(other.mergedAt)).length);
  return { maxOpenPrs: open.length === 0 ? 0 : Math.max(...open), medianOpenPrs: open.length === 0 ? null : round(percentile(open, 0.5)) };
}

function friction(prs) {
  const reruns = prs.map((pr) => pr.checkRunAttempts.reduce((sum, attempt) => sum + (attempt - 1), 0));
  const stuck = prs
    .filter((pr) => pr.enteredQueue && pr.statuses.length > 0)
    .map((pr) => (ms(pr.mergedAt) - Math.max(...pr.statuses.map((s) => ms(s.at)))) / MINUTE_MS)
    .filter((minutes) => minutes >= 0);
  return { prsWithRerun: reruns.filter((n) => n > 0).length, ciReruns: reruns.reduce((sum, n) => sum + n, 0), stuckQueueMinutes: stat(stuck) };
}

// ---- the embedded delivery and review summaries ----

function deliveryBlock({ prs, runs, days, end }) {
  const report = buildDeliveryReport({ prs, runs, fragmentDates: [], now: new Date(end - 1), days: WIDE_DAYS });
  return {
    mergedPrs: report.throughput.mergedPrs,
    perDay: round(prs.length / days, 2),
    leadTimeHoursMedian: report.leadTimeHours.median,
    medianLinesChanged: report.size.medianLinesChanged,
    bounceRate: report.mergeQueue.bounceRate,
    failureRate: report.changeFailure.failureRate,
    revertRate: report.changeFailure.revertRate,
  };
}

function reviewBlock({ reviewPrs, end }) {
  const now = new Date(end - 1);
  const report = buildReviewReport({ entries: collectVerdicts(reviewPrs, { now, days: WIDE_DAYS }), now, days: WIDE_DAYS });
  return {
    runs: report.runs,
    runsWithoutMetrics: report.runsWithoutMetrics,
    realFindings: report.tiers.reduce((sum, t) => sum + t.realFindings, 0),
    minorFindings: report.tiers.reduce((sum, t) => sum + t.minorFindings, 0),
    tiers: report.tiers.map((t) => ({ tier: t.tier, runs: t.runs, realFindings: t.realFindings, noRealFindingShare: t.noRealFindingShare })),
  };
}

// ---- costs.jsonl (local only) ----

/**
 * The valid lines of `.lanes/costs.jsonl` and how many were skipped. A valid line is a JSON object with a readable
 * `removedAt`; blank lines are ignored, anything else is counted so a wrecked file is not mistaken for an empty one.
 * @returns {{ lines: object[], skipped: number }}
 */
export function parseCosts(text) {
  const lines = [];
  let skipped = 0;
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    if (raw.trim() === "") continue;
    let line;
    try {
      line = JSON.parse(raw);
    } catch {
      skipped += 1;
      continue;
    }
    if (line === null || typeof line !== "object" || Array.isArray(line) || !Number.isFinite(ms(line.removedAt))) skipped += 1;
    else lines.push(line);
  }
  return { lines, skipped };
}

/** A model family from a transcript's model ids; several families in one lane, or none known, is `unknown`. */
function modelFamily(model) {
  const families = new Set(
    String(model ?? "")
      .toLowerCase()
      .split(",")
      .filter((id) => id.trim() !== "")
      .map((id) => MODEL_ORDER.find((family) => family !== "unknown" && id.includes(family)) ?? "unknown"),
  );
  return families.size === 1 ? [...families][0] : "unknown";
}

function localBlock(lines) {
  const tokens = new Map();
  for (const line of lines) {
    if (line.tokens === null || typeof line.tokens !== "object") continue;
    const tier = TIER_ORDER.includes(line.tier) ? line.tier : "unknown";
    const key = `${tier}|${modelFamily(line.model)}`;
    const total = Number.isFinite(line.tokens.total) && line.tokens.total > 0 ? Math.round(line.tokens.total) : 0;
    tokens.set(key, (tokens.get(key) ?? 0) + total);
  }
  const sessions = new Map();
  for (const line of lines) {
    if (!Number.isInteger(line.issue) || typeof line.sessionId !== "string") continue;
    sessions.set(line.issue, (sessions.get(line.issue) ?? new Set()).add(line.sessionId));
  }
  const hours = lines.map((line) => (ms(line.removedAt) - ms(line.launchedAt)) / HOUR_MS).filter((h) => Number.isFinite(h) && h >= 0);
  return {
    tokensByTierAndModel: TIER_ORDER.flatMap((tier) => MODEL_ORDER.map((model) => ({ tier, model, tokens: tokens.get(`${tier}|${model}`) })).filter((row) => row.tokens !== undefined)),
    relaunches: [...sessions.values()].reduce((sum, set) => sum + set.size - 1, 0),
    laneHours: stat(hours),
  };
}

// ---- the report ----

function aggregate({ prs, reviewPrs, runs, costs, start, end }) {
  const inRange = (iso) => ms(iso) >= start && ms(iso) < end;
  const merged = prs.filter((pr) => pr !== undefined && inRange(pr.mergedAt));
  const block = {
    rework: rework(merged),
    scopeDrift: scopeDrift(merged),
    ownerTime: ownerTime(merged),
    concurrency: concurrency(merged),
    friction: friction(merged),
    delivery: deliveryBlock({ prs: merged, runs: runs.filter((run) => inRange(run.createdAt)), days: (end - start) / DAY_MS, end }),
    review: reviewBlock({ reviewPrs: reviewPrs.filter((pr) => pr !== undefined && inRange(pr.mergedAt)), end }),
  };
  return costs === undefined ? block : { ...block, ...localBlock(costs.filter((line) => inRange(line.removedAt))) };
}

/**
 * Pure: builds the report from normalised inputs.
 * @param {{ prs: object[], reviewPrs: object[], runs: { conclusion: string, createdAt: string }[], costsText?: string,
 *   now: Date, days: number, split?: string, publicMode?: boolean }} input
 *   prs are normalizeRichPr results, reviewPrs review-metrics normalizePr results; costsText is ignored when public.
 */
export function buildLaneReport({ prs, reviewPrs = [], runs = [], costsText, now, days, split, publicMode = false }) {
  const from = now.getTime() - days * DAY_MS;
  const end = now.getTime() + 1; // the window is closed at both ends: a PR merged at `now` counts
  const costs = publicMode || costsText === undefined ? undefined : parseCosts(costsText).lines;
  const input = { prs, reviewPrs, runs, costs };
  const report = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    public: publicMode,
    window: { days, from: new Date(from).toISOString(), to: now.toISOString() },
    ...aggregate({ ...input, start: from, end }),
  };
  if (split !== undefined) {
    const at = ms(`${split}T00:00:00Z`);
    if (!(at > from && at <= now.getTime())) throw new UsageError(`--split ${split} must fall inside the ${days}-day window (after ${new Date(from).toISOString().slice(0, 10)}, up to today)`);
    report.split = [{ date: split, before: aggregate({ ...input, start: from, end: at }), after: aggregate({ ...input, start: at, end }) }];
  }
  return report;
}

// ---- the PII and local path check ----

const partial = (...parts) => parts.join("");
/** The path shapes the preflight check rejects (a test keeps this in step with scripts/preflight.mjs). */
export const PATH_SHAPES = [partial("C:", "\\Users"), partial("C:", "/Users"), partial("/", "home", "/"), partial("/", "Users", "/"), partial("C:", "\\\\Users")];
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/;
const MENTION = /(?<![\w.@])@[A-Za-z0-9][A-Za-z0-9-]{0,38}/;

/**
 * Throws when `text` holds an email, an @-mention, a local path, one of `logins`, or a private identifier from
 * PREFLIGHT_PATTERNS_FILE. The message names the kind, never the match.
 */
export function assertNoPii(text, { logins = [], patternsFile = process.env.PREFLIGHT_PATTERNS_FILE } = {}) {
  const haystack = String(text).toLowerCase();
  const privateIds = patternsFile && existsSync(patternsFile) ? readFileSync(patternsFile, "utf8").split("\n").map((l) => l.trim()).filter(Boolean) : [];
  const found = [];
  if (EMAIL.test(text)) found.push("an email address");
  if (MENTION.test(text)) found.push("an @-mention");
  if (PATH_SHAPES.some((shape) => haystack.includes(shape.toLowerCase()))) found.push("a local path");
  if (logins.some((login) => login !== "" && haystack.includes(login.toLowerCase()))) found.push("a login");
  if (privateIds.some((id) => haystack.includes(id.toLowerCase()))) found.push("a private identifier");
  if (found.length > 0) throw new UsageError(`refused: the output holds ${found.join(", ")}; nothing was written`);
}

/** Writes `text` to `file` only after assertNoPii passes. */
export function writeOutput(file, text, { logins = [], write = writeFileSync, patternsFile } = {}) {
  assertNoPii(text, { logins, patternsFile });
  mkdirSync(dirname(file), { recursive: true });
  write(file, text);
}

// ---- markdown ----

const show = (value, suffix = "") => (value === null || value === undefined ? "n/a" : `${value}${suffix}`);
const percent = (value) => (value === null ? "n/a" : `${round(value * 100)}%`);
const statText = (s, suffix = "") => `median ${show(s.median, suffix)} over ${s.count}`;

/** The headline rows of one aggregate, shared by the full report and the split table. */
function rows(a) {
  const stages = a.rework.gateFailuresByStage.map((s) => `${s.stage} ${s.count}`).join(", ") || "none";
  return [
    ["Merged PRs", `${a.delivery.mergedPrs} (${a.delivery.perDay} per day)`],
    ["Rework: PRs with a failed status", `${a.rework.prsWithGateFailure} of ${a.rework.prs} (${stages})`],
    ["Rework: pushes after open", statText(a.rework.pushesAfterOpen)],
    ["Scope drift", `${a.scopeDrift.prsWithDrift} of ${a.scopeDrift.prs} PRs (${percent(a.scopeDrift.driftRate)}); files outside: ${statText(a.scopeDrift.filesOutsideScope)}`],
    ["Owner wait", `${statText(a.ownerTime.waitHours, " h")}; ${a.ownerTime.prsWaited} PRs waited`],
    ["Owner interventions", statText(a.ownerTime.interventions)],
    ["Open PRs at once", `max ${a.concurrency.maxOpenPrs}, median ${show(a.concurrency.medianOpenPrs)}`],
    ["Friction: CI reruns", `${a.friction.ciReruns} across ${a.friction.prsWithRerun} PRs`],
    ["Friction: minutes in the merge queue", statText(a.friction.stuckQueueMinutes, " min")],
    ["Reviewer runs", `${a.review.runs} (${a.review.realFindings} real findings, ${a.review.minorFindings} minor)`],
    ...(a.laneHours === undefined ? [] : [["Lane-hours", statText(a.laneHours, " h")], ["Relaunches", String(a.relaunches)]]),
  ];
}

/** The markdown summary, derived from the report alone. */
export function renderMarkdown(report) {
  const { window: w } = report;
  const out = [`# Lane metrics (${w.days} days to ${w.to.slice(0, 10)})`, "", report.public ? "Public report: local-only fields are left out." : "Local report.", ""];
  const section = (title, body) => out.push(`## ${title}`, "", ...body, "");
  const { rework: r, scopeDrift: s, ownerTime: o, concurrency: c, friction: f, delivery: d } = report;
  section("Rework", [`- PRs measured: ${r.prs}; with a failed status: ${r.prsWithGateFailure}`, ...r.gateFailuresByStage.map((x) => `- ${x.stage}: ${x.count}`), `- Pushes after open: ${statText(r.pushesAfterOpen)}`]);
  section("Scope drift", [`- PRs with a Scope: ${s.prs}; with files outside it: ${s.prsWithDrift} (${percent(s.driftRate)})`, `- Files outside Scope: ${statText(s.filesOutsideScope)}`]);
  section("Owner time", [`- PRs that waited on the owner: ${o.prsWaited}`, `- Wait: ${statText(o.waitHours, " h")}`, `- Issue edits after open: ${statText(o.interventions)}`]);
  section("Concurrency", [`- Most lane PRs open at once: ${c.maxOpenPrs}; median ${show(c.medianOpenPrs)}`]);
  section("Friction", [`- CI reruns: ${f.ciReruns} across ${f.prsWithRerun} PRs`, `- Minutes from the last status to merge, through the queue: ${statText(f.stuckQueueMinutes, " min")}`]);
  section("Delivery (from delivery-metrics)", [`- Merged PRs: ${d.mergedPrs} (${d.perDay} per day)`, `- Lead time median: ${show(d.leadTimeHoursMedian, " h")}; median change: ${show(d.medianLinesChanged, " lines")}`, `- Bounce ${percent(d.bounceRate)}, failed main runs ${percent(d.failureRate)}, reverts ${percent(d.revertRate)}`]);
  section("Review (from review-metrics)", [`- Runs: ${report.review.runs} (${report.review.runsWithoutMetrics} without metrics); real findings ${report.review.realFindings}, minor ${report.review.minorFindings}`, ...report.review.tiers.map((t) => `- ${t.tier}: ${t.runs} runs, ${t.realFindings} real findings, ${percent(t.noRealFindingShare)} with none`)]);
  if (report.tokensByTierAndModel !== undefined) {
    section("Tokens (local)", [...report.tokensByTierAndModel.map((t) => `- ${t.tier} on ${t.model}: ${t.tokens} tokens`), `- Relaunches: ${report.relaunches}`, `- Lane-hours: ${statText(report.laneHours, " h")}`]);
  }
  for (const { date, before, after } of report.split ?? []) {
    const left = rows(before);
    section(`Split at ${date}`, ["| Metric | Before | After |", "| --- | --- | --- |", ...rows(after).map(([label, value], i) => `| ${label} | ${left[i][1]} | ${value} |`)]);
  }
  out.push("Medians and counts only; no causal claims. GitHub keeps each status's latest state, and only merged PRs are measured.", "");
  return out.join("\n");
}

// ---- arguments ----

export function parseArgs(argv) {
  const options = { days: 28, split: undefined, public: false, format: "markdown", out: undefined };
  let format;
  const setFormat = (value) => {
    if (format !== undefined && format !== value) throw new UsageError("--json and --markdown cannot be combined");
    format = value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--public") options.public = true;
    else if (arg === "--json") setFormat("json");
    else if (arg === "--markdown") setFormat("markdown");
    else if (arg === "--days") {
      const value = argv[i + 1] ?? "";
      if (!value.startsWith("--")) i += 1;
      options.days = /^\d+$/.test(value) ? Number(value) : Number.NaN;
    } else if (arg === "--split") {
      const value = argv[++i];
      if (value === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(ms(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
        throw new UsageError("--split needs a date as YYYY-MM-DD");
      }
      options.split = value;
    } else if (arg === "--out") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) throw new UsageError("--out needs a file");
      options.out = value;
    } else throw new UsageError(`Unknown argument: ${arg}`);
  }
  if (!Number.isInteger(options.days) || options.days < 1 || options.days > 365) throw new UsageError("--days must be a whole number from 1 to 365");
  options.format = format ?? "markdown";
  return options;
}

// ---- GitHub access (not unit-tested: drives `gh`) ----

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

// Verdict comments are posted last, after the review rounds (the same selection review-metrics.mjs makes).
const REVIEW_QUERY = `query($owner: String!, $name: String!, $cursor: String) {
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

function fetchReviewPrs(from) {
  const [owner, name] = gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]).trim().split("/");
  const prs = [];
  const seen = new Set();
  let cursor = null;
  for (;;) {
    const args = ["api", "graphql", "-f", `query=${REVIEW_QUERY}`, "-F", `owner=${owner}`, "-F", `name=${name}`];
    if (cursor !== null) args.push("-F", `cursor=${cursor}`);
    const page = parseGraphql(gh(args));
    for (const node of page.nodes) {
      if (seen.has(node.number)) continue;
      seen.add(node.number);
      prs.push(normalizeReviewPr(node));
    }
    const stale = page.nodes.length > 0 && page.nodes.every((node) => new Date(node.updatedAt) < from);
    if (!page.pageInfo.hasNextPage || stale) return prs;
    cursor = page.pageInfo.endCursor;
  }
}

function fetchMainRuns(mainWorkflow) {
  const json = gh(["run", "list", "--branch", "main", "--event", "push", "--workflow", mainWorkflow, "--limit", "300", "--json", "conclusion,createdAt"]);
  return JSON.parse(json).map((run) => ({ conclusion: run.conclusion ?? "", createdAt: run.createdAt }));
}

/** The repository owner's and the signed-in user's logins, for the output check; [] when gh cannot say. */
function knownLogins() {
  const logins = [];
  for (const args of [["repo", "view", "--json", "owner", "--jq", ".owner.login"], ["api", "user", "--jq", ".login"]]) {
    try {
      const login = gh(args).trim();
      if (login) logins.push(login);
    } catch {
      // Not fatal: the email, mention and path checks still run.
    }
  }
  return logins;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const now = new Date();
  const from = new Date(now.getTime() - options.days * DAY_MS);
  const settings = metricsSettings(JSON.parse(readFileSync(join(ROOT, "lanes.config.json"), "utf8")));
  const costsFile = join(mainCheckout(ROOT), ".lanes", "costs.jsonl");
  const costsText = !options.public && existsSync(costsFile) ? readFileSync(costsFile, "utf8") : undefined;
  if (costsText !== undefined) {
    const { skipped } = parseCosts(costsText);
    if (skipped > 0) console.error(`lane-metrics: skipped ${skipped} unreadable line(s) in .lanes/costs.jsonl`);
  }
  const report = buildLaneReport({
    prs: fetchMergedPrs(from, { rich: true }),
    reviewPrs: fetchReviewPrs(from),
    runs: fetchMainRuns(settings.mainWorkflow),
    costsText,
    now,
    days: options.days,
    split: options.split,
    publicMode: options.public,
  });
  const text = options.format === "json" ? `${JSON.stringify(report, null, 2)}\n` : renderMarkdown(report);
  const logins = knownLogins();
  if (options.out !== undefined) {
    writeOutput(options.out, text, { logins });
    console.log(`Wrote ${options.out}`);
  } else {
    if (options.public) assertNoPii(text, { logins });
    process.stdout.write(text);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    // A failed gh run's message carries the command and stderr, and a parse error can quote the response: print only our own errors' text.
    console.error(error instanceof UsageError ? error.message : error && typeof error.status === "number" ? `gh failed (exit ${error.status}): check gh auth status and the network` : "lane-metrics failed: check gh auth status and the network");
    process.exitCode = 1;
  }
}
