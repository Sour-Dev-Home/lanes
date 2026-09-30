// scripts/lanes/modules.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkModules, importSpecifiers, listFiles, main, MAX_CYCLES, MAX_STEPS, moduleOf, reviewersFor } from "./modules.mjs";

// Fixture sources are built with `q` so this file's own text never holds a literal `from "./..."` import it doesn't make.
const q = (s) => JSON.stringify(s);
const imp = (spec) => `import { x } from ${q(spec)};\n`;

const map = {
  entries: [
    { id: "core", paths: ["src/core/"], imports: [] },
    { id: "app", paths: ["src/app/"], imports: ["core"] },
  ],
};

test("an import the map allows is not a violation", () => {
  const files = { "src/app/a.mjs": imp("../core/c.mjs"), "src/core/c.mjs": "" };
  assert.deepEqual(checkModules({ map, files }), { violations: [], cycles: [], allowedCycles: [], unmapped: [] });
});

test("an import across a boundary the map does not allow is a violation", () => {
  const files = { "src/core/c.mjs": imp("../app/a.mjs"), "src/app/a.mjs": "" };
  assert.deepEqual(checkModules({ map, files }).violations, [
    { from: "src/core/c.mjs", to: "src/app/a.mjs", fromModule: "core", toModule: "app" },
  ]);
});

test("imports inside one module are always allowed", () => {
  const files = { "src/core/a.mjs": imp("./b.mjs"), "src/core/b.mjs": "" };
  assert.deepEqual(checkModules({ map, files }).violations, []);
});

test("a two-file cycle is reported once", () => {
  const files = { "src/core/b.mjs": imp("./a.mjs"), "src/core/a.mjs": imp("./b.mjs") };
  assert.deepEqual(checkModules({ map, files }).cycles, [["src/core/a.mjs", "src/core/b.mjs"]]);
});

test("a three-file cycle is reported once, in import order", () => {
  const files = {
    "src/core/a.mjs": imp("./c.mjs"),
    "src/core/c.mjs": imp("./b.mjs"),
    "src/core/b.mjs": imp("./a.mjs"),
  };
  assert.deepEqual(checkModules({ map, files }).cycles, [["src/core/a.mjs", "src/core/c.mjs", "src/core/b.mjs"]]);
});

test("a cycle in allowCycles goes to allowedCycles, never to cycles, whatever order it is listed in", () => {
  const files = { "src/core/a.mjs": imp("./b.mjs"), "src/core/b.mjs": imp("./a.mjs") };
  const result = checkModules({ map: { ...map, allowCycles: [["src/core/b.mjs", "src/core/a.mjs"]] }, files });
  assert.deepEqual(result.cycles, []);
  assert.deepEqual(result.allowedCycles, [["src/core/a.mjs", "src/core/b.mjs"]]);
});

test("a new cycle through an allow-listed pair is still reported", () => {
  const files = {
    "src/core/a.mjs": imp("./b.mjs"),
    "src/core/b.mjs": imp("./a.mjs") + imp("./c.mjs"),
    "src/core/c.mjs": imp("./a.mjs"),
  };
  const result = checkModules({ map: { ...map, allowCycles: [["src/core/a.mjs", "src/core/b.mjs"]] }, files });
  assert.deepEqual(result.allowedCycles, [["src/core/a.mjs", "src/core/b.mjs"]]);
  assert.deepEqual(result.cycles, [["src/core/a.mjs", "src/core/b.mjs", "src/core/c.mjs"]]);
});

test("a dynamic import with a string literal is an edge", () => {
  const files = { "src/core/c.mjs": `const m = await import(${q("../app/a.mjs")});\n`, "src/app/a.mjs": "" };
  assert.deepEqual(checkModules({ map, files }).violations.map((v) => v.to), ["src/app/a.mjs"]);
});

test("re-exports and side-effect imports are edges", () => {
  const src = `export { a } from ${q("./a.mjs")};\nexport * from ${q("./b.mjs")};\nimport ${q("./c.mjs")};\n`;
  assert.deepEqual(importSpecifiers(src), ["./a.mjs", "./b.mjs", "./c.mjs"]);
});

