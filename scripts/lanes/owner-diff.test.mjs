import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { classifyOwnerDiff, OWNER_DIFF_FILES } from "./owner-diff.mjs";

const CONFIG = "lanes.config.json";
const WORKFLOW = "scripts/lanes/workflow.test.mjs";

const baseConfig = {
  requiredChecks: ["verify"],
  modules: { entries: [{ id: "gate", paths: ["scripts/lanes/gate."], imports: ["lib"] }], allowCycles: [] },
  paths: { skip: ["^docs/"], owner: ["^\\.github/", "^lanes\\.config\\.json$"] },
};
const json = (value) => JSON.stringify(value, null, 2) + "\n";
const withOwner = (owner) => ({ ...baseConfig, paths: { ...baseConfig.paths, owner } });
const config = (head, base = json(baseConfig)) => classifyOwnerDiff({ files: [CONFIG], base: { [CONFIG]: base }, head: { [CONFIG]: head } });

const baseTests = [
  'import { test } from "node:test";',
  'import assert from "node:assert/strict";',
  "",
  "// I3: a pin",
  'test("pins the gate", () => {',
  "  assert.match(yml, /ref: main/);",
  "});",
  "",
].join("\n");
const newBlock = ['test("pins the new owner path", () => {', '  assert.ok(owner.includes("x"));', "});", ""].join("\n");
const workflow = (head, base = baseTests) => classifyOwnerDiff({ files: [WORKFLOW], base: { [WORKFLOW]: base }, head: { [WORKFLOW]: head } });

const additive = (r) => assert.deepEqual(r, { verdict: "additive", reason: "" });
function needsOwner(r, pattern) {
  assert.equal(r.verdict, "needs-owner");
  assert.equal(typeof r.reason, "string");
  assert.ok(r.reason.length > 0 && !r.reason.includes("\n"), `one-line reason, got ${JSON.stringify(r.reason)}`);
  if (pattern) assert.match(r.reason, pattern);
}

test("the only files it ever classifies are lanes.config.json and workflow.test.mjs", () => {
  assert.deepEqual([...OWNER_DIFF_FILES], [CONFIG, WORKFLOW]);
  assert.ok(Object.isFrozen(OWNER_DIFF_FILES));
});

// Criterion 3: lanes.config.json cases.
test("an entry appended to paths.owner is additive", () => {
  additive(config(json(withOwner([...baseConfig.paths.owner, "^scripts/lanes/owner-diff(\\.test)?\\.mjs$"]))));
});

test("two entries appended to paths.owner are additive", () => {
  additive(config(json(withOwner([...baseConfig.paths.owner, "^a$", "^b$"]))));
});

test("a removed paths.owner entry needs the owner", () => {
  needsOwner(config(json(withOwner(["^\\.github/"]))), /paths\.owner/);
});

test("an edited paths.owner entry needs the owner", () => {
  needsOwner(config(json(withOwner(["^\\.github/", "^lanes\\.config\\.jsonx$"]))), /paths\.owner/);
});

test("an entry inserted before the end of paths.owner needs the owner", () => {
  needsOwner(config(json(withOwner(["^new$", ...baseConfig.paths.owner]))), /paths\.owner/);
});

test("a reordered paths.owner list needs the owner", () => {
  needsOwner(config(json(withOwner([...baseConfig.paths.owner].reverse()))), /paths\.owner/);
});

test("a new modules import needs the owner, even alongside an appended owner entry", () => {
  const head = withOwner([...baseConfig.paths.owner, "^a$"]);
  head.modules = { ...baseConfig.modules, entries: [{ ...baseConfig.modules.entries[0], imports: ["lib", "queue"] }] };
  needsOwner(config(json(head)), /modules/);
});

test("a new top-level key needs the owner", () => {
  needsOwner(config(json({ ...withOwner([...baseConfig.paths.owner, "^a$"]), extra: true })), /extra/);
});

test("a new key under paths needs the owner", () => {
  const head = withOwner([...baseConfig.paths.owner, "^a$"]);
  head.paths.sensitive = ["^x/"];
  needsOwner(config(json(head)), /paths/);
});

test("a changed paths.skip needs the owner", () => {
  const head = withOwner([...baseConfig.paths.owner, "^a$"]);
  head.paths.skip = ["^docs/", "\\.ts$"];
  needsOwner(config(json(head)), /paths\.skip/);
});

test("a parse error at head needs the owner", () => {
  needsOwner(config('{ "paths": '), /parse/);
});

test("a parse error at base needs the owner", () => {
  needsOwner(config(json(baseConfig), "{ nope"), /parse/);
});

// Criterion 3: workflow.test.mjs cases.
test("one new top-level test() block appended is additive", () => {
  additive(workflow(baseTests + newBlock));
});

