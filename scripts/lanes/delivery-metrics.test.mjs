import { test } from "node:test";
import assert from "node:assert/strict";
import { SCHEMA_VERSION, buildReport, metricsSettings, normalizePr, parseArgs, parseGraphql, percentile, renderMarkdown, runsErrorMessage, safeReason, weekStart } from "./delivery-metrics.mjs";

const NOW = new Date("2026-09-27T12:00:00Z");

// A GraphQL node as the API returns it, with the personal fields a careless script could copy through.
const node = (overrides = {}) => ({
  createdAt: "2026-09-26T00:00:00Z",
  mergedAt: "2026-09-26T04:00:00Z",
  updatedAt: "2026-09-26T04:00:00Z",
  additions: 10,
  deletions: 5,
  title: "feat: something private-title-marker",
  author: { login: "octo-person", email: "person@example.invalid", name: "Real Name" },
  headRefName: "feat/private-branch-marker",
  body: "secret-body-marker",
  timelineItems: { nodes: [{ __typename: "AddedToMergeQueueEvent" }, { __typename: "RemovedFromMergeQueueEvent", reason: "merged" }] },
  ...overrides,
});

const report = (nodes, extra = {}) =>
  buildReport({ prs: nodes.map(normalizePr), runs: [], fragmentDates: [], now: NOW, days: 30, ...extra });

test("percentile interpolates and handles empty and single values", () => {
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile([7], 0.9), 7);
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(percentile([10, 0, 5], 0.5), 5);
});

test("weekStart is the Monday 00:00 UTC of the week", () => {
  assert.equal(weekStart("2026-09-27T12:00:00Z"), "2026-09-21T00:00:00.000Z"); // a Sunday
  assert.equal(weekStart("2026-09-21T00:00:00Z"), "2026-09-21T00:00:00.000Z"); // the Monday itself
});

test("a queue removal reason is kept only when it is a short slug", () => {
  assert.equal(safeReason("failed_checks"), "failed_checks");
  assert.equal(safeReason("Some free text with a name"), "other");
  assert.equal(safeReason(undefined), "other");
});

test("throughput, lead time and size are computed from the merged PRs in the window only", () => {
  const r = report([
    node(), // 4 h, 15 lines
    node({ createdAt: "2026-09-25T00:00:00Z", mergedAt: "2026-09-25T10:00:00Z", additions: 100, deletions: 0 }), // 10 h, 100 lines
    node({ mergedAt: "2026-07-01T00:00:00Z", createdAt: "2026-06-30T00:00:00Z" }), // outside the 30-day window
  ]);
  assert.equal(r.schemaVersion, SCHEMA_VERSION);
  assert.equal(r.throughput.mergedPrs, 2);
  assert.equal(r.throughput.perDay, 0.07);
  assert.deepEqual(r.throughput.perWeek, [{ weekStart: "2026-09-21T00:00:00.000Z", merged: 2 }]);
  assert.equal(r.leadTimeHours.median, 7);
  assert.equal(r.leadTimeHours.mean, 7);
  assert.equal(r.size.medianLinesChanged, 57.5);
});

test("an empty window gives nulls, not NaN or a crash", () => {
  const r = report([]);
  assert.equal(r.throughput.mergedPrs, 0);
  assert.equal(r.leadTimeHours.median, null);
  assert.equal(r.size.medianLinesChanged, null);
  assert.equal(r.mergeQueue.bounceRate, null);
  assert.equal(r.changeFailure.failureRate, null);
  assert.match(renderMarkdown(r), /n\/a/);
});

test("the bounce rate counts PRs removed for a reason other than merged or manual", () => {
  const bounced = node({
    timelineItems: {
      nodes: [
        { __typename: "AddedToMergeQueueEvent" },
        { __typename: "RemovedFromMergeQueueEvent", reason: "failed_checks" },
        { __typename: "AddedToMergeQueueEvent" },
        { __typename: "RemovedFromMergeQueueEvent", reason: "merged" },
      ],
    },
  });
  const manual = node({ timelineItems: { nodes: [{ __typename: "AddedToMergeQueueEvent" }, { __typename: "RemovedFromMergeQueueEvent", reason: "manual" }] } });
  const noQueue = node({ timelineItems: { nodes: [] } });
  const r = report([bounced, manual, node(), noQueue]);
  assert.equal(r.mergeQueue.prsThroughQueue, 3);
  assert.equal(r.mergeQueue.prsBounced, 1);
  assert.equal(r.mergeQueue.bounceRate, 0.333);
  assert.deepEqual(r.mergeQueue.removals, { failed_checks: 1, manual: 1, merged: 2 });
});