test("a file under no module's path is unmapped", () => {
  const files = { "src/other/o.mjs": "", "src/core/c.mjs": "" };
  assert.deepEqual(checkModules({ map, files }).unmapped, ["src/other/o.mjs"]);
});

test("checkModules reads nothing from disk: a missing target is judged by its path alone", () => {
  const files = { "src/core/c.mjs": imp("../app/missing.mjs") };
  assert.deepEqual(checkModules({ map, files }).violations, [
    { from: "src/core/c.mjs", to: "src/app/missing.mjs", fromModule: "core", toModule: "app" },
  ]);
});

// ---- edge cases -------------------------------------------------------------------------------------------------

test("edge: bare and absolute specifiers are ignored", () => {
  assert.deepEqual(importSpecifiers(`import a from ${q("node:fs")};\nimport b from ${q("/abs/x.mjs")};\n`), []);
});

test("edge: a dynamic import of a non-literal is ignored", () => {
  assert.deepEqual(importSpecifiers("const m = await import(name);\nimport(`./t${x}.mjs`);\n"), []);
});

test("edge: import text inside strings, templates, comments and regexes is not an edge", () => {
  const src = [
    `const s = 'import x from "./s.mjs"';`,
    "const t = `export * from './t.mjs'`;",
    `// import x from "./line.mjs"`,
    `/* import(${q("./block.mjs")}) */`,
    `const re = /from ["']\\.\\/re\\.mjs["']/;`,
    `import real from ${q("./real.mjs")};`,
  ].join("\n");
  assert.deepEqual(importSpecifiers(src), ["./real.mjs"]);
});

test("edge: a regex literal right after a control-flow `)` is not read as division", () => {
  const src = [
    `if (check) /from ${q("./fake.mjs")}/.test(s);`,
    `while (more()) /export \\* from ${q("./loop.mjs")}/.test(s);`,
    `import real from ${q("./real.mjs")};`,
  ].join("\n");
  assert.deepEqual(importSpecifiers(src), ["./real.mjs"]);
});

test("edge: a multi-line import and single-quoted specifiers are read", () => {
  const src = "import {\n  a,\n  b,\n} from './m.mjs';\nexport {\n  c } from '../n.mjs'\n";
  assert.deepEqual(importSpecifiers(src), ["./m.mjs", "../n.mjs"]);
});

test("edge: a method or property named from/import is not an import", () => {
  assert.deepEqual(importSpecifiers(`Array.from(${q("./a.mjs")});\nobj.import(${q("./b.mjs")});\n`), []);
});

test("edge: an import resolving outside every module is a violation with toModule null", () => {
  const files = { "src/core/c.mjs": imp("../../lib/x.mjs") };
  assert.deepEqual(checkModules({ map, files }).violations, [
    { from: "src/core/c.mjs", to: "lib/x.mjs", fromModule: "core", toModule: null },
  ]);
});

test("edge: an unmapped file's imports are not violations but still form cycles", () => {
  const files = { "src/x/a.mjs": imp("../core/c.mjs"), "src/core/c.mjs": imp("../x/a.mjs") };
  const result = checkModules({ map, files });
  assert.deepEqual(result.unmapped, ["src/x/a.mjs"]);
  assert.deepEqual(result.violations.map((v) => v.from), ["src/core/c.mjs"]);
  assert.deepEqual(result.cycles, [["src/core/c.mjs", "src/x/a.mjs"]]);
});

test("edge: a file importing itself is a one-file cycle", () => {
  assert.deepEqual(checkModules({ map, files: { "src/core/a.mjs": imp("./a.mjs") } }).cycles, [["src/core/a.mjs"]]);
});

test("edge: the longest matching path prefix decides a file's module", () => {
  const nested = { entries: [{ id: "outer", paths: ["src/"], imports: [] }, { id: "inner", paths: ["src/in/"], imports: ["outer"] }] };
  const files = { "src/in/a.mjs": imp("../b.mjs"), "src/b.mjs": "" };
  assert.deepEqual(checkModules({ map: nested, files }).violations, []);
});

