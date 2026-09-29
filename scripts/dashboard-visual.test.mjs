import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseArgs, buildCases, classify, exitCode, formatReport, PLAYWRIGHT_PACKAGE, DEFAULT_FIXTURE, DEFAULT_OUT } from "./dashboard-visual.mjs";

test("parseArgs: defaults", () => {
  assert.deepEqual(parseArgs([]), { fixture: DEFAULT_FIXTURE, out: DEFAULT_OUT, count: false });
  assert.equal(DEFAULT_FIXTURE, "contracts/dashboard-visual.fixture.json");
  assert.equal(DEFAULT_OUT, ".lanes/visual");
});

test("parseArgs: --fixture, --out and --count", () => {
  assert.deepEqual(parseArgs(["--fixture", "a.json", "--out", "shots", "--count"]), { fixture: "a.json", out: "shots", count: true });
});

test("parseArgs: rejects unknown flags, missing values and shell metacharacters", () => {
  assert.throws(() => parseArgs(["--nope"]), /unknown/i);
  assert.throws(() => parseArgs(["--fixture"]), /needs a value/i);
  assert.throws(() => parseArgs(["--out", "--count"]), /needs a value/i);
  assert.throws(() => parseArgs(["--out", 'a"b']), /unsafe/i);
  assert.throws(() => parseArgs(["--fixture", "a&b.json"]), /unsafe/i);
});

test("buildCases: three widths by two schemes, in a fixed order", () => {
  const cases = buildCases();
  assert.equal(cases.length, 6);
  assert.deepEqual(cases.map((c) => c.name), ["375-light", "375-dark", "768-light", "768-dark", "1280-light", "1280-dark"]);
  assert.deepEqual(cases.map((c) => c.width), [375, 375, 768, 768, 1280, 1280]);
  assert.deepEqual(cases.map((c) => c.scheme), ["light", "dark", "light", "dark", "light", "dark"]);
});

test("PLAYWRIGHT_PACKAGE is pinned to an exact version", () => {
  assert.match(PLAYWRIGHT_PACKAGE, /^playwright@\d+\.\d+\.\d+$/);
});

const box = (over) => ({
  id: 0, selector: "li.task", ancestors: [], visible: true, hasText: true, inScroller: false, overflowX: "visible", overflowY: "visible",
  scrollWidth: 100, clientWidth: 100, scrollHeight: 20, clientHeight: 20, rect: { left: 0, right: 100, top: 0, bottom: 20 }, ...over,
});
const run = (elements, required = [], width = 375) => classify({ name: "375-light", viewportWidth: width, elements, required });

test("classify: clean boxes give no defects", () => {
  assert.deepEqual(run([box({})]), []);
});

test("classify: clipped width and height only count with hidden overflow", () => {
  const w = run([box({ overflowX: "hidden", scrollWidth: 150 })]);
  assert.deepEqual(w, [{ case: "375-light", selector: "li.task", kind: "text-clipped" }]);
  assert.equal(run([box({ overflowY: "clip", scrollHeight: 40 })]).length, 1);
  assert.equal(run([box({ overflowX: "visible", scrollWidth: 150 })]).length, 0);
  assert.equal(run([box({ overflowX: "auto", scrollWidth: 150 })]).length, 0);
});

test("classify: edge: one pixel of rounding is not a defect, zero-width inline boxes are skipped", () => {
  assert.equal(run([box({ overflowX: "hidden", scrollWidth: 101 })]).length, 0);
  assert.equal(run([box({ overflowX: "hidden", scrollWidth: 300, clientWidth: 0 })]).length, 0);
});

test("classify: hidden and text-less elements are ignored", () => {
  assert.equal(run([box({ visible: false, overflowX: "hidden", scrollWidth: 300 })]).length, 0);
  assert.equal(run([box({ hasText: false, overflowX: "hidden", scrollWidth: 300 })]).length, 0);
});

test("classify: two text boxes that overlap", () => {
  const a = box({ id: 1, selector: "span.num", rect: { left: 0, right: 50, top: 0, bottom: 20 } });
  const b = box({ id: 2, selector: "span.title", rect: { left: 40, right: 120, top: 5, bottom: 25 } });
  assert.deepEqual(run([a, b]), [{ case: "375-light", selector: "span.num / span.title", kind: "text-overlap" }]);
});

test("classify: edge: touching boxes, nested boxes and hidden boxes do not overlap", () => {
  const a = box({ id: 1, selector: "a", rect: { left: 0, right: 50, top: 0, bottom: 20 } });
  const touching = box({ id: 2, selector: "b", rect: { left: 50, right: 90, top: 0, bottom: 20 } });
  assert.equal(run([a, touching]).length, 0);
  const child = box({ id: 3, selector: "c", ancestors: [1], rect: { left: 5, right: 20, top: 5, bottom: 15 } });
  assert.equal(run([a, child]).length, 0);
  const hidden = box({ id: 4, selector: "d", visible: false, rect: { left: 0, right: 50, top: 0, bottom: 20 } });
  assert.equal(run([a, hidden]).length, 0);
});

test("classify: an element partly outside the viewport width", () => {
  const right = run([box({ rect: { left: 300, right: 400, top: 0, bottom: 20 } })]);
  assert.deepEqual(right, [{ case: "375-light", selector: "li.task", kind: "outside-viewport" }]);
  assert.equal(run([box({ rect: { left: -20, right: 60, top: 0, bottom: 20 } })]).length, 1);
});

test("classify: edge: exactly the viewport width, and boxes inside a scroller, are fine", () => {
  assert.equal(run([box({ rect: { left: 275, right: 375, top: 0, bottom: 20 } })]).length, 0);
  assert.equal(run([box({ inScroller: true, rect: { left: 300, right: 900, top: 0, bottom: 20 } })]).length, 0);
});

test("classify: a required field rendered empty", () => {
  const defects = run([], [
    { selector: "li.task .num", text: "#101" },
    { selector: "li.task .title", text: "   " },
    { selector: "li.task .chip", text: "" },
  ]);
  assert.deepEqual(defects, [
    { case: "375-light", selector: "li.task .title", kind: "required-empty" },
    { case: "375-light", selector: "li.task .chip", kind: "required-empty" },
  ]);
});

test("classify: edge: no elements at all gives no defects", () => {
  assert.deepEqual(run([]), []);
});

test("formatReport: one line per defect and a last defects line", () => {
  const lines = formatReport([{ case: "375-light", selector: "a", kind: "text-clipped" }]);
  assert.deepEqual(lines, ["375-light a: text-clipped", "defects: 1"]);
  assert.deepEqual(formatReport([]), ["defects: 0"]);
});

test("exitCode: 0 clean, 1 defects, and --count exits 0 whenever it measured", () => {
  assert.equal(exitCode(0, false), 0);
  assert.equal(exitCode(3, false), 1);
  assert.equal(exitCode(3, true), 0);
  assert.equal(exitCode(0, true), 0);
});

test("the shipped fixture parses, and no workflow references the script", async () => {
  const fixture = JSON.parse(readFileSync(DEFAULT_FIXTURE, "utf8"));
  assert.ok(Array.isArray(fixture.issues) && fixture.issues.length > 0);
  const { readdirSync } = await import("node:fs");
  for (const f of readdirSync(".github/workflows")) {
    assert.ok(!readFileSync(`.github/workflows/${f}`, "utf8").includes("dashboard-visual"), `${f} references it`);
  }
});
