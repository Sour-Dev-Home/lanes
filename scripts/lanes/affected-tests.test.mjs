import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { moduleOf } from "./modules.mjs";
import { affectedTests, main } from "./affected-tests.mjs";

const map = {
  entries: [
    { id: "lib", paths: ["scripts/lanes/lib."], imports: [] },
    { id: "gate", paths: ["scripts/lanes/gate."], imports: ["lib"] },
    { id: "queue", paths: ["scripts/lanes/queue."], imports: ["gate"] },
    { id: "other", paths: ["scripts/other."], imports: [] },
  ],
  allowCycles: [],
};
const config = { modules: map };
const FILES = [
  "scripts/lanes/lib.mjs", "scripts/lanes/lib.test.mjs",
  "scripts/lanes/gate.mjs", "scripts/lanes/gate.test.mjs",
  "scripts/lanes/queue.mjs", "scripts/lanes/queue.test.mjs",
  "scripts/other.mjs", "scripts/other.test.mjs",
];
const run = (changed, cfg = config, files = FILES) => affectedTests({ changed, config: cfg, files });

const io = (over = {}) => ({
  diff: () => "scripts/lanes/queue.mjs\0",
  readConfig: () => config,
  listFiles: () => FILES,
  ...over,
});

test("one module: its own test files", () => {
  assert.deepEqual(run(["scripts/other.mjs"]), ["scripts/other.test.mjs"]);
});

test("a changed test file selects its module's tests", () => {
  assert.deepEqual(run(["scripts/other.test.mjs"]), ["scripts/other.test.mjs"]);
});

test("transitive importers are included, sorted, once", () => {
  assert.deepEqual(run(["scripts/lanes/lib.mjs", "scripts/lanes/gate.mjs"]), [
    "scripts/lanes/gate.test.mjs", "scripts/lanes/lib.test.mjs", "scripts/lanes/queue.test.mjs",
  ]);
});

test("a leaf importer does not pull in what it imports", () => {
  assert.deepEqual(run(["scripts/lanes/queue.mjs"]), ["scripts/lanes/queue.test.mjs"]);
});

test("an unmapped file is ALL", () => {
  assert.equal(run(["scripts/other.mjs", "README.md"]), "ALL");
});

for (const path of [
  ".github/workflows/verify.yml", "contracts/a.schema.json", "package.json", "package-lock.json", "lanes.config.json",
  "scripts/lanes/shell-lex.fixtures.mjs", "scripts/test/helper.mjs", "scripts/__tests__/data.json", "test/fixtures/a.json",
]) {
  test(`ALL path class: ${path}`, () => {
    assert.equal(run(["scripts/other.mjs", path]), "ALL");
  });
}

// The class tests above use unmapped paths, which are ALL anyway; here every path IS mapped, so only the class rule forces ALL.
for (const path of [
  ".github/workflows/verify.yml", "contracts/a.schema.json", "package.json", "package-lock.json", "lanes.config.json",
  "scripts/a.fixtures.mjs", "scripts/test/helper.mjs", "scripts/__tests__/data.json", "scripts/tests/data.json",
]) {
  test(`ALL path class, even when mapped: ${path}`, () => {
    const paths = [".github/", "contracts/", "package", "lanes.config.", "scripts/", "scripts/other."];
    const cfg = { modules: { entries: [{ id: "all", paths, imports: [] }], allowCycles: [] } };
    assert.notEqual(moduleOf(path, cfg.modules), null);
    assert.equal(run([path], cfg, ["scripts/x.test.mjs"]), "ALL");
  });
}

test("a test file inside a test directory is not a helper", () => {
  const cfg = { modules: { entries: [{ id: "t", paths: ["test/"], imports: [] }], allowCycles: [] } };
  assert.deepEqual(run(["test/a.test.mjs"], cfg, ["test/a.test.mjs"]), ["test/a.test.mjs"]);
});

test("an empty change list is ALL", () => {
  assert.equal(run([]), "ALL");
});

test("a module with no test files is ALL", () => {
  assert.equal(run(["scripts/other.mjs"], config, ["scripts/other.mjs"]), "ALL");
});

test("edge: a malformed module map is ALL, never a throw", () => {
  assert.equal(run(["scripts/other.mjs"], { modules: { entries: "x" } }), "ALL");
  assert.equal(run(["scripts/other.mjs"], {}), "ALL");
  assert.equal(run(["scripts/other.mjs"], null), "ALL");
});

test("edge: an import cycle in the map terminates", () => {
  const cyc = { modules: { entries: [
    { id: "a", paths: ["a."], imports: ["b"] }, { id: "b", paths: ["b."], imports: ["a"] },
  ], allowCycles: [] } };
  assert.deepEqual(run(["a.mjs"], cyc, ["a.test.mjs", "b.test.mjs"]), ["a.test.mjs", "b.test.mjs"]);
});

