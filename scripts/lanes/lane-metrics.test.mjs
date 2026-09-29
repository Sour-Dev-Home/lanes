import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizeRichPr } from "./delivery-metrics.mjs";
import { normalizePr as normalizeReviewPr } from "./review-metrics.mjs";
import { LOCAL_ONLY, PATH_SHAPES, assertNoPii, buildLaneReport, parseArgs, parseCosts, renderMarkdown, writeOutput } from "./lane-metrics.mjs";

const NOW = new Date("2026-09-28T12:00:00Z");
const schema = JSON.parse(readFileSync("contracts/lane-metrics.schema.json", "utf8"));

// A small validator for the keywords the contract uses (contracts.test.mjs keeps its own private copy).
function accepts(s, value, root = schema) {
  if (s.$ref !== undefined && !accepts(root.$defs[s.$ref.slice("#/$defs/".length)], value, root)) return false;
  const types = [].concat(s.type ?? []);
  const isType = (t) =>
    t === "object" ? value !== null && typeof value === "object" && !Array.isArray(value)
    : t === "array" ? Array.isArray(value)
    : t === "null" ? value === null
    : t === "integer" ? Number.isInteger(value)
    : t === "number" ? typeof value === "number" && Number.isFinite(value)
    : typeof value === t;
  if (types.length && !types.some(isType)) return false;
  if (s.enum && !s.enum.includes(value)) return false;
  if ("const" in s && value !== s.const) return false;
  if (s.minimum !== undefined && !(value >= s.minimum)) return false;
  if (s.maximum !== undefined && !(value <= s.maximum)) return false;
  if (s.pattern !== undefined && !new RegExp(s.pattern).test(value)) return false;
  if (s.items && Array.isArray(value) && !value.every((v) => accepts(s.items, v, root))) return false;
  if (types.includes("object")) {
    if ((s.required ?? []).some((k) => !Object.hasOwn(value, k))) return false;
    for (const [k, v] of Object.entries(value)) {
      const sub = s.properties?.[k];
      if (sub ? !accepts(sub, v, root) : s.additionalProperties === false) return false;
    }
  }
  return true;
}

const issueBody = (scope, contract = "none") => `### Goal\n\nDo it\n\n### Acceptance criteria\n\n- [ ] one\n\n### Interface contract\n\n${contract}\n\n### Scope\n\n${scope}\n\n### Blocked by\n\nnone\n\n### Tier\n\nfull\n`;

// A rich GraphQL node as the API returns it, with the personal fields a careless script could copy through.
const richNode = ({ number, createdAt, mergedAt, files = [], commits = [], statuses = [], attempts = [], scope, edits = [], queue = [], tier, extra = {} }) => ({
  number,
  createdAt,
  mergedAt,
  updatedAt: mergedAt,
  additions: 10,
  deletions: 5,
  title: "feat: private-title-marker",
  author: { login: "octo-person" },
  // queue: [["added" | "removed", time], ...], the merge-queue events with their own times
  timelineItems: { nodes: queue.map(([kind, createdAt]) => (kind === "added" ? { __typename: "AddedToMergeQueueEvent", createdAt } : { __typename: "RemovedFromMergeQueueEvent", reason: "merged", createdAt })) },
  files: { nodes: files.map((path) => ({ path })) },
  commits: { nodes: commits.map((committedDate) => ({ commit: { committedDate } })) },
  lastCommit: {
    nodes: [{
      commit: {
        statusCheckRollup: {
          contexts: {
            nodes: [
              ...statuses.map(([context, state, createdAt]) => ({ __typename: "StatusContext", context, state, createdAt })),
              ...attempts.map((runAttempt) => ({ __typename: "CheckRun", checkSuite: { workflowRun: { runAttempt } } })),
            ],
          },
        },
      },
    }],
  },
  closingIssuesReferences: scope === undefined ? { nodes: [] } : { nodes: [{ number: number + 100, body: issueBody(scope), labels: { nodes: tier === undefined ? [] : [{ name: `tier:${tier}` }] }, userContentEdits: { nodes: edits.map((editedAt) => ({ editedAt })) } }] },
  ...extra,
});

