#!/usr/bin/env node
// Delivery metrics, DORA-style, from the GitHub API and the log.d fragments. AGGREGATES ONLY: no login, email,
// commit message, PR title or SHA ever leaves the normalisers below, so the report can feed a public metrics page
// and be committed. The JSON shape is stable and versioned (`schemaVersion`); the markdown is derived from it.
//
//   npm run delivery-metrics                      # last 30 days, markdown on stdout
//   npm run delivery-metrics -- --days 7 --json   # JSON on stdout
//   npm run delivery-metrics -- --out <dir>       # writes delivery-metrics.json and delivery-metrics.md there
//
// JSON shape (schemaVersion 1; every number is a plain number, every date an ISO-8601 UTC string):
//   { schemaVersion, generatedAt, window: { days, from, to },
//     throughput:    { mergedPrs, perDay, perWeek: [{ weekStart, merged }] },
//     leadTimeHours: { median, p90, mean },                 // PR opened -> merged; null when nothing merged
//     size:          { medianLinesChanged },                // additions + deletions per merged PR; null when nothing merged
//     mergeQueue:    { prsThroughQueue, prsBounced, bounceRate, removals: { <reason>: count } },
//     changeFailure: { mainRuns, failedMainRuns, failureRate, revertPrs, revertRate },
//     logFragments:  { inWindow } }
//
// Definitions and limits (see docs/USING.md):
// - Lead time is PR created -> merged, not first commit -> merged (a draft counts from when it was opened).
// - A PR "bounced" if the merge queue removed it for a reason other than "merged" or "manual" (observed reasons:
//   failed_checks, merge_conflict, merged, manual); PRs that never merged are not in the window's PR list.
// - Change failure signals are proxies: failed CI runs on push to main, and merged PRs whose title starts with "Revert".
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseGraphql } from "./graphql-lib.mjs";
import { parseIssueForm } from "./lib.mjs";
import { issuePaths } from "./paths.mjs";

export const SCHEMA_VERSION = 1;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FRAGMENT_NAME = /^(\d{4}-\d{2}-\d{2})-[a-z0-9][a-z0-9-]*\.md$/;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Extract metrics settings from lanes.config.json.
 * @param {object} rawConfig - parsed lanes.config.json
 * @returns {{ mainWorkflow: string; fragmentsDir: string | null }}
 */
export function metricsSettings(rawConfig) {
  const defaults = { mainWorkflow: "verify.yml", fragmentsDir: null };
  const config = rawConfig?.metrics ?? {};

  const mainWorkflow = "mainWorkflow" in config ? config.mainWorkflow : defaults.mainWorkflow;
  if (typeof mainWorkflow !== "string" || !mainWorkflow || !/\.(yml|yaml)$/.test(mainWorkflow)) {
    throw new Error("mainWorkflow must be a non-empty string ending in .yml or .yaml");
  }

  return {
    mainWorkflow,
    fragmentsDir: config.fragmentsDir ?? defaults.fragmentsDir,
  };
}

const round = (value, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;

/** Linear-interpolated percentile of a numeric array (p in 0..1); null for an empty one. */
export function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * p;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}

/** Monday 00:00 UTC of the week that contains the instant, as ISO text. */
export function weekStart(iso) {
  const date = new Date(iso);
  const dayOfWeek = (date.getUTCDay() + 6) % 7; // Monday = 0
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - dayOfWeek)).toISOString();
}

/** A merge-queue removal reason is a short slug; anything else is folded into "other" so free text never leaks. */
export function safeReason(reason) {
  const slug = typeof reason === "string" ? reason.toLowerCase() : "";
  return /^[a-z_]{1,32}$/.test(slug) ? slug : "other";
}

/** The times of one kind of merge-queue event, oldest first; an event with no readable time is dropped. */
function eventTimes(events, typename) {
  return events
    .filter((event) => event.__typename === typename && typeof event.createdAt === "string" && !Number.isNaN(Date.parse(event.createdAt)))
    .map((event) => event.createdAt)
    .sort((a, b) => Date.parse(a) - Date.parse(b));
}

