import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { REASONS, budgetReport, costLine, loadBudget, mainCheckout, projectFolder, recordLaneCost, render, sessionUsage, spentSince, summarize } from "./lane-cost.mjs";

const msg = (id, usage, model = "claude-opus-5-5", role = "assistant") =>
  JSON.stringify({ message: { id, role, model, usage } });
const u = (input, output, cacheRead = 0, cacheCreation = 0) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheCreation,
});

test("sessionUsage sums the four token kinds and lists the models", () => {
  const r = sessionUsage([msg("a", u(1, 2, 3, 4)), msg("b", u(10, 20, 30, 40), "claude-sonnet-5-5")].join("\n"));
  assert.deepEqual(r, { input: 11, output: 22, cacheRead: 33, cacheCreation: 44, total: 110, messages: 2, models: ["claude-opus-5-5", "claude-sonnet-5-5"] });
});

test("sessionUsage counts a duplicated message id once, keeping its last usage", () => {
  const r = sessionUsage([msg("a", u(1, 5)), msg("a", u(1, 9)), msg("b", u(2, 2))].join("\n"));
  assert.equal(r.output, 11);
  assert.equal(r.messages, 2);
});

test("sessionUsage skips lines with no usage and user lines", () => {
  const r = sessionUsage([JSON.stringify({ type: "summary" }), JSON.stringify({ message: { id: "x", role: "assistant" } }), msg("u1", u(9, 9), "m", "user"), msg("a", u(1, 1))].join("\n"));
  assert.equal(r.total, 2);
});

test("sessionUsage skips a malformed line and still counts the rest", () => {
  const r = sessionUsage(["{not json", msg("a", u(3, 4)), ""].join("\n"));
  assert.equal(r.total, 7);
});

test("edge: sessionUsage on empty, non-string and non-numeric usage", () => {
  assert.equal(sessionUsage("").total, 0);
  assert.equal(sessionUsage(undefined).messages, 0);
  assert.equal(sessionUsage(msg("a", { input_tokens: "5", output_tokens: -3, cache_read_input_tokens: null })).total, 0);
});

test("edge: sessionUsage counts messages with no id separately and ignores synthetic models", () => {
  const r = sessionUsage([msg(undefined, u(1, 1), "<synthetic>"), msg(undefined, u(1, 1))].join("\n"));
  assert.equal(r.messages, 2);
  assert.deepEqual(r.models, ["claude-opus-5-5"]);
});

test("projectFolder replaces every non-alphanumeric character", () => {
  assert.equal(projectFolder("D:\\work\\my.repo"), "D--work-my-repo");
  assert.equal(projectFolder("/srv/my.repo"), "-srv-my-repo");
});

const lane = { issue: 7, tier: "full", sessionId: "abc-123", startedAt: Date.UTC(2026, 8, 1), root: "/r/x", now: () => Date.UTC(2026, 8, 2), home: "/h" };

test("costLine reads <home>/.claude/projects/<folder>/<session>.jsonl and totals it", () => {
  let asked;
  const line = costLine({ ...lane, read: (f) => ((asked = f), msg("a", u(1, 2, 3, 4))) });
  assert.match(asked.replace(/\\/g, "/"), /\/h\/\.claude\/projects\/-r-x\/abc-123\.jsonl$/);
  assert.deepEqual(line, {
    issue: 7, tier: "full", sessionId: "abc-123", model: "claude-opus-5-5",
    launchedAt: "2026-09-01T00:00:00.000Z", removedAt: "2026-09-02T00:00:00.000Z",
    tokens: { input: 1, output: 2, cacheRead: 3, cacheCreation: 4, total: 10 },
  });
});

test("costLine falls back to the session's cwd folder when the root's folder has no transcript (real Claude Code layout)", () => {
  const asked = [];
  const read = (f) => {
    asked.push(f.replace(/\\/g, "/"));
    if (asked.length === 1) throw Object.assign(new Error("x"), { code: "ENOENT" });
    return msg("a", u(1, 2));
  };
  const line = costLine({ ...lane, cwd: "/r/x/.claude/worktrees/issue-7", read });
  assert.equal(asked.length, 2);
  assert.match(asked[1], /projects\/-r-x--claude-worktrees-issue-7\/abc-123\.jsonl$/);
  assert.equal(line.tokens.total, 3);
  // both missing: still tokens null with the fixed reason, and nothing of either path in the line
  const none = costLine({ ...lane, cwd: "/r/x/wt", read: () => { throw Object.assign(new Error("x"), { code: "ENOENT" }); } });
  assert.deepEqual([none.tokens, none.reason], [null, REASONS.missing]);
});

