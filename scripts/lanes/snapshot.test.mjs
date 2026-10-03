import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { DEFAULT_SOFT_PATHS, RUNNING_LABEL, TREND_WEEKS, buildSnapshot, buildTrends, isoWeekLabel, normalizeTrendPr, parseFromArg, parseInput, parseOutArg, readOwnerApprovals, verdictCriteria, writeSnapshot } from "./snapshot.mjs";
import { buildVerdictComment } from "./post-review.mjs";
import { REVIEWERS, TEAM_REQUIRED_MESSAGE } from "./lib.mjs";
import { STATUS_QUERY } from "./status.mjs";

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
  isCrossRepository: false,
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
  assert.deepEqual(build(), { version: 0, generatedAt: NOW, profile: "team", issues: [], edges: [], overlaps: [] });
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
  assert.deepEqual(i.pr, { number: 5, headSha: SHA, checks: [{ name: "verify", result: "pass" }, { name: "lanes/gate", result: "pass" }], ownerApproved: false });
});

test("a PR in the merge queue is blocked by the queue", () => {
  const i = one({ issues: [issue(1)], prs: [pr(5)], mergeQueue: [{ number: 5, position: 2 }] });
  assert.deepEqual(i.blockedBy, [{ kind: "queue", ref: "merge queue", reason: "in merge queue, position 2" }]);
});

test("a failing CI check is a check blocker per failing check, and shows as fail", () => {
  const i = one({
    issues: [issue(1)],
    prs: [pr(5, { statusCheckRollup: [{ name: "verify", conclusion: "FAILURE" }, { name: "security", conclusion: "CANCELLED" }, gate("PENDING", "waiting for a code-owner review in GitHub")] })],
  });
  assert.equal(i.stage, "failing");
  assert.deepEqual(i.blockedBy.map((b) => [b.kind, b.ref]), [["check", "verify"], ["check", "security"]]);
  assert.deepEqual(i.pr.checks.map((c) => c.result), ["fail", "fail", "pending"]);
});

test("a gate waiting on the owner is an owner blocker with the description verbatim", () => {
  const i = one({ issues: [issue(1)], prs: [pr(5, { statusCheckRollup: [gate("PENDING", "waiting for a code-owner review in GitHub")] })] });
  assert.equal(i.stage, "owner");
  assert.deepEqual(i.blockedBy, [{ kind: "owner", ref: "code-owner review", reason: "waiting for a code-owner review in GitHub" }]);
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
  const bare = { number: 7, title: "t", headRefOid: SHA, isCrossRepository: false };
  assert.deepEqual(build({ prs: [bare], issues: [issue(1)] }).issues.map((i) => i.pr), [undefined]);
});

test("a fork's PR, or one whose origin is unknown, is ignored: its check names never reach the snapshot", () => {
  const strangerChecks = [{ name: ["job ", "", "home", "x"].join("/"), conclusion: "SUCCESS" }, gate("SUCCESS")];
  for (const isCrossRepository of [true, undefined, null, "false"]) {
    const s = build({ issues: [issue(1)], prs: [pr(5, { isCrossRepository, statusCheckRollup: strangerChecks })] });
    assert.equal(s.issues[0].pr, undefined, String(isCrossRepository));
    assert.equal(s.issues[0].stage, "ready");
    assert.ok(!JSON.stringify(s).includes(["", "home", ""].join("/")));
  }
});

