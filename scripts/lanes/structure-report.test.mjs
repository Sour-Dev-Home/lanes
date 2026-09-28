// scripts/lanes/structure-report.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  GIT_LOG_FORMAT, JSCPD_PACKAGE, isLaneMerge, main, parseArgs, parseLog, rankGrowth, rankHotspots, summarizeJscpd,
} from "./structure-report.mjs";

// One commit as `git log --numstat --format=%x1e%P%x1f%s` prints it: a record separator, the parents, a unit
// separator, the subject, a blank line, then one `added<TAB>deleted<TAB>path` line per file.
const commit = (parents, subject, stats) => `\x1e${parents}\x1f${subject}\n\n${stats.map((s) => s.join("\t")).join("\n")}\n`;

const LOG = [
  commit("a1", "reap.mjs CLI: poll and remove (#192)", [["120", "4", "scripts/lanes/reap.mjs"], ["30", "0", "scripts/lanes/cleanup.mjs"]]),
  commit("b1 b2", "Merge pull request #12 from someone/issue-12-gate", [["10", "2", "scripts/lanes/gate.mjs"], ["5", "5", "scripts/lanes/cleanup.mjs"]]),
  commit("c1 c2", "Merge branch 'main' into feature-x", [["400", "0", "scripts/lanes/big.mjs"]]),
  commit("d1", "hand-edited typo fix", [["1", "1", "scripts/lanes/cleanup.mjs"]]),
  commit("e1", "cleanup waits for a stopped session (#188)", [["-", "-", "docs/logo.png"], ["7", "3", "scripts/lanes/cleanup.mjs"]]),
].join("");

// ---- criterion 3: git-log parsing and ranking with fixed input ----

test("parseLog reads each commit's parent count, subject and numstat lines", () => {
  const commits = parseLog(LOG);
  assert.equal(commits.length, 5);
  assert.deepEqual(commits[0], {
    parents: 1,
    subject: "reap.mjs CLI: poll and remove (#192)",
    files: [{ path: "scripts/lanes/reap.mjs", added: 120, deleted: 4 }, { path: "scripts/lanes/cleanup.mjs", added: 30, deleted: 0 }],
  });
  assert.equal(commits[1].parents, 2);
});

test("parseLog counts a binary file's `-` as 0 lines", () => {
  assert.deepEqual(parseLog(LOG)[4].files[0], { path: "docs/logo.png", added: 0, deleted: 0 });
});

test("isLaneMerge: a merge commit naming an issue-* branch, or a squash-merged PR commit ending (#N)", () => {
  const [squash, laneMerge, otherMerge, direct, squash2] = parseLog(LOG);
  assert.equal(isLaneMerge(squash), true);
  assert.equal(isLaneMerge(laneMerge), true);
  assert.equal(isLaneMerge(otherMerge), false);
  assert.equal(isLaneMerge(direct), false);
  assert.equal(isLaneMerge(squash2), true);
});

test("rankGrowth ranks files by lines added across every commit, most first", () => {
  assert.deepEqual(rankGrowth(parseLog(LOG)), [
    { path: "scripts/lanes/big.mjs", count: 400 },
    { path: "scripts/lanes/reap.mjs", count: 120 },
    { path: "scripts/lanes/cleanup.mjs", count: 43 },
    { path: "scripts/lanes/gate.mjs", count: 10 },
  ]);
});

test("rankHotspots ranks files by how many lane merges touched them", () => {
  assert.deepEqual(rankHotspots(parseLog(LOG)), [
    { path: "scripts/lanes/cleanup.mjs", count: 3 },
    { path: "docs/logo.png", count: 1 },
    { path: "scripts/lanes/gate.mjs", count: 1 },
    { path: "scripts/lanes/reap.mjs", count: 1 },
  ]);
});

test("rankGrowth and rankHotspots keep the top 10, ties broken by path", () => {
  const many = Array.from({ length: 12 }, (_, n) => commit("x", `lane ${n} (#${n})`, [["5", "0", `f${String(n).padStart(2, "0")}.mjs`]])).join("");
  const growth = rankGrowth(parseLog(many));
  assert.equal(growth.length, 10);
  assert.deepEqual(growth.map((r) => r.path), Array.from({ length: 10 }, (_, n) => `f${String(n).padStart(2, "0")}.mjs`));
  assert.equal(rankHotspots(parseLog(many)).length, 10);
});

// ---- criterion 1: the report ----

