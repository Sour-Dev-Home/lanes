import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PATH_PATTERNS } from "./preflight.mjs";

// #278 (ADR 0012): dashboard.yml publishes snapshot.json. These tests pin the properties that keep it safe.
const raw = readFileSync(".github/workflows/dashboard.yml", "utf8").replace(/\r\n/g, "\n");
// Comments explain the rules and name the forbidden triggers, so only the YAML itself is matched.
const yml = raw.replace(/^\s*#.*\n/gm, "").replace(/[ \t]+#.*$/gm, "");
const section = (text, start, end) => text.slice(text.indexOf(start), end && text.includes(end) ? text.indexOf(end) : undefined);
const onBlock = section(yml, "\non:\n", "\npermissions:\n");
const jobsBlock = section(yml, "\njobs:\n");
const buildJob = section(jobsBlock, "\n  build:\n", "\n  deploy:\n");
const deployJob = section(jobsBlock, "\n  deploy:\n", "\n  health:\n");
// ADR 0027 part 9: the health job is required in dashboard.yml. #683: it once went missing when #662 merged without its
// ADR 0023 hand-over and these tests skipped, so a missing job now fails them.
const healthJob = jobsBlock.includes("\n  health:\n") ? section(jobsBlock, "\n  health:\n") : undefined;

test("dashboard.yml has the health job", () => {
  assert.notEqual(healthJob, undefined, "the health job is missing from dashboard.yml (ADR 0027 part 5)");
});

test("it triggers on issues, status, a push to the default branch and a 5-minute cron", () => {
  for (const trigger of ["issues", "status", "push", "schedule"]) assert.match(onBlock, new RegExp(`\\n {2}${trigger}:`), trigger);
  assert.match(onBlock, /\n {2}push:\n {4}branches: \[main\]/);
  assert.match(onBlock, /- cron: "\*\/5 \* \* \* \*"/);
});

test("it has no pull_request, pull_request_target or merge_group trigger, anywhere in the file", () => {
  // #475: github-pages only accepts deploys from main, so a merge group's ref (or a PR's) can never deploy.
  assert.doesNotMatch(yml, /pull_request|merge_group/);
  assert.deepEqual([...onBlock.matchAll(/\n {2}(\w+):/g)].map((m) => m[1]).sort(), ["issues", "push", "schedule", "status"]);
});

test("every checkout is of the default branch's own code", () => {
  const checkouts = [...yml.matchAll(/uses: actions\/checkout@[^\n]*\n((?: {8,}[^\n]*\n)*)/g)];
  assert.equal(checkouts.length, 2);
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
  assert.equal(uses.length, 7);
  for (const [line, , ref, comment] of uses) assert.ok(/^[0-9a-f]{40}$/.test(ref) && comment, line);
});

test("the health job's only write permission is issues: write, with the reads health.mjs needs", () => {
  const perms = healthJob.match(/permissions:\n((?: {6}\S[^\n]*\n)+)/)[1];
  assert.deepEqual(
    perms.trim().split("\n").map((l) => l.trim()).sort(),
    ["actions: read", "checks: read", "contents: read", "issues: write", "pull-requests: read", "statuses: read"],
  );
  assert.equal((yml.match(/issues: write/g) ?? []).length, 1);
  assert.equal((healthJob.match(/: write/g) ?? []).length, 1);
  assert.doesNotMatch(healthJob, /pages: write|id-token: write/);
});

test("the health job runs health.mjs on schedule only, from the default branch, with the default token and no secret", () => {
  assert.match(healthJob, /\n {4}if: github\.event_name == 'schedule'\n/);
  assert.match(healthJob, /run: node scripts\/lanes\/health\.mjs\n/);
  assert.match(healthJob, /default_branch \}\}\n {10}persist-credentials: false\n/);
  assert.match(healthJob, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.doesNotMatch(healthJob, /secrets\.|needs:/);
  assert.doesNotMatch(healthJob, /snapshot\.mjs|upload-pages|deploy-pages/);
});

test("the snapshot job keeps contents: read and issues: read and no write, whether or not the health job exists", () => {
  assert.match(buildJob, /permissions:\n {6}contents: read\n {6}issues: read\n/);
  assert.doesNotMatch(buildJob, /: write/);
  assert.doesNotMatch(buildJob, /health\.mjs/);
});