test("edge: a fork's PR does not hide a same-repo PR for the same issue, whatever its number", () => {
  const s = build({ issues: [issue(1)], prs: [pr(5), pr(9, { isCrossRepository: true })] });
  assert.equal(s.issues[0].pr.number, 5);
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

test("a configured reviewer's verdict counts when buildSnapshot is given its name, and is ignored otherwise", () => {
  const v = verdict("extra-reviewer", [{ index: 1, result: "fail", evidence: "e" }]);
  const c = { body: `<!-- lanes:verdict extra-reviewer ${SHA} -->\n\`\`\`json\n${JSON.stringify(v)}\n\`\`\``, authorAssociation: "OWNER" };
  const input = { issues: [issue(1)], prs: [pr(5, { comments: [c] })] };
  assert.deepEqual(one({ ...input, reviewers: [...REVIEWERS, "extra-reviewer"] }).criteria, [{ index: 1, result: "fail" }]);
  assert.equal(one(input).criteria, undefined);
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
    // Run in the temp directory, so the repository's own lanes.config.json is not read; ADR 0025: it must be a team one.
    const script = resolve("scripts/lanes/snapshot.mjs");
    writeFileSync(join(dir, "lanes.config.json"), JSON.stringify({ identity: TEAM_ID }));
    execFileSync(process.execPath, [script, "--from", join(dir, "in.json"), "--out", join(dir, "out.json")], { stdio: "pipe", cwd: dir, windowsHide: true });
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "out.json"), "utf8")), build({ issues: [issue(1)], profile: "team" }));
    const stdout = execFileSync(process.execPath, [script, "--from", join(dir, "in.json")], { encoding: "utf8", cwd: dir, windowsHide: true });
    assert.equal(JSON.parse(stdout).generatedAt, NOW);
    // The profile comes from the config's identity in the working directory.
    assert.equal(JSON.parse(stdout).profile, "team");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// #613 (ADR 0025): a config that is not team shows the one line in place of data; the command does not crash and writes no file.
