import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// vendor/owasp-cheatsheets/ (ADR 0009, #159): the sheets are upstream bytes at one pinned commit, and the lanes-written
// INDEX.md and VENDORED.md must stay consistent with what is actually on disk.
const DIR = "vendor/owasp-cheatsheets";
const SHEETS = join(DIR, "sheets");
const read = (p) => readFileSync(p, "utf8");

const EXPECTED = [
  "Authentication", "Session_Management", "Authorization", "OAuth2", "Cross-Site_Request_Forgery_Prevention",
  "Cross_Site_Scripting_Prevention", "Content_Security_Policy", "Input_Validation", "REST_Security",
  "Server_Side_Request_Forgery_Prevention", "Secrets_Management", "Logging", "Nodejs_Security", "CI_CD_Security",
  "Docker_Security", "OS_Command_Injection_Defense",
].map((n) => `${n}_Cheat_Sheet.md`);

// Sheet file names cited as `sheets/<Name>.md`; anything with a path separator or `..` is not a sheet name.
export const sheetRefs = (text) => [...new Set([...text.matchAll(/sheets\/([A-Za-z0-9_-]+\.md)/g)].map((m) => m[1]))];

// The pinned commit: the 40-hex value opening VENDORED.md's `- Commit:` line, or null.
export const pinnedCommit = (text) => /^- Commit: `?([0-9a-f]{40})(?![0-9a-f])/m.exec(text)?.[1] ?? null;

// Git's blob id for these bytes, so an unchanged file can be checked against upstream's tree without a network call.
export const gitBlobSha = (buf) => createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex");

// True when a file's source imports from "node:child_process", single- or double-quoted (repo style is double, but
// the trip-wire below must not go blind just because a future script picks the other quote).
export const importsChildProcess = (text) => /from ["']node:child_process["']/.test(text);

// `| <blob sha> | <file> |` rows of VENDORED.md's hash table, as a Map of file -> sha.
export const blobTable = (text) => new Map([...text.matchAll(/^\|\s*`?([0-9a-f]{40})`?\s*\|\s*`?([A-Za-z0-9_.-]+)`?\s*\|/gm)].map((m) => [m[2], m[1]]));

// The blob-id check itself, over `{ name, bytes }` entries: one message per file that VENDORED.md does not list or whose
// bytes differ from the recorded id. Empty means every file matches the pinned upstream tree.
export const blobIdProblems = (table, entries) => entries.flatMap(({ name, bytes }) => {
  if (!table.has(name)) return [`VENDORED.md records no blob id for ${name}`];
  return gitBlobSha(bytes) === table.get(name) ? [] : [`${name} differs from the pinned upstream bytes`];
});

const vendored = () => read(join(DIR, "VENDORED.md"));
const index = () => read(join(DIR, "INDEX.md"));
const sheetFiles = () => readdirSync(SHEETS).sort();

test("criterion 1: sheets/ holds exactly the sixteen approved sheets", () => {
  assert.deepEqual(sheetFiles(), [...EXPECTED].sort());
});

test("criterion 1: every sheet and the licence match the blob ids recorded from the pinned upstream tree", () => {
  assert.deepEqual(blobIdProblems(blobTable(vendored()), realEntries()), []);
});

// The vendored sheets are exempt from the local-path and secret scans (#183), so this check is what stops a changed or
// unlisted sheet slipping through: the negative tests below run the same helper the real test above uses.
const realEntries = () => [...sheetFiles().map((f) => ({ name: f, bytes: readFileSync(join(SHEETS, f)) })), { name: "LICENSE", bytes: readFileSync(join(DIR, "LICENSE")) }];

test("criterion 1 (negative): a sheet copy with one added line fails the blob-id check, naming the file", () => {
  const dir = mkdtempSync(join(tmpdir(), "vendor-blob-"));
  try {
    const name = sheetFiles()[0];
    const copy = join(dir, name);
    // Built at run time so this source file carries no absolute local path itself.
    const localPath = ["C:", "Users", "someone", "notes.txt"].join("\\");
    writeFileSync(copy, `${read(join(SHEETS, name))}see ${localPath}\n`);
    assert.deepEqual(blobIdProblems(blobTable(vendored()), [{ name, bytes: readFileSync(copy) }]), [`${name} differs from the pinned upstream bytes`]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("criterion 2 (negative): a sheet missing from VENDORED.md's blob-id table fails the check, naming the file", () => {
  const name = sheetFiles()[0];
  const table = blobTable(vendored());
  table.delete(name);
  assert.deepEqual(blobIdProblems(table, realEntries()), [`VENDORED.md records no blob id for ${name}`]);
});

test("edge: blobIdProblems reports an empty table for every file, and a changed licence as well as a changed sheet", () => {
  const entries = [{ name: "a.md", bytes: Buffer.from("a\n") }, { name: "LICENSE", bytes: Buffer.from("b\n") }];
  assert.deepEqual(blobIdProblems(new Map(), entries), ["VENDORED.md records no blob id for a.md", "VENDORED.md records no blob id for LICENSE"]);
  assert.deepEqual(blobIdProblems(new Map([["a.md", gitBlobSha(entries[0].bytes)], ["LICENSE", "0".repeat(40)]]), entries), ["LICENSE differs from the pinned upstream bytes"]);
  assert.deepEqual(blobIdProblems(new Map(), []), []);
});

test("criterion 2 and 5: the licence file exists and is CC BY-SA 4.0", () => {
  const p = join(DIR, "LICENSE");
  assert.ok(existsSync(p), "vendor/owasp-cheatsheets/LICENSE is missing");
  const text = read(p);
  assert.match(text, /^# Attribution-ShareAlike 4\.0 International/m);
  assert.match(text, /SPDX-License-Identifier: CC-BY-SA-4\.0/);
});

test("criterion 3 and 5: VENDORED.md names the upstream, the pinned commit, attribution, the update rule and a security read", () => {
  const v = vendored();
  assert.match(v, /https:\/\/github\.com\/OWASP\/CheatSheetSeries/);
  const sha = pinnedCommit(v);
  assert.ok(sha, "VENDORED.md has no `- Commit: <40 hex>` line");
  assert.ok(v.includes(`/tree/${sha}`) || v.includes(`/blob/${sha}`), "the upstream link does not point at the pinned commit");
  assert.match(v, /CC BY-SA 4\.0/);
  assert.match(v, /^## Attribution$/m);
  assert.match(v, /To update:/);
  assert.match(v, /^## Security read$/m);
  assert.match(v, /^Findings:/m);
});

test("criterion 5: every file in sheets/ is listed in VENDORED.md", () => {
  const v = vendored();
  for (const f of sheetFiles()) assert.ok(v.includes(f), `${f} is not listed in VENDORED.md`);
});

test("criterion 5: every sheet INDEX.md names exists in sheets/", () => {
  const refs = sheetRefs(index());
  assert.ok(refs.length > 0, "INDEX.md cites no sheets");
  const have = new Set(sheetFiles());
  for (const r of refs) assert.ok(have.has(r), `INDEX.md cites sheets/${r}, which is not vendored`);
});

// The reverse direction of the check above: a vendored sheet that INDEX.md never mentions is dead weight the
// security reviewer would not know to read, and criterion 4 requires INDEX.md to map every sheet to a reason.
test("criterion 4: every sheet in sheets/ is referenced somewhere in INDEX.md", () => {
  const refs = new Set(sheetRefs(index()));
  for (const f of sheetFiles()) assert.ok(refs.has(f), `${f} is vendored but INDEX.md never mentions it`);
});

test("criterion 4: INDEX.md stays within about 2k tokens", () => {
  // ~4 characters per token for English Markdown; 9000 leaves headroom over 2k tokens without allowing a rewrite of a sheet.
  assert.ok(index().length <= 9000, `INDEX.md is ${index().length} characters`);
});

test("criterion 4: INDEX.md maps the guards, workflows, secrets, logging and Node.js topics", () => {
  const i = index();
  for (const needle of ["scripts/lanes/approve-guard.mjs", "scripts/lanes/start-guard.mjs", ".github/workflows/", "pull_request_target"]) {
    assert.ok(i.includes(needle), `INDEX.md does not mention ${needle}`);
  }
  for (const topic of [/secret/i, /token/i, /logging/i, /Node\.js/]) assert.match(i, topic);
});

// Deliberate trip-wire: a script that gains a child process must add its line to INDEX.md, and vendor/ is an owner
// path, so that PR needs owner review whatever its tier. New shell-out surface is exactly what the owner reviews.
test("criterion 4: INDEX.md lists every script that runs a child process", () => {
  const i = index();
  const scripts = ["scripts/preflight.mjs", ...readdirSync("scripts/lanes").filter((f) => f.endsWith(".mjs") && !f.endsWith(".test.mjs")).map((f) => `scripts/lanes/${f}`)];
  const spawning = scripts.filter((p) => importsChildProcess(read(p)));
  assert.ok(spawning.length > 0);
  for (const p of spawning) assert.ok(i.includes(p), `${p} imports node:child_process but INDEX.md does not list it`);
});

// Regression: the trip-wire above scans repo source with a regex, not a parser. It must not go blind just because a
// future script imports node:child_process with single quotes instead of this repo's usual double quotes.
test("edge: importsChildProcess matches single- and double-quoted imports alike", () => {
  assert.ok(importsChildProcess('import { execFileSync } from "node:child_process";'));
  assert.ok(importsChildProcess("import { execFileSync } from 'node:child_process';"));
  assert.ok(!importsChildProcess('import { readFileSync } from "node:fs";'));
});

test("edge: sheetRefs on empty text is empty", () => {
  assert.deepEqual(sheetRefs(""), []);
});

test("edge: sheetRefs ignores traversal and nested paths, and dedupes", () => {
  assert.deepEqual(sheetRefs("sheets/../LICENSE.md sheets/a/b.md sheets/X_Cheat_Sheet.md sheets/X_Cheat_Sheet.md"), ["X_Cheat_Sheet.md"]);
});

test("edge: pinnedCommit rejects a short or missing commit", () => {
  assert.equal(pinnedCommit("- Commit: abc123"), null);
  assert.equal(pinnedCommit(""), null);
  assert.equal(pinnedCommit(`- Commit: ${"a".repeat(41)}`), null);
  assert.equal(pinnedCommit(`- Commit: ${"a".repeat(40)} (2026-09-27)`), "a".repeat(40));
  assert.equal(pinnedCommit(`- Commit: \`${"a".repeat(40)}\``), "a".repeat(40));
});

