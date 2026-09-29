import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { parseAdr, parseIssueForm, parsePrBody, parseSections, duplicateHeadings, parseVerdictComment } from "./lib.mjs";
import { buildVerdictComment, validateVerdict } from "./post-review.mjs";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

/**
 * The JSON Schema subset the contracts use (type, enum, const, minimum, pattern, maxLength, items, required,
 * properties, additionalProperties, plus local `$ref` to `#/$defs/<name>`). A keyword outside it makes the schema throw, so it can never pass unchecked.
 */
const KNOWN_KEYWORDS = new Set(["$schema", "$id", "title", "description", "type", "enum", "const", "minimum", "maximum", "pattern", "maxLength", "items", "required", "properties", "additionalProperties", "propertyNames", "$defs", "$ref"]);
function schemaAccepts(schema, value, root = schema) {
  for (const k of Object.keys(schema)) if (!KNOWN_KEYWORDS.has(k)) throw new Error(`schemaAccepts does not implement "${k}"`);
  if (schema.$ref !== undefined) {
    const target = schema.$ref.startsWith("#/$defs/") ? root.$defs?.[schema.$ref.slice("#/$defs/".length)] : undefined;
    if (target === undefined) throw new Error(`schemaAccepts cannot resolve "${schema.$ref}"`);
    if (!schemaAccepts(target, value, root)) return false;
  }
  const types = [].concat(schema.type ?? []);
  const isType = (t) =>
    t === "object" ? value !== null && typeof value === "object" && !Array.isArray(value)
    : t === "array" ? Array.isArray(value)
    : t === "null" ? value === null
    : t === "boolean" ? typeof value === "boolean"
    : t === "integer" ? Number.isInteger(value)
    : t === "number" ? typeof value === "number" && Number.isFinite(value)
    : typeof value === t;
  if (types.length && !types.some(isType)) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if ("const" in schema && value !== schema.const) return false;
  if (schema.minimum !== undefined && !(value >= schema.minimum)) return false;
  if (schema.maximum !== undefined && !(value <= schema.maximum)) return false;
  if (schema.pattern !== undefined && !(typeof value === "string" && new RegExp(schema.pattern).test(value))) return false;
  if (schema.maxLength !== undefined && !(typeof value === "string" && value.length <= schema.maxLength)) return false;
  if (schema.items && Array.isArray(value) && !value.every((v) => schemaAccepts(schema.items, v, root))) return false;
  if (types.includes("object")) {
    if ((schema.required ?? []).some((k) => !Object.hasOwn(value, k))) return false;
    for (const [k, v] of Object.entries(value)) {
      if (schema.propertyNames && !schemaAccepts(schema.propertyNames, k, root)) return false;
      const sub = schema.properties?.[k] ?? (typeof schema.additionalProperties === "object" ? schema.additionalProperties : undefined);
      if (sub ? !schemaAccepts(sub, v, root) : schema.additionalProperties === false) return false;
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

// The ADR format contract: contracts/adr-template.md, parsed by parseAdr. A malformed ADR can't merge.
test("the ADR template's example parses", () => {
  const template = readFileSync("contracts/adr-template.md", "utf8").replace(/\r\n/g, "\n");
  const example = template.match(/^```markdown\n([\s\S]*?)^```$/m);
  assert.ok(example, "the template has a ```markdown example block");
  const r = parseAdr(example[1]);
  assert.equal(r.error, undefined, r.error);
  assert.equal(r.status, "accepted");
  assert.ok(r.governs.length > 0);
});

test("every docs/adr/*.md parses, and its file name carries its number", () => {
  const files = readdirSync("docs/adr").filter((f) => f.endsWith(".md"));
  assert.ok(files.length > 0, "docs/adr has at least one ADR");
  for (const f of files) {
    const r = parseAdr(readFileSync(`docs/adr/${f}`, "utf8"));
    assert.equal(r.error, undefined, `${f}: ${r.error}`);
    assert.match(f, /^\d{4}-[a-z0-9-]+\.md$/, `${f}: name must be NNNN-<slug>.md`);
    assert.equal(Number(f.slice(0, 4)), r.number, `${f}: file number differs from the title's`);
  }
});

test("4 backticks are not closed by 3 backticks", () => {
  const body = "````\nCloses #999\n```\n\n## What changed\nx\n## Contract changes\nnone\n## Tests added\nx\n## Reviewer results\nx\n## Needs the owner\nnothing\n## Not done\nnothing\n";
  assert.equal(parsePrBody(body).closes, null);
});

// The snapshot contract: contracts/snapshot.schema.json and snapshot.mjs's buildSnapshot must agree, field by field.
const snapshotSchema = JSON.parse(readFileSync("contracts/snapshot.schema.json", "utf8"));
const SNAP_SHA = "0123456789abcdef0123456789abcdef01234567";
const snapForm = (blockedBy) => `### Goal\n\ng\n\n### Acceptance criteria\n\n- [ ] a\n\n### Interface contract\n\nx\n\n### Scope\n\nIn: a.\n\n### Blocked by\n\n${blockedBy}\n\n### Tier\n\nfull\n`;
// snapshot.mjs belongs to another module, so it is run as a command (`--from` builds offline, without gh), not imported.
const builtSnapshot = () => {
  const dir = mkdtempSync(join(tmpdir(), "snapshot-contract-"));
  try {
    writeFileSync(join(dir, "input.json"), JSON.stringify(snapshotInput));
    execFileSync(process.execPath, ["scripts/lanes/snapshot.mjs", "--from", join(dir, "input.json"), "--out", join(dir, "snapshot.json")], { stdio: "pipe" });
    return JSON.parse(readFileSync(join(dir, "snapshot.json"), "utf8"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
const snapshotInput = {
    generatedAt: "2026-09-28T12:00:00.000Z",
    issues: [
      { number: 1, title: "A", labels: [{ name: "ready" }, { name: "tier:full" }], body: snapForm("none") },
      { number: 2, title: "B", labels: [{ name: "ready" }, { name: "tier:quick" }], body: snapForm("#1") },
      { number: 3, title: "C", labels: [{ name: "tier:skip" }], body: snapForm("none") },
    ],
    prs: [
      {
        number: 9,
        headRefOid: SNAP_SHA,
        isCrossRepository: false,
        statusCheckRollup: [{ name: "verify", conclusion: "FAILURE" }, { context: "lanes/gate", state: "PENDING", description: "waiting on owner (/approve)" }],
        closingIssuesReferences: [{ number: 3 }],
        comments: [{ authorAssociation: "OWNER", body: buildVerdictComment({ reviewer: "test-hunter", verdict: "success", summary: "s", criteria: [{ index: 1, result: "pass", evidence: "e" }], findings: [] }, SNAP_SHA) }],
      },
    ],
};

test("the snapshot schema defines every top-level and per-issue field, required ones listed, no other keys", () => {
  assert.deepEqual([...snapshotSchema.required].sort(), ["edges", "generatedAt", "issues", "overlaps", "version"]);
  assert.deepEqual(Object.keys(snapshotSchema.properties).sort(), ["edges", "generatedAt", "issues", "overlaps", "version"]);
  const pair = snapshotSchema.properties.overlaps.items;
  assert.deepEqual([...pair.required].sort(), ["a", "b"]);
  assert.deepEqual(Object.keys(pair.properties).sort(), ["a", "b"]);
  assert.equal(pair.additionalProperties, false);
  assert.equal(snapshotSchema.additionalProperties, false);
  const issue = snapshotSchema.properties.issues.items;
  assert.deepEqual([...issue.required].sort(), ["blockedBy", "number", "stage", "tier", "title"]);
  assert.deepEqual(Object.keys(issue.properties).sort(), ["blockedBy", "criteria", "number", "pr", "stage", "tier", "title"]);
  assert.deepEqual(issue.properties.tier.enum, ["skip", "quick", "full", "unknown"]);
  assert.deepEqual(issue.properties.blockedBy.items.properties.kind.enum, ["issue", "check", "review", "owner", "queue"]);
  assert.deepEqual(Object.keys(issue.properties.pr.properties).sort(), ["checks", "headSha", "number"]);
  assert.deepEqual(Object.keys(issue.properties.criteria.items.properties).sort(), ["index", "result"]);
  assert.deepEqual(Object.keys(snapshotSchema.properties.edges.items.properties).sort(), ["from", "to"]);
});

test("a snapshot built by snapshot.mjs conforms to the schema, and it exercises every optional field", () => {
  const s = builtSnapshot();
  assert.equal(schemaAccepts(snapshotSchema, s), true);
  const three = s.issues.find((i) => i.number === 3);
  assert.ok(three.pr && three.criteria && three.blockedBy.length, "the sample covers pr, criteria and blockedBy");
  assert.ok(s.edges.length, "the sample covers edges");
});

test("every stage snapshot.mjs can emit is in the schema's stage enum", () => {
  const stages = snapshotSchema.properties.issues.items.properties.stage.enum;
  for (const s of ["ready", "blocked", "not-ready", "already met", "starting", "failing", "contract", "owner", "gate", "review", "queued", "running"]) assert.ok(stages.includes(s), s);
});

// `a < b` compares two fields, which the schema cannot say, so it is checked here (ADR 0014).
const overlapErrors = (s) => (s.overlaps ?? []).filter((p) => !(p.a < p.b)).map((p) => `${p.a} >= ${p.b}`);
const fixture = JSON.parse(readFileSync("contracts/dashboard-visual.fixture.json", "utf8"));
const fixtureIssue = (n) => fixture.issues.find((i) => i.number === n);

test("the visual-check fixture conforms to the snapshot schema, with every overlap pair ordered a < b", () => {
  assert.equal(schemaAccepts(snapshotSchema, fixture), true);
  assert.deepEqual(overlapErrors(fixture), []);
});

test("the visual-check fixture covers every stage, blocker kind, a chain of three, two overlaps, a long title and an owner wait", () => {
  const stageEnum = snapshotSchema.properties.issues.items.properties.stage.enum;
  const kindEnum = snapshotSchema.properties.issues.items.properties.blockedBy.items.properties.kind.enum;
  assert.deepEqual([...new Set(fixture.issues.map((i) => i.stage))].sort(), [...stageEnum].sort());
  assert.deepEqual([...new Set(fixture.issues.flatMap((i) => i.blockedBy.map((b) => b.kind)))].sort(), [...kindEnum].sort());
  const blocks = new Map(fixture.edges.map((e) => [e.from, e.to]));
  assert.ok(fixture.edges.some((e1) => blocks.has(e1.to) && fixture.edges.some((e2) => e2.from === e1.to)), "a Blocked-by chain of three");
  assert.ok(fixture.overlaps.length >= 2, "two overlap pairs");
  assert.ok(fixture.issues.some((i) => i.title.length === 120), "a 120-character title");
  assert.ok(fixture.issues.some((i) => i.stage === "owner" && i.pr && i.blockedBy.some((b) => b.kind === "owner")), "a PR awaiting the owner");
  const numbers = new Set(fixture.issues.map((i) => i.number));
  for (const e of fixture.edges) assert.ok(numbers.has(e.from) && numbers.has(e.to), `edge ${e.from}->${e.to} names listed issues`);
  for (const p of fixture.overlaps) assert.ok(numbers.has(p.a) && numbers.has(p.b), `overlap ${p.a}/${p.b} names listed issues`);
});

test("the snapshot schema and overlap check reject a bad overlaps list", () => {
  const mutate = (fn) => {
    const s = structuredClone(fixture);
    fn(s);
    return s;
  };
  const bad = [
    ["an extra field on a pair", (s) => (s.overlaps[0].path = "a.mjs")],
    ["a pair missing b", (s) => delete s.overlaps[0].b],
    ["a zero issue number", (s) => (s.overlaps[0].a = 0)],
    ["a string issue number", (s) => (s.overlaps[0].b = "9")],
    ["overlaps that is not an array", (s) => (s.overlaps = {})],
    ["a snapshot without overlaps", (s) => delete s.overlaps],
  ];
  for (const [name, fn] of bad) assert.equal(schemaAccepts(snapshotSchema, mutate(fn)), false, name);
  for (const [name, fn] of [["a >= b", (s) => ([s.overlaps[0].a, s.overlaps[0].b] = [s.overlaps[0].b, s.overlaps[0].a])], ["a == b", (s) => (s.overlaps[0].b = s.overlaps[0].a)]]) {
    assert.notDeepEqual(overlapErrors(mutate(fn)), [], `edge: ${name}`);
  }
});

test("the snapshot schema rejects a bad snapshot, field by field", () => {
  const mutate = (fn) => {
    const s = structuredClone(builtSnapshot());
    fn(s);
    return s;
  };
  const three = (s) => s.issues.find((i) => i.number === 3);
  const cases = [
    ["a login on an issue", (s) => (s.issues[0].author = "someone")],
    ["a body on the pr", (s) => (three(s).pr.body = "text")],
    ["an unknown top-level key", (s) => (s.comments = [])],
    ["a missing generatedAt", (s) => delete s.generatedAt],
    ["a non-UTC generatedAt", (s) => (s.generatedAt = "2026-09-28 12:00")],
    ["a wrong version", (s) => (s.version = 1)],
    ["a missing stage", (s) => delete s.issues[0].stage],
    ["an unknown stage", (s) => (s.issues[0].stage = "flying")],
    ["an unknown tier", (s) => (s.issues[0].tier = "huge")],
    ["a string number", (s) => (s.issues[0].number = "1")],
    ["a zero number", (s) => (s.issues[0].number = 0)],
    ["a 201-character title", (s) => (s.issues[0].title = "x".repeat(201))],
    ["an unknown blocker kind", (s) => (s.issues[1].blockedBy[0].kind = "person")],
    ["a blocker without a reason", (s) => delete s.issues[1].blockedBy[0].reason],
    ["a short headSha", (s) => (three(s).pr.headSha = "abc")],
    ["an unknown check result", (s) => (three(s).pr.checks[0].result = "green")],
    ["a criterion index of 0", (s) => (three(s).criteria[0].index = 0)],
    ["an unknown criterion result", (s) => (three(s).criteria[0].result = "maybe")],
    ["an edge missing to", (s) => delete s.edges[0].to],
    ["issues that is not an array", (s) => (s.issues = {})],
  ];
  for (const [name, fn] of cases) assert.equal(schemaAccepts(snapshotSchema, mutate(fn)), false, name);
});

test("edge: schemaAccepts refuses a schema keyword it does not implement", () => {
  assert.throws(() => schemaAccepts({ type: "string", format: "email" }, "a@b.c"), /does not implement "format"/);
});

// The lane metrics contract (ADR 0013): contracts/lane-metrics.schema.json. Aggregates only; local-only fields never in public output.
const laneSchema = JSON.parse(readFileSync("contracts/lane-metrics.schema.json", "utf8"));
const LOCAL_ONLY = ["tokensByTierAndModel", "relaunches", "laneHours"];
const stat = (median = 2, count = 4) => ({ count, median });
const laneBlocks = () => ({
  rework: { prs: 4, prsWithGateFailure: 1, gateFailuresByStage: [{ stage: "review", count: 1 }], pushesAfterOpen: stat(1) },
  scopeDrift: { prs: 4, prsWithDrift: 1, driftRate: 0.25, filesOutsideScope: stat(0) },
  ownerTime: { prsWaited: 3, waitHours: stat(5.5, 3), interventions: stat(1) },
  concurrency: { maxOpenPrs: 3, medianOpenPrs: 2 },
  friction: { prsWithRerun: 1, ciReruns: 2, stuckQueueMinutes: stat(0) },
  delivery: { mergedPrs: 4, perDay: 0.57, leadTimeHoursMedian: 6.2, medianLinesChanged: 80, bounceRate: null, failureRate: 0, revertRate: 0 },
  review: { runs: 8, runsWithoutMetrics: 1, realFindings: 2, minorFindings: 5, tiers: [{ tier: "full", runs: 8, realFindings: 2, noRealFindingShare: 0.75 }] },
});
const laneLocal = () => ({ tokensByTierAndModel: [{ tier: "full", model: "sonnet", tokens: 120000 }], relaunches: 1, laneHours: stat(1.5) });
const laneReport = (over = {}) => {
  const doc = {
    schemaVersion: 1,
    generatedAt: "2026-09-28T12:00:00Z",
    public: false,
    window: { days: 28, from: "2026-08-31T12:00:00Z", to: "2026-09-28T12:00:00Z" },
    ...laneBlocks(),
    ...over,
  };
  for (const k of Object.keys(doc)) if (doc[k] === undefined) delete doc[k];
  return doc;
};
// A schema cannot say "absent when public", so the rule lives here beside the schema check.
const publicLeaks = (doc) => {
  if (doc?.public !== true) return [];
  const scopes = [doc, ...(doc.split ?? []).flatMap((s) => [s.before, s.after])];
  return scopes.flatMap((s) => LOCAL_ONLY.filter((k) => s !== null && typeof s === "object" && Object.hasOwn(s, k)));
};
const laneConforms = (doc) => schemaAccepts(laneSchema, doc) && publicLeaks(doc).length === 0;

test("the lane metrics schema defines the envelope, the aggregate blocks and the optional local-only fields", () => {
  assert.equal(laneSchema.additionalProperties, false);
  const blocks = ["rework", "scopeDrift", "ownerTime", "concurrency", "friction", "delivery", "review"];
  assert.deepEqual([...laneSchema.required].sort(), ["generatedAt", "public", "schemaVersion", "window", ...blocks].sort());
  assert.deepEqual(Object.keys(laneSchema.properties).sort(), ["byTier", "generatedAt", "public", "schemaVersion", "split", "window", ...blocks, ...LOCAL_ONLY].sort());
  assert.ok(!laneSchema.required.includes("byTier"), "byTier is optional");
  assert.ok(!laneSchema.$defs.aggregate.required.includes("byTier"), "byTier is optional in a split side");
  assert.ok(!laneSchema.$defs.stat.required.includes("p90"), "p90 is optional");
  for (const k of LOCAL_ONLY) assert.ok(!laneSchema.required.includes(k), `${k} is optional`);
  assert.deepEqual([...laneSchema.$defs.aggregate.required].sort(), [...blocks].sort());
  assert.deepEqual(Object.keys(laneSchema.properties.split.items.properties).sort(), ["after", "before", "date"]);
});

test("a lane metrics report conforms, with or without the local-only fields, and with a split", () => {
  assert.equal(laneConforms(laneReport()), true);
  assert.equal(laneConforms(laneReport({ public: true })), true);
  assert.equal(laneConforms(laneReport({ public: false, ...laneLocal() })), true);
  assert.equal(laneConforms(laneReport({ ...laneLocal() })), true);
  const split = [{ date: "2026-09-01", before: laneBlocks(), after: { ...laneBlocks(), ...laneLocal() } }];
  assert.equal(laneConforms(laneReport({ split })), true);
  assert.equal(laneConforms(laneReport({ public: true, split: [{ date: "2026-09-01", before: laneBlocks(), after: laneBlocks() }] })), true);
});

test("the lane metrics schema rejects a bad report, field by field", () => {
  const b = laneBlocks();
  const side = (over) => [{ date: "2026-09-01", before: b, after: b, ...over }];
  const cases = [
    ["a login on the report", { author: "someone" }],
    ["a title on the report", { title: "Add the thing" }],
    ["an unknown top-level key", { prs: [] }],
    ["a missing generatedAt", { generatedAt: undefined }],
    ["a non-UTC generatedAt", { generatedAt: "2026-09-28 12:00" }],
    ["a wrong schemaVersion", { schemaVersion: 2 }],
    ["a missing block", { rework: undefined }],
    ["a window with no from", { window: { days: 28, to: "2026-09-28T12:00:00Z" } }],
    ["a zero-day window", { window: { days: 0, from: "2026-09-28T12:00:00Z", to: "2026-09-28T12:00:00Z" } }],
    ["a free-text stage", { rework: { ...b.rework, gateFailuresByStage: [{ stage: "Fix login for alice@example.com", count: 1 }] } }],
    ["a stage with a path in it", { rework: { ...b.rework, gateFailuresByStage: [{ stage: "src/a.ts", count: 1 }] } }],
    ["a per-PR list in a block", { scopeDrift: { ...b.scopeDrift, files: ["a.ts"] } }],
    ["a rate above 1", { scopeDrift: { ...b.scopeDrift, driftRate: 1.5 } }],
    ["a negative rate", { scopeDrift: { ...b.scopeDrift, driftRate: -0.1 } }],
    ["a negative count", { friction: { ...b.friction, ciReruns: -1 } }],
    ["a fractional count", { friction: { ...b.friction, ciReruns: 1.5 } }],
    ["a string median", { ownerTime: { ...b.ownerTime, waitHours: { count: 1, median: "5" } } }],
    ["a non-boolean public", { public: "yes" }],
    ["an unknown review tier", { review: { ...b.review, tiers: [{ tier: "huge", runs: 1, realFindings: 0, noRealFindingShare: 0 }] } }],
    ["a split date with a time", { split: side({ date: "2026-09-01T00:00:00Z" }) }],
    ["a split missing after", { split: side({ after: undefined }) }],
    ["a split side with a login", { split: side({ before: { ...b, author: "x" } }) }],
    ["a split side missing a block", { split: side({ before: { ...b, rework: undefined } }) }],
    ["a missing public flag", { public: undefined }],
    ["local-only fields with no public flag", { public: undefined, ...laneLocal() }],
    ["a lower-case free-text stage", { rework: { ...b.rework, gateFailuresByStage: [{ stage: "fix login for alice", count: 1 }] } }],
    ["a login as a stage", { rework: { ...b.rework, gateFailuresByStage: [{ stage: "alice", count: 1 }] } }],
    ["a free-text model", { tokensByTierAndModel: [{ tier: "full", model: "Sonnet 5.5 (Alice's key)", tokens: 1 }] }],
    ["a lower-case login as a model", { tokensByTierAndModel: [{ tier: "full", model: "alice", tokens: 1 }] }],
    ["a string relaunches", { relaunches: "1" }],
  ];
  for (const [name, over] of cases) assert.equal(schemaAccepts(laneSchema, JSON.parse(JSON.stringify(laneReport(over)))), false, name);
});

test("the lane metrics schema takes an optional p90 on a stat and an optional per-tier breakdown", () => {
  const b = laneBlocks();
  const row = (over = {}) => ({ tier: "full", rework: b.rework, scopeDrift: b.scopeDrift, ownerTime: b.ownerTime, friction: b.friction, ...over });
  const withP90 = (p90) => laneReport({ friction: { ...b.friction, stuckQueueMinutes: { count: 4, median: 2, p90 } } });
  assert.equal(laneConforms(withP90(7.5)), true);
  assert.equal(laneConforms(withP90(null)), true);
  assert.equal(laneConforms(laneReport({ byTier: [row(), row({ tier: "unknown" })] })), true);
  assert.equal(laneConforms(laneReport({ byTier: [] })), true);
  const split = [{ date: "2026-09-01", before: { ...b, byTier: [row()] }, after: b }];
  assert.equal(laneConforms(laneReport({ split })), true);
  const cases = [
    ["a string p90", withP90("7")],
    ["a negative p90", withP90(-1)],
    ["an unknown stat key", laneReport({ friction: { ...b.friction, stuckQueueMinutes: { count: 4, median: 2, p95: 3 } } })],
    ["an unknown tier", laneReport({ byTier: [row({ tier: "huge" })] })],
    ["a tier row with no tier", laneReport({ byTier: [row({ tier: undefined })] })],
    ["a tier row missing a block", laneReport({ byTier: [row({ friction: undefined })] })],
    ["a tier row with the delivery block", laneReport({ byTier: [row({ delivery: b.delivery })] })],
    ["a tier row with a login", laneReport({ byTier: [row({ author: "someone" })] })],
    ["a byTier that is not a list", laneReport({ byTier: row() })],
    ["a split side with a bad byTier", laneReport({ split: [{ date: "2026-09-01", before: { ...b, byTier: [row({ tier: "x" })] }, after: b }] })],
  ];
  for (const [name, doc] of cases) assert.equal(schemaAccepts(laneSchema, JSON.parse(JSON.stringify(doc))), false, name);
});

test("a public: true report carrying a local-only field fails, at the top level and in a split side", () => {
  for (const k of LOCAL_ONLY) {
    assert.equal(laneConforms(laneReport({ public: true, [k]: laneLocal()[k] })), false, `top-level ${k}`);
    const split = [{ date: "2026-09-01", before: laneBlocks(), after: { ...laneBlocks(), [k]: laneLocal()[k] } }];
    assert.equal(laneConforms(laneReport({ public: true, split })), false, `split ${k}`);
  }
  assert.equal(laneConforms(laneReport({ public: true, ...laneLocal() })), false, "all three");
});

test("edge: null medians and rates, empty lists and an empty split conform", () => {
  const empty = laneReport({
    rework: { prs: 0, prsWithGateFailure: 0, gateFailuresByStage: [], pushesAfterOpen: { count: 0, median: null } },
    scopeDrift: { prs: 0, prsWithDrift: 0, driftRate: null, filesOutsideScope: { count: 0, median: null } },
    concurrency: { maxOpenPrs: 0, medianOpenPrs: null },
    review: { runs: 0, runsWithoutMetrics: 0, realFindings: 0, minorFindings: 0, tiers: [] },
    split: [],
  });
  assert.equal(laneConforms(empty), true);
});

test("edge: a report that is not an object does not conform", () => {
  for (const v of [null, [], "report", 1]) assert.equal(laneConforms(v), false, JSON.stringify(v));
});

test("edge: a zero or null local-only value still leaks in a public report", () => {
  assert.equal(laneConforms(laneReport({ public: true, relaunches: 0 })), false);
  assert.equal(laneConforms(laneReport({ public: true, laneHours: null })), false);
});

test("edge: schemaAccepts refuses an unresolvable $ref, and every $ref in the lane schema resolves", () => {
  assert.throws(() => schemaAccepts({ $ref: "#/$defs/nope" }, 1), /cannot resolve/);
  const refs = [...JSON.stringify(laneSchema).matchAll(/"\$ref":"#\/\$defs\/([A-Za-z]+)"/g)].map((m) => m[1]);
  assert.ok(refs.length > 10);
  for (const r of refs) assert.ok(laneSchema.$defs[r], r);
});

// The upgrade lock contract (ADR 0016): contracts/lanes-lock.schema.json.
const lockSchema = JSON.parse(readFileSync("contracts/lanes-lock.schema.json", "utf8"));
const HASH = "a".repeat(64);
const lock = (files, over = {}) => ({ version: "1.2.3", files, ...over });

test("the lock schema accepts a valid lock", () => {
  assert.equal(schemaAccepts(lockSchema, lock({ "scripts/lanes/gate.mjs": HASH, ".claude/agents/x.md": HASH })), true);
});

test("the lock schema rejects an absolute path, a .. path, a short hash and an extra key", () => {
  assert.equal(schemaAccepts(lockSchema, lock({ "/etc/passwd": HASH })), false);
  assert.equal(schemaAccepts(lockSchema, lock({ "../outside.txt": HASH })), false);
  assert.equal(schemaAccepts(lockSchema, lock({ "a/../../b": HASH })), false);
  assert.equal(schemaAccepts(lockSchema, lock({ "a/b.mjs": "abc123" })), false);
  assert.equal(schemaAccepts(lockSchema, lock({ "a/b.mjs": HASH }, { extra: 1 })), false);
});

test("edge: lock paths with a drive letter, backslash, empty segment or trailing slash are rejected", () => {
  for (const p of ["C:/x", "c:\\x", "\\x", "a\\b", "a//b", "a/", "a/..", "..", "", "./../x", "x:y"]) {
    assert.equal(schemaAccepts(lockSchema, lock({ [p]: HASH })), false, JSON.stringify(p));
  }
  for (const p of ["a", "..a/b", "a/..b", ".gitattributes", "a/.hidden/b", "xy:z"]) {
    assert.equal(schemaAccepts(lockSchema, lock({ [p]: HASH })), true, JSON.stringify(p));
  }
});

test("edge: lock hashes must be 64 lowercase hex characters", () => {
  for (const h of ["A".repeat(64), "a".repeat(65), "g".repeat(64), "", 5, null]) {
    assert.equal(schemaAccepts(lockSchema, lock({ "a.mjs": h })), false, String(h));
  }
});

test("edge: lock version must be semver, and version and files are required", () => {
  for (const v of ["1.2", "v1.2.3", "01.2.3", "", 1, null]) assert.equal(schemaAccepts(lockSchema, lock({}, { version: v })), false, String(v));
  for (const v of ["0.0.0", "1.2.3-rc.1", "1.2.3+build.5"]) assert.equal(schemaAccepts(lockSchema, lock({}, { version: v })), true, v);
  assert.equal(schemaAccepts(lockSchema, { files: {} }), false);
  assert.equal(schemaAccepts(lockSchema, { version: "1.0.0" }), false);
  assert.equal(schemaAccepts(lockSchema, lock([])), false);
  assert.equal(schemaAccepts(lockSchema, null), false);
});

test("lanes.config.json makes lanes.lock.json an owner path", () => {
  const owner = JSON.parse(readFileSync("lanes.config.json", "utf8")).paths.owner;
  assert.ok(owner.includes("^lanes\\.lock\\.json$"));
  assert.ok(owner.some((p) => new RegExp(p).test("lanes.lock.json")));
  assert.ok(!owner.some((p) => new RegExp(p).test("sub/lanes.lock.jsonx")));
});
