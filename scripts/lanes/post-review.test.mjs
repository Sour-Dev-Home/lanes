// scripts/lanes/post-review.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildStatus, buildVerdictComment, checkSha, metricsWarning, parseArgs, validateVerdict } from "./post-review.mjs";

test("skipped is a success whose description starts with skipped", () => {
  assert.deepEqual(buildStatus("ui-reviewer", "skipped", "no visible change"), { context: "review/ui-reviewer", state: "success", description: "skipped: no visible change" });
});

test("a reviewer's success or failure must come as a JSON verdict", () => {
  assert.throws(() => buildStatus("test-hunter", "success", "x"), /--file/);
  assert.throws(() => buildStatus("test-hunter", "failure", "x"), /--file/);
});

test("unknown reviewer and empty summary are refused", () => {
  assert.throws(() => buildStatus("me", "skipped", "x"), /reviewer/);
  assert.throws(() => buildStatus("test-hunter", "skipped", "  "), /summary/);
});

test("the owner can only approve", () => {
  assert.equal(buildStatus("owner", "success", "approved").context, "review/owner");
  assert.throws(() => buildStatus("owner", "skipped", "x"), /owner/);
});

test("descriptions are cut to 140 characters", () => {
  assert.equal(buildStatus("test-hunter", "skipped", "x".repeat(200)).description.length, 140);
});

const verdict = (over = {}) => ({
  reviewer: "test-hunter",
  verdict: "success",
  summary: "4 tests added, 1 bug fixed",
  criteria: [
    { index: 1, result: "pass", evidence: "rejects a duplicate name" },
    { index: 2, result: "not-applicable", evidence: "no UI in this change" },
  ],
  findings: [{ severity: "important", file: "src/a.mjs", line: 3, summary: "off by one", fixed: true }],
  ...over,
});

test("a valid verdict becomes a status with derived counts", () => {
  assert.deepEqual(validateVerdict(verdict(), { criteriaCount: 2 }), {
    ok: true,
    errors: [],
    status: { context: "review/test-hunter", state: "success", description: "1/2 criteria pass, 1 fixed: 4 tests added, 1 bug fixed" },
  });
});

test("the test-hunter and ui-reviewer must assess every criterion exactly once", () => {
  assert.match(validateVerdict(verdict({ criteria: [verdict().criteria[0]] }), { criteriaCount: 2 }).errors.join(), /all 2 criteria/);
  const dup = [verdict().criteria[0], verdict().criteria[0]];
  assert.match(validateVerdict(verdict({ criteria: dup }), { criteriaCount: 2 }).errors.join(), /appears twice/);
  const out = [{ index: 3, result: "pass", evidence: "x" }];
  assert.match(validateVerdict(verdict({ criteria: out }), { criteriaCount: 2 }).errors.join(), /not 1\.\.2/);
});

test("success is refused with a failing criterion or an unfixed important finding", () => {
  const failing = [{ index: 1, result: "fail", evidence: "x" }, verdict().criteria[1]];
  assert.match(validateVerdict(verdict({ criteria: failing }), { criteriaCount: 2 }).errors.join(), /a criterion fails/);
  const open = [{ severity: "important", summary: "leak", fixed: false }];
  assert.match(validateVerdict(verdict({ findings: open }), { criteriaCount: 2 }).errors.join(), /unfixed/);
  assert.equal(validateVerdict(verdict({ verdict: "failure", findings: open }), { criteriaCount: 2 }).status.state, "failure");
});

test("an unfixed minor finding does not block success", () => {
  assert.equal(validateVerdict(verdict({ findings: [{ severity: "minor", summary: "naming", fixed: false }] }), { criteriaCount: 2 }).ok, true);
});

test("the security reviewer may leave criteria empty", () => {
  const r = validateVerdict(verdict({ reviewer: "security-reviewer", criteria: [], findings: [] }), { criteriaCount: 2 });
  assert.equal(r.ok, true);
  assert.equal(r.status.description, "0 fixed: 4 tests added, 1 bug fixed");
});

// M1 + T7: strict argument parsing, so a malformed command line cannot reach the owner form without a prompt
test("--file takes a value and then no positional arguments", () => {
  assert.deepEqual(parseArgs(["--file", "v.json"]), { file: "v.json", pr: undefined, sha: undefined, positional: [] });
  assert.throws(() => parseArgs(["--file", "v.json", "extra"]), /positional/);
  assert.throws(() => parseArgs(["--file"]), /requires a value/);
  assert.throws(() => parseArgs(["--file", "--pr"]), /requires a value/);
});

test("the positional form needs exactly 3 positionals, reviewer first", () => {
  const r = parseArgs(["test-hunter", "skipped", "no ui in this change"]);
  assert.deepEqual(r.positional, ["test-hunter", "skipped", "no ui in this change"]);
  assert.equal(r.file, undefined);
  assert.throws(() => parseArgs(["test-hunter", "skipped"]), /usage/);
  assert.throws(() => parseArgs(["test-hunter", "skipped", "a", "extra"]), /usage/);
});