test("costLine with a missing transcript gives tokens null and a fixed reason", () => {
  const line = costLine({ ...lane, read: () => { throw Object.assign(new Error("ENOENT: C:\\secret\\path"), { code: "ENOENT" }); } });
  assert.equal(line.tokens, null);
  assert.equal(line.reason, REASONS.missing);
  assert.doesNotMatch(JSON.stringify(line), /secret/);
});

test("edge: costLine with an unreadable, empty or id-less session", () => {
  assert.equal(costLine({ ...lane, read: () => { throw Object.assign(new Error("x"), { code: "EACCES" }); } }).reason, REASONS.unreadable);
  assert.equal(costLine({ ...lane, read: () => "" }).reason, REASONS.unreadable);
  const none = costLine({ ...lane, sessionId: "../evil", read: () => assert.fail("must not read") });
  assert.equal(none.reason, REASONS.noSession);
  assert.equal(none.sessionId, null);
  assert.equal(costLine({ ...lane, startedAt: undefined, tier: undefined, read: () => "" }).launchedAt, null);
});

test("mainCheckout finds the main checkout from a plain checkout, a worktree and a subfolder", () => {
  const dirs = new Set([resolve("/m/.git")]);
  const isDir = (p) => dirs.has(resolve(p));
  const read = (f) => {
    if (resolve(f) === resolve("/m/.claude/worktrees/w/.git")) return `gitdir: ${resolve("/m/.git/worktrees/w")}\n`;
    throw Object.assign(new Error("nope"), { code: "ENOENT" });
  };
  assert.equal(mainCheckout("/m", { read, isDir }), resolve("/m"));
  assert.equal(mainCheckout("/m/scripts/lanes", { read, isDir }), resolve("/m"));
  assert.equal(mainCheckout("/m/.claude/worktrees/w", { read, isDir }), resolve("/m"));
  assert.equal(mainCheckout("/m/.claude/worktrees/w/src", { read, isDir }), resolve("/m"));
});

test("edge: mainCheckout falls back to the folder itself outside any repository", () => {
  assert.equal(mainCheckout("/nowhere/x", { read: () => { throw new Error("x"); }, isDir: () => false }), resolve("/nowhere/x"));
});

test("edge: costLine keeps only a known tier and caps the model string", () => {
  assert.equal(costLine({ ...lane, tier: "weird\ntier", read: () => "" }).tier, null);
  const long = costLine({ ...lane, read: () => msg("a", u(1, 1), "m".repeat(500)) });
  assert.equal(long.model.length, 100);
});

test("edge: costLine does not read a transcript over the size cap", () => {
  const big = costLine({ ...lane, read: () => { throw Object.assign(new Error("transcript too large"), { code: "E2BIG" }); } });
  assert.equal(big.tokens, null);
  assert.equal(big.reason, REASONS.unreadable);
});

