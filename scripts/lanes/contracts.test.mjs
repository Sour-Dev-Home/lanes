import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseIssueForm, parsePrBody, parseSections, duplicateHeadings } from "./lib.mjs";

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

test("4 backticks are not closed by 3 backticks", () => {
  const body = "````\nCloses #999\n```\n\n## What changed\nx\n## Contract changes\nnone\n## Tests added\nx\n## Reviewer results\nx\n## Needs the owner\nnothing\n## Not done\nnothing\n";
  assert.equal(parsePrBody(body).closes, null);
});