test("unknown flags are errors", () => {
  assert.throws(() => parseArgs(["--bogus", "x", "y", "z"]), /unknown flag/);
});

test("a summary may start with -- only after a literal --", () => {
  assert.throws(() => parseArgs(["owner", "success", "--looks-like-a-flag"]), /unknown flag/);
  const r = parseArgs(["owner", "success", "--", "--looks-like-a-flag"]);
  assert.deepEqual(r.positional, ["owner", "success", "--looks-like-a-flag"]);
});

test("--pr and --sha are recognised flags with values", () => {
  assert.equal(parseArgs(["--pr", "12", "test-hunter", "skipped", "x"]).pr, "12");
  assert.equal(parseArgs(["--sha", "a".repeat(40), "test-hunter", "skipped", "x"]).sha, "a".repeat(40));
});

test("--sha must be a 40-character hex commit SHA", () => {
  assert.throws(() => parseArgs(["--sha", "deadbeef", "test-hunter", "skipped", "x"]), /40-character/);
  assert.doesNotThrow(() => parseArgs(["--sha", "A".repeat(40), "test-hunter", "skipped", "x"]));
});

test("a flag may not be given twice", () => {
  assert.throws(() => parseArgs(["--pr", "1", "--pr", "2", "test-hunter", "skipped", "x"]), /once/);
});

// M5: /approve races a push; --sha refuses unless it matches the PR's current head
test("checkSha refuses a stale head, accepts a match case-insensitively, and is a no-op when omitted", () => {
  assert.equal(checkSha(undefined, "a".repeat(40)), null);
  assert.equal(checkSha("A".repeat(40), "a".repeat(40)), null);
  assert.match(checkSha("a".repeat(40), "b".repeat(40)), /does not match the PR's current head/);
});

test("malformed verdicts are refused with every problem listed", () => {
  assert.deepEqual(validateVerdict(null, { criteriaCount: 1 }).errors, ["verdict must be a JSON object"]);
  const r = validateVerdict({ reviewer: "owner", verdict: "ok", summary: "", criteria: "x", findings: [{ severity: "huge" }] }, { criteriaCount: 1 });
  assert.equal(r.ok, false);
  for (const re of [/reviewer must be/, /verdict must be/, /summary is required/, /criteria must be an array/, /severity must be/, /fixed must be/]) {
    assert.match(r.errors.join("\n"), re);
  }
});

const SHA = "0123456789abcdef0123456789abcdef01234567";
const commentVerdict = { reviewer: "test-hunter", verdict: "success", summary: "ok", criteria: [], findings: [] };

test("the verdict comment starts with a marker naming the reviewer and the head SHA, then the JSON fence", () => {
  const body = buildVerdictComment(commentVerdict, SHA);
  assert.equal(body, `<!-- lanes:verdict test-hunter ${SHA} -->\n\`\`\`json\n${JSON.stringify(commentVerdict, null, 2)}\n\`\`\``);
});

test("the verdict comment builder refuses a SHA that is not 40 hex characters", () => {
  for (const sha of [undefined, "", "abc1234", `${SHA}0`, "g".repeat(40)]) {
    assert.throws(() => buildVerdictComment(commentVerdict, sha), /40-character hex/, String(sha));
  }
});

test("the verdict comment builder refuses an unknown reviewer", () => {
  assert.throws(() => buildVerdictComment({ ...commentVerdict, reviewer: "owner" }, SHA), /reviewer must be one of/);
});

// Reviewer metrics (contracts/review-metrics.schema.json): optional, validated when present.
const metrics = (over = {}) => ({ tier: "full", minutes: 12.5, tokens: 48000, ...over });

test("a verdict without metrics is accepted exactly as before", () => {
  const r = validateVerdict(verdict(), { criteriaCount: 2 });
  assert.equal(r.ok, true, r.errors.join("; "));
  assert.equal(r.status.description, "1/2 criteria pass, 1 fixed: 4 tests added, 1 bug fixed");
});

test("broken metrics are refused, naming the field", () => {
  const errors = (m) => validateVerdict(verdict({ metrics: m }), { criteriaCount: 2 }).errors.join();
  assert.match(errors(metrics({ minutes: -1 })), /metrics\.minutes/);
  assert.match(errors(metrics({ tokens: 1.5 })), /metrics\.tokens/);
  assert.match(errors(metrics({ tier: "huge" })), /metrics\.tier/);
  assert.match(errors(metrics({ extra: 1 })), /metrics\.extra/);
  assert.match(errors({ minutes: 1, tokens: 1 }), /metrics\.tier/);
  for (const m of [null, [], "fast"]) assert.match(errors(m), /metrics must be an object/, JSON.stringify(m));
});

test("metrics rejects NaN, Infinity and string numbers, but accepts -0 as zero", () => {
  const errors = (m) => validateVerdict(verdict({ metrics: m }), { criteriaCount: 2 }).errors.join();
  assert.match(errors(metrics({ minutes: NaN })), /metrics\.minutes/);
  assert.match(errors(metrics({ minutes: Infinity })), /metrics\.minutes/);
  assert.match(errors(metrics({ minutes: "3.5" })), /metrics\.minutes/);
  assert.match(errors(metrics({ tokens: NaN })), /metrics\.tokens/);
  assert.match(errors(metrics({ tokens: Infinity })), /metrics\.tokens/);
  assert.match(errors(metrics({ tokens: "1200" })), /metrics\.tokens/);
  const r = validateVerdict(verdict({ metrics: metrics({ minutes: -0, tokens: -0 }) }), { criteriaCount: 2 });
  assert.equal(r.ok, true, r.errors.join("; "));
});

test("a __proto__ key read back from a verdict file is refused as an unknown field, not silently accepted", () => {
  // Parsing untrusted JSON with a literal "__proto__" key creates an own property (not a prototype write), but
  // metricsErrors must still treat it as an unrecognized field rather than skip it.
  const text = JSON.stringify(verdict({})).slice(0, -1) + `,"metrics":{"tier":"quick","minutes":1,"tokens":1,"__proto__":{"polluted":true}}}`;
  const parsed = JSON.parse(text);
  assert.deepEqual(Object.keys(parsed.metrics), ["tier", "minutes", "tokens", "__proto__"]);
  const r = validateVerdict(parsed, { criteriaCount: 2 });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(), /metrics\.__proto__ is not a known field/);
  assert.equal(({}).polluted, undefined);
});