/**
 * The ONLY place a GraphQL pull request node is read. Everything except numbers, dates, booleans and a slug is dropped
 * here (author, title, body, URL...), so nothing personal can reach the report.
 * @returns {{ createdAt: string; mergedAt: string; linesChanged: number; isRevert: boolean; queueRemovals: string[]; enteredQueue: boolean } | undefined}
 */
export function normalizePr(node) {
  if (!node || typeof node.createdAt !== "string" || typeof node.mergedAt !== "string") return undefined;
  const events = node.timelineItems?.nodes ?? [];
  return {
    createdAt: node.createdAt,
    mergedAt: node.mergedAt,
    linesChanged: (Number(node.additions) || 0) + (Number(node.deletions) || 0),
    isRevert: typeof node.title === "string" && /^revert\b/i.test(node.title),
    enteredQueue: events.some((event) => event.__typename === "AddedToMergeQueueEvent"),
    queueRemovals: events.filter((event) => event.__typename === "RemovedFromMergeQueueEvent").map((event) => safeReason(event.reason)),
    queueAdded: eventTimes(events, "AddedToMergeQueueEvent"),
    queueRemoved: eventTimes(events, "RemovedFromMergeQueueEvent"),
  };
}

/**
 * @param {{ prs: ReturnType<typeof normalizePr>[]; runs: { conclusion: string; createdAt: string }[]; fragmentDates: string[]; now: Date; days: number }} input
 */
export function buildReport({ prs, runs, fragmentDates, now, days }) {
  const from = new Date(now.getTime() - days * DAY_MS);
  const merged = prs.filter((pr) => pr !== undefined && new Date(pr.mergedAt) >= from && new Date(pr.mergedAt) <= now);
  const leadHours = merged.map((pr) => (new Date(pr.mergedAt) - new Date(pr.createdAt)) / HOUR_MS);

  const weeks = new Map();
  for (const pr of merged) {
    const key = weekStart(pr.mergedAt);
    weeks.set(key, (weeks.get(key) ?? 0) + 1);
  }

  const removals = {};
  let bounced = 0;
  for (const pr of merged) {
    for (const reason of pr.queueRemovals) removals[reason] = (removals[reason] ?? 0) + 1;
    if (pr.queueRemovals.some((reason) => reason !== "merged" && reason !== "manual")) bounced += 1;
  }
  const throughQueue = merged.filter((pr) => pr.enteredQueue || pr.queueRemovals.length > 0).length;

  const mainRuns = runs.filter((run) => new Date(run.createdAt) >= from && new Date(run.createdAt) <= now && run.conclusion !== "" && run.conclusion !== "cancelled" && run.conclusion !== "skipped");
  const failedRuns = mainRuns.filter((run) => run.conclusion === "failure").length;
  const reverts = merged.filter((pr) => pr.isRevert).length;

  const ratio = (numerator, denominator) => (denominator === 0 ? null : round(numerator / denominator, 3));
  const stat = (values, fn) => (values.length === 0 ? null : round(fn(values)));

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    window: { days, from: from.toISOString(), to: now.toISOString() },
    throughput: {
      mergedPrs: merged.length,
      perDay: round(merged.length / days, 2),
      perWeek: [...weeks.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([start, count]) => ({ weekStart: start, merged: count })),
    },
    leadTimeHours: {
      median: stat(leadHours, (v) => percentile(v, 0.5)),
      p90: stat(leadHours, (v) => percentile(v, 0.9)),
      mean: stat(leadHours, (v) => v.reduce((sum, x) => sum + x, 0) / v.length),
    },
    size: { medianLinesChanged: stat(merged.map((pr) => pr.linesChanged), (v) => percentile(v, 0.5)) },
    mergeQueue: { prsThroughQueue: throughQueue, prsBounced: bounced, bounceRate: ratio(bounced, throughQueue), removals },
    changeFailure: {
      mainRuns: mainRuns.length,
      failedMainRuns: failedRuns,
      failureRate: ratio(failedRuns, mainRuns.length),
      revertPrs: reverts,
      revertRate: ratio(reverts, merged.length),
    },
    logFragments: { inWindow: fragmentDates.filter((date) => new Date(`${date}T00:00:00Z`) >= from && new Date(`${date}T00:00:00Z`) <= now).length },
  };
}

