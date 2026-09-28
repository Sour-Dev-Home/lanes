import { test } from "node:test";
import assert from "node:assert/strict";
import { issuePaths, pathsOverlap } from "./paths.mjs";

test("issuePaths reads backticked and bare paths from the contract and Scope's In: part, ignoring Out:", () => {
  const paths = issuePaths({
    contract: "none (additive `--json` fields on `ready` items), see docs/contract.md",
    scope: "In: `scripts/lanes/status.mjs`, scripts/lanes/status.test.mjs.\nOut: the 3-lane cap, `lib.mjs`, `.claude/commands/*`.",
  });
  assert.deepEqual(paths, ["docs/contract.md", "scripts/lanes/status.mjs", "scripts/lanes/status.test.mjs"]);
  assert.deepEqual(issuePaths({ contract: "none", scope: "tidy up the wording" }), []);
  assert.deepEqual(issuePaths({ contract: "", scope: "In: `src/ui/` and ./README.md" }), ["src/ui/", "README.md"]);
  // "Built-in:" and "Opt-out:" are not the In:/Out: labels.
  assert.deepEqual(issuePaths({ scope: "Built-in: `x.mjs`. In: `a.mjs`, opt-out: `b.mjs`\nOut: `c.mjs`" }), ["a.mjs", "b.mjs"]);
});

test("issuePaths ignores paths in the parenthesised note after a `none` contract: they are only read", () => {
  const reads = (scope) => issuePaths({ contract: "none (reads `contracts/adr-template.md` from #44)", scope });
  assert.deepEqual(reads("In: `.claude/commands/adr.md`."), [".claude/commands/adr.md"]);
  // #45 and #46 both only read the template, so they do not overlap.
  assert.equal(pathsOverlap(reads("In: `scripts/lanes/reviewers.mjs`."), reads("In: `.claude/commands/plan-issues.md`.")), false);
});

test("a real contract path still overlaps another issue that edits it", () => {
  const owner = issuePaths({ contract: "`contracts/adr-template.md`", scope: "In: `scripts/lanes/adr.mjs`." });
  const reader = issuePaths({ contract: "none (reads `contracts/adr-template.md` from #44)", scope: "In: `contracts/adr-template.md`." });
  assert.deepEqual(owner, ["contracts/adr-template.md", "scripts/lanes/adr.mjs"]);
  assert.equal(pathsOverlap(owner, reader), true);
  assert.equal(pathsOverlap(owner, issuePaths({ contract: "none (reads `contracts/adr-template.md`)", scope: "In: `b.mjs`." })), false);
});

test("edge: only a note right after `none` is dropped; other contract text, nested parentheses and case are handled", () => {
  assert.deepEqual(issuePaths({ contract: "None (reads `a.md` (see #4) and `b.md`)", scope: "In: `c.mjs`." }), ["c.mjs"]);
  assert.deepEqual(issuePaths({ contract: "`x.md` (reads `y.md`)", scope: "In: `c.mjs`." }), ["x.md", "y.md", "c.mjs"]);
  assert.deepEqual(issuePaths({ contract: "none (reads `a.md`), writes `d.md`", scope: "" }), ["d.md"]);
  assert.deepEqual(issuePaths({ contract: "nonetheless `e.md`", scope: "" }), ["e.md"]);
  assert.deepEqual(issuePaths({ contract: "none (unclosed `f.md`", scope: "" }), ["f.md"]);
});

test("edge: no arguments, URLs, flags and repeated paths", () => {
  assert.deepEqual(issuePaths({}), []);
  assert.deepEqual(issuePaths({ scope: "In: https://example.com/a/b.html and --flag/x.mjs" }), []);
  assert.deepEqual(issuePaths({ contract: "`a.mjs`", scope: "In: `a.mjs`, ./a.mjs" }), ["a.mjs"]);
  assert.deepEqual(issuePaths({ scope: "In: `.claude/commands/*`" }), [".claude/commands/"]);
});

test("paths overlap when equal or when one is a directory containing the other", () => {
  assert.equal(pathsOverlap(["a/b.mjs"], ["a/b.mjs"]), true);
  assert.equal(pathsOverlap(["a/"], ["a/b/c.mjs"]), true);
  assert.equal(pathsOverlap(["a/b/c.mjs"], ["a/"]), true);
  assert.equal(pathsOverlap(["a/b.mjs"], ["a/c.mjs"]), false);
  assert.equal(pathsOverlap(["ab/"], ["a/b.mjs", "abc/d.mjs"]), false);
});

test("edge: empty lists never overlap", () => {
  assert.equal(pathsOverlap([], ["a.mjs"]), false);
  assert.equal(pathsOverlap(["a.mjs"], []), false);
  assert.equal(pathsOverlap([], []), false);
});
