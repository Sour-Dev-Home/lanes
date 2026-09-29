import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { REASONS, costLine, projectFolder, recordLaneCost, render, sessionUsage, summarize } from "./lane-cost.mjs";

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
  assert.equal(projectFolder("C:\\Users\\Me\\my.repo"), "C--Users-Me-my-repo");
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