test("a new block plus an edited line elsewhere needs the owner", () => {
  needsOwner(workflow(baseTests.replace("ref: main", "ref: .*") + newBlock), /changed or removed/);
});

test("a partial block needs the owner", () => {
  needsOwner(workflow(baseTests + 'test("half", () => {\n  assert.ok(true);\n'));
});

// Criterion 4: the checker belongs to the gate module and is itself an owner path.
test("lanes.config.json maps owner-diff into the gate module and makes it an owner path", () => {
  const real = JSON.parse(readFileSync(CONFIG, "utf8"));
  const gate = real.modules.entries.find((e) => e.id === "gate");
  assert.ok(gate.paths.includes("scripts/lanes/owner-diff."));
  assert.ok(real.paths.owner.includes("^scripts/lanes/owner-diff(\\.test)?\\.mjs$"));
  const owner = real.paths.owner.map((p) => new RegExp(p));
  for (const f of ["scripts/lanes/owner-diff.mjs", "scripts/lanes/owner-diff.test.mjs"]) assert.ok(owner.some((re) => re.test(f)), f);
});

// Edge cases: inputs.
test("edge: no files, a non-list, or an unexpected file needs the owner", () => {
  needsOwner(classifyOwnerDiff({ files: [], base: {}, head: {} }));
  needsOwner(classifyOwnerDiff({ files: CONFIG, base: {}, head: {} }));
  needsOwner(classifyOwnerDiff());
  needsOwner(classifyOwnerDiff({ files: [CONFIG, "src/a.ts"], base: { [CONFIG]: "{}" }, head: { [CONFIG]: "{}" } }), /unexpected file/);
  needsOwner(classifyOwnerDiff({ files: ["./lanes.config.json"], base: {}, head: {} }), /unexpected file/);
});

test("edge: a file missing or not text at either side needs the owner", () => {
  needsOwner(classifyOwnerDiff({ files: [CONFIG], base: {}, head: { [CONFIG]: json(baseConfig) } }), /missing/);
  needsOwner(classifyOwnerDiff({ files: [CONFIG], base: { [CONFIG]: json(baseConfig) }, head: { [CONFIG]: null } }), /missing/);
  needsOwner(classifyOwnerDiff({ files: [CONFIG], base: null, head: null }), /missing/);
  needsOwner(classifyOwnerDiff({ files: [CONFIG], base: Object.create({ [CONFIG]: json(baseConfig) }), head: { [CONFIG]: json(baseConfig) } }), /missing/);
});

test("edge: both files additive together is additive; one bad file makes it needs-owner", () => {
  const files = [CONFIG, WORKFLOW];
  const base = { [CONFIG]: json(baseConfig), [WORKFLOW]: baseTests };
  const head = (tests) => ({ [CONFIG]: json(withOwner([...baseConfig.paths.owner, "^a$"])), [WORKFLOW]: tests });
  additive(classifyOwnerDiff({ files, base, head: head(baseTests + newBlock) }));
  needsOwner(classifyOwnerDiff({ files, base, head: head(baseTests + "run();\n") }));
});

// Edge cases: lanes.config.json.
test("edge: an unchanged or reformatted config appends nothing, so it needs the owner", () => {
  needsOwner(config(json(baseConfig)), /appends no entry/);
  needsOwner(config(JSON.stringify(baseConfig)), /appends no entry/);
});

test("edge: a duplicate key hiding a change needs the owner", () => {
  const head = json(withOwner([...baseConfig.paths.owner, "^a$"])).replace('"requiredChecks"', '"requiredChecks": [], "requiredChecks"');
  needsOwner(config(head), /duplicate key/);
});

test("edge: an appended entry that is not a valid non-empty pattern needs the owner", () => {
  needsOwner(config(json(withOwner([...baseConfig.paths.owner, 5]))), /not a pattern/);
  needsOwner(config(json(withOwner([...baseConfig.paths.owner, ""]))), /not a pattern/);
  needsOwner(config(json(withOwner([...baseConfig.paths.owner, "(unclosed"]))), /invalid pattern/);
});

test("edge: a config that is not an object, or whose paths or paths.owner has the wrong shape, needs the owner", () => {
  needsOwner(config("[]", "[]"), /not a JSON object/);
  const ownerText = json({ ...baseConfig, paths: { ...baseConfig.paths, owner: "x" } });
  needsOwner(config(ownerText, ownerText), /not a list/);
  const pathsList = json({ ...baseConfig, paths: [] });
  needsOwner(config(pathsList, pathsList), /not an object/);
});

test("edge: a removed top-level key or paths key needs the owner", () => {
  const { requiredChecks, ...noChecks } = withOwner([...baseConfig.paths.owner, "^a$"]);
  needsOwner(config(json(noChecks)), /removes top-level key "requiredChecks"/);
  const noSkip = withOwner([...baseConfig.paths.owner, "^a$"]);
  delete noSkip.paths.skip;
  needsOwner(config(json(noSkip)), /removes paths\.key "skip"/);
});

