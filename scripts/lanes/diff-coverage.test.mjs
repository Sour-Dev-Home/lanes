// scripts/lanes/diff-coverage.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_ENTRIES, isCandidate, intersect, main, normalizeSf, parseArgs, parseDiff, parseLcov, report,
} from "./diff-coverage.mjs";

const lcov = (files) => files.map(([sf, lines]) => `TN:\nSF:${sf}\n${lines.map(([n, c]) => `DA:${n},${c}`).join("\n")}\nLF:${lines.length}\nend_of_record\n`).join("");

// ---- criterion 3: the lcov parser ----

test("parseLcov reads DA line hits per source file and ignores the other record types", () => {
  const map = parseLcov(lcov([["/repo/a.mjs", [[1, 3], [2, 0]]], ["/repo/b.mjs", [[7, 1]]]]) + "FN:1,foo\nBRDA:1,0,0,1\n");
  assert.deepEqual([...map.keys()], ["/repo/a.mjs", "/repo/b.mjs"]);
  assert.deepEqual([...map.get("/repo/a.mjs")], [[1, 3], [2, 0]]);
  assert.deepEqual([...map.get("/repo/b.mjs")], [[7, 1]]);
});

test("edge: parseLcov sums repeated DA lines for one file and tolerates CRLF, blank and malformed input", () => {
  const map = parseLcov("SF:/repo/a.mjs\r\nDA:4,0\r\nDA:4,2\r\nDA:oops\r\nDA:x,y\r\nend_of_record\r\n");
  assert.deepEqual([...map.get("/repo/a.mjs")], [[4, 2]]);
  assert.equal(parseLcov("").size, 0);
  assert.equal(parseLcov("DA:1,1\n").size, 0, "a DA line before any SF has no file to belong to");
});

test("normalizeSf makes an absolute lcov path repo-relative with forward slashes", () => {
  assert.equal(normalizeSf("/repo/scripts/lanes/a.mjs", "/repo"), "scripts/lanes/a.mjs");
  assert.equal(normalizeSf("C:\\repo\\scripts\\a.mjs", "C:\\repo"), "scripts/a.mjs");
  assert.equal(normalizeSf("scripts/a.mjs", "/repo"), "scripts/a.mjs");
});

// ---- criterion 3: the diff-hunk parser ----

const DIFF = [
  "diff --git a/scripts/lanes/a.mjs b/scripts/lanes/a.mjs",
  "index 111..222 100644",
  "--- a/scripts/lanes/a.mjs",
  "+++ b/scripts/lanes/a.mjs",
  "@@ -3,0 +4,2 @@ export function f() {",
  "+  const x = 1;",
  "+  return x;",
  "@@ -10 +12 @@",
  "-  old();",
  "+  fresh();",
  "@@ -20,2 +22,0 @@",
  "-gone();",
  "-gone2();",
  "diff --git a/scripts/lanes/new.mjs b/scripts/lanes/new.mjs",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/scripts/lanes/new.mjs",
  "@@ -0,0 +1,3 @@",
  "+// a comment",
  "+",
  "+run();",
  "diff --git a/scripts/lanes/old.mjs b/scripts/lanes/old.mjs",
  "deleted file mode 100644",
  "--- a/scripts/lanes/old.mjs",
  "+++ /dev/null",
  "@@ -1,2 +0,0 @@",
  "-one",
  "-two",
  "diff --git a/scripts/lanes/before.mjs b/scripts/lanes/after.mjs",
  "similarity index 80%",
  "rename from scripts/lanes/before.mjs",
  "rename to scripts/lanes/after.mjs",
  "index 333..444 100644",
  "--- a/scripts/lanes/before.mjs",
  "+++ b/scripts/lanes/after.mjs",
  "@@ -5 +5 @@",
  "-a",
  "+b();",
  "diff --git a/scripts/lanes/moved.mjs b/scripts/lanes/moved2.mjs",
  "similarity index 100%",
  "rename from scripts/lanes/moved.mjs",
  "rename to scripts/lanes/moved2.mjs",
].join("\n");

