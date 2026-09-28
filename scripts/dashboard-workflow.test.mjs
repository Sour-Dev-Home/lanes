import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PATH_PATTERNS } from "./preflight.mjs";

// #278 (ADR 0012): dashboard.yml publishes snapshot.json. These tests pin the properties that keep it safe.
const raw = readFileSync(".github/workflows/dashboard.yml", "utf8").replace(/\r\n/g, "\n");
// Comments explain the rules and name the forbidden triggers, so only the YAML itself is matched.
const yml = raw.replace(/^\s*#.*\n/gm, "").replace(/[ \t]+#.*$/gm, "");
const section = (text, start, end) => text.slice(text.indexOf(start), end ? text.indexOf(end) : undefined);
const onBlock = section(yml, "\non:\n", "\npermissions:\n");
const jobsBlock = section(yml, "\njobs:\n");
const buildJob = section(jobsBlock, "\n  build:\n", "\n  deploy:\n");
const deployJob = section(jobsBlock, "\n  deploy:\n");

test("it triggers on issues, status, merge_group, a push to the default branch and a 5-minute cron", () => {
  for (const trigger of ["issues", "status", "merge_group", "push", "schedule"]) assert.match(onBlock, new RegExp(`\\n {2}${trigger}:`), trigger);
  assert.match(onBlock, /\n {2}push:\n {4}branches: \[main\]/);
  assert.match(onBlock, /- cron: "\*\/5 \* \* \* \*"/);
});

test("it has no pull_request or pull_request_target trigger, anywhere in the file", () => {
  assert.doesNotMatch(yml, /pull_request/);
  assert.deepEqual([...onBlock.matchAll(/\n {2}(\w+):/g)].map((m) => m[1]).sort(), ["issues", "merge_group", "push", "schedule", "status"]);
});

test("every checkout is of the default branch's own code", () => {
  const checkouts = [...yml.matchAll(/uses: actions\/checkout@[^\n]*\n((?: {8,}[^\n]*\n)*)/g)];
  assert.equal(checkouts.length, 1);
  for (const [, withBlock] of checkouts) assert.match(withBlock, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
  assert.doesNotMatch(yml, /github\.(head_ref|event\.pull_request)/);
  assert.match(buildJob, /default_branch \}\}\n {10}persist-credentials: false\n/);
});

test("pages: write and id-token: write appear in the deploy job only", () => {
  assert.equal((yml.match(/pages: write/g) ?? []).length, 1);
  assert.equal((yml.match(/id-token: write/g) ?? []).length, 1);
  assert.match(deployJob, /permissions:\n {6}pages: write\n {6}id-token: write\n/);
  for (const other of [section(yml, "\npermissions:\n", "\nconcurrency:\n"), buildJob]) {
    assert.doesNotMatch(other, /pages: write|id-token: write/);
    assert.doesNotMatch(other, /: write/);
  }
});

test("the workflow default and the build job are read-only", () => {
  assert.match(yml, /\npermissions:\n {2}contents: read\n/);
  assert.match(buildJob, /permissions:\n {6}contents: read\n/);
});

test("concurrency is one group with cancel-in-progress", () => {
  assert.match(yml, /\nconcurrency:\n {2}group: dashboard-publish\n {2}cancel-in-progress: true\n/);
});

test("the build runs snapshot.mjs, then the PII check on snapshot.json, then upload-pages-artifact, then deploy-pages deploys", () => {
  const at = (needle) => buildJob.indexOf(needle);
  assert.ok(at("node scripts/lanes/snapshot.mjs --out _site/snapshot.json") > 0);
  assert.ok(at("node scripts/lanes/snapshot.mjs") < at("PII_PATTERNS"), "the check follows the build");
  assert.ok(at("PII_PATTERNS") < at("actions/upload-pages-artifact@"), "the check precedes the upload");
  assert.match(buildJob, /uses: actions\/upload-pages-artifact@[0-9a-f]{40}\n {8}with:\n {10}path: _site/);
  assert.match(deployJob, /needs: build/);
  assert.match(deployJob, /uses: actions\/deploy-pages@[0-9a-f]{40}/);
  assert.doesNotMatch(deployJob, /run:|checkout/, "the deploy job runs nothing else");
});

