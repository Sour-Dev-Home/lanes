import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseIssueForm, parsePrBody, parseSections, duplicateHeadings, parseVerdictComment } from "./lib.mjs";
import { buildVerdictComment, validateVerdict } from "./post-review.mjs";

const issue = (over = {}) => {
  const f = { Goal: "Add the snapshot schema", "Acceptance criteria": "- [ ] schema validates a sample\n- [ ] rejects a missing id", "Interface contract": "contracts/snapshot.ts", Scope: "In: contracts/. Out: UI.", "Blocked by": "none", Tier: "quick", ...over };
  return Object.entries(f).map(([k, v]) => `### ${k}\n\n${v}\n`).join("\n");
};

test("a complete issue form parses", () => {
  const r = parseIssueForm(issue());
  assert.equal(r.ok, true, r.errors.join("; "));
  assert.deepEqual(r.fields.criteria, ["schema validates a sample", "rejects a missing id"]);
  assert.equal(r.fields.tier, "quick");
  assert.deepEqual(r.fields.blockedBy, []);
});

test("_No response_ counts as missing", () => {
  const r = parseIssueForm(issue({ Scope: "_No response_" }));
  assert.equal(r.ok, false);
  assert.match(r.errors.join(), /missing: scope/);
});

test("criteria must be checkbox lines", () => {
  assert.match(parseIssueForm(issue({ "Acceptance criteria": "it works" })).errors.join(), /acceptance criteria/);
});

test("blocked by lists issue numbers", () => {
  assert.deepEqual(parseIssueForm(issue({ "Blocked by": "#3, #12" })).fields.blockedBy, [3, 12]);
  assert.match(parseIssueForm(issue({ "Blocked by": "the other one" })).errors.join(), /blocked by/);
});

test("tier must be known", () => {
  assert.match(parseIssueForm(issue({ Tier: "huge" })).errors.join(), /tier must be one of/);
});

test("CRLF bodies parse", () => {
  assert.equal(parseIssueForm(issue().replace(/\n/g, "\r\n")).ok, true);
});

const pr = (over = {}) => {
  const s = { "What changed": "- schema validates a sample: added", "Contract changes": "additive: new type", "Tests added": "2", "Reviewer results": "test-hunter: 0 bugs", "Needs the owner": "nothing", "Not done": "nothing", ...over };
  return "Closes #7\n\n" + Object.entries(s).map(([k, v]) => `## ${k}\n\n${v}\n`).join("\n");
};

test("a complete PR body parses", () => {
  const r = parsePrBody(pr());
  assert.equal(r.closes, 7);
  assert.deepEqual(r.missing, []);
  assert.equal(r.contractChange, "additive");
});

test("the unfilled template fails: HTML comments are not content", () => {
  const template = readFileSync(".github/pull_request_template.md", "utf8");
  const r = parsePrBody(template.replace("Closes #", "Closes #7"));
  assert.ok(r.missing.includes("what changed"));
  assert.equal(r.contractChange, null);
});

test("a heading inside a code fence is not a section", () => {
  const body = pr({ "Not done": "```\n## What changed\n```" }).replace(/## What changed\n\n- schema validates a sample: added\n/, "");
  assert.ok(parsePrBody(body).missing.includes("what changed"));
});

test("no closing keyword gives closes null", () => {
  assert.equal(parsePrBody(pr().replace("Closes #7", "Refs #7")).closes, null);
});

test("parseSections lower-cases headings", () => {
  assert.deepEqual(parseSections("### Goal\n\nx\n", "###"), { goal: "x" });
});

// Fix round 1: Issue 1 — Closes keyword in code fences should not match
test("Closes #N inside a code fence is not parsed", () => {
  const body = "```\nCloses #999\n```\n\n## What changed\nx\n## Contract changes\nnone\n## Tests added\nx\n## Reviewer results\nx\n## Needs the owner\nnothing\n## Not done\nnothing\n";
  assert.equal(parsePrBody(body).closes, null);
});

// Fix round 1: Issue 2a — First occurrence of a heading is kept (not last)
test("parseSections keeps first occurrence of a heading", () => {
  const body = "## Goal\n\nfirst\n\n## Goal\n\nsecond\n";
  const result = parseSections(body, "##");
  assert.equal(result.goal, "first");
});

// Fix round 1: Issue 2b — duplicateHeadings detects repeated headings
test("duplicateHeadings finds repeated headings", () => {
  const body = "## What changed\nx\n## Contract changes\ny\n## What changed\nz\n";
  const dups = duplicateHeadings(body, "##");
  assert.deepEqual(dups, ["what changed"]);
});

// Fix round 1: Issue 2c — parseIssueForm errors on duplicate headings
test("parseIssueForm fails with duplicate heading error", () => {
  const body = issue({ "Acceptance criteria": "- [ ] a\n\n### Acceptance criteria\n\n- [ ] b" });
  const r = parseIssueForm(body);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(), /duplicate heading/);
});

// Fix round 1: Issue 3 — Checkbox spacing: both "- [ ] a" and "- [ ]  b" work
test("both single and double spaces in checkboxes are accepted", () => {
  const criteria = "- [ ] single space\n- [ ]  double space";
  const r = parseIssueForm(issue({ "Acceptance criteria": criteria }));
  assert.equal(r.ok, true, r.errors.join("; "));
  assert.deepEqual(r.fields.criteria, ["single space", "double space"]);
});

// Fix round 2: CommonMark fence scanner (backticks and tildes)
test("Closes #N inside a ~~~ tilde fence is not parsed", () => {
  const body = "~~~\nCloses #999\n~~~\n\n## What changed\nx\n## Contract changes\nnone\n## Tests added\nx\n## Reviewer results\nx\n## Needs the owner\nnothing\n## Not done\nnothing\n";
  assert.equal(parsePrBody(body).closes, null);
});