const show = (value, suffix = "") => (value === null ? "n/a" : `${value}${suffix}`);
const percent = (value) => (value === null ? "n/a" : `${round(value * 100)}%`);

/** The markdown summary, derived from the JSON report alone. */
export function renderMarkdown(report) {
  const { window: w, throughput: t, leadTimeHours: l, size, mergeQueue: q, changeFailure: c, logFragments: f } = report;
  const reasons = Object.entries(q.removals).sort(([a], [b]) => a.localeCompare(b)).map(([reason, count]) => `${reason} ${count}`).join(", ");
  return [
    `# Delivery metrics (${w.days} days to ${w.to.slice(0, 10)})`,
    "",
    "| Metric | Value |",
    "| --- | --- |",
    `| Merged PRs | ${t.mergedPrs} (${t.perDay} per day) |`,
    `| Lead time, PR opened to merged | median ${show(l.median, " h")}, p90 ${show(l.p90, " h")}, mean ${show(l.mean, " h")} |`,
    `| Median change size | ${show(size.medianLinesChanged, " lines")} |`,
    `| Merge queue bounce rate | ${percent(q.bounceRate)} (${q.prsBounced} of ${q.prsThroughQueue} PRs through the queue) |`,
    `| Queue removals by reason | ${reasons === "" ? "none" : reasons} |`,
    `| Failed CI runs on main | ${percent(c.failureRate)} (${c.failedMainRuns} of ${c.mainRuns}) |`,
    `| Revert PRs | ${c.revertPrs} (${percent(c.revertRate)} of merged) |`,
    `| Log fragments | ${f.inWindow} |`,
    "",
    "Merged per week (week starting Monday, UTC):",
    "",
    ...(t.perWeek.length === 0 ? ["none"] : t.perWeek.map((week) => `- ${week.weekStart.slice(0, 10)}: ${week.merged}`)),
    "",
    "Aggregates only. Lead time is PR opened to merged; a PR bounced when the merge queue removed it for a reason other than merged or manual; failed runs and revert PRs are proxies for change failure.",
    "",
  ].join("\n");
}

/**
 * Format an error message when the workflow cannot be read.
 * Includes gh's stderr only if its first line (safe API error text, no personal data).
 * @param {string} workflow - the configured workflow name
 * @param {string} stderr - gh's stderr output
 * @returns {string}
 */
export function runsErrorMessage(workflow, stderr) {
  const firstLine = stderr.split("\n")[0];
  const apiError = firstLine && firstLine.includes("HTTP") ? ` (${firstLine})` : "";
  return `Could not read runs for workflow "${workflow}": check metrics.mainWorkflow in lanes.config.json${apiError}`;
}

// ---- GitHub access (not unit-tested: drives `gh`) ----

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

// The extra selections `rich` adds. Personal fields (author, login, message, PR and issue titles) are never selected;
// the issue body is fetched only to be reduced to counts by normalizeRichPr.
const RICH_FIELDS = `
        files(first: 100) { nodes { path } }
        commits(first: 100) { nodes { commit { committedDate } } }
        lastCommit: commits(last: 1) {
          nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
            __typename
            ... on StatusContext { context state createdAt }
            ... on CheckRun { checkSuite { workflowRun { runAttempt } } }
          } } } } }
        }
        closingIssuesReferences(first: 1) { nodes { number body labels(first: 20) { nodes { name } } userContentEdits(first: 100) { nodes { editedAt } } } }`;