const PR1 = richNode({
  number: 1,
  createdAt: "2026-09-10T00:00:00Z",
  mergedAt: "2026-09-10T10:00:00Z",
  files: ["scripts/lanes/a.mjs", "docs/x.md"],
  commits: ["2026-09-10T00:00:00Z", "2026-09-10T02:00:00Z", "2026-09-10T03:00:00Z"],
  statuses: [
    ["review/ui-reviewer", "failure", "2026-09-10T03:00:00Z"],
    ["review/test-hunter", "success", "2026-09-10T04:00:00Z"],
    ["review/security-reviewer", "success", "2026-09-10T05:00:00Z"],
    ["review/owner", "success", "2026-09-10T07:00:00Z"],
    ["lanes/gate", "success", "2026-09-10T09:30:00Z"],
  ],
  attempts: [2, 1],
  scope: "In: `scripts/lanes/a.mjs`. Out: nothing.",
  edits: ["2026-09-09T00:00:00Z", "2026-09-10T05:00:00Z"],
  queue: [["added", "2026-09-10T09:35:00Z"], ["removed", "2026-09-10T09:50:00Z"]],
  tier: "full",
});
const PR2 = richNode({
  number: 2,
  createdAt: "2026-09-10T05:00:00Z",
  mergedAt: "2026-09-11T00:00:00Z",
  files: ["scripts/lanes/b.mjs"],
  commits: ["2026-09-10T05:00:00Z"],
  scope: "In: `scripts/lanes/`. Out: nothing.",
  tier: "quick",
});
const PR3 = richNode({
  number: 3,
  createdAt: "2026-09-20T00:00:00Z",
  mergedAt: "2026-09-21T00:00:00Z",
  statuses: [["lanes/gate", "failure", "2026-09-20T12:00:00Z"], ["review/owner", "success", "2026-09-20T13:00:00Z"]],
});
const rich = (...nodes) => nodes.map(normalizeRichPr);
const build = (over = {}) => buildLaneReport({ prs: rich(PR1, PR2, PR3), reviewPrs: [], runs: [], now: NOW, days: 28, ...over });

test("the report conforms to the contract and embeds the delivery and review summaries", () => {
  const r = build();
  assert.equal(accepts(schema, r), true);
  assert.equal(r.public, false);
  assert.deepEqual(r.window, { days: 28, from: "2026-08-31T12:00:00.000Z", to: "2026-09-28T12:00:00.000Z" });
  assert.equal(r.delivery.mergedPrs, 3);
  assert.equal(r.delivery.leadTimeHoursMedian, 19); // 10, 19 and 24 hours
  assert.equal(r.delivery.perDay, 0.11);
  assert.deepEqual(r.review, { runs: 0, runsWithoutMetrics: 0, realFindings: 0, minorFindings: 0, tiers: [] });
});

test("the review block is summarised by review-metrics from the verdict comments", () => {
  const v = { reviewer: "test-hunter", verdict: "success", summary: "s", criteria: [], findings: [{ severity: "important", file: "f", line: 1, summary: "x", fixed: true }], metrics: { tier: "full", minutes: 3, tokens: 1000 } };
  const body = `<!-- lanes:verdict test-hunter ${"a".repeat(40)} -->\n\`\`\`json\n${JSON.stringify(v)}\n\`\`\``;
  const reviewPrs = [normalizeReviewPr({ mergedAt: "2026-09-10T10:00:00Z", closingIssuesReferences: { nodes: [{ labels: { nodes: [{ name: "tier:full" }] } }] }, comments: { nodes: [{ body }] } })];
  const r = build({ reviewPrs });
  assert.equal(accepts(schema, r), true);
  assert.deepEqual(r.review, { runs: 1, runsWithoutMetrics: 0, realFindings: 1, minorFindings: 0, tiers: [{ tier: "full", runs: 1, realFindings: 1, noRealFindingShare: 0 }] });
});

