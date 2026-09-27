import { test } from "node:test";
import assert from "node:assert/strict";
import { EMPTY_TREE, PATH_PATTERNS, addedLines, checkPr, dedupeHits, diffBase, scanLines, scanMessages } from "./preflight.mjs";

// The path shapes are taken from the module, so this file does not contain them literally (CI's PII scan would flag it).
const [WINDOWS_PATH] = PATH_PATTERNS;

const DIFF = [
  "diff --git a/docs/a.md b/docs/a.md",
  "--- a/docs/a.md",
  "+++ b/docs/a.md",
  "@@ -1,2 +10,3 @@",
  " context",
  "+first added",
  "+second added",
  "diff --git a/src/b.ts b/src/b.ts",
  "--- a/src/b.ts",
  "+++ b/src/b.ts",
  "@@ -5,0 +7 @@",
  "+third added",
  "diff --git a/gone.txt b/gone.txt",
  "--- a/gone.txt",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-removed",
].join("\n");

test("addedLines reads the file and the new line number of every added line, and ignores removals", () => {
  assert.deepEqual(addedLines(DIFF), [
    { file: "docs/a.md", line: 11, text: "first added" },
    { file: "docs/a.md", line: 12, text: "second added" },
    { file: "src/b.ts", line: 7, text: "third added" },
  ]);
});

test("a local absolute path in an added line is a hit, reported by file and line, never by its text", () => {
  const lines = [{ file: "docs/a.md", line: 3, text: `see ${WINDOWS_PATH}\\someone\\repo` }];
  const hits = scanLines(lines, PATH_PATTERNS);
  assert.deepEqual(hits, [{ file: "docs/a.md", line: 3, pattern: 0 }]);
  assert.equal(JSON.stringify(hits).includes("someone"), false);
});

test("the scan is case-insensitive and reports every pattern that matches", () => {
  const lines = [{ file: "x.md", line: 1, text: `${WINDOWS_PATH.toUpperCase()} and secret-name` }];
  const hits = scanLines(lines, [...PATH_PATTERNS, "Secret-Name"]);
  assert.deepEqual(
    hits.map((hit) => hit.pattern),
    [0, PATH_PATTERNS.length],
  );
});

test("clean lines and blank patterns produce no hits", () => {
  assert.deepEqual(scanLines([{ file: "x.md", line: 1, text: "nothing to see" }], [...PATH_PATTERNS, ""]), []);
});

test("only the files CI's scan skips are exempt, and no wider", () => {
  for (const file of ["LICENSE", "CLAUDE.md", "backend/CLAUDE.md", ".github/workflows/security.yml"]) {
    assert.deepEqual(scanLines([{ file, line: 1, text: WINDOWS_PATH }], PATH_PATTERNS), [], file);
  }
  for (const file of ["scripts/other.mjs", "scripts/preflight.mjs", "docs/LICENSE", "README.md"]) {
    assert.equal(scanLines([{ file, line: 1, text: WINDOWS_PATH }], PATH_PATTERNS).length, 1, file);
  }
});

test("an added line whose text starts with '++ ' is content, not a file header", () => {
  const diff = ["diff --git a/x.md b/x.md", "--- a/x.md", "+++ b/x.md", "@@ -0,0 +1,2 @@", "+++ b/other.md", "+second"].join("\n");
  assert.deepEqual(addedLines(diff), [
    { file: "x.md", line: 1, text: "++ b/other.md" },
    { file: "x.md", line: 2, text: "second" },
  ]);
  const devNull = ["diff --git a/x.md b/x.md", "--- a/x.md", "+++ b/x.md", "@@ -0,0 +1 @@", "+++ /dev/null"].join("\n");
  assert.equal(addedLines(devNull)[0].file, "x.md");
});

