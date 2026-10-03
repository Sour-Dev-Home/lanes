import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { suiteFiles, testWithRetry } from "./test-retry.mjs";

const SCRIPT = fileURLToPath(new URL("./test-retry.mjs", import.meta.url));
// The real runner in a child process, without the env node's own runner sets for its children (it would stop the nested run).
const cli = (...files) => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [SCRIPT, ...files], { encoding: "utf8", env, windowsHide: true });
};
const inTmp = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), "test-retry-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

// A fake runner: each call takes the next scripted answer and records the files it was asked to run.
const scripted = (...answers) => {
  const calls = [];
  const runner = async (files) => {
    calls.push(files);
    return answers[calls.length - 1] ?? { failures: [] };
  };
  return { runner, calls };
};
const fail = (file, name) => ({ file, name });

test("a clean run passes without a rerun or a warning", async () => {
  const { runner, calls } = scripted({ failures: [] });
  const r = await testWithRetry(["a.test.mjs", "b.test.mjs"], runner);
  assert.deepEqual([r.code, r.lines, r.flaky, r.failed], [0, [], [], []]);
  assert.equal(calls.length, 1);
});

test("a failure that passes on the rerun exits 0 with one lanes-flaky warning per test, rerunning only the failed files", async () => {
  const { runner, calls } = scripted({ failures: [fail("a.test.mjs", "one"), fail("a.test.mjs", "two"), fail("c.test.mjs", "three")] }, { failures: [] });
  const r = await testWithRetry(["a.test.mjs", "b.test.mjs", "c.test.mjs"], runner);
  assert.equal(r.code, 0);
  assert.deepEqual(calls[1], ["a.test.mjs", "c.test.mjs"]);
  assert.deepEqual(r.lines, [
    "::warning title=lanes-flaky::a.test.mjs :: one",
    "::warning title=lanes-flaky::a.test.mjs :: two",
    "::warning title=lanes-flaky::c.test.mjs :: three",
  ]);
});

test("a failure that fails again exits 1 with the failure, and warns only for tests that passed on the rerun", async () => {
  const { runner } = scripted({ failures: [fail("a.test.mjs", "one"), fail("a.test.mjs", "two")] }, { failures: [fail("a.test.mjs", "two")] });
  const r = await testWithRetry(["a.test.mjs"], runner);
  assert.equal(r.code, 1);
  assert.deepEqual(r.failed, [fail("a.test.mjs", "two")]);
  assert.deepEqual(r.lines, ["::warning title=lanes-flaky::a.test.mjs :: one"]);
});

test("it never retries more than once", async () => {
  const { runner, calls } = scripted({ failures: [fail("a.test.mjs", "x")] }, { failures: [fail("a.test.mjs", "x")] }, { failures: [] });
  const r = await testWithRetry(["a.test.mjs"], runner);
  assert.equal(r.code, 1);
  assert.equal(calls.length, 2);
});

test("edge: a test name with a newline or a percent stays on one warning line", async () => {
  const { runner } = scripted({ failures: [fail("a.test.mjs", "50%\nof it")] }, { failures: [] });
  const r = await testWithRetry(["a.test.mjs"], runner);
  assert.deepEqual(r.lines, ["::warning title=lanes-flaky::a.test.mjs :: 50%25 of it"]);
});

test("edge: a rerun failure the first run did not name still fails the run", async () => {
  const { runner } = scripted({ failures: [fail("a.test.mjs", "x")] }, { failures: [fail("a.test.mjs", "a.test.mjs")] });
  const r = await testWithRetry(["a.test.mjs"], runner);
  assert.equal(r.code, 1);
});

test("suiteFiles lists the *.test.mjs files under a directory, sorted, skipping node_modules", () => {
  const files = suiteFiles("scripts");
  assert.ok(files.includes("scripts/lanes/test-retry.test.mjs"));
  assert.ok(files.every((f) => f.endsWith(".test.mjs") && !f.includes("node_modules")));
  assert.deepEqual(files, [...files].sort());
});

test("the CLI: a flaky file fails once, passes on the rerun, exits 0 and prints a lanes-flaky warning", () => {
  inTmp((dir) => {
    const marker = join(dir, "marker");
    const flaky = join(dir, "flaky.test.mjs");
    const good = join(dir, "good.test.mjs");
    writeFileSync(flaky, `import test from "node:test";\nimport { existsSync, writeFileSync } from "node:fs";\ntest("sometimes", () => {\n  if (!existsSync(${JSON.stringify(marker)})) { writeFileSync(${JSON.stringify(marker)}, "x"); throw new Error("first time"); }\n});\n`);
    writeFileSync(good, `import test from "node:test";\ntest("always", () => {});\n`);
    const r = cli(flaky, good);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(existsSync(marker), true);
    assert.match(r.stdout, /^::warning title=lanes-flaky::.*flaky\.test\.mjs :: sometimes$/m);
    assert.equal((r.stdout.match(/title=lanes-flaky/g) ?? []).length, 1);
  });
});

test("the CLI: a test that always fails exits 1 and names it, with no warning", () => {
  inTmp((dir) => {
    const bad = join(dir, "bad.test.mjs");
    writeFileSync(bad, `import test from "node:test";\ntest("broken", () => { throw new Error("no"); });\n`);
    const r = cli(bad);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /bad\.test\.mjs :: broken/);
    assert.doesNotMatch(r.stdout, /lanes-flaky/);
  });
});