test("edge: a repeated import is one edge, reported once", () => {
  const files = { "src/core/c.mjs": imp("../app/a.mjs") + imp("../app/./a.mjs"), "src/app/a.mjs": "" };
  assert.equal(checkModules({ map, files }).violations.length, 1);
});

test("edge: an empty file set is a clean report", () => {
  assert.deepEqual(checkModules({ map, files: {} }), { violations: [], cycles: [], allowedCycles: [], unmapped: [] });
});

test("edge: a malformed map is refused with the reason", () => {
  const bad = [
    [null, /modules must be an object/],
    [{}, /modules\.entries must be an array/],
    [{ entries: [{ id: "a", paths: "src/", imports: [] }] }, /paths must be a non-empty array/],
    [{ entries: [{ id: "a", paths: ["src/"] }] }, /imports must be an array/],
    [{ entries: [{ id: "a", paths: ["src/"], imports: ["nope"] }] }, /unknown module "nope"/],
    [{ entries: [{ id: "a", paths: ["x/"], imports: [] }, { id: "a", paths: ["y/"], imports: [] }] }, /duplicate module id "a"/],
    [{ entries: [], allowCycles: ["a.mjs"] }, /allowCycles must be an array of file arrays/],
  ];
  for (const [m, re] of bad) assert.throws(() => checkModules({ map: m, files: {} }), re);
});

test("edge: a path prefix outside the repo is refused", () => {
  for (const p of ["/etc/", "../up/", "src/../../x/", "D:/x/","src\\core\\"]) {
    const m = { entries: [{ id: "a", paths: [p], imports: [] }] };
    assert.throws(() => checkModules({ map: m, files: {} }), /must be repo-relative/, p);
  }
});

test("edge: a graph with too many cycles is refused rather than enumerated", () => {
  // 12 files each importing every other: far more than MAX_CYCLES elementary cycles.
  const names = Array.from({ length: 12 }, (_, k) => `src/core/f${String(k).padStart(2, "0")}.mjs`);
  const files = Object.fromEntries(names.map((f) => [f, names.filter((g) => g !== f).map((g) => imp(`./${g.slice(9)}`)).join("")]));
  assert.throws(() => checkModules({ map, files }), new RegExp(`more than ${MAX_CYCLES} import cycles|over ${MAX_STEPS} steps`));
});

test("edge: a large acyclic graph with exponentially many paths is cheap, not refused", () => {
  // 60 files, each importing every later one: ~2^59 paths, no cycles. Only strongly connected files are walked.
  const names = Array.from({ length: 60 }, (_, k) => `src/core/f${String(k).padStart(2, "0")}.mjs`);
  const files = Object.fromEntries(names.map((f, k) => [f, names.slice(k + 1).map((g) => imp(`./${g.slice(9)}`)).join("")]));
  assert.deepEqual(checkModules({ map, files }).cycles, []);
});

test("edge: a 20,000-file import chain does not overflow the stack", () => {
  const names = Array.from({ length: 20000 }, (_, k) => `src/core/f${k}.mjs`);
  const files = Object.fromEntries(names.map((f, k) => [f, k + 1 < names.length ? imp(`./f${k + 1}.mjs`) : ""]));
  assert.deepEqual(checkModules({ map, files }).cycles, []);
});