test("file names with spaces (trailing tab), quoted non-ASCII names and CRLF are read correctly", () => {
  const diff = [
    "diff --git a/my file.md b/my file.md",
    "--- a/my file.md\t",
    "+++ b/my file.md\t",
    "@@ -0,0 +1 @@",
    "+one\r",
    'diff --git "a/caf\\303\\251.md" "b/caf\\303\\251.md"',
    '--- "a/caf\\303\\251.md"',
    '+++ "b/caf\\303\\251.md"',
    "@@ -0,0 +4 @@",
    "+two",
  ].join("\n");
  assert.deepEqual(addedLines(diff), [
    { file: "my file.md", line: 1, text: "one\r" },
    { file: "café.md", line: 4, text: "two" },
  ]);
  assert.equal(scanLines([{ file: "a.md", line: 1, text: `${WINDOWS_PATH}\r` }], PATH_PATTERNS).length, 1);
});

test("binary, deleted and pure-rename entries add nothing and do not corrupt the next file", () => {
  const diff = [
    "diff --git a/img.png b/img.png",
    "Binary files a/img.png and b/img.png differ",
    "diff --git a/old.md b/new.md",
    "similarity index 100%",
    "rename from old.md",
    "rename to new.md",
    "diff --git a/gone.md b/gone.md",
    "--- a/gone.md",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-x",
    "diff --git a/n.md b/n.md",
    "--- a/n.md",
    "+++ b/n.md",
    "@@ -0,0 +2 @@",
    "+added",
  ].join("\n");
  assert.deepEqual(addedLines(diff), [{ file: "n.md", line: 2, text: "added" }]);
});

test("an added line whose file name cannot be read is still reported, under a placeholder", () => {
  const diff = ["diff --git x y", "@@ -0,0 +1 @@", "+leak"].join("\n");
  assert.deepEqual(addedLines(diff), [{ file: "(unknown file)", line: 1, text: "leak" }]);
});

test("the JSON-escaped form of the Windows path is caught too", () => {
  const hits = scanLines([{ file: "a.json", line: 1, text: `"${PATH_PATTERNS[4]}"` }], PATH_PATTERNS);
  assert.deepEqual(hits, [{ file: "a.json", line: 1, pattern: 4 }]);
});

test("commit messages are scanned line by line", () => {
  const hits = scanMessages(`fix: a thing\n\nran it from ${WINDOWS_PATH}\\x`, PATH_PATTERNS);
  assert.deepEqual(hits, [{ file: "(commit message)", line: 3, pattern: 0 }]);
});

test("diffBase compares against origin/main when it exists, or git's empty tree before a first push", () => {
  assert.equal(diffBase(true), "origin/main");
  assert.equal(diffBase(false), EMPTY_TREE);
  assert.match(EMPTY_TREE, /^[0-9a-f]{40}$/);
});

// M6: a line matching several patterns must be reported once, not once per pattern
test("dedupeHits keeps only the first hit per file:line", () => {
  const hits = [
    { file: "a.md", line: 1, pattern: 0 },
    { file: "a.md", line: 1, pattern: 3 },
    { file: "a.md", line: 2, pattern: 0 },
    { file: "b.md", line: 1, pattern: 0 },
  ];
  assert.deepEqual(dedupeHits(hits), [
    { file: "a.md", line: 1, pattern: 0 },
    { file: "a.md", line: 2, pattern: 0 },
    { file: "b.md", line: 1, pattern: 0 },
  ]);
});

test("a PR that is not OPEN blocks the push; a CONFLICTING one too; a clean one and no PR do not", () => {
  assert.equal(checkPr({ state: "MERGED", mergeable: "UNKNOWN" }).length, 1);
  assert.match(checkPr({ state: "MERGED", mergeable: "UNKNOWN" })[0], /MERGED.*Branch fresh from origin\/main/);
  assert.equal(checkPr({ state: "CLOSED", mergeable: "MERGEABLE" }).length, 1);
  assert.match(checkPr({ state: "OPEN", mergeable: "CONFLICTING" })[0], /CONFLICTING/);
  assert.deepEqual(checkPr({ state: "OPEN", mergeable: "MERGEABLE" }), []);
  assert.deepEqual(checkPr({ state: "OPEN", mergeable: "UNKNOWN" }), []);
  assert.deepEqual(checkPr(undefined), []);
});