test("rework counts gate failures by stage and pushes after the PR opened", () => {
  const { rework } = build();
  assert.equal(rework.prs, 3);
  assert.equal(rework.prsWithGateFailure, 2);
  assert.deepEqual(rework.gateFailuresByStage, [{ stage: "gate", count: 1 }, { stage: "review", count: 1 }]);
  assert.deepEqual(rework.pushesAfterOpen, { count: 3, median: 0, p90: 1.6 }); // 2, 0 and 0 pushes
});

test("scope drift counts changed files outside the closing issue's Scope, for PRs that have one", () => {
  const { scopeDrift } = build();
  assert.equal(scopeDrift.prs, 2); // PR 3 closes no issue, so it is not measured
  assert.equal(scopeDrift.prsWithDrift, 1);
  assert.equal(scopeDrift.driftRate, 0.5);
  assert.deepEqual(scopeDrift.filesOutsideScope, { count: 2, median: 0.5, p90: 0.9 });
});

test("owner time is the wait from the last reviewer success to review/owner success, plus issue edits after open", () => {
  const { ownerTime } = build();
  assert.equal(ownerTime.prsWaited, 1); // PR 3 has no reviewer success
  assert.deepEqual(ownerTime.waitHours, { count: 1, median: 2, p90: 2 }); // 05:00 to 07:00
  assert.deepEqual(ownerTime.interventions, { count: 3, median: 0, p90: 0.8 }); // 1 edit after open on PR 1; the earlier one does not count
});

test("concurrency counts the lane PRs open when each one opened", () => {
  assert.deepEqual(build().concurrency, { maxOpenPrs: 2, medianOpenPrs: 1 });
});

test("friction counts CI reruns and the minutes in the merge queue from the queue events' own times", () => {
  const { friction } = build();
  assert.deepEqual(friction, { prsWithRerun: 1, ciReruns: 1, stuckQueueMinutes: { count: 1, median: 15, p90: 15 } }); // 09:35 to 09:50, not the last status (09:30) to the merge (10:00)
});

test("edge: queue minutes run to the merge when nothing removed the PR, sum re-queues, and skip PRs never queued", () => {
  const at = (h, m = 0) => `2026-09-12T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`;
  const open = (number, queue) => richNode({ number, createdAt: at(0), mergedAt: at(10), queue });
  const prs = rich(
    open(11, [["added", at(9)]]), // merged with no removal event: 60 minutes
    open(12, [["added", at(2)], ["removed", at(2, 10)], ["added", at(3)], ["removed", at(3, 20)]]), // bounced once: 10 + 20
    open(13, []), // never queued
    open(14, [["removed", at(4)]]), // a removal with no add is not a queue stay
  );
  const { friction } = build({ prs });
  assert.deepEqual(friction.stuckQueueMinutes, { count: 2, median: 45, p90: 57 });
});

test("edge: a closing issue with an unrecognised tier label lands in unknown, never as free text", () => {
  const mk = (number, tier) => richNode({ number, createdAt: "2026-09-10T08:00:00Z", mergedAt: "2026-09-10T10:00:00Z", scope: ["a.mjs"], tier });
  const r = build({ prs: rich(mk(21, "secret-customer-name"), mk(22, "fullish"), mk(23, "quick")) });
  assert.equal(accepts(schema, r), true);
  assert.deepEqual(r.byTier.map((t) => t.tier), ["quick", "unknown"]);
  assert.equal(r.byTier[1].rework.prs, 2);
  assert.doesNotMatch(JSON.stringify(r), /secret-customer-name/);
});

test("byTier splits rework, scope drift, owner time and friction by the closing issue's tier, and conforms", () => {
  const r = build();
  assert.equal(accepts(schema, r), true);
  assert.deepEqual(r.byTier.map((t) => t.tier), ["full", "quick", "unknown"]); // PR 3 closes no issue
  const [full, quick, unknown] = r.byTier;
  assert.deepEqual(full.rework.pushesAfterOpen, { count: 1, median: 2, p90: 2 });
  assert.equal(full.rework.prsWithGateFailure, 1);
  assert.deepEqual(full.scopeDrift.filesOutsideScope, { count: 1, median: 1, p90: 1 });
  assert.deepEqual(full.ownerTime.waitHours, { count: 1, median: 2, p90: 2 });
  assert.deepEqual(full.friction.stuckQueueMinutes, { count: 1, median: 15, p90: 15 });
  assert.equal(quick.rework.prs, 1);
  assert.deepEqual(quick.friction.stuckQueueMinutes, { count: 0, median: null, p90: null });
  assert.equal(unknown.scopeDrift.prs, 0);
  assert.equal(unknown.rework.prsWithGateFailure, 1);
  assert.deepEqual(Object.keys(full).sort(), ["friction", "ownerTime", "rework", "scopeDrift", "tier"]);
});

