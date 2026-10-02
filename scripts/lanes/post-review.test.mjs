// scripts/lanes/post-review.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildStatus, buildVerdictComment, checkSha, configuredReviewers, configuredReviewersFrom, mainCheckoutFrom, main, metricsWarning, parseArgs, TEAM_REASON, validateVerdict } from "./post-review.mjs";

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

test("the owner has no status to post", () => {
  assert.throws(() => buildStatus("owner", "success", "approved"), /no owner status/);
  assert.throws(() => buildStatus("owner", "skipped", "x"), /no owner status/);
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

test("a description shows no criteria count when every criterion is not-applicable", () => {
  const allNa = [
    { index: 1, result: "not-applicable", evidence: "no auth in this change" },
    { index: 2, result: "not-applicable", evidence: "no input handling" },
  ];
  const r = validateVerdict(verdict({ reviewer: "security-reviewer", criteria: allNa, findings: [] }), { criteriaCount: 2 });
  assert.equal(r.ok, true);
  assert.equal(r.status.description, "0 fixed: 4 tests added, 1 bug fixed");
});

test("a description shows the count for a mix of pass and fail", () => {
  const mix = [
    { index: 1, result: "pass", evidence: "ok" },
    { index: 2, result: "fail", evidence: "misses the empty case" },
    { index: 3, result: "not-applicable", evidence: "no UI" },
  ];
  const r = validateVerdict(verdict({ verdict: "failure", criteria: mix }), { criteriaCount: 3 });
  assert.equal(r.status.description, "1/3 criteria pass, 1 fixed: 4 tests added, 1 bug fixed");
});

test("a description shows the count when only failing criteria were assessed", () => {
  const allFail = [{ index: 1, result: "fail", evidence: "x" }, { index: 2, result: "not-applicable", evidence: "y" }];
  const r = validateVerdict(verdict({ verdict: "failure", criteria: allFail }), { criteriaCount: 2 });
  assert.equal(r.status.description, "0/2 criteria pass, 1 fixed: 4 tests added, 1 bug fixed");
});

test("edge: one pass among not-applicable criteria still shows the count, and a null criterion is refused", () => {
  const some = [{ index: 1, result: "pass", evidence: "ok" }, { index: 2, result: "not-applicable", evidence: "no UI" }];
  assert.equal(validateVerdict(verdict({ criteria: some }), { criteriaCount: 2 }).status.description, "1/2 criteria pass, 1 fixed: 4 tests added, 1 bug fixed");
  const bad = validateVerdict(verdict({ reviewer: "security-reviewer", criteria: [null] }), { criteriaCount: 2 });
  assert.equal(bad.ok, false);
  assert.equal(bad.status, null);
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

// ADR 0023 part 3: `pending` is optional, validated with parsePending when present.
const pendingEntry = (over = {}) => ({ path: ".github/workflows/ci.yml", sha256: "a".repeat(64), ...over });

test("a verdict with a valid pending list is accepted, and the comment keeps it", () => {
  const v = verdict({ pending: [pendingEntry()] });
  const r = validateVerdict(v, { criteriaCount: 2 });
  assert.equal(r.ok, true, r.errors.join("; "));
  assert.match(buildVerdictComment(v, "b".repeat(40)), /"pending"/);
});

test("a verdict without pending is unchanged", () => {
  assert.equal(validateVerdict(verdict(), { criteriaCount: 2 }).ok, true);
});

test("edge: a malformed pending is refused with a clear message", () => {
  const bad = [[], "x", [pendingEntry({ path: "src/a.ts" })], [pendingEntry({ sha256: "XYZ" })], [pendingEntry(), pendingEntry()], [pendingEntry({ path: ".github/workflows/../x.yml" })], [null], null];
  for (const pending of bad) {
    const r = validateVerdict(verdict({ pending }), { criteriaCount: 2 });
    assert.equal(r.ok, false, JSON.stringify(pending));
    assert.match(r.errors.join(), /pending must be a non-empty list/, JSON.stringify(pending));
  }
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

// #42: with --file the verdict comment goes first, so the status event that re-runs lanes/gate always finds it.
const HEAD = "a".repeat(40);
const ISSUE_BODY = "### Goal\n\ng\n\n### Acceptance criteria\n\n- [ ] one\n- [ ] two\n\n### Interface contract\n\nnone\n\n### Scope\n\nIn: `a.mjs`.\n\n### Blocked by\n\nnone\n\n### Tier\n\nfull\n";

/** A fake `gh`: answers the reads, records every write, and throws on the write named by `failOn`. */
function fakeGh({ failOn = null, prBody = "Closes #7", statuses = [], totalCount = null } = {}) {
  const writes = [];
  const run = (args) => {
    if (args[0] === "api" && args.length === 2 && args[1].endsWith("/status?per_page=100")) return JSON.stringify({ statuses, total_count: totalCount ?? statuses.length });
    if (args[0] === "pr" && args[1] === "view") return JSON.stringify({ number: 12, headRefOid: HEAD, body: prBody });
    if (args[0] === "repo" && args[1] === "view") return "o/r\n";
    if (args[0] === "issue" && args[1] === "view") return JSON.stringify({ body: ISSUE_BODY });
    const kind = args[0] === "pr" && args[1] === "comment" ? "comment" : args[0] === "api" ? "status" : args.join(" ");
    if (kind === failOn) throw new Error(`gh ${kind} failed`);
    writes.push({ kind, args });
    return "";
  };
  return { run, writes };
}

const quiet = { log: () => {}, warn: () => {} };

function verdictFile(v = verdict()) {
  const file = join(mkdtempSync(join(tmpdir(), "post-review-")), "v.json");
  writeFileSync(file, JSON.stringify(v));
  return file;
}

test("with --file, the verdict comment is posted before the review status", () => {
  const gh = fakeGh();
  main(["--file", verdictFile()], { run: gh.run, ...quiet });
  assert.deepEqual(gh.writes.map((w) => w.kind), ["comment", "status"]);
  assert.ok(gh.writes[0].args.at(-1).startsWith(`<!-- lanes:verdict test-hunter ${HEAD} -->`));
  assert.ok(gh.writes[1].args.includes("context=review/test-hunter"));
});

test("with --file, a failed comment posts no status and the command throws (a non-zero exit)", () => {
  const gh = fakeGh({ failOn: "comment" });
  assert.throws(() => main(["--file", verdictFile()], { run: gh.run, ...quiet }), /comment failed/);
  assert.deepEqual(gh.writes, []);
});

test("without --file, only the status is posted, exactly as before", () => {
  const gh = fakeGh();
  main(["ui-reviewer", "skipped", "no visible change"], { run: gh.run, ...quiet });
  assert.deepEqual(gh.writes, [
    { kind: "status", args: ["api", `repos/o/r/statuses/${HEAD}`, "-f", "state=success", "-f", "context=review/ui-reviewer", "-f", "description=skipped: no visible change"] },
  ]);
});

test("edge: a failed status after a posted comment still throws, leaving the comment for a re-run", () => {
  const gh = fakeGh({ failOn: "status" });
  assert.throws(() => main(["--file", verdictFile()], { run: gh.run, ...quiet }), /status failed/);
  assert.deepEqual(gh.writes.map((w) => w.kind), ["comment"]);
});

test("edge: a refused verdict posts neither comment nor status", () => {
  const gh = fakeGh();
  assert.throws(() => main(["--file", verdictFile(verdict({ verdict: "maybe" }))], { run: gh.run, ...quiet }), /verdict refused/);
  assert.deepEqual(gh.writes, []);
});

test("edge: a PR body without Closes posts neither comment nor status", () => {
  const gh = fakeGh({ prBody: "no link" });
  assert.throws(() => main(["--file", verdictFile()], { run: gh.run, ...quiet }), /Closes #N/);
  assert.deepEqual(gh.writes, []);
});

test("edge: a stale --sha posts nothing, with or without --file", () => {
  const gh = fakeGh();
  const stale = "b".repeat(40);
  assert.throws(() => main(["--file", verdictFile(), "--sha", stale], { run: gh.run, ...quiet }), /does not match/);
  assert.throws(() => main(["ui-reviewer", "skipped", "x", "--sha", stale], { run: gh.run, ...quiet }), /does not match/);
  assert.deepEqual(gh.writes, []);
});

test("edge: a --file path that does not exist posts neither comment nor status", () => {
  const gh = fakeGh();
  const missing = join(mkdtempSync(join(tmpdir(), "post-review-")), "does-not-exist.json");
  assert.throws(() => main(["--file", missing], { run: gh.run, ...quiet }), /ENOENT/);
  assert.deepEqual(gh.writes, []);
});

// #447: the security reviewer's failure flips to success only through a real reviewer run (metrics), never a hand edit.
const secVerdict = (over = {}) => verdict({ reviewer: "security-reviewer", criteria: [], findings: [], ...over });
const METRICS = { tier: "full", minutes: 3.2, tokens: 41000 };
const secFailed = [{ context: "review/security-reviewer", state: "failure" }];

test("a security-reviewer success without metrics over a failure on the same SHA is refused, posting nothing", () => {
  const gh = fakeGh({ statuses: secFailed });
  assert.throws(() => main(["--file", verdictFile(secVerdict())], { run: gh.run, ...quiet }), /review\/security-reviewer is failure.*re-run the security reviewer/);
  assert.deepEqual(gh.writes, []);
});

test("a security-reviewer success with metrics over a failure is allowed", () => {
  const gh = fakeGh({ statuses: secFailed });
  main(["--file", verdictFile(secVerdict({ metrics: METRICS }))], { run: gh.run, ...quiet });
  assert.deepEqual(gh.writes.map((w) => w.kind), ["comment", "status"]);
});

test("edge: without metrics, a security success is allowed when the status is not a failure, and other reviewers are never refused", () => {
  for (const statuses of [[], [{ context: "review/security-reviewer", state: "success" }], [{ context: "review/security-reviewer", state: "pending" }], [{ context: "review/test-hunter", state: "failure" }]]) {
    const gh = fakeGh({ statuses });
    const warnings = [];
    main(["--file", verdictFile(secVerdict())], { run: gh.run, log: () => {}, warn: (w) => warnings.push(w) });
    assert.deepEqual(gh.writes.map((w) => w.kind), ["comment", "status"]);
    assert.match(warnings[0], /no metrics/);
  }
  const gh = fakeGh({ statuses: [{ context: "review/test-hunter", state: "failure" }] });
  main(["--file", verdictFile()], { run: gh.run, ...quiet });
  assert.deepEqual(gh.writes.map((w) => w.kind), ["comment", "status"]);
});

test("edge: a security failure verdict is never refused over a failure status", () => {
  const gh = fakeGh({ statuses: secFailed });
  main(["--file", verdictFile(secVerdict({ verdict: "failure", summary: "still open", findings: [{ severity: "critical", file: "a.mjs", line: 1, summary: "x", fixed: false }] }))], { run: gh.run, ...quiet });
  assert.deepEqual(gh.writes.map((w) => w.kind), ["comment", "status"]);
});

test("the team refusal for post-review.mjs owner is unchanged", () => {
  assert.equal(TEAM_REASON, "under the team profile, approve the PR in GitHub (ADR 0021)");
  assert.throws(() => buildStatus("owner", "skipped", "x"), (e) => e.message === `there is no owner status: ${TEAM_REASON}`);
});

test("mainCheckoutFrom finds the main checkout from the main checkout and from a worktree", () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "grant-repo-")));
  const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "core.hooksPath=", ...args], { cwd, stdio: "pipe" });
  const mainCheckout = join(root, "main");
  mkdirSync(join(mainCheckout, "scripts", "lanes"), { recursive: true });
  git(mainCheckout, "init", "-q", "-b", "main");
  git(mainCheckout, "commit", "-q", "--allow-empty", "-m", "init");
  const wt = join(root, "wt");
  git(mainCheckout, "worktree", "add", "-q", "-b", "wt", wt);
  mkdirSync(join(wt, "scripts", "lanes"), { recursive: true });
  assert.equal(join(mainCheckoutFrom(join(mainCheckout, "scripts", "lanes"))), mainCheckout);
  assert.equal(join(mainCheckoutFrom(join(wt, "scripts", "lanes"))), mainCheckout);
});

test("edge: mainCheckoutFrom outside any repository falls back to the checkout holding the script", () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "grant-nogit-")));
  const dir = join(root, "scripts", "lanes");
  mkdirSync(dir, { recursive: true });
  assert.equal(mainCheckoutFrom(dir), root);
});

