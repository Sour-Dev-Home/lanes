// scripts/lanes/validate.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, splitCommand } from "./validate.mjs";

const line = (cmd, tail = "(\\d+) passed >= 3 (attempts: 3)") => `validate: ${cmd} — ${tail}`;
const body = (...criteria) =>
  ["### Goal", "g", "### Acceptance criteria", ...criteria.map((c) => `- [ ] ${c}`), "### Interface contract", "c", "### Scope", "s", "### Blocked by", "none", "### Tier", "quick"].join("\n");

function setup(criterion, results) {
  const dir = mkdtempSync(join(tmpdir(), "validate-"));
  const calls = [];
  let i = 0;
  const deps = {
    dir,
    now: () => new Date("2026-09-28T10:00:00Z"),
    readIssue: () => body("plain criterion", criterion),
    run: (argv) => {
      calls.push(argv);
      return results[Math.min(i++, results.length - 1)];
    },
  };
  return {
    dir,
    deps,
    calls,
    log: () => readFileSync(join(dir, "validate", "276.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
const ok = (stdout) => ({ status: 0, stdout, stderr: "" });
const args = ["--issue", "276", "--criterion", "2"];

test("splitCommand splits on whitespace and honours quotes", () => {
  assert.deepEqual(splitCommand(`node --test "a b.mjs" 'c d'`), ["node", "--test", "a b.mjs", "c d"]);
  assert.deepEqual(splitCommand("  node   x  "), ["node", "x"]);
});

test("exit 0 when the metric meets the threshold, and the log gets one entry", () => {
  const t = setup(line("node --test"), [ok("5 passed")]);
  const r = main(args, t.deps);
  assert.equal(r.code, 0);
  assert.deepEqual(t.calls[0], ["node", "--test"]);
  const [e] = t.log();
  assert.deepEqual(Object.keys(e).slice(0, 4), ["attempt", "value", "pass", "at"]);
  assert.equal(e.attempt, 1);
  assert.equal(e.value, 5);
  assert.equal(e.pass, true);
  assert.equal(e.at, "2026-09-28T10:00:00.000Z");
  assert.match(r.message, /best: 5/);
  t.cleanup();
});

test("exit 1 below the cap, then 2 at the cap; attempts accumulate", () => {
  const t = setup(line("x"), [ok("1 passed")]);
  assert.equal(main(args, t.deps).code, 1);
  assert.equal(main(args, t.deps).code, 1);
  const r = main(args, t.deps);
  assert.equal(r.code, 2);
  assert.deepEqual(t.log().map((e) => e.attempt), [1, 2, 3]);
  assert.match(r.message, /best: 1/);
  t.cleanup();
});

test("edge: already at the cap runs nothing more and exits 2", () => {
  const t = setup(line("x", "(\\d+) passed >= 3 (attempts: 1)"), [ok("1 passed")]);
  assert.equal(main(args, t.deps).code, 2);
  assert.equal(main(args, t.deps).code, 2);
  assert.equal(t.calls.length, 1);
  assert.equal(t.log().length, 1);
  t.cleanup();
});

test("edge: a non-numeric capture is a failed attempt with the reason", () => {
  const t = setup(line("x", "(\\w+) passed >= 3 (attempts: 3)"), [ok("abc passed")]);
  const r = main(args, t.deps);
  assert.equal(r.code, 1);
  const [e] = t.log();
  assert.equal(e.pass, false);
  assert.equal(e.value, null);
  assert.match(e.reason, /not a number/);
  assert.match(r.message, /not a number/);
  t.cleanup();
});

test("edge: no regex match, a nonzero exit and a spawn error are failed attempts", () => {
  const t = setup(line("x"), [ok("nothing here"), { status: 1, stdout: "9 passed", stderr: "boom" }, { error: new Error("spawn ENOENT") }]);
  main(args, t.deps);
  main(args, t.deps);
  const r = main(args, t.deps);
  const es = t.log();
  assert.match(es[0].reason, /did not match/);
  assert.match(es[1].reason, /exited 1/);
  assert.equal(es[1].pass, false);
  assert.match(es[2].reason, /ENOENT/);
  assert.equal(r.code, 2);
  t.cleanup();
});

test("edge: a strict operator with a decimal value", () => {
  const t = setup(line("x", "took (\\d+\\.?\\d*)s < 2.5 (attempts: 2)"), [ok("took 2.4s")]);
  assert.equal(main(args, t.deps).code, 0);
  t.cleanup();
});

test("edge: best value follows the operator direction", () => {
  const t = setup(line("x", "n=(\\d+) < 1 (attempts: 3)"), [ok("n=9"), ok("n=4"), ok("n=7")]);
  main(args, t.deps);
  main(args, t.deps);
  assert.match(main(args, t.deps).message, /best: 4/);
  t.cleanup();
});

test("edge: bad usage, a plain criterion, a malformed line and an unreadable issue exit 3 without running", () => {
  const t = setup(line("x"), [ok("5 passed")]);
  for (const a of [[], ["--issue", "x", "--criterion", "1"], ["--issue", "276", "--criterion", "0"], ["--issue", "276", "--criterion", "9"], ["--issue", "276", "--criterion", "1"]]) {
    assert.equal(main(a, t.deps).code, 3, a.join(" "));
  }
  const bad = setup("validate: x", [ok("")]);
  const r = main(args, bad.deps);
  assert.equal(r.code, 3);
  assert.match(r.message, /validate/);
  const gone = { ...t.deps, readIssue: () => { throw new Error("not found"); } };
  assert.equal(main(args, gone).code, 3);
  assert.equal(t.calls.length, 0);
  assert.equal(existsSync(join(t.dir, "validate")), false);
  t.cleanup();
  bad.cleanup();
});

test("the real runner executes an argument array without a shell", () => {
  const t = setup(line("node -e console.log(7)", "(\\d+) >= 7 (attempts: 1)"), []);
  delete t.deps.run;
  assert.equal(main(args, t.deps).code, 0);
  t.cleanup();
});

test("edge: a throwing runner is a failed attempt, and control characters are stripped from the reason", () => {
  const t = setup(line("x", "(\\w+) passed >= 3 (attempts: 3)"), [ok("\u001b[31mred\u0007 passed")]);
  t.deps.run = () => {
    throw new Error("bad\u001b[2Jthing");
  };
  assert.equal(main(args, t.deps).code, 1);
  assert.doesNotMatch(t.log()[0].reason, /[\u0000-\u001f]/);
  const u = setup(line("x", "(\\S+) passed >= 3 (attempts: 3)"), [ok("\u001b[31mred passed")]);
  const r = main(args, u.deps);
  assert.doesNotMatch(r.message, /\u001b/);
  t.cleanup();
  u.cleanup();
});

test("edge: a corrupt log line is a cannot-run (exit 3), never a crash or a below-cap exit 1", () => {
  const t = setup(line("node --test"), [ok("5 passed")]);
  mkdirSync(join(t.dir, "validate"), { recursive: true });
  writeFileSync(join(t.dir, "validate", "276.jsonl"), '{"attempt":1\n');
  assert.equal(main(args, t.deps).code, 3);
  t.cleanup();
});

test("edge: an unwritable log directory is a cannot-run (exit 3), not a crash", () => {
  const t = setup(line("node --test"), [ok("5 passed")]);
  writeFileSync(join(t.dir, "validate"), "a file where the directory should be");
  assert.equal(main(args, t.deps).code, 3);
  t.cleanup();
});

test("edge: inclusive operators pass at exactly the threshold, strict ones do not", () => {
  for (const [op, expected] of [["<=", 0], [">=", 0], ["<", 2], [">", 2]]) {
    const t = setup(line("node --test", `(\\d+) passed ${op} 3 (attempts: 1)`), [ok("3 passed")]);
    assert.equal(main(args, t.deps).code, expected, op);
    t.cleanup();
  }
});

test("edge: an empty quoted argument survives splitCommand", () => {
  assert.deepEqual(splitCommand('node -e ""'), ["node", "-e", ""]);
});