test("a heading inside a ~~~ fence is neither a section nor a duplicate", () => {
  const body = "## Contract changes\nbreaking\n\n~~~\n## Contract changes\nfake example\n~~~\n";
  const result = parseSections(body, "##");
  assert.equal(result["contract changes"], "breaking");
  assert.deepEqual(duplicateHeadings(body, "##"), []);
});

test("``` fence is not closed by ~~~ and vice versa", () => {
  const body = "```\nCloses #1\n~~~\n\n## What changed\nx\n## Contract changes\nnone\n## Tests added\nx\n## Reviewer results\nx\n## Needs the owner\nnothing\n## Not done\nnothing\n";
  assert.equal(parsePrBody(body).closes, null);
  const body2 = "~~~\nCloses #2\n```\n\n## What changed\nx\n## Contract changes\nnone\n## Tests added\nx\n## Reviewer results\nx\n## Needs the owner\nnothing\n## Not done\nnothing\n";
  assert.equal(parsePrBody(body2).closes, null);
});

// The verdict comment contract: post-review.mjs builds it, parseVerdictComment reads it back.
test("a verdict comment round-trips through the builder and the parser", () => {
  const sha = "fedcba9876543210fedcba9876543210fedcba98";
  const verdict = {
    reviewer: "test-hunter",
    verdict: "failure",
    summary: "a summary with ``` backticks, <!-- a comment --> and\na newline",
    criteria: [{ index: 1, result: "fail", evidence: "see `x`" }],
    findings: [{ severity: "important", file: "a.mjs", line: 3, summary: "bug", fixed: false }],
  };
  assert.deepEqual(parseVerdictComment(buildVerdictComment(verdict, sha)), { reviewer: "test-hunter", sha, verdict });
});

// The reviewer metrics contract: contracts/review-metrics.schema.json and validateVerdict must agree.
const metricsSchema = JSON.parse(readFileSync("contracts/review-metrics.schema.json", "utf8"));

/** The JSON Schema subset the metrics schema uses (type, enum, minimum, required, properties, additionalProperties). */
function schemaAccepts(schema, value) {
  const types = [].concat(schema.type ?? []);
  const isType = (t) =>
    t === "object" ? value !== null && typeof value === "object" && !Array.isArray(value)
    : t === "integer" ? Number.isInteger(value)
    : t === "number" ? typeof value === "number" && Number.isFinite(value)
    : typeof value === t;
  if (types.length && !types.some(isType)) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.minimum !== undefined && !(value >= schema.minimum)) return false;
  if (types.includes("object")) {
    if ((schema.required ?? []).some((k) => !Object.hasOwn(value, k))) return false;
    for (const [k, v] of Object.entries(value)) {
      const sub = schema.properties?.[k];
      if (sub ? !schemaAccepts(sub, v) : schema.additionalProperties === false) return false;
    }
  }
  return true;
}

test("the metrics schema defines tier, minutes and tokens, all required, no other keys", () => {
  assert.equal(metricsSchema.type, "object");
  assert.deepEqual([...metricsSchema.required].sort(), ["minutes", "tier", "tokens"]);
  assert.equal(metricsSchema.additionalProperties, false);
  const { tier, minutes, tokens } = metricsSchema.properties;
  assert.deepEqual(Object.keys(metricsSchema.properties).sort(), ["minutes", "tier", "tokens"]);
  assert.deepEqual(tier.enum, ["skip", "quick", "full"]);
  assert.deepEqual([minutes.type, minutes.minimum], ["number", 0]);
  assert.deepEqual([tokens.type, tokens.minimum], ["integer", 0]);
});

test("the metrics schema and validateVerdict agree", () => {
  const valid = { tier: "quick", minutes: 3.5, tokens: 1200 };
  const without = (k) => Object.fromEntries(Object.entries(valid).filter(([key]) => key !== k));
  const cases = [
    ["a valid object", valid, true],
    ["zero minutes and tokens", { tier: "skip", minutes: 0, tokens: 0 }, true],
    ["missing tier", without("tier"), false],
    ["missing minutes", without("minutes"), false],
    ["missing tokens", without("tokens"), false],
    ["a negative minutes", { ...valid, minutes: -0.5 }, false],
    ["a fractional tokens", { ...valid, tokens: 10.5 }, false],
    ["an unknown tier", { ...valid, tier: "huge" }, false],
    ["an extra key", { ...valid, cost: 1 }, false],
    ["negative zero minutes", { ...valid, minutes: -0 }, true],
    ["NaN minutes", { ...valid, minutes: NaN }, false],
    ["Infinity minutes", { ...valid, minutes: Infinity }, false],
    ["a string minutes", { ...valid, minutes: "3.5" }, false],
    ["NaN tokens", { ...valid, tokens: NaN }, false],
    ["Infinity tokens", { ...valid, tokens: Infinity }, false],
    ["a string tokens", { ...valid, tokens: "1200" }, false],
  ];
  const verdict = (metrics) => ({ reviewer: "security-reviewer", verdict: "success", summary: "ok", criteria: [], findings: [], metrics });
  for (const [name, metrics, expected] of cases) {
    assert.equal(schemaAccepts(metricsSchema, metrics), expected, `schema: ${name}`);
    assert.equal(validateVerdict(verdict(metrics), { criteriaCount: 1 }).ok, expected, `validateVerdict: ${name}`);
  }
});

test("4 backticks are not closed by 3 backticks", () => {
  const body = "````\nCloses #999\n```\n\n## What changed\nx\n## Contract changes\nnone\n## Tests added\nx\n## Reviewer results\nx\n## Needs the owner\nnothing\n## Not done\nnothing\n";
  assert.equal(parsePrBody(body).closes, null);
});