test("lane.md says a lane posts only a verdict the reviewer returned, never edits its verdict field, and re-runs after fixes", () => {
  const step6 = laneStep6();
  assert.match(step6, /only a verdict the reviewer agent returned/);
  assert.match(step6, /never change a verdict's `verdict` field/);
  assert.match(step6, /re-run the reviewer/);
});

test("edge: a truncated status list without the security status fails closed, and a complete one without it is allowed", () => {
  const gh = fakeGh({ statuses: [{ context: "review/test-hunter", state: "success" }], totalCount: 150 });
  assert.throws(() => main(["--file", verdictFile(secVerdict())], { run: gh.run, ...quiet }), /re-run the security reviewer/);
  assert.deepEqual(gh.writes, []);
});

test("edge: an inherited GIT_DIR cannot redirect mainCheckoutFrom", () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "grant-env-")));
  const dir = join(root, "scripts", "lanes");
  mkdirSync(dir, { recursive: true });
  const other = join(root, "elsewhere", ".git");
  mkdirSync(join(root, "elsewhere"), { recursive: true });
  execFileSync("git", ["init", "-q", join(root, "elsewhere")], { stdio: "pipe" });
  const saved = process.env.GIT_DIR;
  process.env.GIT_DIR = other;
  try {
    assert.equal(mainCheckoutFrom(dir), root);
  } finally {
    if (saved === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = saved;
  }
});

