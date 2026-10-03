import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { applyUpgrade, main, planUpgrade, readLock } from "./upgrade.mjs";

const sha = (s) => createHash("sha256").update(s).digest("hex");
const tmp = () => mkdtempSync(path.join(tmpdir(), "lanes-upgrade-"));
const put = (dir, rel, text) => {
  mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  writeFileSync(path.join(dir, rel), text);
};
const get = (dir, rel) => readFileSync(path.join(dir, rel), "utf8");
const out = () => {
  const lines = [];
  return { lines, print: (l) => lines.push(l) };
};

// A source checkout at 0.2.0 and a target installed from 0.1.0.
function fixture({ lockFiles, manifest = ["a.txt", "b.txt", "c.txt", "new.txt", "lanes.config.json"] } = {}) {
  const source = tmp();
  const target = tmp();
  put(source, "package.json", JSON.stringify({ version: "0.2.0" }));
  put(source, "lanes.config.json", JSON.stringify({ keep: 1, added: { x: 2 }, extra: "d" }));
  for (const f of manifest) if (f !== "lanes.config.json") put(source, f, `source ${f}`);
  put(target, "lanes.config.json", JSON.stringify({ keep: "mine" }));
  const files = lockFiles ?? { "a.txt": sha("old a"), "b.txt": sha("old b"), "gone.txt": sha("old gone") };
  put(target, "a.txt", "old a"); // unchanged since install
  put(target, "b.txt", "my edit of b"); // edited
  put(target, "gone.txt", "old gone");
  put(target, "lanes.lock.json", JSON.stringify({ version: "0.1.0", files }));
  return { source, target, manifest };
}

test("plan: one line per file with overwrite, refuse, add and no longer part of lanes", () => {
  const { source, target, manifest } = fixture();
  put(target, "c.txt", "untracked local file"); // in MANIFEST, missing from the lock
  const plan = planUpgrade(source, target, manifest);
  const by = Object.fromEntries(plan.map((p) => [p.file, p.action]));
  assert.deepEqual(by, { "a.txt": "overwrite", "b.txt": "refuse", "c.txt": "refuse", "new.txt": "add", "gone.txt": "no longer part of lanes" });
});

test("plan: a file in the lock but gone from the target is refused, never re-created silently", () => {
  const { source, target, manifest } = fixture();
  rmTarget(target, "a.txt");
  assert.equal(planUpgrade(source, target, manifest).find((p) => p.file === "a.txt").action, "refuse");
});

function rmTarget(dir, rel) {
  execFileSync(process.execPath, ["-e", `require("fs").rmSync(${JSON.stringify(path.join(dir, rel))})`], { windowsHide: true });
}

test("plan: the dashboard workflow is tracked under its .disabled name when the lock has it", () => {
  const dash = ".github/workflows/dashboard.yml";
  const { source, target } = fixture({ lockFiles: { [`${dash}.disabled`]: sha("old dash") } });
  put(source, dash, "src dash");
  put(target, `${dash}.disabled`, "old dash");
  const plan = planUpgrade(source, target, [dash]);
  assert.deepEqual(plan, [{ file: `${dash}.disabled`, from: dash, action: "overwrite" }]);
});

test("--help and -h print the usage and exit 0 without planning or writing, even inside Claude", () => {
  for (const argv of [["--help"], ["-h"], ["somewhere", "--apply", "--help"]]) {
    const o = out();
    assert.equal(main(argv, { CLAUDECODE: "1" }, { source: "/nonexistent-source", print: o.print }), 0);
    assert.equal(o.lines.length, 1);
    assert.match(o.lines[0], /^usage: upgrade\.mjs <target-dir> \[--apply\]/);
  }
});

test("an unknown flag exits 2 naming it with the usage, and writes nothing", () => {
  const { source, target } = fixture();
  const before = [get(target, "a.txt"), get(target, "lanes.lock.json")];
  for (const flag of ["--force", "-x", "--apply=1"]) {
    const o = out();
    assert.equal(main([target, flag], {}, { source, print: o.print }), 2, flag);
    assert.equal(o.lines.length, 1);
    assert.match(o.lines[0], new RegExp(`^unknown argument: ${flag}\\nusage: upgrade\\.mjs `));
  }
  assert.deepEqual([get(target, "a.txt"), get(target, "lanes.lock.json")], before);
});

test("main without --apply prints the plan and writes nothing", () => {
  const { source, target } = fixture();
  const before = [get(target, "a.txt"), get(target, "lanes.lock.json"), get(target, "lanes.config.json")];
  const o = out();
  const code = main([target], {}, { source, manifest: ["a.txt", "b.txt", "new.txt", "lanes.config.json"], print: o.print });
  assert.equal(code, 0);
  assert.ok(o.lines.includes("overwrite a.txt"));
  assert.ok(o.lines.includes("refuse b.txt"));
  assert.ok(o.lines.includes("add new.txt"));
  assert.ok(o.lines.includes("no longer part of lanes gone.txt"));
  assert.deepEqual([get(target, "a.txt"), get(target, "lanes.lock.json"), get(target, "lanes.config.json")], before);
  assert.equal(existsSync(path.join(target, "new.txt")), false);
});

