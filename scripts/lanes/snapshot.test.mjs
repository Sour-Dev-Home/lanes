import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { buildSnapshot, parseFromArg, parseInput, parseOutArg, verdictCriteria, writeSnapshot } from "./snapshot.mjs";
import { buildVerdictComment } from "./post-review.mjs";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const OTHER_SHA = "fedcba9876543210fedcba9876543210fedcba98";
const NOW = "2026-09-28T12:00:00.000Z";

const body = (blockedBy = "none") =>
  `### Goal\n\ng\n\n### Acceptance criteria\n\n- [ ] a\n- [ ] b\n\n### Interface contract\n\nx\n\n### Scope\n\nIn: a.\n\n### Blocked by\n\n${blockedBy}\n\n### Tier\n\nquick\n`;
const issue = (number, over = {}) => ({ number, title: `Issue ${number}`, labels: [{ name: "ready" }, { name: "tier:quick" }], body: body(), ...over });
const gate = (state, description) => ({ context: "lanes/gate", state, description });
const pr = (number, over = {}) => ({
  number,
  title: `PR ${number}`,
  body: "Closes #1",
  headRefOid: SHA,
  headRefName: `issue-${number}`,
  statusCheckRollup: [{ name: "verify", conclusion: "SUCCESS" }, gate("SUCCESS")],
  autoMergeRequest: { enabledAt: NOW },
  closingIssuesReferences: [{ number: 1 }],
  comments: [],
  ...over,
});
const verdict = (reviewer, criteria, sha = SHA) => ({ reviewer, verdict: "success", summary: "s", criteria, findings: [] });
const comment = (v, over = {}, sha = SHA) => ({ body: buildVerdictComment(v, sha), authorAssociation: "OWNER", author: { login: "someone" }, ...over });

const build = (over = {}) => buildSnapshot({ prs: [], issues: [], mergeQueue: [], gateDescriptions: new Map(), generatedAt: NOW, ...over });
const one = (over) => build(over).issues[0];

test("an empty repository gives an empty snapshot with the time", () => {
  assert.deepEqual(build(), { version: 0, generatedAt: NOW, issues: [], edges: [] });
});

test("a ready issue with no blockers lists as ready with no blockedBy", () => {
  const s = build({ issues: [issue(1)] });
  assert.deepEqual(s.issues, [{ number: 1, title: "Issue 1", tier: "quick", stage: "ready", blockedBy: [] }]);
});

test("an issue blocked by an open issue is blocked, with an issue blocker and an edge", () => {
  const s = build({ issues: [issue(1), issue(2, { body: body("#1") })] });
  const two = s.issues.find((i) => i.number === 2);
  assert.equal(two.stage, "blocked");
  assert.deepEqual(two.blockedBy, [{ kind: "issue", ref: "#1", reason: "blocked by #1" }]);
  assert.deepEqual(s.edges, [{ from: 1, to: 2 }]);
});

test("edge: a blocker that is closed (not in the open list) neither blocks nor makes an edge", () => {
  const s = build({ issues: [issue(2, { body: body("#99") })] });
  assert.equal(s.issues[0].stage, "ready");
  assert.deepEqual(s.edges, []);
});

test("edge: an open blocker without a tier label still blocks but gets no edge (only listed issues do)", () => {
  const s = build({ issues: [issue(1, { labels: [] }), issue(2, { body: body("#1") })] });
  assert.deepEqual(s.issues.map((i) => i.number), [2]);
  assert.equal(s.issues[0].stage, "blocked");
  assert.deepEqual(s.edges, []);
});

test("a task issue that is not ready lists as not-ready; one labelled needs-owner as already met", () => {
  const s = build({ issues: [issue(1, { labels: [{ name: "tier:full" }] }), issue(2, { labels: [{ name: "tier:full" }, { name: "needs-owner" }] })] });
  assert.deepEqual(s.issues.map((i) => [i.stage, i.tier]), [["not-ready", "full"], ["already met", "full"]]);
});

test("an issue with no tier label and no PR is left out; one a PR closes is listed with tier unknown", () => {
  assert.deepEqual(build({ issues: [issue(1, { labels: [{ name: "ready" }] })] }).issues, []);
  assert.equal(one({ issues: [issue(1, { labels: [] })], prs: [pr(5)] }).tier, "unknown");
});