test("metrics do not change the status", () => {
  const without = validateVerdict(verdict(), { criteriaCount: 2 });
  const withMetrics = validateVerdict(verdict({ metrics: metrics() }), { criteriaCount: 2 });
  assert.equal(withMetrics.ok, true, withMetrics.errors.join("; "));
  assert.deepEqual(withMetrics.status, without.status);
});

test("the verdict comment carries the whole verdict, metrics included", () => {
  const v = verdict({ metrics: metrics() });
  const body = buildVerdictComment(v, SHA);
  assert.deepEqual(JSON.parse(body.split("```json\n")[1].split("\n```")[0]), v);
});

// #23: a reviewer verdict without metrics is posted, with a one-line warning (not a refusal).
test("a verdict without metrics gets a one-line warning naming the reviewer", () => {
  const w = metricsWarning(verdict());
  assert.equal(typeof w, "string");
  assert.match(w, /^warning: /);
  assert.match(w, /test-hunter/);
  assert.match(w, /metrics/);
  assert.doesNotMatch(w, /\n/);
});

test("a verdict with metrics gets no warning", () => {
  assert.equal(metricsWarning(verdict({ metrics: metrics() })), null);
  assert.equal(metricsWarning(verdict({ reviewer: "security-reviewer", metrics: metrics({ tier: "quick", minutes: 0, tokens: 0 }) })), null);
});

test("a verdict without metrics is still valid: the warning is not a refusal", () => {
  const r = validateVerdict(verdict(), { criteriaCount: 2 });
  assert.equal(r.ok, true, r.errors.join("; "));
  assert.deepEqual(r.errors, []);
});

// lane.md step 6 is where a lane fills `metrics` before calling post-review.mjs --file.
const laneStep6 = () => readFileSync(".claude/commands/lane.md", "utf8").match(/\n6\. [\s\S]*?\n7\. /)[0].replace(/\s+/g, " ");

test("lane.md step 6 adds metrics from the Agent tool's result, tier from the issue, per round", () => {
  const step6 = laneStep6();
  assert.match(step6, /[Aa]fter each reviewer subagent returns, add `"metrics": \{ "tier", "minutes", "tokens" \}` to its verdict/);
  assert.match(step6, /tokens and duration from the Agent tool's result \(rounded to 0\.1 minute\)/);
  assert.match(step6, /the tier from the issue/);
  assert.match(step6, /for a second round, record the second run's figures in the second verdict/);
});

test("lane.md step 6 says never to estimate, and to leave metrics out when the Agent tool reported none", () => {
  const step6 = laneStep6();
  assert.match(step6, /[Nn]ever estimate/);
  assert.match(step6, /if the Agent tool reported no figures, leave `metrics` out/);
});

test("night.md has no reviewer step of its own: its lanes follow lane.md, so they record metrics too", () => {
  const night = readFileSync(".claude/commands/night.md", "utf8");
  assert.match(night, /follow `\.claude\/commands\/lane\.md` exactly/);
  assert.doesNotMatch(night, /reviewers\.mjs|post-review|verdict/);
});

test("edge: an unknown, missing or multi-line reviewer name still gives a one-line warning, never a throw", () => {
  assert.match(metricsWarning({}), /^warning: .*metrics/);
  assert.doesNotMatch(metricsWarning({ reviewer: "a\nb" }), /\n/);
});

test("edge: metricsWarning never throws on null or undefined input, and still warns", () => {
  assert.match(metricsWarning(null), /^warning: .*metrics/);
  assert.match(metricsWarning(undefined), /^warning: .*metrics/);
});