test("edge: a changed path that only looks like a directory prefix is unmapped", () => {
  assert.equal(run(["scripts/lanes/libx.mjs"]), "ALL");
});

test("edge: a file under .github-like names elsewhere is not the .github class", () => {
  assert.deepEqual(run(["scripts/other.mjs"]), ["scripts/other.test.mjs"]);
});

test("ci.affectedTests false is ALL; a missing ci key means true", () => {
  assert.equal(run(["scripts/other.mjs"], { ...config, ci: { affectedTests: false } }), "ALL");
  assert.deepEqual(run(["scripts/other.mjs"], { ...config, ci: {} }), ["scripts/other.test.mjs"]);
  assert.deepEqual(run(["scripts/other.mjs"], { ...config, ci: { affectedTests: true } }), ["scripts/other.test.mjs"]);
});

test("main prints one test file per line", () => {
  assert.deepEqual(main(["origin/main"], io()), { code: 0, message: "scripts/lanes/queue.test.mjs" });
});

test("main passes the base ref to the diff", () => {
  let seen;
  main(["origin/main"], io({ diff: (b) => { seen = b; return "scripts/other.mjs\0"; } }));
  assert.equal(seen, "origin/main");
});

test("main: a failed diff is ALL", () => {
  const r = main(["origin/main"], io({ diff: () => { throw new Error("bad revision"); } }));
  assert.deepEqual(r, { code: 0, message: "ALL" });
});

test("main: an empty diff is ALL", () => {
  assert.deepEqual(main(["origin/main"], io({ diff: () => "" })), { code: 0, message: "ALL" });
});

test("main: ci.affectedTests false is ALL", () => {
  assert.equal(main(["origin/main"], io({ readConfig: () => ({ ...config, ci: { affectedTests: false } }) })).message, "ALL");
});

test("main: an unreadable config is ALL", () => {
  assert.equal(main(["origin/main"], io({ readConfig: () => { throw new Error("nope"); } })).message, "ALL");
});

test("main: a missing or option-shaped base ref is ALL, and never reaches git", () => {
  let called = false;
  const spy = io({ diff: () => { called = true; return ""; } });
  assert.equal(main([], spy).message, "ALL");
  assert.equal(main(["--output=x"], spy).message, "ALL");
  assert.equal(called, false);
});

test("edge: main splits on NUL, so a path with a space or newline stays one path", () => {
  assert.equal(main(["b"], io({ diff: () => "scripts/other.mjs\0\0" })).message, "scripts/other.test.mjs");
  assert.equal(main(["b"], io({ diff: () => "scripts/a b\nc.mjs\0" })).message, "ALL");
});

test("edge: a rename's old path is seen (both paths in the diff), so an old .github/ path forces ALL", () => {
  assert.equal(main(["b"], io({ diff: () => ".github/x.mjs\0scripts/other.mjs\0" })).message, "ALL");
});

test("edge: a mistyped ci.affectedTests switch fails safe to ALL", () => {
  for (const bad of ["false", "true", 0, 1, null, "", []]) {
    assert.equal(run(["scripts/other.mjs"], { ...config, ci: { affectedTests: bad } }), "ALL", JSON.stringify(bad));
  }
  for (const bad of [null, false, "x", 0, []]) {
    assert.equal(run(["scripts/other.mjs"], { ...config, ci: bad }), "ALL", JSON.stringify(bad));
  }
});

test("edge: a nested package.json forces ALL", () => {
  assert.equal(run(["scripts/other.mjs", "scripts/lanes/package.json"]), "ALL");
  assert.equal(run(["scripts/other.mjs", "sub/package-lock.json"]), "ALL");
});

test("lanes.config.json maps this script into the modules module", () => {
  const cfg = JSON.parse(readFileSync("lanes.config.json", "utf8"));
  assert.equal(moduleOf("scripts/lanes/affected-tests.mjs", cfg.modules), "modules");
  assert.equal(moduleOf("scripts/lanes/affected-tests.test.mjs", cfg.modules), "modules");
});

// #621: the PR job runs the affected files through npm, as the merge group does, so both see one environment.
test("verify.yml runs the affected tests through npm, and the full suite through npm test when none or ALL", () => {
  const workflow = readFileSync(".github/workflows/verify.yml", "utf8");
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  assert.ok(workflow.includes("npm run test:files -- $files"), "the affected files go through npm");
  assert.ok(!/^\s*node --test\b/m.test(workflow), "no bare node --test step is left");
  assert.match(workflow, /if \[ -z "\$files" \] \|\| \[ "\$files" = "ALL" \]; then\s+npm test\s+else/);
  assert.equal(pkg.scripts["test:files"], "node --test", "test:files takes the file arguments as given");
  assert.match(pkg.scripts.test, /^node --test /, "npm test still runs the whole suite");
});