/** The paginated merged-PR query; `rich` adds the per-PR files, commits, statuses and closing-issue edits. */
export function prQuery(rich = false) {
  return `query($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: MERGED, first: 50, after: $cursor, orderBy: { field: UPDATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number createdAt mergedAt updatedAt additions deletions title
        timelineItems(first: 100, itemTypes: [ADDED_TO_MERGE_QUEUE_EVENT, REMOVED_FROM_MERGE_QUEUE_EVENT]) {
          nodes { __typename ... on AddedToMergeQueueEvent { createdAt } ... on RemovedFromMergeQueueEvent { createdAt reason } }
        }${rich ? RICH_FIELDS : ""}
      }
    }
  }
}`;
}

const isoDate = (value) => (typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : undefined);

/** A status context name is kept only when it looks like a check name (e.g. "lanes/gate"); free text folds to "other". */
function safeContext(context) {
  return typeof context === "string" && /^[A-Za-z0-9_./-]{1,64}$/.test(context) ? context : "other";
}

/** The paths an issue form claims in its Interface contract and Scope; [] when the body is not an issue form. */
function scopePaths(body) {
  const { contract, scope } = parseIssueForm(body).fields;
  return issuePaths({ contract, scope });
}

/**
 * The rich counterpart of normalizePr: the same base fields plus changed file paths, commit dates, status contexts
 * (name, lowercase state, time), check-run attempt counts and the closing issue reduced to numbers and dates. Logins,
 * titles, commit messages and the issue body text never leave this function.
 * @returns {ReturnType<typeof normalizePr> & { number: number; files: string[]; commitDates: string[]; statuses: { context: string; state: string; at: string }[]; checkRunAttempts: number[]; closingIssue: { number: number; criteria: number; criteriaDone: number; bodyChars: number; editedAt: string[]; scopePaths: string[] } | null } | undefined}
 */
export function normalizeRichPr(node) {
  const base = normalizePr(node);
  if (base === undefined) return undefined;
  const list = (value) => (Array.isArray(value) ? value : []);
  const contexts = list(node.lastCommit?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes);
  const issue = node.closingIssuesReferences?.nodes?.[0];
  const body = typeof issue?.body === "string" ? issue.body : "";
  return {
    ...base,
    number: Number(node.number) || 0,
    files: list(node.files?.nodes).map((file) => file?.path).filter((path) => typeof path === "string"),
    commitDates: list(node.commits?.nodes).map((entry) => isoDate(entry?.commit?.committedDate)).filter((date) => date !== undefined),
    statuses: contexts
      .filter((entry) => entry?.__typename === "StatusContext" && isoDate(entry.createdAt) !== undefined)
      .map((entry) => ({ context: safeContext(entry.context), state: safeReason(entry.state), at: entry.createdAt })),
    checkRunAttempts: contexts
      .filter((entry) => entry?.__typename === "CheckRun")
      .map((entry) => Number(entry.checkSuite?.workflowRun?.runAttempt))
      .filter((attempt) => Number.isInteger(attempt) && attempt >= 1),
    closingIssue: issue
      ? {
          number: Number(issue.number) || 0,
          criteria: (body.match(/^\s*- \[[ xX]\]/gm) ?? []).length,
          criteriaDone: (body.match(/^\s*- \[[xX]\]/gm) ?? []).length,
          bodyChars: body.length,
          tier: list(issue.labels?.nodes).map((label) => /^tier:(full|quick|skip)$/.exec(label?.name ?? "")?.[1]).find((t) => t !== undefined) ?? "unknown",
          editedAt: list(issue.userContentEdits?.nodes).map((edit) => isoDate(edit?.editedAt)).filter((date) => date !== undefined),
          scopePaths: scopePaths(body),
        }
      : null,
  };
}

