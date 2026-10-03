import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EMPTY_TREE, PATH_PATTERNS, PATH_SCAN_EXEMPT, addedLines, checkPr, dedupeHits, diffBase, scanLines, scanMessages } from "./preflight.mjs";

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

// #183: the vendored OWASP sheets are upstream bytes with URL fragments such as a users/profile route.
const SHEET = "vendor/owasp-cheatsheets/sheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.md";
const URL_LINE = `fetch('${["", "users", "profile"].join("/")}', { method: 'POST' })`;

test("a sheet line containing a users/profile route is not a hit", () => {
  assert.deepEqual(scanLines([{ file: SHEET, line: 942, text: URL_LINE }], PATH_PATTERNS), []);
});

test("the same line anywhere else under vendor/ is a hit, including the OWASP index", () => {
  for (const file of ["vendor/owasp-cheatsheets/INDEX.md", "vendor/other/x.md"]) {
    assert.equal(scanLines([{ file, line: 1, text: URL_LINE }], PATH_PATTERNS).length, 1, file);
  }
});

test("a sheet line matching a private pattern is still a hit, and only for that pattern", () => {
  const hits = scanLines([{ file: SHEET, line: 3, text: `${URL_LINE} secret-name` }], [...PATH_PATTERNS, "Secret-Name"]);
  assert.deepEqual(hits, [{ file: SHEET, line: 3, pattern: PATH_PATTERNS.length }]);
});

test("the path exemption is exactly the sheets folder and no wider", () => {
  assert.deepEqual(PATH_SCAN_EXEMPT.map((exempt) => exempt.source), ["^vendor\\/owasp-cheatsheets\\/sheets\\/"]);
});

test("edge: near-miss paths are still scanned for local paths", () => {
  for (const file of [
    "vendor/owasp-cheatsheets/VENDORED.md",
    "vendor/owasp-cheatsheets/LICENSE",
    "vendor/owasp-cheatsheets/sheets", // a file named like the folder, not inside it
    "vendor/owasp-cheatsheets/sheets-extra/a.md",
    "vendor/owasp-cheatsheets/sheetsa.md",
    "docs/vendor/owasp-cheatsheets/sheets/a.md", // not anchored at the repo root
    "Vendor/owasp-cheatsheets/sheets/a.md", // case differs: git paths are case-sensitive
    "(commit message)",
  ]) {
    assert.equal(scanLines([{ file, line: 1, text: URL_LINE }], PATH_PATTERNS).length, 1, file);
  }
});

test("edge: every path shape, including the JSON-escaped one, is skipped in a sheet", () => {
  const lines = PATH_PATTERNS.map((pattern, index) => ({ file: SHEET, line: index + 1, text: `see ${pattern}x` }));
  assert.deepEqual(scanLines(lines, PATH_PATTERNS), []);
});

test("edge: a commit message naming a sheet path is still scanned", () => {
  assert.equal(scanMessages(`${SHEET}\n${URL_LINE}`, PATH_PATTERNS).length, 1);
});

// Not covered above: every other test calls scanLines/scanMessages directly. This runs the real CLI (`node
// preflight.mjs`, the actual program CI's PR hook invokes) end to end in a throwaway repo, so a wiring mistake in
// runChecks itself (patterns list, exempt lists, diff plumbing) would fail here even if the exported units look right.
const PREFLIGHT_CLI = fileURLToPath(new URL("./preflight.mjs", import.meta.url));
const GIT_IDENTITY = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.example", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.example" };

test("edge: the CLI itself passes a sheet with a users/profile line, and fails the same line elsewhere", () => {
  const dir = mkdtempSync(join(tmpdir(), "preflight-cli-"));
  try {
    const sheetDir = join(dir, "vendor", "owasp-cheatsheets", "sheets");
    mkdirSync(sheetDir, { recursive: true });
    writeFileSync(join(sheetDir, "CSRF.md"), `${URL_LINE}\n`);
    writeFileSync(join(dir, "README.md"), "clean\n");
    const env = { ...process.env, ...GIT_IDENTITY };
    execFileSync("git", ["init", "-q"], { cwd: dir, windowsHide: true });
    execFileSync("git", ["add", "-A"], { cwd: dir, windowsHide: true });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir, env, windowsHide: true });

    const clean = spawnSync("node", [PREFLIGHT_CLI], { cwd: dir, encoding: "utf8", windowsHide: true });
    assert.equal(clean.status, 0, clean.stdout + clean.stderr);

    writeFileSync(join(dir, "other.md"), `${URL_LINE}\n`);
    execFileSync("git", ["add", "-A"], { cwd: dir, windowsHide: true });
    const dirty = spawnSync("node", [PREFLIGHT_CLI], { cwd: dir, encoding: "utf8", windowsHide: true });
    assert.equal(dirty.status, 1, dirty.stdout + dirty.stderr);
    assert.match(dirty.stderr, /other\.md:1 contains a local absolute path/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
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

test("a CONFLICTING PR does not block the push once origin/main is already merged into HEAD", () => {
  assert.deepEqual(checkPr({ state: "OPEN", mergeable: "CONFLICTING" }, true), []);
});

test("a CONFLICTING PR still blocks when origin/main is not an ancestor of HEAD", () => {
  assert.match(checkPr({ state: "OPEN", mergeable: "CONFLICTING" }, false)[0], /CONFLICTING/);
  assert.match(checkPr({ state: "OPEN", mergeable: "CONFLICTING" })[0], /CONFLICTING/);
});

test("edge: a resolved conflict never excuses a PR that is not OPEN", () => {
  assert.match(checkPr({ state: "MERGED", mergeable: "CONFLICTING" }, true)[0], /MERGED/);
});