test("change failure: failed main runs (cancelled and skipped ignored) and revert PRs", () => {
  const runs = [
    { conclusion: "success", createdAt: "2026-09-26T00:00:00Z" },
    { conclusion: "failure", createdAt: "2026-09-26T01:00:00Z" },
    { conclusion: "cancelled", createdAt: "2026-09-26T02:00:00Z" },
    { conclusion: "success", createdAt: "2026-01-01T00:00:00Z" }, // outside the window
    { conclusion: "", createdAt: "2026-09-26T03:00:00Z" }, // still running
  ];
  const r = report([node({ title: "Revert \"feat: x\"" }), node()], { runs });
  assert.equal(r.changeFailure.mainRuns, 2);
  assert.equal(r.changeFailure.failedMainRuns, 1);
  assert.equal(r.changeFailure.failureRate, 0.5);
  assert.equal(r.changeFailure.revertPrs, 1);
  assert.equal(r.changeFailure.revertRate, 0.5);
});

test("log fragments are counted by the date in their file name, inside the window", () => {
  const r = report([], { fragmentDates: ["2026-09-26", "2026-09-27", "2026-08-01"] });
  assert.equal(r.logFragments.inWindow, 2);
});

// The privacy guarantee (#280): aggregates only. The input carries a login, an email, a real name, a title, a branch and
// a body; none of them, and no key that could hold one, may appear anywhere in the output.
const ALLOWED_KEYS = new Set([
  "schemaVersion", "generatedAt", "window", "days", "from", "to", "throughput", "mergedPrs", "perDay", "perWeek", "weekStart", "merged",
  "leadTimeHours", "median", "p90", "mean", "size", "medianLinesChanged", "mergeQueue", "prsThroughQueue", "prsBounced", "bounceRate",
  "removals", "changeFailure", "mainRuns", "failedMainRuns", "failureRate", "revertPrs", "revertRate", "logFragments", "inWindow",
]);
const REMOVAL_REASONS = new Set(["failed_checks", "merge_conflict", "merged", "manual", "other"]);

function keysOf(value, path = "", out = []) {
  if (Array.isArray(value)) value.forEach((item) => keysOf(item, path, out));
  else if (value !== null && typeof value === "object") {
    for (const [key, inner] of Object.entries(value)) {
      if (path !== "removals") out.push(key); // the removal reasons are data, checked separately
      keysOf(inner, key, out);
    }
  }
  return out;
}

test("the report holds aggregates only: no author, login, email, name, title, branch or body, in keys or values", () => {
  const dirty = node({
    title: "Revert private-title-marker",
    timelineItems: { nodes: [{ __typename: "AddedToMergeQueueEvent" }, { __typename: "RemovedFromMergeQueueEvent", reason: "free text with Real Name" }] },
  });
  const r = report([dirty, node()]);
  const text = JSON.stringify(r) + renderMarkdown(r);
  for (const marker of ["octo-person", "person@example.invalid", "Real Name", "private-title-marker", "private-branch-marker", "secret-body-marker", "feat/"]) {
    assert.equal(text.includes(marker), false, marker);
  }
  const unexpected = keysOf(r).filter((key) => !ALLOWED_KEYS.has(key));
  assert.deepEqual(unexpected, []);
  for (const reason of Object.keys(r.mergeQueue.removals)) assert.ok(REMOVAL_REASONS.has(reason), reason);
  assert.equal(keysOf(r).some((key) => /login|email|author|title|name|body|message|user|sha|url/i.test(key)), false);
});