test("every action is pinned to a commit SHA", () => {
  const uses = [...raw.matchAll(/uses: (\S+)@(\S+)( # v\d+)?/g)];
  assert.equal(uses.length, 4);
  for (const [line, , ref, comment] of uses) assert.ok(/^[0-9a-f]{40}$/.test(ref) && comment, line);
});

test("the PII step gets its patterns from the secret, and scans snapshot.json for exactly preflight's path shapes", () => {
  assert.match(buildJob, /PII_PATTERNS: \$\{\{ secrets\.PII_PATTERNS \}\}/);
  const listed = buildJob.match(/printf '%s\\n' ((?:'[^']*' ?)+) > "\$PATHS"/)[1].match(/'([^']*)'/g).map((s) => s.slice(1, -1));
  assert.deepEqual(listed, PATH_PATTERNS);
  assert.match(buildJob, /scan\(\) \{ grep -n -iF -f "\$1" _site\/snapshot\.json \|\| \[ \$\? -eq 1 \]; \}/);
  assert.match(buildJob, /\n {10}scan "\$PII" > "\$OUT"\n {10}scan "\$PATHS" >> "\$OUT"\n/);
});

// The step's script, run against a throwaway _site/snapshot.json.
const piiScript = buildJob.match(/- name: Check snapshot\.json[\s\S]*?run: \|\n([\s\S]*?)\n {6}- uses:/)[1].replace(/^ {10}/gm, "");
function runCheck(snapshot, secret) {
  const dir = mkdtempSync(join(tmpdir(), "dashboard-yml-"));
  try {
    mkdirSync(join(dir, "_site"));
    writeFileSync(join(dir, "_site", "snapshot.json"), snapshot);
    // A bash that cannot see the folder (WSL's, say) or has no GNU grep is "not available", not a pass.
    const probe = spawnSync("bash", ["-c", "test -s _site/snapshot.json && grep -iF -f /dev/null _site/snapshot.json; test $? -le 1"], { cwd: dir });
    if (probe.error || probe.status !== 0) return undefined;
    const result = spawnSync("bash", ["-e", "-s"], { input: piiScript, cwd: dir, env: { ...process.env, PII_PATTERNS: secret }, encoding: "utf8" });
    return { status: result.status, out: result.stdout, hits: result.stdout.split("\n").filter((line) => /^snapshot\.json:\d+$/.test(line)) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const skipNoBash = (t, result) => {
  if (result !== undefined) return false;
  assert.ok(!process.env.CI, "CI must run this test, not skip it");
  t.skip("no bash with GNU grep on this machine");
  return true;
};
// Built from parts so this file does not contain a path shape literally (the security scan would flag it).
const WIN = JSON.stringify(["C:", "Users", "someone", "x"].join("\\"));
const NIX = JSON.stringify(["", "home", "someone"].join("/"));
const clean = (title = "Add the schema") => `{\n  "issues": [{ "title": ${JSON.stringify(title)} }]\n}\n`;

test("the PII step passes a clean snapshot with or without the secret", (t) => {
  for (const secret of ["Internal-Codename", ""]) {
    const result = runCheck(clean(), secret);
    if (skipNoBash(t, result)) return;
    assert.equal(result.status, 0, `secret ${JSON.stringify(secret)}: ${result.out}`);
  }
});

test("the PII step fails on a local path, in JSON-escaped or forward-slash form, printing only the line", (t) => {
  for (const title of [WIN, NIX]) {
    const result = runCheck(`{\n  "title": ${title}\n}\n`, "");
    if (skipNoBash(t, result)) return;
    assert.equal(result.status, 1, title);
    assert.deepEqual(result.hits, ["snapshot.json:2"]);
  }
});

test("the PII step fails on a private pattern, case-insensitively, and never prints the matched text", (t) => {
  const result = runCheck(clean("about the internal-codename project"), "Internal-Codename");
  if (skipNoBash(t, result)) return;
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.out, /codename/i);
  assert.deepEqual(result.hits, ["snapshot.json:2"]);
});

test("edge: a secret saved with CRLF line endings still matches", (t) => {
  const result = runCheck(clean("the Internal-Codename project"), "Internal-Codename\r\nOther\r\n");
  if (skipNoBash(t, result)) return;
  assert.equal(result.status, 1);
});

test("edge: a secret with blank lines does not match everything", (t) => {
  const result = runCheck(clean(), "\n  \nInternal-Codename\n\n");
  if (skipNoBash(t, result)) return;
  assert.equal(result.status, 0);
});

test("edge: the PII step fails closed when snapshot.json is absent or empty", (t) => {
  if (skipNoBash(t, runCheck(clean(), ""))) return;
  const dir = mkdtempSync(join(tmpdir(), "dashboard-yml-"));
  try {
    mkdirSync(join(dir, "_site"));
    for (const setup of [() => {}, () => writeFileSync(join(dir, "_site", "snapshot.json"), "")]) {
      setup();
      const result = spawnSync("bash", ["-e", "-s"], { input: piiScript, cwd: dir, env: { ...process.env, PII_PATTERNS: "" }, encoding: "utf8" });
      assert.equal(result.status, 1);
      assert.match(result.stdout, /missing or empty/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