const TEAM_ID = { profile: "team", app: { id: 11, installationId: 22, botLogin: "sour-dev-lanes[bot]" } };
test("the command prints the team-required line instead of a snapshot for a missing config, a missing identity, solo or an unknown profile", () => {
  const dir = mkdtempSync(join(tmpdir(), "snapshot-refuse-"));
  const script = resolve("scripts/lanes/snapshot.mjs");
  try {
    writeFileSync(join(dir, "in.json"), JSON.stringify({ prs: [], issues: [issue(1)], generatedAt: NOW }));
    for (const config of [null, "{}", JSON.stringify({ identity: {} }), JSON.stringify({ identity: { profile: "solo" } }), JSON.stringify({ identity: { profile: "solo", app: TEAM_ID.app } }), JSON.stringify({ identity: { profile: "other" } })]) {
      rmSync(join(dir, "lanes.config.json"), { force: true });
      if (config !== null) writeFileSync(join(dir, "lanes.config.json"), config);
      for (const extra of [[], ["--out", join(dir, "out.json")]]) {
        const stdout = execFileSync(process.execPath, [script, "--from", join(dir, "in.json"), ...extra], { encoding: "utf8", cwd: dir, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
        assert.ok(stdout.startsWith(TEAM_REQUIRED_MESSAGE), stdout);
        assert.equal(stdout.trim().split("\n").length, 1, "one line");
        assert.equal(existsSync(join(dir, "out.json")), false, "no snapshot file");
      }
    }
    writeFileSync(join(dir, "lanes.config.json"), JSON.stringify({ identity: { profile: "solo" } }));
    assert.match(execFileSync(process.execPath, [script, "--from", join(dir, "in.json")], { encoding: "utf8", cwd: dir, windowsHide: true }), /profile "solo"/);
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

test("edge: a PR whose gate passed with auto-merge off is ready, with no blockers", () => {
  const i = one({ issues: [issue(1)], prs: [pr(5, { autoMergeRequest: null })] });
  assert.equal(i.stage, "ready");
  assert.deepEqual(i.blockedBy, []);
});

test("edge: a criterion result outside pass/fail/not-applicable never reaches the criteria", () => {
  const v = { sha: SHA, reviewer: "r", verdict: { criteria: [{ index: 1, result: "<script>" }, { index: 2, result: "pass" }] } };
  assert.deepEqual(verdictCriteria([v], SHA), [{ index: 2, result: "pass" }]);
});

test("snapshot.mjs uses status.mjs's GraphQL query rather than its own copy", () => {
  const source = readFileSync(new URL("./snapshot.mjs", import.meta.url), "utf8");
  assert.equal(typeof STATUS_QUERY, "string");
  assert.match(source, /import \{[^}]*\bSTATUS_QUERY\b[^}]*\} from "\.\/status\.mjs"/);
  assert.match(source, /`query=\$\{STATUS_QUERY\}`/);
  // The only other query is the trends' merged-PR read (TRENDS_QUERY); the status query is never copied.
  assert.equal((source.match(/query\(\$owner/g) ?? []).length, 1);
  assert.match(source, /const TRENDS_QUERY = `query\(\$owner/);
  assert.doesNotMatch(source, /mergeQueue\(|branchProtectionRule/);
});

test("edge: the running label and default soft paths match start.mjs, which snapshot.mjs cannot import", async () => {
  const start = await import("./start.mjs");
  assert.equal(RUNNING_LABEL, start.RUNNING_LABEL);
  assert.deepEqual([...DEFAULT_SOFT_PATHS], [...start.START_DEFAULTS.softPaths]);
});

const scoped = (number, paths, labels = ["ready", "tier:quick"], over = {}) =>
  issue(number, { labels: labels.map((name) => ({ name })), body: body().replace("In: a.", `In: ${paths}.`), ...over });

test("an open issue with lane:running and no PR has the running stage; with a PR the PR stage wins", () => {
  const running = ["lane:running", "tier:quick"];
  assert.equal(one({ issues: [scoped(1, "`a.mjs`", running)] }).stage, "running");
  assert.deepEqual(one({ issues: [scoped(1, "`a.mjs`", running)] }).blockedBy, []);
  const withPr = one({ issues: [scoped(1, "`a.mjs`", running)], prs: [pr(7)], gateDescriptions: new Map([[7, "waiting for a code-owner review in GitHub"]]) });
  assert.notEqual(withPr.stage, "running");
  assert.equal(withPr.pr.number, 7);
});

test("overlaps lists a real overlap once with a < b, and no path is published", () => {
  const s = build({ issues: [scoped(9, "`src/x.mjs`"), scoped(4, "`src/x.mjs`")] });
  assert.deepEqual(s.overlaps, [{ a: 4, b: 9 }]);
  assert.ok(!JSON.stringify(s).includes("src/x.mjs"));
});

test("overlaps ignores a pair sharing only a soft path", () => {
  assert.deepEqual(build({ issues: [scoped(1, "`README.md`"), scoped(2, "`README.md`")] }).overlaps, []);
  assert.deepEqual(build({ issues: [scoped(1, "`a.mjs`"), scoped(2, "`a.mjs`")], softPaths: ["^a\\.mjs$"] }).overlaps, []);
});

test("edge: overlaps counts a directory claim and a running issue, and skips issues that are neither ready nor running", () => {
  const s = build({
    issues: [scoped(1, "`src/`"), scoped(2, "`src/x.mjs`", ["lane:running", "tier:quick"]), scoped(3, "`src/x.mjs`", ["tier:quick"]), scoped(4, "`src/y.mjs`", ["needs-owner", "tier:quick"])],
  });
  assert.deepEqual(s.overlaps, [{ a: 1, b: 2 }]);
});

test("edge: an issue with no Scope paths is never listed, and overlaps is empty rather than missing", () => {
  assert.deepEqual(build({ issues: [scoped(1, "nothing"), scoped(2, "nothing")] }).overlaps, []);
  assert.deepEqual(build().overlaps, []);
});

test("edge: the command reads start.softPaths from lanes.config.json in the working directory, and refuses a malformed one", () => {
  const dir = mkdtempSync(join(tmpdir(), "snapshot-cfg-"));
  const script = join(process.cwd(), "scripts/lanes/snapshot.mjs");
  const run = () => JSON.parse(execFileSync(process.execPath, [script, "--from", "in.json"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true }));
  try {
    writeFileSync(join(dir, "in.json"), JSON.stringify({ prs: [], issues: [scoped(1, "`a.mjs`"), scoped(2, "`a.mjs`")], generatedAt: NOW }));
    writeFileSync(join(dir, "lanes.config.json"), JSON.stringify({ identity: TEAM_ID }));
    assert.deepEqual(run().overlaps, [{ a: 1, b: 2 }]);
    writeFileSync(join(dir, "lanes.config.json"), JSON.stringify({ identity: TEAM_ID, start: { softPaths: ["^a\\.mjs$"] } }));
    assert.deepEqual(run().overlaps, []);
    writeFileSync(join(dir, "lanes.config.json"), JSON.stringify({ identity: TEAM_ID, start: { softPaths: [1] } }));
    assert.throws(run, /softPaths must be an array of regex strings/);
    writeFileSync(join(dir, "lanes.config.json"), JSON.stringify({ identity: TEAM_ID }));
    assert.deepEqual(run().overlaps, [{ a: 1, b: 2 }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("edge: an issue that already has a PR is not listed in overlaps", () => {
  assert.deepEqual(build({ issues: [scoped(1, "`a.mjs`"), scoped(2, "`a.mjs`")], prs: [pr(7)] }).overlaps, []);
});

// #416: a conflicted PR waits on the owner; UNKNOWN changes nothing.
test("a CONFLICTING PR is stage owner with the reason conflict: rebase needed", () => {
  const i = one({ issues: [issue(1)], prs: [pr(5, { mergeable: "CONFLICTING" })] });
  assert.equal(i.stage, "owner");
  assert.deepEqual(i.blockedBy, [{ kind: "owner", ref: "merge conflict", reason: "conflict: rebase needed" }]);
});
test("an UNKNOWN mergeable state changes nothing", () => {
  const i = one({ issues: [issue(1)], prs: [pr(5, { mergeable: "UNKNOWN", statusCheckRollup: [gate("PENDING", "waiting for a code-owner review in GitHub")] })] });
  assert.equal(i.stage, "owner");
  assert.equal(i.blockedBy[0].ref, "code-owner review");
});
test("the default soft paths include lanes.config.json", () => {
  assert.ok(DEFAULT_SOFT_PATHS.includes("^lanes\\.config\\.json$"));
});

// ADR 0024: profile, repo, ownerApproved and check urls.
const REPO = "acme/lanes";
const withRollup = (rollup, over = {}) => one({ issues: [issue(1)], prs: [pr(5, { statusCheckRollup: rollup })], repo: REPO, ...over }).pr.checks;

test("profile is always team, and repo is written when given and valid and omitted otherwise", () => {
  const s = build({ repo: REPO });
  assert.equal(s.profile, "team");
  assert.equal(s.repo, REPO);
  const bare = build();
  assert.equal(bare.profile, "team");
  assert.equal("repo" in bare, false);
  for (const repo of ["acme", "https://github.com/a/b", "a/b/c", "a b/c", "", 5, null, "../x", "a/..", "./.", "a/."]) assert.equal("repo" in build({ repo }), false, `edge: repo ${JSON.stringify(repo)}`);
  assert.equal(build({ profile: "solo" }).profile, "team", "edge: a profile passed in is ignored");
});

test("ownerApproved is written under team from the approvals map: true, false, and false when unread", () => {
  const prs = [pr(5), pr(6, { closingIssuesReferences: [{ number: 2 }] }), pr(7, { closingIssuesReferences: [{ number: 3 }] })];
  const issues = [issue(1), issue(2), issue(3)];
  const s = build({ issues, prs, ownerApprovals: new Map([[5, true], [6, false]]) });
  assert.deepEqual(s.issues.map((i) => i.pr.ownerApproved), [true, false, false]);
});

test("edge: ownerApproved is false with no approvals map, and only a true answer counts", () => {
  assert.equal(one({ issues: [issue(1)], prs: [pr(5)] }).pr.ownerApproved, false);
  assert.equal(one({ issues: [issue(1)], prs: [pr(5)], ownerApprovals: new Map([[5, "yes"]]) }).pr.ownerApproved, false);
});

test("a check url is kept for this repo from detailsUrl, or from targetUrl when there is no detailsUrl", () => {
  const checks = withRollup([
    { name: "verify", conclusion: "SUCCESS", detailsUrl: `https://github.com/${REPO}/actions/runs/1` },
    { context: "ci/x", state: "SUCCESS", targetUrl: `https://github.com/${REPO}/runs/2` },
  ]);
  assert.equal(checks[0].url, `https://github.com/${REPO}/actions/runs/1`);
  assert.equal(checks[1].url, `https://github.com/${REPO}/runs/2`);
});

test("a check url is dropped for another repo, javascript:, http, whitespace, control characters, a lookalike prefix or no repo", () => {
  const bad = [
    "https://github.com/evil/other/actions/runs/1",
    "javascript:alert(1)",
    `http://github.com/${REPO}/runs/1`,
    `https://github.com/${REPO}/runs/1 x`,
    `https://github.com/${REPO}/runs/1\n`,
    `https://github.com/${REPO}/runs/\u001b[31m1`,
    `https://github.com/${REPO}-fork/runs/1`,
    `https://github.com/${REPO}/../../evil/x`,
    `https://github.com/${REPO}/runs/%2e%2E/x`,
    `https://github.com/${REPO}/runs/./1`,
    `https://github.com/${REPO}/runs/..`,
    `https://github.com/${REPO}/pull/1/..\\..\\..\\other/x`,
    `https://github.com/${REPO}/runs\\1`,
    `https://github.com/${REPO}/runs/%5c..%5cother`,
    `https://github.com/${REPO}/runs/%2F..%2fother`,
    `https://github.com/${REPO}/runs/..?x=1`,
    `https://evil.example/https://github.com/${REPO}/runs/1`,
    `https://github.com/${REPO}/${"x".repeat(600)}`,
    42,
  ];
  for (const url of bad) assert.equal("url" in withRollup([{ name: "v", conclusion: "SUCCESS", detailsUrl: url }])[0], false, `edge: ${String(url).slice(0, 40)}`);
  assert.equal("url" in withRollup([{ name: "v", conclusion: "SUCCESS", detailsUrl: `https://github.com/${REPO}/runs/1` }], { repo: undefined })[0], false, "edge: no repo");
});

test("parseInput carries repo and the ownerApproved map", () => {
  const parsed = parseInput(JSON.stringify({ prs: [], issues: [], repo: REPO, ownerApproved: { 5: true, 6: "yes" } }));
  assert.equal(parsed.repo, REPO);
  assert.deepEqual([...parsed.ownerApprovals], [[5, true], [6, false]]);
  assert.equal("ownerApprovals" in parseInput(JSON.stringify({ prs: [], issues: [] })), false);
});

const approvalReview = (login, state = "APPROVED", commit = SHA) => JSON.stringify({ user: { login, type: "User" }, state, commit_id: commit });
const fakeRun = ({ codeowners = "* @boss\n", reviews = {} } = {}) => (args) => {
  const target = args[1];
  if (target.endsWith("/contents/.github/CODEOWNERS")) {
    if (codeowners === null) throw new Error("404");
    return codeowners;
  }
  const n = Number(/pulls\/(\d+)\/reviews/.exec(target)[1]);
  if (reviews[n] === "throw") throw new Error("boom");
  return reviews[n] ?? "";
};

test("readOwnerApprovals: true for a code owner's approval on the head, false for a stale one, the author, a stranger or no review", () => {
  const prs = [5, 6, 7, 8, 9].map((number) => ({ number, headRefOid: SHA, author: { login: "dev" } }));
  prs[3].author = { login: "boss" }; // the owner authored PR 8: self-approval does not count
  const run = fakeRun({ reviews: { 5: approvalReview("boss"), 6: approvalReview("boss", "APPROVED", OTHER_SHA), 7: approvalReview("stranger"), 8: approvalReview("boss") } });
  assert.deepEqual([...readOwnerApprovals({ prs, repo: REPO, run })], [[5, true], [6, false], [7, false], [8, false], [9, false]]);
});

test("readOwnerApprovals: a failed review read, a missing CODEOWNERS or a missing head sha is false, never a throw", () => {
  const prs = [{ number: 5, headRefOid: SHA }, { number: 6, headRefOid: SHA }, { number: 7 }];
  const reviews = { 5: "throw", 6: approvalReview("boss"), 7: approvalReview("boss") };
  assert.deepEqual([...readOwnerApprovals({ prs, repo: REPO, run: fakeRun({ reviews }) })], [[5, false], [6, true], [7, false]]);
  assert.deepEqual([...readOwnerApprovals({ prs, repo: REPO, run: fakeRun({ codeowners: null, reviews }) })], [[5, false], [6, false], [7, false]]);
  assert.deepEqual([...readOwnerApprovals({ prs: [{ number: 5, headRefOid: SHA }], repo: REPO, run: fakeRun({ reviews: { 5: "not json" } }) })], [[5, false]]);
});

test("readOwnerApprovals never returns a login", () => {
  const got = readOwnerApprovals({ prs: [{ number: 5, headRefOid: SHA }], repo: REPO, run: fakeRun({ reviews: { 5: approvalReview("boss") } }) });
  assert.doesNotMatch(JSON.stringify([...got]), /boss/);
});

test("edge: a check url is kept at exactly 500 characters and dropped at 501", () => {
  const base = "https://github.com/" + REPO + "/runs/";
  assert.equal(withRollup([{ name: "v", conclusion: "SUCCESS", detailsUrl: base + "x".repeat(500 - base.length) }])[0].url?.length, 500);
  assert.equal("url" in withRollup([{ name: "v", conclusion: "SUCCESS", detailsUrl: base + "x".repeat(501 - base.length) }])[0], false);
});

// ADR 0027 part 7: weekly trends, counts only.
const richPr = (over = {}) => ({ mergedAt: "2026-09-29T10:00:00Z", queueRemoved: [], statuses: [], checkRunAttempts: [], failedRounds: 0, ...over });
const verdictBody = (rounds) => buildVerdictComment({ reviewer: "test-hunter", verdict: "success", summary: "s", criteria: [], findings: [], metrics: { tier: "full", minutes: 1, tokens: 10, ...(rounds === undefined ? {} : { rounds }) } }, SHA);
const TREND_NOW = new Date("2026-10-02T12:00:00Z"); // a Friday in ISO week 2026-W40

test("isoWeekLabel gives the ISO year and week, including a year boundary", () => {
  assert.equal(isoWeekLabel("2026-10-02T12:00:00Z"), "2026-W40");
  assert.equal(isoWeekLabel("2026-09-28T00:00:00Z"), "2026-W40");
  assert.equal(isoWeekLabel("2027-01-01T00:00:00Z"), "2026-W53");
  assert.equal(isoWeekLabel("2024-12-30T00:00:00Z"), "2025-W01");
});

test("buildTrends counts the four measures per ISO week, oldest first, with every week of the window present", () => {
  const trends = buildTrends({
    now: TREND_NOW,
    weeks: 3,
    prs: [
      richPr({
        queueRemoved: ["2026-09-30T08:00:00Z", "2026-09-22T08:00:00Z"],
        statuses: [{ context: "lanes/gate", state: "failure", at: "2026-10-01T08:00:00Z" }, { context: "review/x", state: "success", at: "2026-10-01T08:00:00Z" }, { context: "ci", state: "error", at: "2026-09-23T08:00:00Z" }],
        checkRunAttempts: [1, 3],
        failedRounds: 2,
      }),
    ],
  });
  assert.deepEqual(trends, [
    { week: "2026-W38", queueRemovals: 0, gateFailures: 0, flakes: 0, reviewRounds: 0 },
    { week: "2026-W39", queueRemovals: 1, gateFailures: 1, flakes: 0, reviewRounds: 0 },
    { week: "2026-W40", queueRemovals: 1, gateFailures: 1, flakes: 2, reviewRounds: 2 },
  ]);
});

test("edge: buildTrends with no PRs is a zero row per week, and drops anything outside the window, in the future or unreadable", () => {
  const empty = buildTrends({ now: TREND_NOW, prs: [], weeks: 2 });
  assert.equal(empty.length, 2);
  assert.ok(empty.every((r) => r.queueRemovals + r.gateFailures + r.flakes + r.reviewRounds === 0));
  const trends = buildTrends({ now: TREND_NOW, weeks: 2, prs: [richPr({ mergedAt: "2026-01-01T00:00:00Z", checkRunAttempts: [4], queueRemoved: ["2026-01-01T00:00:00Z", "2026-12-01T00:00:00Z", "garbage"] }), undefined] });
  assert.ok(trends.every((r) => r.flakes === 0 && r.queueRemovals === 0));
});

test("edge: buildTrends defaults to 8 weeks", () => {
  assert.equal(buildTrends({ now: TREND_NOW, prs: [richPr()] }).length, TREND_WEEKS);
});

const node = (over = {}) => ({
  mergedAt: "2026-09-29T10:00:00Z",
  timelineItems: { nodes: [{ createdAt: "2026-09-29T09:00:00Z" }, { createdAt: "not a time" }] },
  comments: { nodes: [{ body: verdictBody(3) }, { body: verdictBody(1) }, { body: verdictBody(undefined) }, { body: "plain comment" }] },
  lastCommit: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [{ __typename: "StatusContext", state: "FAILURE", createdAt: "2026-09-29T08:00:00Z" }, { __typename: "CheckRun", checkSuite: { workflowRun: { runAttempt: 2 } } }, { __typename: "CheckRun", checkSuite: null }] } } } }] },
  ...over,
});