test("the PII step gets its patterns from the secret, and scans snapshot.json for exactly preflight's path shapes", () => {
  assert.match(buildJob, /PII_PATTERNS: \$\{\{ secrets\.PII_PATTERNS \}\}/);
  const listed = buildJob.match(/printf '%s\\n' ((?:'[^']*' ?)+) > "\$PATHS"/)[1].match(/'([^']*)'/g).map((s) => s.slice(1, -1));
  assert.deepEqual(listed, PATH_PATTERNS);
  assert.match(buildJob, /scan\(\) \{ grep -n -iF -f "\$1" "\$2" \|\| \[ \$\? -eq 1 \]; \}/);
  assert.match(buildJob, /for FILE in snapshot\.json lane-metrics\.json; do\n/);
  assert.match(buildJob, /\n {12}scan "\$PII" "_site\/\$FILE" > "\$OUT"\n {12}scan "\$PATHS" "_site\/\$FILE" >> "\$OUT"\n/);
});

// #297: lane-metrics.json is built once per UTC day (cached), published in the same site, through the same check.
test("lane-metrics.json is restored from an actions/cache entry keyed by the UTC date, and built only on a miss", () => {
  assert.match(buildJob, /echo "day=\$\(date -u \+%F\)" >> "\$GITHUB_OUTPUT"/);
  assert.match(buildJob, /id: metrics-cache\n {8}uses: actions\/cache@[0-9a-f]{40}\n {8}with:\n {10}path: _site\/lane-metrics\.json\n {10}key: lane-metrics-\$\{\{ steps\.prepare\.outputs\.day \}\}\n/);
  assert.match(buildJob, /if: steps\.metrics-cache\.outputs\.cache-hit != 'true'\n {8}run: node scripts\/lanes\/lane-metrics\.mjs --public --days 30 --out _site\/lane-metrics\.json /);
  const at = (needle) => buildJob.indexOf(needle);
  assert.ok(at("actions/cache@") < at("lane-metrics.mjs") && at("lane-metrics.mjs") < at("PII_PATTERNS"), "restore, build, then check");
});

test("the check runs on both files, before the one upload of _site", () => {
  const checkStep = buildJob.match(/- name: Check snapshot\.json and lane-metrics\.json[\s\S]*?\n {6}- uses: actions\/upload-pages-artifact/)[0];
  assert.match(checkStep, /for FILE in snapshot\.json lane-metrics\.json/);
  assert.equal((buildJob.match(/upload-pages-artifact@/g) ?? []).length, 1);
});

test("the metrics build adds no permissions, uses the default token, and no other workflow deploys Pages", () => {
  assert.equal((buildJob.match(/permissions:/g) ?? []).length, 1);
  assert.doesNotMatch(buildJob, /: write/);
  const metricsStep = buildJob.match(/- name: Build the lane metrics[\s\S]*?\n {6}- name: Build the snapshot/)[0];
  assert.match(metricsStep, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.doesNotMatch(metricsStep, /secrets\./);
  const deployers = readdirSync(".github/workflows").filter((f) => /\.ya?ml$/.test(f) && /deploy-pages/.test(readFileSync(join(".github/workflows", f), "utf8")));
  assert.deepEqual(deployers, ["dashboard.yml"]);
});

// The step's script, run against a throwaway _site/snapshot.json (and lane-metrics.json when given).
const piiScript = buildJob.match(/- name: Check snapshot\.json[\s\S]*?run: \|\n([\s\S]*?)\n {6}- uses:/)[1].replace(/^ {10}/gm, "");
function runCheck(snapshot, secret, metrics) {
  const dir = mkdtempSync(join(tmpdir(), "dashboard-yml-"));
  try {
    mkdirSync(join(dir, "_site"));
    writeFileSync(join(dir, "_site", "snapshot.json"), snapshot);
    if (metrics !== undefined) writeFileSync(join(dir, "_site", "lane-metrics.json"), metrics);
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

test("the PII step scans lane-metrics.json too, naming that file, and passes it when clean", (t) => {
  const clean1 = runCheck(clean(), "Internal-Codename", "{}\n");
  if (skipNoBash(t, clean1)) return;
  assert.equal(clean1.status, 0, clean1.out);
  const path = runCheck(clean(), "", `{\n  "x": ${WIN}\n}\n`);
  assert.equal(path.status, 1);
  assert.deepEqual(path.hits, []);
  assert.match(path.out, /^lane-metrics\.json:2$/m);
  const secret = runCheck(clean(), "Internal-Codename", `{\n  "x": "internal-codename"\n}\n`);
  assert.equal(secret.status, 1);
  assert.doesNotMatch(secret.out, /codename/i);
});

test("edge: an absent lane-metrics.json is fine, an empty one fails closed, and both files can fail together", (t) => {
  const absent = runCheck(clean(), "");
  if (skipNoBash(t, absent)) return;
  assert.equal(absent.status, 0);
  const empty = runCheck(clean(), "", "");
  assert.equal(empty.status, 1);
  assert.match(empty.out, /lane-metrics\.json is empty/);
  const both = runCheck(`{\n  "a": ${NIX}\n}\n`, "", `{\n  "b": ${NIX}\n}\n`);
  assert.match(both.out, /^snapshot\.json:2$/m);
  assert.match(both.out, /^lane-metrics\.json:2$/m);
  assert.equal(both.status, 1);
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