test("recordLaneCost appends one line per call under .lanes/costs.jsonl with only the known fields", () => {
  const root = mkdtempSync(join(tmpdir(), "lane-cost-"));
  try {
    recordLaneCost(lane, { root, read: () => msg("a", u(1, 1)) });
    recordLaneCost(lane, { root, read: () => { throw Object.assign(new Error("p"), { code: "ENOENT" }); } });
    const lines = readFileSync(join(root, ".lanes", "costs.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.deepEqual(Object.keys(lines[0]).sort(), ["issue", "launchedAt", "model", "removedAt", "sessionId", "tier", "tokens"]);
    assert.equal(lines[1].tokens, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const NOW = Date.UTC(2026, 8, 28);
const row = (tier, total, daysAgo) =>
  JSON.stringify({ issue: 1, tier, tokens: total === null ? null : { total }, removedAt: new Date(NOW - daysAgo * 86_400_000).toISOString() });

test("summarize reports, per tier, lane count, median and total tokens and lanes without a transcript", () => {
  const text = [row("full", 100, 1), row("full", 300, 2), row("full", 200, 3), row("full", null, 1), row("quick", 50, 1), row("full", 999, 20), "garbage"].join("\n");
  assert.deepEqual(summarize(text, { days: 7, now: NOW }), [
    { tier: "full", lanes: 4, noTranscript: 1, medianTokens: 200, totalTokens: 600 },
    { tier: "quick", lanes: 1, noTranscript: 0, medianTokens: 50, totalTokens: 50 },
  ]);
});

test("edge: summarize puts an unknown tier last, and a tier with only missing transcripts has no median", () => {
  const rows = summarize([row(null, 10, 1), row("skip", null, 1)].join("\n"), { days: 7, now: NOW });
  assert.deepEqual(rows.map((r) => r.tier), ["skip", "unknown"]);
  assert.equal(rows[0].medianTokens, null);
  assert.deepEqual(summarize("", { days: 7, now: NOW }), []);
});

test("render prints one line per tier, and a line for an empty window", () => {
  const text = render(summarize([row("full", 100, 1), row("full", null, 1)].join("\n"), { days: 7, now: NOW }), 7);
  assert.match(text, /full: 2 lanes, median 100 tokens, total 100 tokens, 1 without a transcript/);
  assert.match(render([], 7), /no lanes recorded/);
});

// #390
const BNOW = Date.parse("2026-09-29T12:00:00Z");
const cost = (hoursAgo, total) => JSON.stringify({ issue: 1, removedAt: new Date(BNOW - hoursAgo * 3_600_000).toISOString(), tokens: total === null ? null : { total } });
const enoent = () => Object.assign(new Error("x"), { code: "ENOENT" });

test("spentSince sums the lanes removed in the last 24 hours only", () => {
  const text = [cost(1, 100), cost(23, 200), cost(25, 400), cost(-1, 800)].join("\n");
  assert.equal(spentSince(text, { now: BNOW }), 300);
});

test("edge: spentSince skips bad lines, null tokens and empty text", () => {
  assert.equal(spentSince([cost(1, null), "not json", "", cost(2, 50)].join("\n"), { now: BNOW }), 50);
  assert.equal(spentSince("", { now: BNOW }), 0);
  assert.equal(spentSince(undefined, { now: BNOW }), 0);
});

test("edge: spentSince includes a lane removed exactly 24 h ago and excludes one a millisecond older", () => {
  const at = JSON.stringify({ removedAt: new Date(BNOW - 24 * 3_600_000).toISOString(), tokens: { total: 5 } });
  const past = JSON.stringify({ removedAt: new Date(BNOW - 24 * 3_600_000 - 1).toISOString(), tokens: { total: 7 } });
  assert.equal(spentSince([at, past].join("\n"), { now: BNOW }), 5);
});

test("edge: budgetReport with no running lanes and a lane exactly at its cap", () => {
  const r = budgetReport({ removedSpent: 10, live: new Map([[1, 5]]), perNightTokens: 10, perLaneTokens: 5 });
  assert.equal(r.over, true, "10 + 5 passes 10");
  assert.deepEqual(r.lanesOver, [], "exactly at the lane cap is not over");
  assert.equal(budgetReport({ removedSpent: 10, live: new Map(), perNightTokens: 10, perLaneTokens: 5 }).over, false);
});

test("budgetReport adds live totals, is over only past the cap, and lists lanes past their own cap", () => {
  const args = { perNightTokens: 1000, perLaneTokens: 300 };
  const under = budgetReport({ ...args, removedSpent: 400, live: new Map([[7, 300], [5, 200]]) });
  assert.deepEqual(under, { spent24h: 900, perNightTokens: 1000, over: false, lanesOver: [] });
  const at = budgetReport({ ...args, removedSpent: 500, live: new Map([[7, 300], [5, 200]]) });
  assert.equal(at.over, false, "exactly at the cap is not over");
  const over = budgetReport({ ...args, removedSpent: 500, live: new Map([[9, 301], [4, 400], [5, 200]]) });
  assert.equal(over.over, true);
  assert.deepEqual(over.lanesOver, [4, 9]);
});

test("loadBudget sums costs.jsonl and running transcripts, and reports a lane over its cap", () => {
  const files = { s1: msg("a", u(50, 50)), s2: msg("b", u(10, 10)) };
  const r = loadBudget({
    root: "/repo",
    lanes: [{ issue: 3, sessionId: "s1", cwd: "/repo/wt" }, { issue: 4, sessionId: "s2", cwd: "/repo/wt2" }],
    perNightTokens: 5000,
    perLaneTokens: 50,
    now: BNOW,
    home: "/home",
    readCosts: () => cost(2, 1000),
    read: (f) => files[/([^/\\]+)\.jsonl$/.exec(f)[1]],
  });
  assert.deepEqual(r, { spent24h: 1120, perNightTokens: 5000, over: false, lanesOver: [3] });
});

const tooBig = (size) => () => { throw Object.assign(new Error("transcript too large"), { code: "E2BIG", size }); };

test("an oversized running transcript counts as over its lane cap and adds a size estimate", () => {
  const r = loadBudget({
    root: "/repo",
    lanes: [{ issue: 8, sessionId: "s1" }],
    perNightTokens: 1000,
    perLaneTokens: 50,
    now: BNOW,
    readCosts: () => cost(2, 100),
    read: tooBig(4000),
  });
  assert.deepEqual(r.lanesOver, [8]);
  assert.equal(r.spent24h, 100 + 1000, "size / 4 bytes per token");
  assert.equal(r.over, true);
  assert.match(r.note, /1 running lane transcript over the read cap, estimated from its size/);
  assert.doesNotMatch(r.note, /unreadable/);
});

test("edge: an oversized transcript with no size still counts as over the lane cap", () => {
  const r = loadBudget({ root: "/repo", lanes: [{ issue: 8, sessionId: "s1" }], perNightTokens: 10, perLaneTokens: 5_000_000, now: BNOW, readCosts: () => "", read: tooBig(undefined) });
  assert.deepEqual(r.lanesOver, [8]);
  assert.ok(r.spent24h > 5_000_000);
});

test("edge: a tiny size estimate is raised to just past the lane cap", () => {
  const r = loadBudget({ root: "/repo", lanes: [{ issue: 8, sessionId: "s1" }], perNightTokens: 1e9, perLaneTokens: 500, now: BNOW, readCosts: () => "", read: tooBig(8) });
  assert.deepEqual(r.lanesOver, [8]);
  assert.equal(r.spent24h, 501);
});

test("edge: a missing costs file counts as 0 with a note", () => {
  const r = loadBudget({ root: "/repo", perNightTokens: 10, perLaneTokens: 5, now: BNOW, readCosts: () => { throw enoent(); } });
  assert.equal(r.spent24h, 0);
  assert.equal(r.over, false);
  assert.match(r.note, /no \.lanes\/costs\.jsonl yet/);
});

test("edge: an unreadable costs file and unreadable transcripts count as 0 and say so, without a path", () => {
  const r = loadBudget({
    root: "/repo",
    lanes: [{ issue: 3, sessionId: "s1" }, { issue: 4 }],
    perNightTokens: 10,
    perLaneTokens: 5,
    now: BNOW,
    readCosts: () => { throw Object.assign(new Error("x"), { code: "EACCES" }); },
    read: () => { throw enoent(); },
  });
  assert.equal(r.spent24h, 0);
  assert.match(r.note, /costs\.jsonl unreadable/);
  assert.match(r.note, /2 running lane transcripts unreadable/);
  assert.doesNotMatch(r.note, /\/repo|EACCES/);
});

test("edge: the installed status.mjs and lane-cost.mjs never import the launcher, which re-exports the same budgetConfig", async () => {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const launcher = "./start" + ".mjs";
  for (const file of ["status.mjs", "lane-cost.mjs"]) assert.equal(readFileSync(join(here, file), "utf8").includes(`from "${launcher}"`), false, file);
  const start = await import(launcher);
  const cost = await import("./lane-cost.mjs");
  assert.equal(start.budgetConfig, cost.budgetConfig);
  assert.equal(start.BUDGET_DEFAULTS, cost.BUDGET_DEFAULTS);
});