// --- configured reviewers (#463, ADR 0018) -------------------------------------------------------------------------

const CONFIGURED = ["test-hunter", "ui-reviewer", "security-reviewer", "architecture-advisor", "compliance-reviewer"];
const configuredVerdict = () => verdict({ reviewer: "compliance-reviewer", criteria: [], findings: [] });

test("a verdict from a configured reviewer is accepted, and an unknown name is refused (#463)", () => {
  const v = configuredVerdict();
  assert.equal(validateVerdict(v, { criteriaCount: 2, names: CONFIGURED }).ok, true);
  assert.equal(validateVerdict(v, { criteriaCount: 2, names: CONFIGURED }).status.context, "review/compliance-reviewer");
  assert.match(validateVerdict(v, { criteriaCount: 2 }).errors.join(), /reviewer must be one of/);
  assert.match(validateVerdict({ ...v, reviewer: "nobody" }, { criteriaCount: 2, names: CONFIGURED }).errors.join(), /reviewer must be one of/);
  assert.match(validateVerdict({ ...v, reviewer: "owner" }, { criteriaCount: 2, names: [...CONFIGURED, "owner"] }).errors.join(), /reviewer must be one of/);
});

test("MUST_COVER stays test-hunter and ui-reviewer: a configured reviewer need not assess every criterion (#463)", () => {
  const v = configuredVerdict();
  assert.equal(validateVerdict(v, { criteriaCount: 3, names: CONFIGURED }).ok, true);
  assert.match(validateVerdict({ ...v, reviewer: "ui-reviewer" }, { criteriaCount: 3, names: CONFIGURED }).errors.join(), /all 3 criteria/);
});