test("edge: an empty window has no byTier rows, and split sides carry their own", () => {
  assert.deepEqual(build({ prs: [] }).byTier, []);
  const r = build({ split: "2026-09-15" });
  assert.equal(accepts(schema, r), true);
  assert.deepEqual(r.split[0].before.byTier.map((t) => t.tier), ["full", "quick"]);
  assert.deepEqual(r.split[0].after.byTier.map((t) => t.tier), ["unknown"]);
});

test("the markdown shows p90 and a by-tier table, and stays aggregate-only", () => {
  const md = renderMarkdown(build());
  assert.match(md, /median 0, p90 1\.6 over 3/);
  assert.match(md, /## By tier/);
  assert.match(md, /\| full \| 1 \|/);
  assert.doesNotMatch(md, /octo-person|private-title-marker/);
});

test("an empty window gives zero counts and null medians, and still conforms", () => {
  const r = build({ prs: [] });
  assert.equal(accepts(schema, r), true);
  assert.deepEqual(r.concurrency, { maxOpenPrs: 0, medianOpenPrs: null });
  assert.deepEqual(r.scopeDrift, { prs: 0, prsWithDrift: 0, driftRate: null, filesOutsideScope: { count: 0, median: null, p90: null } });
  assert.deepEqual(r.rework.gateFailuresByStage, []);
});

test("edge: a PR merged outside the window is ignored, and one merged at the window start is kept", () => {
  const atStart = richNode({ number: 9, createdAt: "2026-08-30T00:00:00Z", mergedAt: "2026-08-31T12:00:00Z" });
  const before = richNode({ number: 8, createdAt: "2026-08-30T00:00:00Z", mergedAt: "2026-08-31T11:59:59Z" });
  assert.equal(build({ prs: rich(atStart, before) }).rework.prs, 1);
});

test("edge: undefined nodes, a status with no timestamp and a garbage attempt are skipped", () => {
  const odd = richNode({ number: 4, createdAt: "2026-09-10T00:00:00Z", mergedAt: "2026-09-10T01:00:00Z", statuses: [["review/owner", "success", "not a date"]], attempts: [0, "x", 3] });
  const r = build({ prs: [undefined, ...rich(odd)] });
  assert.equal(r.rework.prs, 1);
  assert.equal(r.friction.ciReruns, 2);
  assert.equal(r.ownerTime.prsWaited, 0);
});

// ---- --split ----

test("--split buckets by merge time: a PR merged at the split instant is after, one second earlier is before", () => {
  const on = richNode({ number: 5, createdAt: "2026-09-14T00:00:00Z", mergedAt: "2026-09-15T00:00:00Z" });
  const early = richNode({ number: 6, createdAt: "2026-09-14T00:00:00Z", mergedAt: "2026-09-14T23:59:59Z" });
  const r = build({ prs: rich(on, early, PR3), split: "2026-09-15" });
  assert.equal(accepts(schema, r), true);
  assert.equal(r.split.length, 1);
  assert.equal(r.split[0].date, "2026-09-15");
  assert.equal(r.split[0].before.delivery.mergedPrs, 1);
  assert.equal(r.split[0].after.delivery.mergedPrs, 2);
  assert.equal(r.split[0].before.rework.prs + r.split[0].after.rework.prs, 3);
  assert.equal(Object.hasOwn(r.split[0].before, "per-pr"), false);
});

test("--split sides get their own review summary, cut at the same instant", () => {
  const comment = (name) => {
    const v = { reviewer: name, verdict: "success", summary: "s", criteria: [], findings: [] };
    return `<!-- lanes:verdict ${name} ${"a".repeat(40)} -->\n\`\`\`json\n${JSON.stringify(v)}\n\`\`\``;
  };
  const pr = (mergedAt) => normalizeReviewPr({ mergedAt, closingIssuesReferences: { nodes: [] }, comments: { nodes: [{ body: comment("test-hunter") }] } });
  const r = build({ reviewPrs: [pr("2026-09-14T23:59:59Z"), pr("2026-09-15T00:00:00Z"), pr("2026-09-16T00:00:00Z")], split: "2026-09-15" });
  assert.equal(r.review.runs, 3);
  assert.equal(r.split[0].before.review.runs, 1);
  assert.equal(r.split[0].after.review.runs, 2);
});

test("--split outside the window, or in the future, is refused", () => {
  assert.throws(() => build({ split: "2026-08-01" }), /--split/);
  assert.throws(() => build({ split: "2026-10-01" }), /--split/);
});

// ---- costs.jsonl, local only ----

const cost = (over = {}) => JSON.stringify({ issue: 7, tier: "full", sessionId: "s1", model: "claude-sonnet-5-5", tokens: { total: 1000 }, launchedAt: "2026-09-10T00:00:00.000Z", removedAt: "2026-09-10T02:00:00.000Z", ...over });

test("costs.jsonl adds tokens per tier and model, relaunches and lane-hours", () => {
  const text = [
    cost(),
    cost({ issue: 8, tier: "quick", model: "claude-haiku-4-5-20251001", tokens: { total: 50 }, launchedAt: "2026-09-11T00:00:00.000Z", removedAt: "2026-09-11T04:00:00.000Z" }),
    cost({ issue: 7, sessionId: "s2", model: "claude-sonnet-5-5", tokens: { total: 500 }, launchedAt: "2026-09-10T03:00:00.000Z", removedAt: "2026-09-10T05:00:00.000Z" }),
    cost({ issue: 9, tier: null, model: "something else", tokens: null }),
  ].join("\n");
  const r = build({ costsText: text });
  assert.equal(accepts(schema, r), true);
  assert.deepEqual(r.tokensByTierAndModel, [
    { tier: "full", model: "sonnet", tokens: 1500 },
    { tier: "quick", model: "haiku", tokens: 50 },
  ]);
  assert.equal(r.relaunches, 1); // issue 7 had two sessions
  assert.deepEqual(r.laneHours, { count: 4, median: 2, p90: 3.4 });
});

test("a lane whose transcript mixed model families is reported as unknown, not guessed", () => {
  const r = build({ costsText: cost({ model: "claude-sonnet-5-5,claude-opus-5-5" }) });
  assert.deepEqual(r.tokensByTierAndModel, [{ tier: "full", model: "unknown", tokens: 1000 }]);
});

test("costs lines outside the window are ignored; --split divides the local fields too", () => {
  const text = [cost({ removedAt: "2026-07-01T00:00:00.000Z" }), cost({ removedAt: "2026-09-16T00:00:00.000Z", launchedAt: "2026-09-16T00:00:00.000Z" })].join("\n");
  const r = build({ costsText: text, split: "2026-09-15" });
  assert.equal(r.laneHours.count, 1);
  assert.equal(Object.hasOwn(r.split[0].before, "tokensByTierAndModel"), true);
  assert.deepEqual(r.split[0].before.tokensByTierAndModel, []);
  assert.equal(r.split[0].after.tokensByTierAndModel[0].tokens, 1000);
});

test("a missing costs file leaves the local fields absent, never zeroed", () => {
  const r = build();
  for (const k of LOCAL_ONLY) assert.equal(Object.hasOwn(r, k), false);
});

test("a malformed costs file skips the bad lines, counts them, and still reports the good ones", () => {
  const { lines, skipped } = parseCosts(`${cost()}\nnot json\n{"removedAt":"nope"}\n[1]\n\n${cost({ issue: 2 })}`);
  assert.equal(lines.length, 2);
  assert.equal(skipped, 3);
  const all = parseCosts("garbage\nmore garbage");
  assert.deepEqual(all, { lines: [], skipped: 2 });
  const r = build({ costsText: "garbage" });
  assert.equal(accepts(schema, r), true);
  assert.deepEqual(r.tokensByTierAndModel, []);
  assert.equal(r.relaunches, 0);
  assert.deepEqual(r.laneHours, { count: 0, median: null, p90: null });
});

test("edge: negative and non-numeric token totals count as zero, and a removal before the launch is skipped for lane-hours", () => {
  const text = [cost({ tokens: { total: -5 } }), cost({ issue: 3, tokens: { total: "9" }, removedAt: "2026-09-09T00:00:00.000Z" })].join("\n");
  const r = build({ costsText: text });
  assert.deepEqual(r.tokensByTierAndModel, [{ tier: "full", model: "sonnet", tokens: 0 }]);
  assert.deepEqual(r.laneHours, { count: 1, median: 2, p90: 2 });
});

test("--public leaves the local fields out entirely, even with a costs file, and sets public: true", () => {
  const r = build({ costsText: cost(), publicMode: true, split: "2026-09-15" });
  assert.equal(r.public, true);
  assert.equal(accepts(schema, r), true);
  for (const k of LOCAL_ONLY) {
    assert.equal(Object.hasOwn(r, k), false, k);
    assert.equal(Object.hasOwn(r.split[0].before, k), false, k);
    assert.equal(Object.hasOwn(r.split[0].after, k), false, k);
  }
});

// ---- the PII / local path check ----

const EMAIL = "someone@example.com";
const LOGIN = "octo-person";
const LOCAL_PATH = `${PATH_SHAPES[0]}\\me\\repo`;

// The metrics module may not import preflight (lanes.config.json), so its five shapes are listed here and checked by behaviour.
test("every local path shape the preflight check rejects is refused", () => {
  assert.equal(PATH_SHAPES.length, 5);
  for (const shape of PATH_SHAPES) assert.throws(() => assertNoPii(`x ${shape}me`), /local path/);
  assert.throws(() => assertNoPii(`x ${PATH_SHAPES[0].toLowerCase()}`), /local path/);
});

test("assertNoPii refuses an email, a login and a local path, without echoing what it found", () => {
  const options = { logins: [LOGIN] };
  for (const [what, text] of [["an email", `x ${EMAIL} y`], ["a login", `by ${LOGIN}`], ["a local path", `at ${LOCAL_PATH}`], ["a mention", "thanks @somebody"]]) {
    assert.throws(() => assertNoPii(text, options), (err) => new RegExp(what.replace("an ", "").replace("a ", ""), "i").test(err.message) && !err.message.includes(EMAIL) && !err.message.includes(LOGIN) && !err.message.includes(LOCAL_PATH));
  }
  assert.doesNotThrow(() => assertNoPii('{"rework":{"prs":3}}', options));
  assert.throws(() => assertNoPii(`BY ${LOGIN.toUpperCase()}`, options), /login/);
});

test("--public output never contains an email, a login or a local path, even when the inputs do", () => {
  const dirty = richNode({
    number: 11,
    createdAt: "2026-09-10T00:00:00Z",
    mergedAt: "2026-09-10T10:00:00Z",
    files: [`${LOCAL_PATH}/x.mjs`, "a.mjs"],
    statuses: [[`review/${LOGIN}`, "failure", "2026-09-10T03:00:00Z"], [`ctx ${EMAIL}`, "failure", "2026-09-10T03:00:00Z"]],
    scope: `In: \`${LOCAL_PATH}\` ${EMAIL}`,
    extra: { title: `Fix for ${EMAIL} by ${LOGIN}`, author: { login: LOGIN, email: EMAIL }, headRefName: LOCAL_PATH },
  });
  const costsText = cost({ model: `${LOGIN} ${EMAIL}`, reason: LOCAL_PATH, sessionId: LOGIN });
  const r = build({ prs: rich(dirty), costsText, publicMode: true });
  for (const output of [JSON.stringify(r), renderMarkdown(r)]) {
    assert.doesNotThrow(() => assertNoPii(output, { logins: [LOGIN] }));
    assert.equal(output.includes(EMAIL) || output.includes(LOGIN) || output.includes(LOCAL_PATH), false);
  }
});

test("--out refuses to write output that holds an email, a login or a local path, and writes nothing", () => {
  const writes = [];
  const write = (file, text) => writes.push([file, text]);
  for (const bad of [EMAIL, LOGIN, LOCAL_PATH]) {
    assert.throws(() => writeOutput("out.json", `{"x":"${bad.replaceAll("\\", "\\\\")}"}`, { logins: [LOGIN], write }), /refus/i);
  }
  assert.deepEqual(writes, []);
  writeOutput("out.json", '{"ok":1}\n', { logins: [LOGIN], write });
  assert.deepEqual(writes, [["out.json", '{"ok":1}\n']]);
});

// ---- rendering and arguments ----

test("the markdown is derived from the report and names the window, the axes and the local fields when present", () => {
  const md = renderMarkdown(build({ costsText: cost(), split: "2026-09-15" }));
  for (const heading of ["# Lane metrics", "## Rework", "## Scope drift", "## Owner time", "## Concurrency", "## Friction", "## Tokens", "## Split at 2026-09-15"]) assert.match(md, new RegExp(heading));
  const pub = renderMarkdown(build({ costsText: cost(), publicMode: true }));
  assert.doesNotMatch(pub, /## Tokens|relaunch|lane-hours/i);
});

test("parseArgs reads the documented flags and rejects the rest", () => {
  assert.deepEqual(parseArgs([]), { days: 28, split: undefined, public: false, format: "markdown", out: undefined });
  assert.deepEqual(parseArgs(["--days", "7", "--split", "2026-09-15", "--public", "--json", "--out", "f.json"]), { days: 7, split: "2026-09-15", public: true, format: "json", out: "f.json" });
  assert.equal(parseArgs(["--markdown"]).format, "markdown");
  for (const bad of [["--days", "0"], ["--days", "x"], ["--days", "366"], ["--split"], ["--split", "2026-13-40"], ["--split", "15-09-2026"], ["--json", "--markdown"], ["--out"], ["--out", "--json"], ["--bogus"]]) {
    assert.throws(() => parseArgs(bad), Error, bad.join(" "));
  }
});

// ---- extra edge cases (test-hunter) ----

test("edge: failed statuses map to the stage allowlist, and an unknown or error-state context is reported as failing", () => {
  const pr = richNode({
    number: 20,
    createdAt: "2026-09-10T00:00:00Z",
    mergedAt: "2026-09-10T10:00:00Z",
    statuses: [["review/owner", "failure", "2026-09-10T01:00:00Z"], ["some/other-check", "error", "2026-09-10T01:00:00Z"], ["lanes/gate", "pending", "2026-09-10T01:00:00Z"]],
  });
  const r = build({ prs: rich(pr) });
  assert.deepEqual(r.rework.gateFailuresByStage, [{ stage: "owner", count: 1 }, { stage: "failing", count: 1 }]);
  assert.equal(accepts(schema, r), true);
});

test("edge: a PR merged exactly at now counts, and a split exactly at now is accepted", () => {
  const now = new Date("2026-09-28T00:00:00Z");
  const pr = richNode({ number: 21, createdAt: "2026-09-27T00:00:00Z", mergedAt: "2026-09-28T00:00:00Z" });
  const r = buildLaneReport({ prs: rich(pr), now, days: 28, split: "2026-09-28" });
  assert.equal(r.rework.prs, 1);
  assert.equal(r.split[0].after.rework.prs, 1); // merged at the split instant is after
  assert.equal(r.split[0].before.rework.prs, 0);
  assert.equal(accepts(schema, r), true);
});

test("edge: non-finite token totals and non-integer issues in costs lines do not crash or poison the totals", () => {
  const text = [cost({ tokens: { total: 1e999 } }), cost({ issue: "7", sessionId: "x" }), cost({ issue: 1.5 }), cost({ tier: "bogus", tokens: { total: 4.6 } })].join("\n");
  const r = build({ costsText: text });
  assert.equal(accepts(schema, r), true);
  assert.equal(r.relaunches, 0);
  assert.ok(r.tokensByTierAndModel.every((row) => Number.isInteger(row.tokens)));
});