test("parseDiff returns the added and changed lines by their new line numbers, with their text", () => {
  const changed = parseDiff(DIFF);
  assert.deepEqual(changed.get("scripts/lanes/a.mjs"), [
    { line: 4, text: "  const x = 1;" }, { line: 5, text: "  return x;" }, { line: 12, text: "  fresh();" },
  ]);
});

test("parseDiff lists every line of a new file", () => {
  assert.deepEqual(parseDiff(DIFF).get("scripts/lanes/new.mjs").map((l) => l.line), [1, 2, 3]);
});

test("parseDiff skips a deleted file and a pure deletion hunk", () => {
  const changed = parseDiff(DIFF);
  assert.equal(changed.has("scripts/lanes/old.mjs"), false);
  assert.equal(changed.get("scripts/lanes/a.mjs").some((l) => l.text.startsWith("gone")), false);
});

test("parseDiff keys a renamed file by its new path and drops a rename with no changed lines", () => {
  const changed = parseDiff(DIFF);
  assert.deepEqual(changed.get("scripts/lanes/after.mjs"), [{ line: 5, text: "b();" }]);
  assert.equal(changed.has("scripts/lanes/before.mjs"), false);
  assert.equal(changed.has("scripts/lanes/moved2.mjs"), false);
});

test("edge: parseDiff drops the tab git appends to a path with spaces, ignores '\\ No newline' markers, and handles empty input", () => {
  const spaced = ["--- a/x y.mjs", "+++ b/x y.mjs\t", "@@ -1 +1 @@", "-a", "+b", "\\ No newline at end of file"].join("\n");
  assert.deepEqual(parseDiff(spaced).get("x y.mjs"), [{ line: 1, text: "b" }]);
  assert.equal(parseDiff("").size, 0);
});

test("isCandidate keeps non-test .mjs files only", () => {
  assert.equal(isCandidate("scripts/lanes/a.mjs"), true);
  assert.equal(isCandidate("scripts/lanes/a.test.mjs"), false);
  assert.equal(isCandidate("scripts/lanes/a.js"), false);
  assert.equal(isCandidate("docs/a.md"), false);
  assert.equal(isCandidate("lanes.config.json"), false);
});

// ---- criterion 3: the intersection ----

test("intersect counts only changed lines the coverage data knows, and lists the uncovered ones in order", () => {
  const changed = new Map([["a.mjs", [{ line: 1, text: "// c" }, { line: 2, text: "run();" }, { line: 3, text: "miss();" }]]]);
  const coverage = new Map([["a.mjs", new Map([[2, 4], [3, 0]])]]);
  assert.deepEqual(intersect(changed, coverage), { covered: 1, total: 2, uncovered: ["a.mjs:3"] });
});

test("intersect treats non-test changed files the tests never loaded as uncovered, except blank and comment-only lines", () => {
  const changed = new Map([["lonely.mjs", [{ line: 1, text: "// note" }, { line: 2, text: "  " }, { line: 3, text: "work();" }]]]);
  assert.deepEqual(intersect(changed, new Map()), { covered: 0, total: 1, uncovered: ["lonely.mjs:3"] });
});

test("intersect skips test files and non-.mjs files", () => {
  const changed = new Map([
    ["a.test.mjs", [{ line: 1, text: "x();" }]], ["README.md", [{ line: 1, text: "x" }]], ["b.mjs", [{ line: 1, text: "y();" }]],
  ]);
  const coverage = new Map([["b.mjs", new Map([[1, 1]])]]);
  assert.deepEqual(intersect(changed, coverage), { covered: 1, total: 1, uncovered: [] });
});

test("edge: intersect on an empty diff is 0 of 0", () => {
  assert.deepEqual(intersect(new Map(), new Map()), { covered: 0, total: 0, uncovered: [] });
});

// ---- criterion 1: the summary line and the 30-entry cap ----

test("report prints the summary line, then one file:line per uncovered changed line", () => {
  assert.equal(report({ covered: 3, total: 4, uncovered: ["a.mjs:9"] }), "changed lines covered: 3 of 4 (75%)\na.mjs:9");
  assert.equal(report({ covered: 4, total: 4, uncovered: [] }), "changed lines covered: 4 of 4 (100%)");
});