test("the comment and status builders take the configured names, and never owner (#463)", () => {
  const v = configuredVerdict();
  assert.ok(buildVerdictComment(v, SHA, CONFIGURED).startsWith(`<!-- lanes:verdict compliance-reviewer ${SHA} -->`));
  assert.throws(() => buildVerdictComment(v, SHA), /reviewer must be one of/);
  assert.throws(() => buildVerdictComment({ ...v, reviewer: "owner" }, SHA, [...CONFIGURED, "owner"]), /reviewer must be one of/);
  assert.equal(buildStatus("compliance-reviewer", "skipped", "no change", CONFIGURED).context, "review/compliance-reviewer");
  assert.throws(() => buildStatus("compliance-reviewer", "skipped", "x"), /reviewer/);
  assert.throws(() => buildStatus("nobody", "skipped", "x", CONFIGURED), /reviewer/);
});

test("main posts a configured reviewer's verdict file and refuses an unknown one (#463)", () => {
  const gh = fakeGh();
  main(["--file", verdictFile(configuredVerdict())], { run: gh.run, ...quiet, reviewers: CONFIGURED });
  assert.deepEqual(gh.writes.map((w) => w.kind), ["comment", "status"]);
  assert.ok(gh.writes[1].args.includes("context=review/compliance-reviewer"));
  const again = fakeGh();
  assert.throws(() => main(["--file", verdictFile(configuredVerdict())], { run: again.run, ...quiet, reviewers: CONFIGURED.slice(0, 4) }), /reviewer must be one of/);
  assert.deepEqual(again.writes, []);
});