test("edge: listFiles walks subdirectories but never follows a symlink or junction", (t) => {
  const root = mkdtempSync(join(tmpdir(), "modules-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const inside = join(root, "repo");
  const outside = join(root, "outside");
  mkdirSync(join(inside, "sub"), { recursive: true });
  mkdirSync(join(inside, "node_modules"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(inside, "a.mjs"), "");
  writeFileSync(join(inside, "sub", "b.mjs"), "");
  writeFileSync(join(inside, "node_modules", "dep.mjs"), "");
  writeFileSync(join(outside, "secret.mjs"), "");
  symlinkSync(outside, join(inside, "linked"), "junction");
  const dir = inside.replaceAll("\\", "/");
  assert.deepEqual(listFiles(`${dir}/`).map((f) => f.slice(dir.length + 1)).sort(), ["a.mjs", "sub/b.mjs"]);
  assert.deepEqual(listFiles(`${dir}/missing/`), []);
});

// ---- main -------------------------------------------------------------------------------------------------------

/** A fake disk: `tree` maps repo-relative paths to contents; `config` is the parsed lanes.config.json. */
function fakeIo(config, tree = {}) {
  return {
    readConfig: () => config,
    listFiles: (dir) => Object.keys(tree).filter((f) => f.startsWith(dir)),
    readFile: (f) => tree[f],
  };
}

test("main: no modules key prints `no module map configured` and exits 0", () => {
  assert.deepEqual(main(fakeIo({ requiredChecks: ["verify"] })), { code: 0, message: "no module map configured" });
});

test("main: a clean map exits 0 and still lists allowed cycles", () => {
  const tree = { "src/core/a.mjs": imp("./b.mjs"), "src/core/b.mjs": imp("./a.mjs") };
  const { code, message } = main(fakeIo({ modules: { ...map, allowCycles: [["src/core/a.mjs", "src/core/b.mjs"]] } }, tree));
  assert.equal(code, 0);
  assert.match(message, /allowed cycle: src\/core\/a\.mjs -> src\/core\/b\.mjs -> src\/core\/a\.mjs/);
});

test("main: a violation exits 1 and names it", () => {
  const { code, message } = main(fakeIo({ modules: map }, { "src/core/c.mjs": imp("../app/a.mjs"), "src/app/a.mjs": "" }));
  assert.equal(code, 1);
  assert.match(message, /violation: src\/core\/c\.mjs -> src\/app\/a\.mjs \(core may not import app\)/);
});

test("main: an unallowed cycle exits 1", () => {
  const { code, message } = main(fakeIo({ modules: map }, { "src/core/a.mjs": imp("./b.mjs"), "src/core/b.mjs": imp("./a.mjs") }));
  assert.equal(code, 1);
  assert.match(message, /^cycle: src\/core\/a\.mjs -> src\/core\/b\.mjs -> src\/core\/a\.mjs$/m);
});

test("main: an unmapped file beside a mapped path exits 1", () => {
  const one = { entries: [{ id: "core", paths: ["src/core/a"], imports: [] }] };
  const { code, message } = main(fakeIo({ modules: one }, { "src/core/a.mjs": "", "src/core/new.mjs": "" }));
  assert.equal(code, 1);
  assert.match(message, /unmapped: src\/core\/new\.mjs/);
});

test("edge: main scans only source files", () => {
  const tree = { "src/core/a.mjs": "", "src/core/notes.md": imp("../app/a.mjs"), "src/core/data.json": "{}" };
  assert.equal(main(fakeIo({ modules: map }, tree)).code, 0);
});

test("edge: main refuses a malformed map with exit 2", () => {
  const { code, message } = main(fakeIo({ modules: { entries: "x" } }));
  assert.equal(code, 2);
  assert.match(message, /^modules: .*entries must be an array/);
});

test("edge: main reports an unreadable lanes.config.json with exit 2", () => {
  const io = { ...fakeIo({}), readConfig: () => { throw new Error("ENOENT"); } };
  const { code, message } = main(io);
  assert.equal(code, 2);
  assert.match(message, /cannot read lanes\.config\.json: ENOENT/);
});

// ---- #127 / ADR 0008: lanes' own module map, checked against the repository itself ----
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const realConfig = () => JSON.parse(readFileSync(join(repoRoot, "lanes.config.json"), "utf8"));

// listFiles and main read paths relative to the working directory, so run them from the repository root.
function inRepo(fn) {
  const prev = process.cwd();
  process.chdir(repoRoot);
  try { return fn(); } finally { process.chdir(prev); }
}

const repoFiles = () => inRepo(() => Object.fromEntries(
  listFiles("scripts/").filter((f) => f.endsWith(".mjs")).map((f) => [f, readFileSync(f, "utf8")]),
));

test("the repository's module map has no violation, unallowed cycle or unmapped file", () => {
  const { code, message } = inRepo(() => main());
  assert.equal(code, 0, message);
  assert.doesNotMatch(message, /no module map configured/);
  assert.match(message, /, 0 violations, 0 cycles \(0 allowed\), 0 unmapped$/m);
});

test("the map claims every non-test file in scripts/lanes/ and scripts/preflight.mjs", () => {
  const files = repoFiles();
  const sourceFiles = Object.fromEntries(Object.entries(files).filter(([f]) => !f.endsWith(".test.mjs")));
  const sources = Object.keys(sourceFiles).filter((f) => f.startsWith("scripts/lanes/") || f === "scripts/preflight.mjs");
  assert.ok(sources.includes("scripts/preflight.mjs") && sources.includes("scripts/lanes/modules.mjs"), "the scan found the expected sources");
  const { unmapped } = checkModules({ map: realConfig().modules, files: sourceFiles });
  assert.deepEqual(unmapped, []);
});

test("the map claims the vendor.* prefix in a module that imports nothing", () => {
  const entry = realConfig().modules.entries.find((e) => e.paths.includes("scripts/lanes/vendor."));
  assert.ok(entry, "an entry claims the scripts/lanes/vendor. prefix");
  assert.deepEqual(entry.imports, []);
});

test("edge: a vendor.test.mjs that imports only node: built-ins is mapped and violates nothing", () => {
  const files = { ...repoFiles(), "scripts/lanes/vendor.test.mjs": imp("node:test") + imp("node:fs") };
  const r = checkModules({ map: realConfig().modules, files });
  assert.deepEqual(r.unmapped, []);
  assert.deepEqual(r.violations, []);
});

test("edge: a vendor.* file that imports a lanes module is a violation (imports: [] is enforced)", () => {
  const files = { ...repoFiles(), "scripts/lanes/vendor.test.mjs": imp("node:test") + imp("./lib.mjs") };
  const r = checkModules({ map: realConfig().modules, files });
  assert.ok(r.violations.length > 0, "importing ./lib.mjs from the vendor module is reported");
});

test("edge: the real map passes on a tree with no vendor.* file (a prefix that matches nothing is not an error)", () => {
  const files = Object.fromEntries(Object.entries(repoFiles()).filter(([f]) => !f.startsWith("scripts/lanes/vendor.")));
  const r = checkModules({ map: realConfig().modules, files });
  assert.deepEqual([r.unmapped, r.violations, r.cycles], [[], [], []]);
});

test("allowCycles is empty, and the graph has no cycle at all (pick.mjs and status.mjs no longer import each other)", () => {
  const { modules } = realConfig();
  assert.deepEqual(modules.allowCycles, []);
  const r = checkModules({ map: modules, files: repoFiles() });
  assert.deepEqual(r.allowedCycles, []);
  assert.deepEqual(r.cycles, []);
  assert.deepEqual(r.violations, []);
});

test("edge: a file in a mapped directory that no module claims is reported unmapped", () => {
  const files = { ...repoFiles(), "scripts/lanes/brand-new.mjs": "" };
  assert.deepEqual(checkModules({ map: realConfig().modules, files }).unmapped, ["scripts/lanes/brand-new.mjs"]);
});

test("edge: an import across a boundary the map does not allow is a violation", () => {
  const files = repoFiles();
  files["scripts/lanes/modules.mjs"] += imp("./lib.mjs");
  const r = checkModules({ map: realConfig().modules, files });
  assert.deepEqual(r.violations.map((v) => `${v.from} -> ${v.to}`), ["scripts/lanes/modules.mjs -> scripts/lanes/lib.mjs"]);
});

test("edge: a new import cycle is reported", () => {
  const files = repoFiles();
  files["scripts/lanes/lib.mjs"] += imp("./blockers.mjs");
  const r = checkModules({ map: realConfig().modules, files });
  assert.equal(r.cycles.length, 1);
  assert.ok(r.cycles[0].includes("scripts/lanes/lib.mjs") && r.cycles[0].includes("scripts/lanes/blockers.mjs"));
  assert.equal(r.allowedCycles.length, 0);
});

test("edge: main on the real map exits 1 and names a stray file that no module claims", () => {
  const files = { ...repoFiles(), "scripts/lanes/stray.mjs": "" };
  const io = { readConfig: realConfig, listFiles: (dir) => Object.keys(files).filter((f) => f.startsWith(dir)), readFile: (f) => files[f] };
  const { code, message } = main(io);
  assert.equal(code, 1);
  assert.match(message, /^unmapped: scripts\/lanes\/stray\.mjs$/m);
});

test("moduleOf returns the id of the module whose path prefix matches, or null for no module", () => {
  assert.equal(moduleOf("src/app/a.mjs", map), "app");
  assert.equal(moduleOf("src/core/deep/c.mjs", map), "core");
  assert.equal(moduleOf("README.md", map), null);
});

test("edge: moduleOf picks the longest matching prefix and matches nothing for an empty path", () => {
  const nested = { entries: [{ id: "outer", paths: ["src/"], imports: [] }, { id: "inner", paths: ["src/core/"], imports: [] }] };
  assert.equal(moduleOf("src/core/x.mjs", nested), "inner");
  assert.equal(moduleOf("src/other.mjs", nested), "outer");
  assert.equal(moduleOf("", nested), null);
});

test("edge: moduleOf refuses a malformed map with the reason, like checkModules", () => {
  assert.throws(() => moduleOf("src/a.mjs", { entries: "no" }), /entries must be an array/);
  assert.throws(() => moduleOf("src/a.mjs", null), /must be an object/);
});

test("edge: moduleOf gives the module lanes.config.json assigns to a real file", () => {
  const config = JSON.parse(readFileSync("lanes.config.json", "utf8"));
  assert.equal(moduleOf("scripts/lanes/modules.mjs", config.modules), "modules");
  assert.equal(moduleOf("scripts/lanes/lessons.mjs", config.modules), "lessons");
});

// --- Optional per-entry fields and the schema file (ADR 0018, #461) ---
const entry = (extra) => ({ entries: [{ id: "a", paths: ["src/a/"], imports: [], ...extra }] });
const schema = JSON.parse(readFileSync(new URL("../../contracts/module-map.schema.json", import.meta.url), "utf8"));
const config = JSON.parse(readFileSync("lanes.config.json", "utf8"));
const FIELDS = { reviewers: ["security-reviewer"], contracts: ["contracts/"], owner: true, risk: "sensitive", test: "node --test" };

test("each new field is accepted with a valid value", () => {
  for (const [k, v] of Object.entries(FIELDS)) assert.equal(moduleOf("src/a/x.mjs", entry({ [k]: v })), "a", k);
  assert.equal(moduleOf("src/a/x.mjs", entry(FIELDS)), "a");
  assert.equal(moduleOf("src/a/x.mjs", entry({ risk: "normal" })), "a");
});

test("a wrong type, unknown key or bad risk is rejected with an error naming the entry", () => {
  const bad = [
    { reviewers: "security-reviewer" }, { reviewers: [1] }, { contracts: "c" }, { contracts: [""] }, { contracts: ["../x"] }, { contracts: ["/x"] }, { contracts: ["a\\b"] }, { owner: "yes" },
    { risk: "high" }, { risk: true }, { test: 3 }, { test: "" }, { tset: "x" },
  ];
  for (const extra of bad) assert.throws(() => moduleOf("src/a/x.mjs", entry(extra)), /entries\[0\]/, JSON.stringify(extra));
  assert.throws(() => moduleOf("x", { ...entry({}), extras: 1 }), /unknown key "extras"/);
});

test("a reviewer name must match the pattern, not be owner, and have an agent file", () => {
  for (const name of ["Bad", "1x", "a b", "owner", "no-such-reviewer", "../x"]) {
    assert.throws(() => moduleOf("src/a/x.mjs", entry({ reviewers: [name] })), /entries\[0\].*reviewers/, name);
  }
  assert.equal(moduleOf("src/a/x.mjs", entry({ reviewers: ["test-hunter", "ui-reviewer"] })), "a");
});

test("edge: owner is refused as a reviewer even when an owner.md agent file exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "mm-owner-"));
  const cwd = process.cwd();
  try {
    mkdirSync(join(dir, ".claude", "agents"), { recursive: true });
    writeFileSync(join(dir, ".claude", "agents", "owner.md"), "x");
    process.chdir(dir);
    assert.throws(() => moduleOf("src/a/x.mjs", entry({ reviewers: ["owner"] })), /entries\[0\].*owner/);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reviewersFor returns the sorted union of reviewers of modules containing the files", () => {
  const m = { entries: [
    { id: "a", paths: ["src/a/"], imports: [], reviewers: ["ui-reviewer", "test-hunter"] },
    { id: "b", paths: ["src/b/"], imports: [], reviewers: ["test-hunter", "security-reviewer"] },
    { id: "c", paths: ["src/c/"], imports: [] },
  ] };
  assert.deepEqual(reviewersFor(["src/a/x.mjs", "src/b/y.mjs", "src/c/z.mjs", "other"], m), ["security-reviewer", "test-hunter", "ui-reviewer"]);
  assert.deepEqual(reviewersFor(["src/c/z.mjs"], m), []);
  assert.deepEqual(reviewersFor(["nowhere"], m), []);
});

test("edge: reviewersFor counts every module with a matching prefix, not only the longest", () => {
  const m = { entries: [
    { id: "outer", paths: ["src/"], imports: [], reviewers: ["ui-reviewer"] },
    { id: "inner", paths: ["src/core/"], imports: [], reviewers: ["test-hunter"] },
  ] };
  assert.deepEqual(reviewersFor(["src/core/x.mjs"], m), ["test-hunter", "ui-reviewer"]);
  assert.deepEqual(reviewersFor(["src/other.mjs"], m), ["ui-reviewer"]);
});

test("edge: reviewersFor gives [] with no map, no files, or a map without the field", () => {
  assert.deepEqual(reviewersFor(["src/a/x.mjs"], undefined), []);
  assert.deepEqual(reviewersFor(["src/a/x.mjs"], null), []);
  assert.deepEqual(reviewersFor([], entry({ reviewers: ["test-hunter"] })), []);
  assert.deepEqual(reviewersFor(["src/a/x.mjs"], config.modules), []);
});

test("edge: reviewersFor refuses a malformed map", () => {
  assert.throws(() => reviewersFor(["x"], { entries: "no" }), /entries must be an array/);
});

test("the schema has no key that removes a reviewer", () => {
  const props = Object.keys(schema.$defs.entry.properties);
  assert.deepEqual([...props].sort(), ["contracts", "id", "imports", "owner", "paths", "reviewers", "risk", "test"]);
  assert.equal(schema.$defs.entry.additionalProperties, false);
  assert.equal(schema.additionalProperties, false);
  assert.ok(!props.some((p) => /remove|except|skip|disable|without/i.test(p)));
});

// A checker for the subset of JSON Schema the map schema uses, so the two definitions are compared by behaviour.
function conforms(v, s, root = schema) {
  if (s.$ref) return conforms(v, s.$ref.split("/").slice(1).reduce((o, k) => o[k], root), root);
  if (s.enum && !s.enum.includes(v)) return false;
  switch (s.type) {
    case "string": return typeof v === "string" && (s.minLength === undefined || v.length >= s.minLength) && (!s.pattern || new RegExp(s.pattern).test(v));
    case "boolean": return typeof v === "boolean";
    case "array": return Array.isArray(v) && (s.minItems === undefined || v.length >= s.minItems) && v.every((x) => conforms(x, s.items, root));
    case "object": {
      if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
      if ((s.required ?? []).some((k) => !(k in v))) return false;
      return Object.entries(v).every(([k, x]) => s.properties?.[k] ? conforms(x, s.properties[k], root) : s.additionalProperties !== false);
    }
    default: return true;
  }
}
const accepts = (m) => { try { moduleOf("x", m); return true; } catch { return false; } };

test("the schema and the validator agree: every schema property is accepted, and every accepted key is in the schema", () => {
  for (const [k, v] of Object.entries(FIELDS)) {
    assert.ok(k in schema.$defs.entry.properties, `${k} in schema`);
    assert.ok(conforms(entry({ [k]: v }), schema) && accepts(entry({ [k]: v })), `${k} valid`);
  }
  for (const k of Object.keys(schema.$defs.entry.properties)) assert.ok(k in FIELDS || ["id", "paths", "imports"].includes(k), `${k} has a sample`);
  assert.deepEqual(Object.keys(schema.properties).sort(), ["allowCycles", "entries"]);
  // A key the validator accepts but the schema lacks would make the schema reject a valid map.
  assert.ok(conforms(config.modules, schema) && accepts(config.modules));
});

test("the schema and the validator agree on invalid samples", () => {
  const samples = [
    entry({ reviewers: "x" }), entry({ reviewers: ["Bad"] }), entry({ contracts: [""] }), entry({ owner: 1 }), entry({ risk: "high" }),
    entry({ test: 1 }), entry({ test: "" }), entry({ unknown: 1 }), { ...entry({}), extras: 1 }, { entries: "no" },
    { entries: [{ id: "", paths: ["p/"], imports: [] }] }, { entries: [{ id: "a", paths: [], imports: [] }] },
    { entries: [{ id: "a", paths: ["p/"], imports: "x" }] }, { ...entry({}), allowCycles: [[]] }, { ...entry({}), allowCycles: "no" },
  ];
  for (const s of samples) {
    assert.equal(conforms(s, schema), false, `schema: ${JSON.stringify(s)}`);
    assert.equal(accepts(s), false, `validator: ${JSON.stringify(s)}`);
  }
  // The schema cannot see the filesystem: an unknown agent file is the validator's alone to refuse.
  assert.equal(accepts(entry({ reviewers: ["no-such-reviewer"] })), false);
});

// A path is covered when a regex of the list matches it, or the file the prefix names (a `.`-ended prefix stands for `.mjs`).
const covered = (patterns, prefix) => patterns.some((p) => [prefix, prefix.endsWith("/") ? `${prefix}x.mjs` : `${prefix}mjs`].some((s) => new RegExp(p).test(s)));
const uncovered = (m, cfg) => (m?.entries ?? []).flatMap((e) => [
  ...(e.risk === "sensitive" ? e.paths.filter((p) => !covered(cfg.paths.sensitive, p)).map((p) => `${e.id}: ${p} not in paths.sensitive`) : []),
  ...(e.owner === true ? e.paths.filter((p) => !covered(cfg.paths.owner, p)).map((p) => `${e.id}: ${p} not in paths.owner`) : []),
]);

test("a module marked risk sensitive or owner true has every path covered by paths.sensitive or paths.owner", () => {
  assert.deepEqual(uncovered(config.modules, config), []);
});

test("the coverage check fails for a sensitive or owner module with an uncovered path", () => {
  const cfg = { paths: { sensitive: ["^scripts/lanes/"], owner: ["^scripts/lanes/lib\\.mjs$"] } };
  const m = { entries: [
    { id: "s", paths: ["scripts/lanes/x.", "docs/"], imports: [], risk: "sensitive" },
    { id: "o", paths: ["scripts/lanes/lib.", "scripts/lanes/other."], imports: [], owner: true },
    { id: "n", paths: ["docs/"], imports: [], risk: "normal", owner: false },
  ] };
  assert.deepEqual(uncovered(m, cfg), ["s: docs/ not in paths.sensitive", "o: scripts/lanes/other. not in paths.owner"]);
});