test("a PR with a passing gate and auto-merge is queued with checks and its head", () => {
  const i = one({ issues: [issue(1)], prs: [pr(5)] });
  assert.equal(i.stage, "queued");
  assert.deepEqual(i.blockedBy, []);
  assert.deepEqual(i.pr, { number: 5, headSha: SHA, checks: [{ name: "verify", result: "pass" }, { name: "lanes/gate", result: "pass" }] });
});

test("a PR in the merge queue is blocked by the queue", () => {
  const i = one({ issues: [issue(1)], prs: [pr(5)], mergeQueue: [{ number: 5, position: 2 }] });
  assert.deepEqual(i.blockedBy, [{ kind: "queue", ref: "merge queue", reason: "in merge queue, position 2" }]);
});

test("a failing CI check is a check blocker per failing check, and shows as fail", () => {
  const i = one({
    issues: [issue(1)],
    prs: [pr(5, { statusCheckRollup: [{ name: "verify", conclusion: "FAILURE" }, { name: "security", conclusion: "CANCELLED" }, gate("PENDING", "waiting on owner (/approve)")] })],
  });
  assert.equal(i.stage, "failing");
  assert.deepEqual(i.blockedBy.map((b) => [b.kind, b.ref]), [["check", "verify"], ["check", "security"]]);
  assert.deepEqual(i.pr.checks.map((c) => c.result), ["fail", "fail", "pending"]);
});

test("a gate waiting on the owner is an owner blocker with the description verbatim", () => {
  const i = one({ issues: [issue(1)], prs: [pr(5, { statusCheckRollup: [gate("PENDING", "waiting on owner (/approve)")] })] });
  assert.equal(i.stage, "owner");
  assert.deepEqual(i.blockedBy, [{ kind: "owner", ref: "review/owner", reason: "waiting on owner (/approve)" }]);
});

test("a gate waiting on a reviewer is a review blocker naming it; the description may come from gateDescriptions", () => {
  const i = one({
    issues: [issue(1)],
    prs: [pr(5, { statusCheckRollup: [{ context: "lanes/gate", state: "PENDING" }] })],
    gateDescriptions: new Map([[5, "waiting for review/test-hunter"]]),
  });
  assert.equal(i.stage, "gate");
  assert.deepEqual(i.blockedBy, [{ kind: "review", ref: "test-hunter", reason: "waiting for review/test-hunter" }]);
});

test("a failed gate is a contract wait on lanes/gate; no gate yet is starting", () => {
  const failed = one({ issues: [issue(1)], prs: [pr(5, { statusCheckRollup: [gate("FAILURE", "PR body: missing what changed")] })] });
  assert.deepEqual([failed.stage, failed.blockedBy], ["contract", [{ kind: "check", ref: "lanes/gate", reason: "PR body: missing what changed" }]]);
  const starting = one({ issues: [issue(1)], prs: [pr(5, { statusCheckRollup: [] })] });
  assert.deepEqual([starting.stage, starting.blockedBy[0].ref], ["starting", "lanes/gate"]);
});

test("edge: a check with an unknown state or conclusion counts as pending; a status context names the check", () => {
  const i = one({ issues: [issue(1)], prs: [pr(5, { statusCheckRollup: [{ context: "ci/x", state: "PENDING" }, { name: "y", conclusion: "" }, { name: "z", status: "IN_PROGRESS" }, { name: "w", conclusion: "SKIPPED" }, gate("SUCCESS")] })] });
  assert.deepEqual(i.pr.checks, [{ name: "ci/x", result: "pending" }, { name: "y", result: "pending" }, { name: "z", result: "pending" }, { name: "w", result: "pass" }, { name: "lanes/gate", result: "pass" }]);
});

test("edge: a PR with no statusCheckRollup, comments or closing refs does not throw", () => {
  const bare = { number: 7, title: "t", headRefOid: SHA };
  assert.deepEqual(build({ prs: [bare], issues: [issue(1)] }).issues.map((i) => i.pr), [undefined]);
});

test("edge: two PRs closing one issue: the newest number is shown", () => {
  assert.equal(one({ issues: [issue(1)], prs: [pr(5), pr(9)] }).pr.number, 9);
});

test("a PR closing two issues lists both, each with the PR", () => {
  const s = build({ issues: [issue(1), issue(2)], prs: [pr(5, { closingIssuesReferences: [{ number: 1 }, { number: 2 }] })] });
  assert.deepEqual(s.issues.map((i) => i.pr.number), [5, 5]);
});