test("the configured set is read from the main checkout's config, from a worktree path too (#463)", () => {
  const dir = mkdtempSync(join(tmpdir(), "post-review-cfg-"));
  execFileSync("git", ["init", "-q", dir]);
  mkdirSync(join(dir, "scripts", "lanes"), { recursive: true });
  writeFileSync(join(dir, "lanes.config.json"), JSON.stringify({
    requiredChecks: ["verify"],
    paths: { skip: [], contract: [], sensitive: [], ui: [] },
    modules: { entries: [{ id: "m", paths: ["x/"], imports: [], risk: "normal", reviewers: ["compliance-reviewer"] }] },
  }));
  const git = (...a) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", ...a]);
  git("commit", "-q", "--allow-empty", "-m", "x");
  const wt = join(dir, "wt");
  git("worktree", "add", "-q", "-b", "b", wt);
  mkdirSync(join(wt, "scripts", "lanes"), { recursive: true });
  writeFileSync(join(wt, "lanes.config.json"), "{}");
  assert.deepEqual(configuredReviewersFrom(join(wt, "scripts", "lanes")), CONFIGURED);
});

test("main posts a configured reviewer's skipped status and refuses an unknown name (#463)", () => {
  const gh = fakeGh();
  main(["compliance-reviewer", "skipped", "no change"], { run: gh.run, ...quiet, reviewers: CONFIGURED });
  assert.ok(gh.writes.at(-1).args.includes("context=review/compliance-reviewer"));
  const again = fakeGh();
  assert.throws(() => main(["compliance-reviewer", "skipped", "no change"], { run: again.run, ...quiet, reviewers: CONFIGURED.slice(0, 4) }), /reviewer must be one of/);
  assert.deepEqual(again.writes, []);
});

// --- the owner path is gone: the owner approves in GitHub (ADR 0021, 0025) -----------------------------------------------
const GITHUB_REVIEW = /^Error: there is no owner status: under the team profile, approve the PR in GitHub \(ADR 0021\)$/;