const io = (over = {}) => ({
  gitLog: () => LOG,
  modules: () => ({ code: 1, message: "cycle: a.mjs -> b.mjs -> a.mjs\nmodules: 2 files, 0 violations, 1 cycles (0 allowed), 0 unmapped" }),
  jscpd: () => ({ statistics: { total: { clones: 2, duplicatedLines: 30, percentage: 1.234, sources: 9 } }, duplicates: [] }),
  ...over,
});

test("main prints the modules results, the growth and hotspot rankings, and exits 0", () => {
  const { code, message } = main(["--days", "7"], io());
  assert.equal(code, 0);
  assert.match(message, /^structure report, last 7 days$/m);
  assert.match(message, /^cycle: a\.mjs -> b\.mjs -> a\.mjs$/m);
  assert.match(message, /^modules: 2 files, 0 violations, 1 cycles/m);
  assert.match(message, /^fastest-growing files \(lines added\):\n {2}\+400 scripts\/lanes\/big\.mjs$/m);
  assert.match(message, /^lane hotspots \(lane merges touching the file\):\n {2}3 scripts\/lanes\/cleanup\.mjs$/m);
});

test("main passes --days to the git log", () => {
  let seen;
  main(["--days", "30"], io({ gitLog: (days) => { seen = days; return LOG; } }));
  assert.equal(seen, 30);
});

test("without --jscpd, main does not run jscpd and says how to", () => {
  let ran = false;
  const { message } = main([], io({ jscpd: () => { ran = true; } }));
  assert.equal(ran, false);
  assert.match(message, /^duplicates: not run \(pass --jscpd\)$/m);
});

test("with --jscpd, main prints a duplicate-code summary", () => {
  const { code, message } = main(["--jscpd"], io());
  assert.equal(code, 0);
  assert.match(message, /^duplicates: 2 clones, 30 duplicated lines \(1\.2%\) in 9 files$/m);
});

test("with --jscpd, a jscpd failure prints `skipped` with the reason and the report still exits 0", () => {
  const { code, message } = main(["--jscpd"], io({ jscpd: () => { throw new Error("npx: command not found"); } }));
  assert.equal(code, 0);
  assert.match(message, /^duplicates: skipped \(npx: command not found\)$/m);
  assert.match(message, /^fastest-growing files/m);
});

test("jscpd runs a pinned version through npx --yes", () => {
  assert.match(JSCPD_PACKAGE, /^jscpd@\d+\.\d+\.\d+$/);
});

// ---- criterion 2: health.md ----

const health = readFileSync(fileURLToPath(new URL("../../.claude/commands/health.md", import.meta.url)), "utf8");

test("health.md runs the structure report as a step", () => {
  assert.match(health, /^\d+\. `node scripts\/lanes\/structure-report\.mjs --days 7 --jscpd`/m);
});

test("health.md has the architecture-advisor file at most 3 lane-filed refactor issues, each Scope naming file paths", () => {
  const step = health.slice(health.indexOf("structure-report.mjs"));
  assert.match(step, /architecture-advisor/);
  assert.match(step, /at most 3/);
  assert.match(step, /lane-filed/);
  assert.match(step, /Scope[^\n]*file paths/);
});

// ---- edge cases ----

test("edge: parseLog of empty output is no commits", () => {
  assert.deepEqual(parseLog(""), []);
  assert.deepEqual(rankGrowth([]), []);
  assert.deepEqual(rankHotspots([]), []);
});

test("edge: parseLog keeps a commit with no numstat lines (an empty merge) and skips malformed lines", () => {
  const text = `\x1ea1 a2\x1fMerge branch 'issue-3-x'\n\n` + commit("b1", "fix (#4)", [["2", "1", "a.mjs"]]) + "\x1eb1\x1fodd\n\nnot a numstat line\n3\t1\n";
  const commits = parseLog(text);
  assert.equal(commits.length, 3);
  assert.deepEqual(commits[0].files, []);
  assert.deepEqual(commits[2].files, []);
});

test("edge: parseLog keeps a tab inside a path, and CRLF line ends", () => {
  const [c] = parseLog("\x1ea1\x1fx (#1)\r\n\r\n4\t0\tdir/we\tird.mjs\r\n");
  assert.deepEqual(c.files, [{ path: "dir/we\tird.mjs", added: 4, deleted: 0 }]);
});

test("edge: a root commit (no parents) is not a lane merge", () => {
  assert.equal(isLaneMerge({ parents: 0, subject: "initial (#1)", files: [] }), false);
});

