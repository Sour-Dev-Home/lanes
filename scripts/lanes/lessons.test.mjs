// scripts/lanes/lessons.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { areaOf, checkFragments, lessonsFor, main, MAX_CHARS, MAX_PATTERNS, readFragments, recurring } from "./lessons.mjs";

const map = {
  entries: [
    { id: "gate", paths: ["scripts/lanes/gate."], imports: [] },
    { id: "queue", paths: ["scripts/lanes/pick."], imports: [] },
  ],
};

/** A fragment's text; `fields` overrides or (with undefined) drops frontmatter keys. */
function text(fields = {}, body = "Check the thing before using it.") {
  const all = { area: "general", pattern: "check-first", severity: "important", reviewer: "test-hunter", source: '"#12"', ...fields };
  const lines = Object.entries(all).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join("\n")}\n---\n\n${body}\n`;
}

/** A fragment named after its fields, as readFragments returns it. */
function frag(area, pattern, n, body = `Lesson for ${pattern}.`, extra = {}) {
  return { name: `${area}-${pattern}-${n}.md`, text: text({ area, pattern, source: `"#${n}"`, ...extra }, body), regular: true };
}

const io = (fragments, config = { modules: map }) => ({ readConfig: () => config, listFragments: () => fragments });

// Criterion 1: --paths

test("--paths prints the lessons for the paths' areas plus general, as (xN) area/pattern: lesson, highest count first", () => {
  const fragments = [
    frag("gate", "race", 1), frag("gate", "race", 2, "Latest wording of race."),
    frag("general", "typed-error", 3), frag("general", "typed-error", 4), frag("general", "typed-error", 5),
    frag("queue", "stale-pick", 6),
  ];
  const r = main(["--paths", "scripts/lanes/gate.mjs"], io(fragments));
  assert.equal(r.code, 0);
  assert.equal(r.out, "(x3) general/typed-error: Lesson for typed-error.\n(x2) gate/race: Latest wording of race.\n");
});

test("--paths prints nothing and exits 0 when docs/lessons.d/ is missing or empty", () => {
  assert.deepEqual(main(["--paths", "a.mjs"], io(null)), { code: 0, out: "", err: "" });
  assert.deepEqual(main(["--paths", "a.mjs"], io([])), { code: 0, out: "", err: "" });
});

test("--paths prints at most MAX_PATTERNS patterns", () => {
  const fragments = Array.from({ length: MAX_PATTERNS + 5 }, (_, k) => frag("general", `p${k}`, k + 1));
  const lines = lessonsFor([], checkFragments(fragments, map).fragments, map).split("\n").filter(Boolean);
  assert.equal(MAX_PATTERNS, 20);
  assert.equal(lines.length, MAX_PATTERNS);
});

test("--paths prints at most MAX_CHARS characters, dropping the lowest-count patterns first", () => {
  const long = "A long lesson that takes up room in the prompt " + "x".repeat(400) + ".";
  const fragments = [frag("general", "top", 1), frag("general", "top", 2)];
  for (let k = 0; k < 10; k++) fragments.push(frag("general", `long${k}`, 10 + k, long));
  const { out } = main(["--paths"], io(fragments));
  assert.equal(MAX_CHARS, 3000);
  assert.ok(out.length <= MAX_CHARS, `printed ${out.length} characters`);
  assert.match(out, /^\(x2\) general\/top: /);
  assert.ok(out.split("\n").filter(Boolean).length < 11);
});

test("edge: --paths includes a line landing exactly at MAX_CHARS, excludes one a character over", () => {
  const prefix = "(x1) general/top: ";
  const lesson = "A".repeat(MAX_CHARS - prefix.length - 2) + ".";
  const exact = [{ area: "general", pattern: "top", n: 1, file: "general-top-1.md", body: lesson }];
  const out = lessonsFor([], exact, undefined);
  assert.equal(out.length, MAX_CHARS);
  assert.equal(out, `${prefix}${lesson}\n`);
  const over = [{ area: "general", pattern: "top", n: 1, file: "general-top-1.md", body: `${lesson}!` }];
  assert.equal(lessonsFor([], over, undefined), "");
});

test("edge: --paths with no paths prints general only", () => {
  const { out } = main(["--paths"], io([frag("gate", "race", 1), frag("general", "g", 2)]));
  assert.equal(out, "(x1) general/g: Lesson for g.\n");
});

test("edge: --paths ties on count sort by area/pattern, and a multi-line body prints on one line", () => {
  const fragments = [frag("general", "b", 1), frag("general", "a", 2, "First line.\nSecond line.")];
  assert.equal(main(["--paths"], io(fragments)).out, "(x1) general/a: First line. Second line.\n(x1) general/b: Lesson for b.\n");
});

test("edge: --paths skips an invalid fragment and says so on stderr, never failing the lane", () => {
  const bad = { name: "general-bad-1.md", text: "no frontmatter", regular: true };
  const r = main(["--paths"], io([bad, frag("general", "ok", 2)]));
  assert.equal(r.code, 0);
  assert.equal(r.out, "(x1) general/ok: Lesson for ok.\n");
  assert.match(r.err, /skipped 1 invalid fragment.*--check/);
});

test("edge: --paths accepts Windows separators and a leading ./", () => {
  const { out } = main(["--paths", ".\\scripts\\lanes\\gate.mjs"], io([frag("gate", "race", 1)]));
  assert.equal(out, "(x1) gate/race: Lesson for race.\n");
});

test("edge: --paths with two paths from different modules includes both areas' lessons plus general, but not an unselected module's", () => {
  const threeModules = { entries: [...map.entries, { id: "other", paths: ["scripts/other."], imports: [] }] };
  const fragments = [
    frag("gate", "race", 1), frag("queue", "stale-pick", 2), frag("general", "g", 3), frag("other", "x", 4),
  ];
  const { out } = main(["--paths", "scripts/lanes/gate.mjs", "scripts/lanes/pick.mjs"], io(fragments, { modules: threeModules }));
  const lines = out.split("\n").filter(Boolean).sort();
  assert.deepEqual(lines, ["(x1) gate/race: Lesson for race.", "(x1) general/g: Lesson for g.", "(x1) queue/stale-pick: Lesson for stale-pick."]);
});

// Criterion 2: area

test("area is the module id, general for a file in no module, and the first segment with no map", () => {
  assert.equal(areaOf("scripts/lanes/gate.mjs", map), "gate");
  assert.equal(areaOf("docs/USING.md", map), "general");
  assert.equal(areaOf("src/app/a.mjs", undefined), "src");
  assert.equal(areaOf("README.md", undefined), "README.md");
});

test("with no modules key, --paths selects by first path segment", () => {
  const fragments = [frag("src", "leak", 1), frag("docs", "typo", 2)];
  const { out } = main(["--paths", "src/app/a.mjs"], io(fragments, { requiredChecks: [] }));
  assert.equal(out, "(x1) src/leak: Lesson for leak.\n");
});

test("edge: a missing lanes.config.json means no map; an unreadable one or a malformed map exits 2", () => {
  const missing = { readConfig: () => { throw Object.assign(new Error("nope"), { code: "ENOENT" }); }, listFragments: () => [frag("src", "leak", 1)] };
  assert.equal(main(["--paths", "src/a.mjs"], missing).out, "(x1) src/leak: Lesson for leak.\n");
  const broken = { readConfig: () => { throw new SyntaxError("Unexpected token"); }, listFragments: () => [] };
  assert.equal(main(["--check"], broken).code, 2);
  const r = main(["--check"], io([], { modules: { entries: "no" } }));
  assert.equal(r.code, 2);
  assert.match(r.err, /entries must be an array/);
});

// Criterion 3: --check

test("--check passes valid fragments and exits 0", () => {
  const r = main(["--check"], io([frag("gate", "race", 1), frag("general", "g", 2)]));
  assert.equal(r.code, 0);
  assert.match(r.out, /2 fragments, 0 invalid/);
});

const failures = [
  ["no frontmatter", { name: "general-check-first-12.md", text: "Just a body.\n" }, /frontmatter/],
  ["missing area", { name: "general-check-first-12.md", text: text({ area: undefined }) }, /area/],
  ["missing pattern", { name: "general-check-first-12.md", text: text({ pattern: undefined }) }, /pattern/],
  ["missing reviewer", { name: "general-check-first-12.md", text: text({ reviewer: undefined }) }, /reviewer/],
  ["missing source", { name: "general-check-first-12.md", text: text({ source: undefined }) }, /source/],
  ["pattern not kebab-case", { name: "general-Check_First-12.md", text: text({ pattern: "Check_First" }) }, /pattern.*kebab-case/],
  ["severity minor", { name: "general-check-first-12.md", text: text({ severity: "minor" }) }, /severity/],
  ["source not #N", { name: "general-check-first-12.md", text: text({ source: "12" }) }, /source/],
  ["unknown area", { name: "nowhere-check-first-12.md", text: text({ area: "nowhere" }) }, /unknown area "nowhere"/],
  ["file name does not match", { name: "general-other-12.md", text: text() }, /file name.*general-check-first-12\.md/],
  ["file name number differs from source", { name: "general-check-first-13.md", text: text() }, /file name/],
  ["body over 3 sentences", { name: "general-check-first-12.md", text: text({}, "One. Two. Three. Four.") }, /4 sentences/],
  ["empty body", { name: "general-check-first-12.md", text: text({}, "") }, /body/],
  ["unknown key", { name: "general-check-first-12.md", text: text({ serverity: "critical" }) }, /unknown key "serverity"/],
  ["duplicate key", { name: "general-check-first-12.md", text: text().replace("area: general", "area: general\narea: general") }, /duplicate key "area"/],
  ["not a .md file", { name: "notes.txt", text: text() }, /\.md/],
  ["not a regular file", { name: "linked.md", text: "", regular: false }, /regular file/],
];

for (const [label, f, reason] of failures) {
  test(`--check fails and names the file: ${label}`, () => {
    const r = main(["--check"], io([{ regular: true, ...f }, frag("general", "fine", 1)]));
    assert.equal(r.code, 1);
    const line = r.err.split("\n").find((l) => l.startsWith(`${f.name}: `));
    assert.ok(line, `no line names ${f.name}:\n${r.err}`);
    assert.match(line.slice(f.name.length + 2), reason);
    assert.doesNotMatch(r.err, /general-fine-1\.md/);
  });
}

test("--check names each bad file, one line each", () => {
  const r = main(["--check"], io([
    { name: "general-a-1.md", text: text({ pattern: "a", source: '"#1"', severity: "low" }), regular: true },
    { name: "general-b-2.md", text: text({ pattern: "b", source: '"#2"', reviewer: undefined }), regular: true },
  ]));
  assert.equal(r.code, 1);
  assert.match(r.err, /^general-a-1\.md: /m);
  assert.match(r.err, /^general-b-2\.md: /m);
});

test("--check with no map accepts any single path segment as an area, but not a nested one", () => {
  const noMap = { requiredChecks: [] };
  assert.equal(main(["--check"], io([frag("src", "leak", 1)], noMap)).code, 0);
  const nested = { name: "a/b-leak-1.md", text: text({ area: "a/b", pattern: "leak", source: '"#1"' }), regular: true };
  assert.equal(main(["--check"], io([nested], noMap)).code, 1);
});

test("--check with a map refuses a first-segment area that is not a module id", () => {
  assert.equal(main(["--check"], io([frag("scripts", "leak", 1)])).code, 1);
});

test("edge: --check accepts an unquoted source, CRLF line endings and an area with dashes", () => {
  const dashed = { entries: [{ id: "delivery-metrics", paths: ["scripts/"], imports: [] }] };
  const crlf = text({ area: "delivery-metrics", pattern: "rounding", source: "#7" }).replace(/\n/g, "\r\n");
  assert.equal(main(["--check"], io([{ name: "delivery-metrics-rounding-7.md", text: crlf, regular: true }], { modules: dashed })).code, 0);
});

test("edge: a sentence count ignores dots inside code and names like String(err)", () => {
  const body = "Use `err.message` and `AggregateError.errors`, not `String(err)`. It drops the causes. See e.g. the tests.";
  assert.equal(main(["--check"], io([frag("general", "g", 1, body)])).code, 0);
});

test("edge: --check on a missing or empty directory passes", () => {
  assert.equal(main(["--check"], io(null)).code, 0);
  assert.equal(main(["--check"], io([])).code, 0);
});

// Criterion 4: --recurring

test("--recurring lists each area/pattern with at least 3 fragments, with its count and files", () => {
  const fragments = [
    frag("gate", "race", 1), frag("gate", "race", 2), frag("gate", "race", 3),
    frag("general", "typed-error", 4), frag("general", "typed-error", 5),
  ];
  const r = main(["--recurring"], io(fragments));
  assert.equal(r.code, 0);
  assert.equal(r.out, "(x3) gate/race: gate-race-1.md, gate-race-2.md, gate-race-3.md\n");
});

test("--recurring --min N changes the threshold", () => {
  const fragments = [frag("gate", "race", 1), frag("gate", "race", 2), frag("general", "g", 3)];
  assert.equal(main(["--recurring", "--min", "2"], io(fragments)).out, "(x2) gate/race: gate-race-1.md, gate-race-2.md\n");
  assert.equal(main(["--recurring", "--min", "1"], io(fragments)).out.split("\n").filter(Boolean).length, 2);
  assert.equal(recurring(checkFragments(fragments, map).fragments, 5), "");
});

test("edge: --recurring --min refuses a value that is not a positive integer", () => {
  for (const bad of [["--min"], ["--min", "0"], ["--min", "-1"], ["--min", "2.5"], ["--min", "x"]]) {
    const r = main(["--recurring", ...bad], io([]));
    assert.equal(r.code, 2, bad.join(" "));
    assert.match(r.err, /--min/);
  }
});

test("edge: --recurring on a missing directory prints nothing", () => {
  assert.deepEqual(main(["--recurring"], io(null)), { code: 0, out: "", err: "" });
});

test("edge: no mode, two modes or an unknown flag exits 2 with usage", () => {
  for (const argv of [[], ["--check", "--recurring"], ["--bogus"], ["--check", "extra"]]) {
    const r = main(argv, io([]));
    assert.equal(r.code, 2, argv.join(" "));
    assert.match(r.err, /usage/);
  }
});

// Criteria 5 and 6: the real directory

test("readFragments lists regular files, flags a symlink without reading it, and returns null for a missing dir", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "lessons-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(readFragments(join(dir, "missing")), null);
  writeFileSync(join(dir, "general-a-1.md"), text({ pattern: "a", source: '"#1"' }));
  mkdirSync(join(dir, "sub"));
  const outside = join(dir, "..", `secret-${process.pid}.txt`);
  writeFileSync(outside, "secret");
  t.after(() => rmSync(outside, { force: true }));
  try { symlinkSync(outside, join(dir, "link.md")); } catch { /* no symlink permission: covered by the regular entries */ }
  const got = readFragments(dir).sort((a, b) => (a.name < b.name ? -1 : 1));
  assert.deepEqual(got.find((f) => f.name === "general-a-1.md").regular, true);
  assert.deepEqual(got.find((f) => f.name === "sub"), { name: "sub", text: "", regular: false });
  const link = got.find((f) => f.name === "link.md");
  if (link) assert.deepEqual(link, { name: "link.md", text: "", regular: false });
});

test("the real docs/lessons.d/ passes --check and holds the four general seed fragments from #12", () => {
  const r = spawnSync(process.execPath, ["scripts/lanes/lessons.mjs", "--check"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const config = JSON.parse(readFileSync("lanes.config.json", "utf8"));
  const { fragments, problems } = checkFragments(readFragments("docs/lessons.d"), config.modules);
  assert.deepEqual(problems, []);
  const seeds = fragments.filter((f) => f.source === "#12" && f.area === "general");
  assert.equal(seeds.length, 4);
  const all = seeds.map((f) => f.body).join(" ");
  assert.match(all, /typed error/i);
  assert.match(all, /default/i);
  assert.match(all, /recurs/i);
  assert.match(all, /AggregateError/);
});

test("the CLI --paths prints the seed lessons for any path", () => {
  const r = spawnSync(process.execPath, ["scripts/lanes/lessons.mjs", "--paths", "scripts/lanes/gate.mjs"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  // one line per distinct general pattern (fragments share a pattern across issues), so a new fragment cannot break this
  const patterns = new Set(readdirSync("docs/lessons.d").filter((f) => f.startsWith("general-") && f.endsWith(".md"))
    .map((f) => f.slice("general-".length).replace(/-\d+\.md$/, "")));
  assert.equal(r.stdout.split("\n").filter(Boolean).length, patterns.size);
  assert.match(r.stdout, /^\(x1\) general\//m);
});