test("normalizeTrendPr keeps times, states, attempts and failed rounds only: rounds - 1 per verdict, none when absent", () => {
  assert.deepEqual(normalizeTrendPr(node()), { mergedAt: "2026-09-29T10:00:00Z", queueRemoved: ["2026-09-29T09:00:00Z"], statuses: [{ state: "failure", at: "2026-09-29T08:00:00Z" }], checkRunAttempts: [2], failedRounds: 2 });
});

test("edge: normalizeTrendPr of a node with no merge time, no commit, no comments or an invalid rounds value", () => {
  assert.equal(normalizeTrendPr({}), undefined);
  assert.equal(normalizeTrendPr(null), undefined);
  assert.deepEqual(normalizeTrendPr({ mergedAt: "2026-09-29T10:00:00Z" }), { mergedAt: "2026-09-29T10:00:00Z", queueRemoved: [], statuses: [], checkRunAttempts: [], failedRounds: 0 });
  const bad = { body: buildVerdictComment({ reviewer: "test-hunter", verdict: "success", summary: "s", criteria: [], findings: [], metrics: { tier: "full", minutes: 1, tokens: 1, rounds: 0 } }, SHA) };
  assert.equal(normalizeTrendPr(node({ comments: { nodes: [bad] } })).failedRounds, 0);
});

