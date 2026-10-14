import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { main, parseArgs } from "./scope-tests.mjs";

const config = {
  modules: {
    entries: [
      { id: "a", paths: ["src/a."], imports: [] },
      { id: "b", paths: ["src/b."], imports: ["a"] },
      { id: "c", paths: ["src/c."], imports: [] },
    ],
  },
};
const files = ["src/a.mjs", "src/a.test.mjs", "src/b.test.mjs", "src/c.test.mjs", "src/c.fixtures.json", "README.md"];
const contents = {
  "src/a.test.mjs": "import './a.mjs';",
  "src/b.test.mjs": "check(`node --test $files`)",
  "src/c.test.mjs": "nothing here",
  "src/c.fixtures.json": '{"x":"Node --test"}',
  "README.md": "node --test $files",
};
const io = { readConfig: () => config, tracked: () => files, readFile: (f) => contents[f] ?? "" };
const run = (...argv) => main(argv, io);

test("--paths lists the tests of the owning module and of its importers, with the path as reason", () => {
  const r = run("--paths", "src/a.mjs");
  assert.equal(r.code, 0);
  assert.equal(r.message, "src/a.test.mjs: affected by src/a.mjs\nsrc/b.test.mjs: affected by src/a.mjs");
});

test("--strings finds a test that does not import the changed file (the #621 case)", () => {
  const r = run("--paths", "src/c.mjs", "--strings", "node --test $files");
  assert.equal(r.code, 0);
  assert.equal(r.message, 'src/b.test.mjs: contains "node --test $files"\nsrc/c.test.mjs: affected by src/c.mjs');
});

test("--strings searches only tests and fixtures, and is literal and case-sensitive", () => {
  const r = run("--strings", "node --test");
  assert.equal(r.message, 'src/b.test.mjs: contains "node --test"');
  assert.equal(run("--strings", "Node --test").message, 'src/c.fixtures.json: contains "Node --test"');
  assert.equal(run("--strings", "node.--test").message, "");
});

test("edge: one file hit twice prints one line with both reasons", () => {
  const r = run("--paths", "src/a.mjs", "--strings", "import");
  assert.match(r.message, /^src\/a\.test\.mjs: affected by src\/a\.mjs, contains "import"$/m);
});

test("edge: a Windows-style path is matched as forward slashes, the reason keeps the path as given", () => {
  const r = run("--paths", "src\\a.mjs");
  assert.equal(r.message, "src/a.test.mjs: affected by src\\a.mjs\nsrc/b.test.mjs: affected by src\\a.mjs");
});

test("no hits prints nothing and exits 0", () => {
  assert.deepEqual(run("--paths", "src/c.mjs", "--strings", "zzz-none").message.split("\n").length, 1);
  assert.deepEqual(run("--paths", "docs/unmapped.md", "--strings", "zzz-none"), { code: 0, message: "" });
});

test("edge: an unmapped path (affectedTests says ALL) prints nothing for it", () => {
  assert.deepEqual(run("--paths", "elsewhere/x.mjs"), { code: 0, message: "" });
});

const mapped = { modules: { entries: [{ id: "lanes", paths: ["scripts/lanes/"], imports: [] }] } };
const newIo = { ...io, readConfig: () => mapped };
const runNew = (...argv) => main(argv, newIo);
const CHECK = "(check for the planner)";

test("--new: a scripts path inside a module prefix gets only the two check lines", () => {
  const r = runNew("--new", "scripts/lanes/foo.mjs");
  assert.equal(r.code, 0);
  assert.equal(
    r.message,
    `new scripts/lanes/foo.mjs: vendor/owasp-cheatsheets/INDEX.md if it imports node:child_process ${CHECK}\n` +
      `new scripts/lanes/foo.mjs: .github/CODEOWNERS if queue.mjs will load it ${CHECK}`,
  );
});

test("--new: a scripts path outside every module prefix also names lanes.config.json", () => {
  const r = runNew("--new", "scripts/other/foo.mjs");
  assert.equal(r.message.split("\n")[0], "new scripts/other/foo.mjs: lanes.config.json");
  assert.equal(r.message.split("\n").length, 3);
});

test("edge: --new with no module map in the config skips the lanes.config.json line", () => {
  const r = main(["--new", "scripts/x.mjs"], { ...io, readConfig: () => ({}) });
  assert.doesNotMatch(r.message, /lanes\.config\.json/);
});

test("edge: --new ignores a path that is not a scripts .mjs file", () => {
  assert.deepEqual(runNew("--new", "docs/new.md", "src/x.mjs"), { code: 0, message: "" });
});

test("--paths on a doc lists the tests that read it, by full path and by file name", () => {
  const docFiles = [...files, "scripts/lanes/a.test.mjs", "scripts/lanes/b.test.mjs", "scripts/lanes/c.test.mjs"];
  const docContents = { ...contents, "scripts/lanes/a.test.mjs": "read('docs/USING.md')", "scripts/lanes/b.test.mjs": "join(dir, 'USING.md')", "scripts/lanes/c.test.mjs": "none" };
  const r = main(["--paths", "docs/USING.md"], { ...io, tracked: () => docFiles, readFile: (f) => docContents[f] ?? "" });
  assert.equal(r.message, "scripts/lanes/a.test.mjs: reads docs/USING.md\nscripts/lanes/b.test.mjs: reads docs/USING.md");
});

test("a doc read by no test prints nothing", () => {
  assert.deepEqual(run("--paths", "docs/NOBODY.md"), { code: 0, message: "" });
});

test("edge: a doc search covers tests only, not other files that mention the doc", () => {
  const r = main(["--paths", "README.md"], { ...io, readFile: () => "README.md" });
  assert.doesNotMatch(r.message, /^README\.md:/m);
});

test("bad arguments exit 2: none, unknown flag, value before a flag, flag without value, empty value", () => {
  for (const argv of [[], ["--bogus", "x"], ["src/a.mjs"], ["--paths"], ["--strings"], ["--new"], ["--new", ""], ["--paths", ""], ["--paths", "--strings", "x"]]) {
    assert.equal(run(...argv).code, 2, JSON.stringify(argv));
  }
  assert.equal(parseArgs(["--strings", "x", "--paths", "p"]).paths[0], "p");
});

test("edge: a failing file listing exits 2", () => {
  const r = main(["--paths", "x"], { ...io, tracked: () => { throw new Error("no git"); } });
  assert.equal(r.code, 2);
});

test("CLI: exit 2 on bad arguments, exit 0 on a real lookup", () => {
  let err;
  try { execFileSync("node", ["scripts/lanes/scope-tests.mjs"], { stdio: "pipe", windowsHide: true }); } catch (e) { err = e; }
  assert.equal(err.status, 2);
  const out = execFileSync("node", ["scripts/lanes/scope-tests.mjs", "--strings", "plan-issues.md step 5"], { encoding: "utf8", windowsHide: true });
  assert.match(out, /workflow\.test\.mjs/);
});