test("post-review owner ... refuses before any gh call and points to the GitHub review", () => {
  for (const argv of [["owner", "success", "approved", "--pr", "12"], ["owner", "success", "approved", "--pr", "12", "--sha", HEAD], ["owner", "skipped", "x"], ["owner", "success", "--", "--x"]]) {
    const gh = fakeGh();
    let calls = 0;
    assert.throws(() => main(argv, { run: (args) => (calls++, gh.run(args)), ...quiet }), GITHUB_REVIEW, argv.join(" "));
    assert.equal(calls, 0, "nothing is read from GitHub");
    assert.deepEqual(gh.writes, []);
  }
});

test("buildStatus refuses the owner, even when the owner is passed as a configured name", () => {
  for (const verdict of ["success", "skipped"]) {
    assert.throws(() => buildStatus("owner", verdict, "approved", [...CONFIGURED, "owner"]), /there is no owner status: .*GitHub/);
  }
});

test("a reviewer verdict posts with --file and a skipped reviewer status is unchanged", () => {
  const gh = fakeGh();
  main(["--file", verdictFile()], { run: gh.run, ...quiet });
  assert.deepEqual(gh.writes.map((w) => w.kind), ["comment", "status"]);
  const gh2 = fakeGh();
  main(["ui-reviewer", "skipped", "no visible change"], { run: gh2.run, ...quiet });
  assert.deepEqual(gh2.writes.map((w) => w.kind), ["status"]);
});

test("edge: --file with owner as the verdict's reviewer is refused as an unknown reviewer, posting nothing", () => {
  const gh = fakeGh();
  assert.throws(() => main(["--file", verdictFile(verdict({ reviewer: "owner" }))], { run: gh.run, ...quiet }), /reviewer must be one of/);
  assert.deepEqual(gh.writes, []);
});

const cfgRepo = (text) => {
  const dir = mkdtempSync(join(tmpdir(), "post-review-cfg2-"));
  execFileSync("git", ["init", "-q", dir]);
  mkdirSync(join(dir, "scripts", "lanes"), { recursive: true });
  if (text !== undefined) writeFileSync(join(dir, "lanes.config.json"), text);
  return dir;
};
const cfgWith = (names) => JSON.stringify({
  requiredChecks: ["verify"],
  paths: { skip: [], contract: [], sensitive: [], ui: [] },
  modules: { entries: [{ id: "m", paths: ["x/"], imports: [], risk: "normal", reviewers: names }] },
});
const BUILT_IN_FOUR = CONFIGURED.slice(0, 4);

test("a missing, unreadable or invalid config leaves only the built-in four (#463)", () => {
  for (const text of [undefined, "{not json", "[]", "{}", JSON.stringify({ requiredChecks: [] })]) {
    assert.deepEqual(configuredReviewersFrom(join(cfgRepo(text), "scripts", "lanes")), BUILT_IN_FOUR, String(text));
  }
});

test("a config that lists owner never makes it a configured reviewer (#463)", () => {
  const names = configuredReviewersFrom(join(cfgRepo(cfgWith(["owner", "compliance-reviewer"])), "scripts", "lanes"));
  assert.ok(!names.includes("owner"));
  assert.deepEqual(names, CONFIGURED);
});

test("a config name that is not a plain agent name leaves only the built-in four (#463)", () => {
  for (const bad of ["Owner", "OWNER", "owner ", "review/owner", "", "9lives", "a_b"]) {
    assert.deepEqual(configuredReviewersFrom(join(cfgRepo(cfgWith(["compliance-reviewer", bad])), "scripts", "lanes")), BUILT_IN_FOUR, JSON.stringify(bad));
  }
});

test("edge: configuredReviewers reads the checkout holding the script and never offers owner", () => {
  const names = configuredReviewers();
  assert.ok(names.includes("test-hunter"));
  assert.ok(!names.includes("owner"));
});