test("--apply performs the plan, keeps refused and retired files, and rewrites the lock", () => {
  const { source, target } = fixture();
  const o = out();
  const code = main([target, "--apply"], {}, { source, manifest: ["a.txt", "b.txt", "new.txt", "lanes.config.json"], print: o.print });
  assert.equal(code, 0);
  assert.equal(get(target, "a.txt"), "source a.txt");
  assert.equal(get(target, "new.txt"), "source new.txt");
  assert.equal(get(target, "b.txt"), "my edit of b");
  assert.equal(get(target, "gone.txt"), "old gone");
  const lock = JSON.parse(get(target, "lanes.lock.json"));
  assert.equal(lock.version, "0.2.0");
  assert.deepEqual(lock.files, { "a.txt": sha("source a.txt"), "b.txt": sha("old b"), "new.txt": sha("source new.txt") });
});

test("--apply adds only the missing top-level config keys, each reported, none touched", () => {
  const { source, target } = fixture();
  const o = out();
  main([target, "--apply"], {}, { source, manifest: ["lanes.config.json"], print: o.print });
  assert.deepEqual(JSON.parse(get(target, "lanes.config.json")), { keep: "mine", added: { x: 2 }, extra: "d" });
  assert.ok(o.lines.includes("config added"));
  assert.ok(o.lines.includes("config extra"));
  assert.ok(!o.lines.includes("config keep"));
});

test("--apply with no missing config key leaves lanes.config.json byte for byte", () => {
  const { source, target } = fixture();
  put(target, "lanes.config.json", '{"keep":1,  "added":1,"extra":2}');
  main([target, "--apply"], {}, { source, manifest: [], print: () => {} });
  assert.equal(get(target, "lanes.config.json"), '{"keep":1,  "added":1,"extra":2}');
});

test("edge: --apply with a target without lanes.config.json creates nothing and does not crash", () => {
  const { source, target } = fixture();
  rmTarget(target, "lanes.config.json");
  assert.equal(main([target, "--apply"], {}, { source, manifest: [], print: () => {} }), 0);
  assert.equal(existsSync(path.join(target, "lanes.config.json")), false);
});

test("exit 2 inside Claude, and nothing is read", () => {
  const { source, target } = fixture();
  const o = out();
  assert.equal(main([target, "--apply"], { CLAUDECODE: "1" }, { source, manifest: ["new.txt"], print: o.print }), 2);
  assert.equal(o.lines.length, 1);
  assert.match(o.lines[0], /CLAUDECODE/);
  assert.equal(existsSync(path.join(target, "new.txt")), false);
});

test("exit 2 without a target argument, with an unknown flag, or with a missing directory", () => {
  const { source } = fixture();
  for (const argv of [[], ["--apply"], [source, "--bogus"], [path.join(source, "nope")]]) {
    const o = out();
    assert.equal(main(argv, {}, { source, manifest: [], print: o.print }), 2, argv.join(" "));
    assert.equal(o.lines.length, 1);
  }
});

test("exit 2 when the target has no lanes.lock.json", () => {
  const { source } = fixture();
  const bare = tmp();
  const o = out();
  assert.equal(main([bare], {}, { source, manifest: [], print: o.print }), 2);
  assert.match(o.lines[0], /lanes\.lock\.json/);
});

test("exit 2 when the lock does not validate, one line each", () => {
  const bad = [
    "not json",
    "[]",
    JSON.stringify({ version: "1.0" , files: {} }),
    JSON.stringify({ version: "1.0.0", files: { "a.txt": "XYZ" } }),
    JSON.stringify({ version: "1.0.0", files: {}, extra: 1 }),
    JSON.stringify({ version: "1.0.0" }),
    JSON.stringify({ version: "1.0.0", files: { "a.txt": sha("x").toUpperCase() } }),
  ];
  for (const text of bad) {
    const { source, target } = fixture();
    put(target, "lanes.lock.json", text);
    const o = out();
    assert.equal(main([target, "--apply"], {}, { source, manifest: ["new.txt"], print: o.print }), 2, text);
    assert.equal(o.lines.length, 1);
    assert.equal(existsSync(path.join(target, "new.txt")), false);
  }
});

test("a lock path that tries to escape the target is refused before anything is written", () => {
  const escapes = ["../evil.txt", "/abs.txt", "C:/x.txt", "a\\b.txt", "a/../../b.txt", "a/./b.txt", "a//b.txt", "a/", "a.", "a:b"];
  for (const p of escapes) {
    const { source, target } = fixture();
    put(target, "lanes.lock.json", JSON.stringify({ version: "0.1.0", files: { [p]: sha("x") } }));
    const o = out();
    assert.equal(main([target, "--apply"], {}, { source, manifest: ["new.txt"], print: o.print }), 2, p);
    assert.equal(existsSync(path.join(target, "new.txt")), false, p);
  }
});