test("normalizeTrendPr output carries no title, login, check name or comment text", () => {
  const text = JSON.stringify(normalizeTrendPr(node({ title: "secret title", author: { login: "someone" }, number: 4242 })));
  for (const leak of ["secret title", "someone", "4242", "plain comment", "test-hunter"]) assert.ok(!text.includes(leak), leak);
});

test("buildTrends rows hold only a week label and four integers: no PR number, title, login or check name", () => {
  const [row] = buildTrends({
    now: TREND_NOW,
    weeks: 1,
    prs: [richPr({ number: 4242, title: "secret title", statuses: [{ context: "ci/private-check", state: "failure", at: "2026-10-01T08:00:00Z" }] })],
  });
  assert.deepEqual(Object.keys(row).sort(), ["flakes", "gateFailures", "queueRemovals", "reviewRounds", "week"]);
  const text = JSON.stringify(row);
  for (const leak of ["4242", "secret title", "private-check"]) assert.ok(!text.includes(leak));
});

test("buildSnapshot writes trends only when given them", () => {
  assert.equal("trends" in build(), false);
  const trends = [{ week: "2026-W40", queueRemovals: 1, gateFailures: 0, flakes: 0, reviewRounds: 0 }];
  assert.deepEqual(build({ trends }).trends, trends);
});