test("criteria come from verdicts on the current head: fail beats pass beats not-applicable", () => {
  const c = [
    comment(verdict("test-hunter", [{ index: 1, result: "pass", evidence: "e" }, { index: 2, result: "pass", evidence: "e" }, { index: 3, result: "not-applicable", evidence: "e" }])),
    comment(verdict("ui-reviewer", [{ index: 1, result: "fail", evidence: "e" }, { index: 3, result: "not-applicable", evidence: "e" }, { index: 4, result: "pass", evidence: "e" }])),
  ];
  assert.deepEqual(one({ issues: [issue(1)], prs: [pr(5, { comments: c })] }).criteria, [
    { index: 1, result: "fail" },
    { index: 2, result: "pass" },
    { index: 3, result: "not-applicable" },
    { index: 4, result: "pass" },
  ]);
});

test("edge: a verdict on an older head, an unbound one, or from a stranger is ignored", () => {
  const v = verdict("test-hunter", [{ index: 1, result: "pass", evidence: "e" }]);
  const comments = [
    comment(v, {}, OTHER_SHA),
    { ...comment(v), body: `<!-- lanes:verdict test-hunter -->\n\`\`\`json\n${JSON.stringify(v)}\n\`\`\`` },
    comment(v, { authorAssociation: "NONE" }),
    comment(v, { authorAssociation: "CONTRIBUTOR" }),
  ];
  assert.equal(one({ issues: [issue(1)], prs: [pr(5, { comments })] }).criteria, undefined);
});

test("edge: only the newest verdict per reviewer on the head counts", () => {
  const first = comment(verdict("test-hunter", [{ index: 1, result: "fail", evidence: "e" }]));
  const second = comment(verdict("test-hunter", [{ index: 1, result: "pass", evidence: "e" }]));
  assert.deepEqual(one({ issues: [issue(1)], prs: [pr(5, { comments: [first, second] })] }).criteria, [{ index: 1, result: "pass" }]);
});

test("edge: malformed criteria entries in a verdict are skipped", () => {
  const v = { ...verdict("test-hunter", []), criteria: [null, { index: 0, result: "pass" }, { index: 1.5, result: "pass" }, { index: 2, result: "maybe" }, { index: 3, result: "pass" }] };
  assert.deepEqual(verdictCriteria([{ reviewer: "test-hunter", sha: SHA, verdict: v }], SHA), [{ index: 3, result: "pass" }]);
  assert.deepEqual(verdictCriteria([{ reviewer: "test-hunter", sha: SHA, verdict: { criteria: "x" } }], SHA), []);
});

test("the snapshot holds no logins, emails, bodies or comments from the input", () => {
  const secretBody = "BODY-SECRET alice@example.com";
  const v = verdict("test-hunter", [{ index: 1, result: "pass", evidence: "EVIDENCE-SECRET" }]);
  v.summary = "SUMMARY-SECRET";
  v.findings = [{ severity: "minor", file: "f", line: 1, summary: "FINDING-SECRET", fixed: true }];
  const s = build({
    issues: [issue(1, { body: `${body()}\n${secretBody}`, author: { login: "issue-author-login" }, assignees: [{ login: "assignee-login" }] })],
    prs: [
      pr(5, {
        body: `Closes #1\n${secretBody}`,
        author: { login: "pr-author-login" },
        headRefName: "branch-SECRET",
        files: [{ path: "FILE-SECRET" }],
        comments: [comment(v, { author: { login: "commenter-login", email: "bob@example.com" } }), { body: `COMMENT-SECRET ${secretBody}`, authorAssociation: "OWNER", author: { login: "x" } }],
      }),
    ],
  });
  const text = JSON.stringify(s);
  for (const leak of ["SECRET", "login", "@example.com", "commenter", "assignee", "FINDING", "EVIDENCE", "SUMMARY"]) assert.ok(!text.includes(leak), `leaked: ${leak}`);
});

test("edge: a title loses control characters and is cut to 200 characters", () => {
  const i = one({ issues: [issue(1, { title: `a\u001b[31mb\u0000${"x".repeat(300)}` })] });
  assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(i.title));
  assert.equal(i.title.length, 200);
  assert.ok(i.title.startsWith("a[31mb"));
});