// Edge cases: workflow.test.mjs.
const appended = (text) => workflow(baseTests + text);

test("edge: several blocks, async and one-parameter callbacks, comments and blank lines between are additive", () => {
  additive(appended("\n// a new pin\n" + newBlock + "\n/* another */\ntest('second', async (t) => {\n  await t.test(\"inner\", () => {});\n});\n"));
});

test("edge: a block body with strings, templates, regexes and comments holding braces is additive", () => {
  const body = [
    'test("tricky body", () => {',
    "  const s = \"}); evil(); test('x', () => {\";",
    "  const tpl = `a ${ { b: `}` }.b } c`;",
    "  const re = /\\}\\);[}{/]/g;",
    "  // }); evil();",
    "  /* }); */",
    "  const n = (1 + 2) * [3][0] / 3;",
    "  if (s) return typeof /x/;",
    "});",
    "",
  ].join("\n");
  additive(appended(body));
});

test("edge: top-level code appended alongside a block needs the owner", () => {
  needsOwner(appended("assert.match = () => {};\n" + newBlock), /whole top-level test/);
  needsOwner(appended(newBlock + "process.exitCode = 0;\n"), /whole top-level test/);
});

test("edge: a block that closes early and runs code at import needs the owner", () => {
  needsOwner(appended('test("a", () => {\n  }); assert.ok = () => {}; test("b", () => {\n});\n'), /whole top-level test/);
});

test("edge: a block whose arguments run code at import needs the owner", () => {
  needsOwner(appended('test("a", { timeout: 1 }, () => {\n});\n'));
  needsOwner(appended('test("a" + run(), () => {\n});\n'));
  needsOwner(appended("test(`a${run()}`, () => {\n});\n"));
  needsOwner(appended('test("a", (x = run()) => {\n});\n'));
  needsOwner(appended('test("a", () => {\n})(run());\n'));
  needsOwner(appended('test("a", () => {\n}), run();\n'));
});

test("edge: test.only, a missing semicolon or a non-arrow callback needs the owner", () => {
  needsOwner(appended('test.only("a", () => {\n});\n'));
  needsOwner(appended('test("a", () => {\n})\n'));
  needsOwner(appended('test("a", function () {\n});\n'));
  needsOwner(appended('test("a", async function () {\n});\n'));
});

test("edge: a block inserted between existing tests needs the owner (only appending is proved)", () => {
  const at = baseTests.indexOf("// I3");
  needsOwner(workflow(baseTests.slice(0, at) + newBlock + baseTests.slice(at)), /changed or removed/);
});

test("edge: an unchanged file or only comments added needs the owner", () => {
  needsOwner(workflow(baseTests), /adds no test block/);
  needsOwner(appended("// just a note\n"), /adds no test block/);
});

test("edge: a base without a final newline, or empty, needs the owner", () => {
  needsOwner(workflow(baseTests.trimEnd() + "\n" + newBlock, baseTests.trimEnd()), /newline/);
  needsOwner(workflow(newBlock, ""), /empty/);
});

test("edge: an addition that starts inside an open comment, template or block needs the owner", () => {
  needsOwner(workflow("/* open\n" + newBlock + "*/\n", "/* open\n"));
  needsOwner(workflow("const t = `\n" + newBlock + "`;\n", "const t = `\n"));
  needsOwner(workflow("{\n" + newBlock + "}\n", "{\n"));
});

test("edge: unterminated, unbalanced or ambiguous text needs the owner", () => {
  needsOwner(appended('test("a", () => {\n  const s = "open;\n});\n'), /unterminated string/);
  needsOwner(appended('test("a", () => {\n  const re = /open;\n});\n'), /unterminated regular expression/);
  needsOwner(appended('test("a", () => {\n  /* open\n});\n'), /unterminated comment/);
  needsOwner(appended('test("a", () => {\n  run(]);\n});\n'), /unbalanced/);
  needsOwner(appended('test("a", () => {\n  if (x) /}/.test(y);\n});\n'), /ambiguous/);
  needsOwner(appended('test("a", () => {\n  x++ /2;\n});\n'), /ambiguous/);
  needsOwner(appended('test("a", () => {\n  const \\u0061 = 1;\n});\n'), /backslash/);
});

// Security review: `of` is a legal name in a module and `#return` a legal private name, so a `/` after either can be
// a division. Read as a regex, it would hide "} ); code();" that JavaScript runs at import.
test("edge: a '/' after `of` is ambiguous and needs the owner", () => {
  needsOwner(appended('test("b", () => { const of = 10; const y = of / 2 ; } ); globalThis.evil = 1; // } );\n'), /ambiguous/);
});