test("edge: buildTrends window boundaries, oldest week's first instant in, one ms before out, now in, one ms after out", () => {
  const at = (iso) => buildTrends({ now: TREND_NOW, weeks: 2, prs: [richPr({ queueRemoved: [iso] })] }).map((r) => r.queueRemovals);
  assert.deepEqual(at("2026-09-21T00:00:00.000Z"), [1, 0]);
  assert.deepEqual(at("2026-09-20T23:59:59.999Z"), [0, 0]);
  assert.deepEqual(at("2026-10-02T12:00:00.000Z"), [0, 1]);
  assert.deepEqual(at("2026-10-02T12:00:00.001Z"), [0, 0]);
  assert.deepEqual(at("2026-09-28T00:00:00.000Z"), [0, 1]);
  assert.deepEqual(at("2026-09-27T23:59:59.999Z"), [1, 0]);
});

test("edge: buildTrends counts only failure and error statuses, and no flakes from first attempts", () => {
  const statuses = ["pending", "success", "failure", "error"].map((state) => ({ state, at: "2026-10-01T00:00:00Z" }));
  const [row] = buildTrends({ now: TREND_NOW, weeks: 1, prs: [richPr({ statuses, checkRunAttempts: [1, 1] })] });
  assert.equal(row.gateFailures, 2);
  assert.equal(row.flakes, 0);
});