test("edge: gitBlobSha matches git's id for the empty blob and for LF-only text", () => {
  assert.equal(gitBlobSha(Buffer.alloc(0)), "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
  assert.equal(gitBlobSha(Buffer.from("hello\n")), "ce013625030ba8dba906f756967f9e9ca394464a");
});

// .claude/agents/security-reviewer.md (#160, ADR 0009 decision 3): the brief reads INDEX.md, then 1-3 sheets, cites
// sheet and section, lets a sheet beat the checklist, and keeps the ADR 0004 and 0007 accepted-risk paragraphs verbatim.
const BRIEF = ".claude/agents/security-reviewer.md";
// Markdown hard-wraps at 120 columns, so compare prose with whitespace runs collapsed.
export const flat = (text) => text.replace(/\s+/g, " ").trim();
const brief = () => flat(read(BRIEF));

const ACCEPTED_RISK = {
  "ADR 0004": "Accepted risk (ADR 0004, `docs/adr/0004-approve-guard-accepted-risk.md`): the approve guard is best-effort defence in depth, not a barrier to a determined lane. A newly found way to build a command that reaches `post-review.mjs owner`, or to post `review/owner` directly, is `minor`, not a blocker. File it as a follow-up issue with the `lane-filed` label (`gh issue create --label lane-filed --body-file <file>`, the body in the Task form's layout) and name that issue in the finding. A regression, where something the guard or the script check previously caught now passes, is `critical`.",
  "ADR 0007": "Accepted risk (ADR 0007, `docs/adr/0007-start-guard-accepted-risk.md`): the start guard is best-effort defence in depth, not a barrier to a determined lane. A newly found way to build a command that reaches `start.mjs`, `queue.mjs` or `claude --bg` is `minor`, not a blocker. File it as a follow-up issue with the `lane-filed` label (`gh issue create --label lane-filed --body-file <file>`, the body in the Task form's layout) and name that issue in the finding. A regression, where something the guard or the script check previously caught now passes, is `critical`.",
};

test("criterion 1 (#160): the brief reads INDEX.md first, then only the 1-3 sheets it points to, never the whole folder", () => {
  const b = brief();
  const at = b.indexOf("vendor/owasp-cheatsheets/INDEX.md");
  assert.ok(at >= 0, "the brief does not name vendor/owasp-cheatsheets/INDEX.md");
  assert.ok(at < b.indexOf("security-checklist.md"), "the brief must send the reviewer to INDEX.md before the checklist");
  assert.match(b, /INDEX\.md` first/);
  assert.match(b, /only the 1-3 sheets it points to/);
  assert.match(b, /never read the whole folder/i);
});

test("criterion 2 (#160): every finding names sheet and section, and says so when no sheet matches", () => {
  const b = brief();
  assert.match(b, /Every finding names the sheet and section it rests on/);
  assert.ok(b.includes("Nodejs Security Cheat Sheet § Do not use dangerous functions"), "the brief lacks the citation example");
  assert.match(b, /no matching sheet/);
});

test("criterion 2 (#160): the brief's citation example names a real sheet and a real section of it", () => {
  const sheet = read(join(SHEETS, "Nodejs_Security_Cheat_Sheet.md"));
  assert.match(sheet, /^#+ Do not use dangerous functions\s*$/m);
});

test("criterion 3 (#160): where a sheet and security-checklist.md differ, the sheet wins", () => {
  assert.match(brief(), /Where a sheet and `vendor\/agent-skills\/references\/security-checklist\.md` differ, the sheet wins/);
});

test("criterion 4 (#160): the ADR 0004 and ADR 0007 accepted-risk paragraphs are present word for word", () => {
  const b = brief();
  for (const [adr, para] of Object.entries(ACCEPTED_RISK)) assert.ok(b.includes(flat(para)), `the ${adr} accepted-risk paragraph changed or is missing`);
});

// install.mjs copies the brief into other projects without vendor/owasp-cheatsheets/, so the brief must not dead-end there.
test("edge: the brief says what to do when INDEX.md is not in the repository", () => {
  assert.match(brief(), /If `INDEX\.md` is not in this repository, say so in your summary and carry on from the checklist alone/);
});

test("edge: flat collapses newlines and indentation so re-wrapped prose still matches", () => {
  assert.equal(flat("  a\n  b\r\n\tc  "), "a b c");
  assert.equal(flat(""), "");
});

// #160 renumbered the step list from six items to seven to fit the new INDEX.md step; a botched renumbering could
// drop or duplicate a step without any criterion-specific test above noticing.
test("edge: the brief's numbered step list stays sequential 1-7 with no gap or duplicate", () => {
  const numbers = [...read(BRIEF).matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));
  assert.deepEqual(numbers, [1, 2, 3, 4, 5, 6, 7]);
});

// Steps 1, 4, 6 and 7 and the closing verdict rule were not meant to change in #160; only their numbers should move.
test("edge: the brief's unrelated steps and closing verdict rule are untouched by the #160 rewrite", () => {
  const b = brief();
  assert.match(b, /Read the issue's Goal and Acceptance criteria/);
  assert.match(b, /Focus on what actually changed: new input handling, new secrets or tokens/);
  assert.match(b, /`criteria` may be left empty: you are not required to assess the issue's acceptance criteria one by one\./);
  assert.match(b, /verdict` must be `"failure"` if any finding is `critical` or `important`/);
});

test("edge: blobTable skips malformed rows", () => {
  const t = blobTable(`| ${"b".repeat(40)} | A.md |\n| nothex | B.md |\n| ${"c".repeat(39)} | C.md |`);
  assert.deepEqual([...t.keys()], ["A.md"]);
});