test("edge: report rounds the percentage and shows 100% when nothing executable changed", () => {
  assert.equal(report({ covered: 1, total: 3, uncovered: ["a.mjs:1", "a.mjs:2"] }).split("\n")[0], "changed lines covered: 1 of 3 (33%)");
  assert.equal(report({ covered: 0, total: 0, uncovered: [] }), "changed lines covered: 0 of 0 (100%)");
});

test("report prints at most 30 entries and says how many more there are", () => {
  assert.equal(MAX_ENTRIES, 30);
  const uncovered = Array.from({ length: 45 }, (_, i) => `a.mjs:${i + 1}`);
  const lines = report({ covered: 5, total: 50, uncovered }).split("\n");
  assert.equal(lines.length, 1 + 30 + 1);
  assert.equal(lines[30], "a.mjs:30");
  assert.equal(lines[31], "... and 15 more");
  const exact = report({ covered: 0, total: 30, uncovered: uncovered.slice(0, 30) }).split("\n");
  assert.equal(exact.length, 31, "exactly 30 entries need no 'more' line");
});

// ---- criterion 1: arguments ----

test("parseArgs defaults the base to origin/main and reads --base", () => {
  assert.deepEqual(parseArgs([]), { base: "origin/main" });
  assert.deepEqual(parseArgs(["--base", "main"]), { base: "main" });
});

test("edge: parseArgs rejects an unknown flag, a missing value and a base that git would read as an option", () => {
  assert.throws(() => parseArgs(["--nope"]), /Unknown argument/);
  assert.throws(() => parseArgs(["--base"]), /--base needs a ref/);
  assert.throws(() => parseArgs(["--base", "--output=/tmp/x"]), /--base needs a ref/);
  assert.throws(() => parseArgs(["--base", ""]), /--base needs a ref/);
});

// ---- criterion 2: exit codes ----

const io = (over = {}) => ({
  root: "/repo",
  diff: () => "--- a/a.mjs\n+++ b/a.mjs\n@@ -1 +1,2 @@\n+one();\n+two();\n",
  lcov: () => lcov([["/repo/a.mjs", [[1, 1], [2, 0]]]]),
  ...over,
});

test("main exits 0 and reports the coverage of the changed lines", () => {
  assert.deepEqual(main([], io()), { code: 0, message: "changed lines covered: 1 of 2 (50%)\na.mjs:2" });
});

test("main passes the base ref to the diff", () => {
  const seen = [];
  main(["--base", "abc123"], io({ diff: (base) => (seen.push(base), "") }));
  assert.deepEqual(seen, ["abc123"]);
});

test("main exits 0 at 0% coverage: it reports, it does not gate", () => {
  const out = main([], io({ lcov: () => lcov([["/repo/a.mjs", [[1, 0], [2, 0]]]]) }));
  assert.equal(out.code, 0);
  assert.match(out.message, /^changed lines covered: 0 of 2 \(0%\)/);
});

test("main exits 2 with one line when the coverage run fails", () => {
  const out = main([], io({ lcov: () => { throw new Error("node --test could not start\nsecond line"); } }));
  assert.equal(out.code, 2);
  assert.equal(out.message, "diff-coverage: coverage could not be produced: node --test could not start");
});

test("main exits 2 with one line when the lcov output holds no source files", () => {
  const out = main([], io({ lcov: () => "" }));
  assert.equal(out.code, 2);
  assert.match(out.message, /^diff-coverage: coverage could not be produced: .*no coverage data/);
  assert.equal(out.message.includes("\n"), false);
});

test("main exits 2 with one line when the diff cannot be read, and on bad arguments", () => {
  const bad = main([], io({ diff: () => { throw new Error("bad revision 'origin/main...HEAD'"); } }));
  assert.equal(bad.code, 2);
  assert.match(bad.message, /bad revision/);
  const args = main(["--wat"], io());
  assert.equal(args.code, 2);
  assert.match(args.message, /Unknown argument: --wat/);
});