test("normalizePr keeps only numbers, dates, booleans and slugs, and skips nodes that did not merge", () => {
  const normalized = normalizePr(node({ title: "Revert x" }));
  assert.deepEqual(Object.keys(normalized).sort(), ["createdAt", "enteredQueue", "isRevert", "linesChanged", "mergedAt", "queueRemovals"]);
  assert.equal(normalized.isRevert, true);
  assert.equal(normalizePr({ createdAt: "2026-09-26T00:00:00Z", mergedAt: null }), undefined);
  assert.equal(normalizePr(null), undefined);
});

test("parseArgs takes --days, --json and --out and rejects anything else", () => {
  assert.deepEqual(parseArgs([]), { days: 30, json: false, out: undefined });
  assert.deepEqual(parseArgs(["--days", "7", "--json", "--out", "x"]), { days: 7, json: true, out: "x" });
  assert.throws(() => parseArgs(["--days", "0"]), /--days/);
  assert.throws(() => parseArgs(["--days", "abc"]), /--days/);
  assert.throws(() => parseArgs(["--bogus"]), /Unknown argument/);
});

test("parseArgs rejects a missing value, hex, decimals and a flag swallowed as a value", () => {
  assert.throws(() => parseArgs(["--days"]), /--days/);
  assert.throws(() => parseArgs(["--days", "0x10"]), /--days/);
  assert.throws(() => parseArgs(["--days", "1.5"]), /--days/);
  assert.throws(() => parseArgs(["--days", "366"]), /--days/);
  assert.throws(() => parseArgs(["--days", "--json"]), /--days/);
  assert.throws(() => parseArgs(["--out"]), /--out/);
  assert.throws(() => parseArgs(["--out", "--json"]), /--out/);
});

test("metricsSettings returns config from lanes.config.json metrics block", () => {
  const config = { metrics: { mainWorkflow: "verify.yml", fragmentsDir: null } };
  assert.deepEqual(metricsSettings(config), { mainWorkflow: "verify.yml", fragmentsDir: null });
});

test("metricsSettings returns defaults when metrics block is missing", () => {
  assert.deepEqual(metricsSettings({}), { mainWorkflow: "verify.yml", fragmentsDir: null });
});

test("metricsSettings throws when mainWorkflow is not a non-empty string ending in .yml or .yaml", () => {
  assert.throws(() => metricsSettings({ metrics: { mainWorkflow: "ci" } }), /mainWorkflow/);
  assert.throws(() => metricsSettings({ metrics: { mainWorkflow: "" } }), /mainWorkflow/);
  assert.throws(() => metricsSettings({ metrics: { mainWorkflow: null } }), /mainWorkflow/);
  assert.throws(() => metricsSettings({ metrics: { mainWorkflow: 123 } }), /mainWorkflow/);
});

test("runsErrorMessage formats a helpful error message with the workflow name and (optionally) the API error", () => {
  const msg = runsErrorMessage("verify.yml", "HTTP 404: workflow not found\nother text");
  assert.match(msg, /Could not read runs for workflow "verify.yml"/);
  assert.match(msg, /metrics\.mainWorkflow in lanes\.config\.json/);
  assert.match(msg, /HTTP 404/);

  const msg2 = runsErrorMessage("verify.yml", "");
  assert.match(msg2, /Could not read runs for workflow "verify.yml"/);
  assert.match(msg2, /metrics\.mainWorkflow in lanes\.config\.json/);
  assert.equal(msg2.includes("HTTP"), false);
});

test("safeReason is case-insensitive for slugs and still folds free text", () => {
  assert.equal(safeReason("FAILED_CHECKS"), "failed_checks");
  assert.equal(safeReason("Alice broke it"), "other");
  assert.equal(safeReason(undefined), "other");
});

test("parseGraphql never echoes raw API text in an error", () => {
  assert.throws(() => parseGraphql("secret@example.com not json"), (error) => !/secret/.test(error.message));
  assert.throws(() => parseGraphql(JSON.stringify({ errors: [{ message: "secret@example.com" }] })), (error) => !/secret/.test(error.message));
  const page = { nodes: [], pageInfo: { hasNextPage: false } };
  assert.equal(parseGraphql(JSON.stringify({ data: { repository: { pullRequests: page } } })).nodes.length, 0);
});