test("edge: an issue's title given as non-text becomes an empty string", () => {
  assert.equal(one({ issues: [issue(1, { title: null })] }).title, "");
});

test("issues are listed by number, whatever order they arrive in", () => {
  assert.deepEqual(build({ issues: [issue(3), issue(1), issue(2)] }).issues.map((i) => i.number), [1, 2, 3]);
});

test("edge: a cycle in Blocked by keeps every issue blocked and lists each edge once", () => {
  const s = build({ issues: [issue(1, { body: body("#2, #2") }), issue(2, { body: body("#1") })] });
  assert.deepEqual(s.issues.map((i) => i.stage), ["blocked", "blocked"]);
  assert.deepEqual(s.edges, [{ from: 1, to: 2 }, { from: 2, to: 1 }]);
});

test("parseOutArg reads --out <file>, and refuses a missing value", () => {
  assert.equal(parseOutArg([]), undefined);
  assert.equal(parseOutArg(["--out", "snapshot.json"]), "snapshot.json");
  assert.throws(() => parseOutArg(["--out"]), /--out takes a file/);
  assert.throws(() => parseOutArg(["--out", "--json"]), /--out takes a file/);
});

test("parseFromArg reads --from <file>, and refuses a missing value", () => {
  assert.equal(parseFromArg(["--out", "a", "--from", "in.json"]), "in.json");
  assert.equal(parseFromArg([]), undefined);
  assert.throws(() => parseFromArg(["--from"]), /--from takes a file/);
});

test("parseInput turns the JSON into buildSnapshot's inputs, gate descriptions keyed by PR number", () => {
  const r = parseInput(JSON.stringify({ prs: [], issues: [], mergeQueue: [{ number: 5, position: 1 }], gateDescriptions: { 5: "waiting for review/test-hunter" }, generatedAt: NOW }));
  assert.deepEqual(r, { prs: [], issues: [], mergeQueue: [{ number: 5, position: 1 }], gateDescriptions: new Map([[5, "waiting for review/test-hunter"]]), generatedAt: NOW });
});

test("edge: parseInput defaults the queue and descriptions, stamps the time itself, and refuses malformed input", () => {
  const r = parseInput('{"prs":[],"issues":[]}');
  assert.deepEqual([r.mergeQueue, [...r.gateDescriptions]], [[], []]);
  assert.match(r.generatedAt, /^\d{4}-\d\d-\d\dT[\d:.]+Z$/);
  assert.throws(() => parseInput("nope"), /not valid JSON/);
  assert.throws(() => parseInput("null"), /prs and issues/);
  assert.throws(() => parseInput('{"prs":[]}'), /prs and issues/);
  assert.throws(() => parseInput('{"prs":[],"issues":[],"gateDescriptions":{"5":7}}'), /gateDescriptions/);
  assert.throws(() => parseInput('{"prs":[],"issues":[],"gateDescriptions":[]}'), /gateDescriptions/);
  assert.throws(() => parseInput('{"prs":[],"issues":[],"mergeQueue":{}}'), /mergeQueue/);
});

test("the command builds a snapshot offline with --from and writes it with --out", () => {
  const dir = mkdtempSync(join(tmpdir(), "snapshot-cli-"));
  try {
    writeFileSync(join(dir, "in.json"), JSON.stringify({ prs: [], issues: [issue(1)], generatedAt: NOW }));
    execFileSync(process.execPath, ["scripts/lanes/snapshot.mjs", "--from", join(dir, "in.json"), "--out", join(dir, "out.json")], { stdio: "pipe" });
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "out.json"), "utf8")), build({ issues: [issue(1)] }));
    const stdout = execFileSync(process.execPath, ["scripts/lanes/snapshot.mjs", "--from", join(dir, "in.json")], { encoding: "utf8" });
    assert.equal(JSON.parse(stdout).generatedAt, NOW);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeSnapshot writes the JSON to the file, creating the folder, and ends with a newline", () => {
  const dir = mkdtempSync(join(tmpdir(), "snapshot-"));
  try {
    const file = join(dir, "site", "snapshot.json");
    writeSnapshot(build({ issues: [issue(1)] }), file);
    const text = readFileSync(file, "utf8");
    assert.ok(text.endsWith("\n"));
    assert.equal(JSON.parse(text).issues[0].number, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