// Security review round 2: `class A extends /'/ {}` is valid, so a regex can follow `extends`; read as a division, its
// quote opened a string JavaScript never sees and hid the block's close.
test("edge: a '/' after extends needs the owner", () => {
  needsOwner(appended('test("b", () => { class A extends /\'/ {} } ); globalThis.evil = 1; test("c", () => { // \'\n} );\n'), /ambiguous/);
});

test("edge: a '/' after any other reserved or contextual word needs the owner", () => {
  for (const word of ["debugger", "break", "continue", "default", "extends", "let", "static", "get", "set", "async", "as", "from", "enum", "import", "export", "class", "function"]) {
    needsOwner(appended(`test("b", () => {\n  ${word}\n  /x/.test("");\n});\n`), /ambiguous/);
  }
});

test("edge: a '/' after a value word or a plain name is a division", () => {
  additive(appended('test("b", () => {\n  const x = 4, y = [this / 2, true / 1, null / 1, x / 2, undefined / 1];\n});\n'));
});

// Security review round 3: a comment between "." and a keyword hid the member context, so `a./**/return / 2` was
// read as a regex where JavaScript divides.
test("edge: a comment between '.', '?.' or '#' and a keyword still makes it a name", () => {
  needsOwner(appended('test("t", () => { a./**/return / 2; }); globalThis.evil = 1; test("u", () => { x / 3; });\n'));
  needsOwner(appended('test("t", () => { a?./**/return / 2; }); globalThis.evil = 1; test("u", () => { x / 3; });\n'));
  needsOwner(appended('test("t", () => { class A { #return = 1; m() { return this.#/**/return / 2; } } }); globalThis.evil = 1; test("u", () => { x / 3; });\n'));
  additive(appended('test("t", () => {\n  const a = { return: 4 };\n  const n = a./* note */return / 2;\n});\n'));
});

// Whatever the tokenizer misreads, JavaScript's own parser must accept each body exactly as the tokenizer cut it.
test("edge: a body the tokenizer cut where JavaScript would not needs the owner", () => {
  needsOwner(appended('test("t", () => {\n  const s = 1;\n  s = ;\n});\n'), /does not parse/);
  needsOwner(appended('test("t", () => {\n  await Promise.resolve();\n});\n'), /does not parse/);
  additive(appended('test("t", async () => {\n  await Promise.resolve();\n});\n'));
  additive(appended('test("t", (t) => {\n  t.diagnostic("x");\n});\n'));
});

// Security review round 4: `0x1e+/'/` is 0x1e plus a regex, not one number, and a wrapper around the body let the
// wrongly cut text parse as a comma expression. The body must now parse alone, as the Function constructor parses it.
test("edge: a hex literal before '+' does not swallow the sign, and a body that escapes its function needs the owner", () => {
  needsOwner(appended('test("a", () => { 0x1e+/\'/; }, globalThis.MARK = 1, () => { void \'a\'; // \'\n});\n'));
  additive(appended('test("a", () => {\n  const n = 0x1e+1, m = 1e+3, k = 0b1+0o7, big = 10n;\n  const r = 0x1e + /x/.source.length;\n});\n'));
});

test("edge: an HTML-like comment marker, which a module does not treat as a comment, needs the owner", () => {
  needsOwner(appended('test("t", () => {\n  const a = 1;\n  a <!-- 2;\n});\n'), /HTML-like comment/);
  needsOwner(appended('test("t", () => {\n  let a = 3;\n  a-->0;\n});\n'), /HTML-like comment/);
});

test("edge: a '/' after a keyword used as a private or member name is a division", () => {
  needsOwner(appended('test("b", () => { class A { #return = 1; m() { return this.#return / 2 ; } } ); globalThis.evil = 1; // } } );\n'));
  additive(appended('test("b", () => {\n  class A { #return = 4; m() { return this.#return / 2; } }\n  const o = { typeof: 4 };\n  const n = o.typeof / 2;\n});\n'));
});

test("edge: a CRLF file with a block appended is additive", () => {
  const crlf = baseTests.replace(/\n/g, "\r\n");
  additive(workflow(crlf + newBlock.replace(/\n/g, "\r\n"), crlf));
});

test("edge: the real workflow.test.mjs reads cleanly, so appending a block to it is additive", () => {
  const real = readFileSync(WORKFLOW, "utf8");
  additive(workflow(real + newBlock, real));
});

// test-hunter: a line comment ends at U+2028 in JavaScript, so code after it runs at import.
test("edge: a line separator ends a comment, so code after it needs the owner", () => {
  needsOwner(appended('test("b", () => { // a  }); globalThis.evil = 1; test("c", () => {\n});\n'));
});

test("edge: nested templates and a backslash-newline string continuation stay inside their block", () => {
  additive(appended('test("b", () => {\n  const a = `${`}`}`;\n  const s = "x\\\ny";\n});\n'));
});