test("edge: a subject that only mentions (#N) mid-line, or issue-N in a non-merge, is not a lane merge", () => {
  assert.equal(isLaneMerge({ parents: 1, subject: "see (#5) for details", files: [] }), false);
  assert.equal(isLaneMerge({ parents: 1, subject: "fix issue-12 notes", files: [] }), false);
  assert.equal(isLaneMerge({ parents: 2, subject: "Merge branch 'tissue-12'", files: [] }), false);
});

test("edge: a file touched twice by one lane merge counts once", () => {
  const text = commit("a", "x (#1)", [["1", "0", "a.mjs"], ["2", "0", "a.mjs"]]);
  assert.deepEqual(rankHotspots(parseLog(text)), [{ path: "a.mjs", count: 1 }]);
});

test("edge: files with no lines added are left out of the growth ranking", () => {
  assert.deepEqual(rankGrowth(parseLog(commit("a", "x", [["0", "9", "gone.mjs"]]))), []);
});

test("edge: summarizeJscpd names up to 5 largest clones by file and line range, forward slashes", () => {
  const dup = (lines, a, b) => ({ lines, firstFile: { name: a, start: 1, end: lines }, secondFile: { name: b, start: 10, end: 9 + lines } });
  const report = {
    statistics: { total: { clones: 6, duplicatedLines: 70, percentage: 3, sources: 4 } },
    duplicates: [dup(5, "a.mjs", "b.mjs"), dup(20, "scripts\\lanes\\c.mjs", "d.mjs"), dup(8, "e", "f"), dup(9, "g", "h"), dup(12, "i", "j"), dup(3, "k", "l")],
  };
  const lines = summarizeJscpd(report).split("\n");
  assert.equal(lines[0], "duplicates: 6 clones, 70 duplicated lines (3.0%) in 4 files");
  assert.equal(lines.length, 6);
  assert.equal(lines[1], "  20 lines: scripts/lanes/c.mjs:1-20 ~ d.mjs:10-29");
  assert.ok(!lines.some((l) => l.includes("k:")));
});

test("edge: summarizeJscpd on a report without statistics throws, so main reports skipped", () => {
  assert.throws(() => summarizeJscpd({}), /jscpd report/);
  const { message } = main(["--jscpd"], io({ jscpd: () => ({ nonsense: true }) }));
  assert.match(message, /^duplicates: skipped \(.*jscpd report.*\)$/m);
});

test("edge: a multi-line jscpd error is reported on one line", () => {
  const { message } = main(["--jscpd"], io({ jscpd: () => { throw new Error("first line\nsecond line"); } }));
  assert.match(message, /^duplicates: skipped \(first line\)$/m);
});

test("edge: an empty log prints `none` under both rankings", () => {
  const { message } = main([], io({ gitLog: () => "" }));
  assert.match(message, /^fastest-growing files \(lines added\):\n {2}none$/m);
  assert.match(message, /^lane hotspots \(lane merges touching the file\):\n {2}none$/m);
});

test("edge: a failing git log exits 2 with the reason", () => {
  const { code, message } = main([], io({ gitLog: () => { throw new Error("not a git repository"); } }));
  assert.equal(code, 2);
  assert.match(message, /structure-report: git log failed: not a git repository/);
});

test("edge: a modules check that cannot run is printed and the report carries on", () => {
  const { code, message } = main([], io({ modules: () => ({ code: 2, message: "modules: cannot read lanes.config.json: ENOENT" }) }));
  assert.equal(code, 0);
  assert.match(message, /^modules: cannot read lanes\.config\.json: ENOENT$/m);
});

test("edge: parseArgs defaults to 7 days, takes --days and --jscpd, and rejects anything else", () => {
  assert.deepEqual(parseArgs([]), { days: 7, jscpd: false });
  assert.deepEqual(parseArgs(["--days", "30", "--jscpd"]), { days: 30, jscpd: true });
  for (const bad of [["--days"], ["--days", "0"], ["--days", "366"], ["--days", "1.5"], ["--days", "0x10"], ["--days", "--jscpd"]]) {
    assert.throws(() => parseArgs(bad), /--days/);
  }
  assert.throws(() => parseArgs(["--bogus"]), /Unknown argument/);
});

test("edge: main reports a bad argument with exit 2 and runs nothing", () => {
  let ran = false;
  const { code, message } = main(["--days", "abc"], io({ gitLog: () => { ran = true; return ""; } }));
  assert.equal(code, 2);
  assert.equal(ran, false);
  assert.match(message, /--days/);
});

test("edge: the git log format separates commits and fields with control characters", () => {
  assert.equal(GIT_LOG_FORMAT, "%x1e%P%x1f%s");
});