test("a symlinked directory inside the target that points outside is never written through", (t) => {
  const { source, target } = fixture({ lockFiles: {} });
  const outside = tmp();
  try {
    symlinkSync(outside, path.join(target, "link"), "junction");
  } catch {
    return t.skip("cannot create a symlink here");
  }
  put(source, "link/f.txt", "payload");
  const o = out();
  assert.equal(main([target, "--apply"], {}, { source, manifest: ["link/f.txt"], print: o.print }), 2);
  assert.equal(existsSync(path.join(outside, "f.txt")), false);
});

test("edge: a directory at a managed path exits 2 with one line, not a stack trace", () => {
  const { source, target } = fixture({ lockFiles: { "dir.txt": sha("x") } });
  put(target, "dir.txt/inner", "x"); // dir.txt is a directory here
  const o = out();
  assert.equal(main([target], {}, { source, manifest: ["dir.txt"], print: o.print }), 2);
  assert.equal(o.lines.length, 1);
  assert.match(o.lines[0], /^upgrade failed/);
});

test("edge: a source config key named like an inherited property is still added", () => {
  const { source, target } = fixture();
  put(source, "lanes.config.json", '{"toString":1,"constructor":2}');
  main([target, "--apply"], {}, { source, manifest: [], print: () => {} });
  const cfg = JSON.parse(get(target, "lanes.config.json"));
  assert.equal(Object.hasOwn(cfg, "toString"), true);
  assert.equal(Object.hasOwn(cfg, "constructor"), true);
});

test("a managed file that is itself a link to a file outside the target is never written through", (t) => {
  const { source, target } = fixture({ lockFiles: {} });
  const outside = tmp();
  put(outside, "victim.txt", "outside");
  try {
    symlinkSync(path.join(outside, "victim.txt"), path.join(target, "f.txt"), "file");
  } catch {
    return t.skip("cannot create a file symlink here");
  }
  put(source, "f.txt", "payload");
  assert.equal(main([target, "--apply"], {}, { source, manifest: ["f.txt"], print: () => {} }), 2);
  assert.equal(get(outside, "victim.txt"), "outside");
});

test("edge: a config key the source has and the target has as null is not re-added", () => {
  const { source, target } = fixture();
  put(target, "lanes.config.json", '{"keep":null,"added":null,"extra":null}');
  main([target, "--apply"], {}, { source, manifest: [], print: () => {} });
  assert.equal(get(target, "lanes.config.json"), '{"keep":null,"added":null,"extra":null}');
});

test("readLock returns the parsed lock for a valid file", () => {
  const { target } = fixture();
  assert.equal(readLock(target).version, "0.1.0");
});

test("edge: an empty lock plan adds every manifest file and applies cleanly", () => {
  const { source, target } = fixture({ lockFiles: {} });
  const plan = planUpgrade(source, target, ["new.txt"]);
  assert.deepEqual(plan, [{ file: "new.txt", from: "new.txt", action: "add" }]);
  applyUpgrade(source, target, plan);
  assert.equal(get(target, "new.txt"), "source new.txt");
});

const SETTINGS = ".claude/settings.json";
const NOTICE = /remove the start-guard\.mjs hook from \.claude\/settings\.json and add the ADR 0030 deny rules/;
function settingsFixture(targetText, lockText) {
  const f = fixture({ manifest: [SETTINGS, "lanes.config.json"], lockFiles: lockText === undefined ? {} : { [SETTINGS]: sha(lockText) } });
  put(f.source, SETTINGS, "{}");
  if (targetText !== undefined) put(f.target, SETTINGS, targetText);
  return f;
}
const run = (f, argv) => {
  const o = out();
  main(argv, {}, { source: f.source, manifest: f.manifest, print: o.print });
  return o.lines;
};

test("a kept settings.json that still names start-guard.mjs gets one notice line, in a dry run and with --apply", () => {
  const edited = '{"hooks":{"x":"node scripts/lanes/start-guard.mjs"}}';
  for (const argv of [[], ["--apply"]]) {
    const f = settingsFixture(edited, "shipped");
    const lines = run(f, [f.target, ...argv]);
    assert.ok(lines.includes(`refuse ${SETTINGS}`));
    assert.equal(lines.filter((l) => NOTICE.test(l)).length, 1);
  }
});

test("a settings.json the lock does not track is kept too, so the notice shows", () => {
  const f = settingsFixture('{"a":"start-guard.mjs"}');
  assert.equal(run(f, [f.target]).filter((l) => NOTICE.test(l)).length, 1);
});

test("no notice for a kept settings.json that does not name the guard, an overwritten one, or none at all", () => {
  const kept = settingsFixture('{"hooks":{}}', "shipped");
  assert.equal(run(kept, [kept.target]).some((l) => NOTICE.test(l)), false);
  const text = '{"a":"start-guard.mjs"}';
  const replaced = settingsFixture(text, text); // unedited since install: overwritten by the shipped file
  const lines = run(replaced, [replaced.target]);
  assert.ok(lines.includes(`overwrite ${SETTINGS}`));
  assert.equal(lines.some((l) => NOTICE.test(l)), false);
  const missing = settingsFixture(undefined);
  assert.equal(run(missing, [missing.target]).some((l) => NOTICE.test(l)), false);
});