function repoSlug(run = gh) {
  const [owner, name] = run(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]).trim().split("/");
  return { owner, name };
}

export { parseGraphql };

/**
 * Merged PRs updated since `from`, normalised. Without `rich` the query and output are the plain normalizePr shape;
 * with it the same paginated query also returns normalizeRichPr's extra fields. `run` is the gh runner (injectable for tests).
 */
export function fetchMergedPrs(from, { rich = false, run = gh } = {}) {
  const { owner, name } = repoSlug(run);
  const query = prQuery(rich);
  const normalize = rich ? normalizeRichPr : normalizePr;
  const prs = [];
  const seen = new Set();
  let cursor = null;
  for (;;) {
    const args = ["api", "graphql", "-f", `query=${query}`, "-F", `owner=${owner}`, "-F", `name=${name}`];
    if (cursor !== null) args.push("-F", `cursor=${cursor}`);
    const page = parseGraphql(run(args));
    // A PR updated while paging can shift onto the next page: count each PR number once.
    for (const node of page.nodes) {
      if (seen.has(node.number)) continue;
      seen.add(node.number);
      prs.push(normalize(node));
    }
    // Ordered by update time: once a whole page was last touched before the window, nothing older can have merged inside it.
    const stale = page.nodes.length > 0 && page.nodes.every((node) => new Date(node.updatedAt) < from);
    if (!page.pageInfo.hasNextPage || stale) return prs;
    cursor = page.pageInfo.endCursor;
  }
}

function fetchMainRuns(mainWorkflow) {
  try {
    const json = gh(["run", "list", "--branch", "main", "--event", "push", "--workflow", mainWorkflow, "--limit", "300", "--json", "conclusion,createdAt"]);
    return JSON.parse(json).map((run) => ({ conclusion: run.conclusion ?? "", createdAt: run.createdAt }));
  } catch (e) {
    // Fail loudly: workflow not found, auth error, network error, all treated equally
    const stderr = e.stderr || e.message || "";
    throw new Error(runsErrorMessage(mainWorkflow, stderr));
  }
}

function fragmentDates(fragmentsDir) {
  if (fragmentsDir === null || !existsSync(fragmentsDir)) return [];
  return readdirSync(fragmentsDir)
    .map((file) => FRAGMENT_NAME.exec(file)?.[1])
    .filter((date) => date !== undefined);
}

export function parseArgs(argv) {
  const options = { days: 30, json: false, out: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--json") options.json = true;
    else if (argv[i] === "--days") {
      const value = argv[i + 1] ?? "";
      if (!value.startsWith("--")) i += 1;
      options.days = /^\d+$/.test(value) ? Number(value) : Number.NaN;
    }
    else if (argv[i] === "--out") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) throw new Error("--out needs a directory");
      options.out = value;
    } else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!Number.isInteger(options.days) || options.days < 1 || options.days > 365) throw new Error("--days must be a whole number from 1 to 365");
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const now = new Date();
  const from = new Date(now.getTime() - options.days * DAY_MS);

  const configPath = join(ROOT, "lanes.config.json");
  const rawConfig = JSON.parse(readFileSync(configPath, "utf8"));
  const settings = metricsSettings(rawConfig);

  const fragmentsPath = settings.fragmentsDir ? join(ROOT, settings.fragmentsDir) : null;
  const report = buildReport({ prs: fetchMergedPrs(from), runs: fetchMainRuns(settings.mainWorkflow), fragmentDates: fragmentDates(fragmentsPath), now, days: options.days });
  if (options.out !== undefined) {
    mkdirSync(options.out, { recursive: true });
    writeFileSync(join(options.out, "delivery-metrics.json"), `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(join(options.out, "delivery-metrics.md"), renderMarkdown(report));
    console.log(`Wrote delivery-metrics.json and delivery-metrics.md to ${options.out}`);
  } else {
    console.log(options.json ? JSON.stringify(report, null, 2) : renderMarkdown(report));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
