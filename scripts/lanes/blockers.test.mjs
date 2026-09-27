// scripts/lanes/blockers.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { blockerReport, main } from "./blockers.mjs";

const form = (blockedBy) =>
  ["### Goal", "g", "### Acceptance criteria", "- [ ] a", "### Interface contract", "c", "### Scope", "s", "### Blocked by", blockedBy, "### Tier", "quick"].join("\n\n");

/** A fake `gh`: `bodies` maps issue N to its body, `states` maps blocker B to its API state; a missing entry throws like gh does. */
function fakeGh({ bodies = {}, states = {}, fail = [] } = {}) {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    if (args[0] === "issue" && args[1] === "view") {
      const n = Number(args[2]);
      if (!(n in bodies)) throw new Error("gh: Could not resolve to an issue");
      return JSON.stringify({ body: bodies[n] });
    }
    if (args[0] === "api") {
      const b = Number(args[1].match(/issues\/(\d+)$/)[1]);
      if (fail.includes(b)) throw new Error("gh: HTTP 502");
      if (!(b in states)) throw new Error("gh: Not Found (HTTP 404)");
      return JSON.stringify({ number: b, state: states[b] });
    }
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
  return { run, calls };
}

// blockerReport

test("blockerReport: none (an empty list) is ok", () => {
  assert.deepEqual(blockerReport([], {}), { ok: true, open: [], unreadable: [] });
});

test("blockerReport: all closed is ok", () => {
  assert.deepEqual(blockerReport([3, 4], { 3: "closed", 4: "closed" }), { ok: true, open: [], unreadable: [] });
});

test("blockerReport: one open is not ok and lists it", () => {
  assert.deepEqual(blockerReport([3, 4], { 3: "closed", 4: "open" }), { ok: false, open: [4], unreadable: [] });
});

test("blockerReport: several open are all listed, in order", () => {
  assert.deepEqual(blockerReport([5, 3, 4], { 5: "open", 3: "closed", 4: "open" }), { ok: false, open: [5, 4], unreadable: [] });
});

test("blockerReport: null or a missing entry is unreadable, and fails closed", () => {
  assert.deepEqual(blockerReport([3, 4], { 3: null }), { ok: false, open: [], unreadable: [3, 4] });
});

test("edge: blockerReport treats any state other than open or closed as unreadable", () => {
  assert.deepEqual(blockerReport([3, 4], { 3: "CLOSED", 4: "merged" }), { ok: false, open: [], unreadable: [3, 4] });
});

test("edge: blockerReport accepts a Map and reports a repeated blocker once", () => {
  assert.deepEqual(blockerReport([3, 3], new Map([[3, "open"]])), { ok: false, open: [3], unreadable: [] });
});

test("edge: blockerReport does not mutate its inputs", () => {
  const list = [4, 3];
  const states = { 3: "closed", 4: "closed" };
  blockerReport(list, states);
  assert.deepEqual(list, [4, 3]);
  assert.deepEqual(states, { 3: "closed", 4: "closed" });
});

// CLI

test("cli: none exits 0 with no open blockers and reads no blocker", () => {
  const gh = fakeGh({ bodies: { 15: form("none") } });
  assert.deepEqual(main(["15"], gh.run), { code: 0, message: "#15: no open blockers" });
  assert.deepEqual(gh.calls, [["issue", "view", "15", "--json", "body"]]);
});

test("cli: all closed exits 0, reading each blocker through the issues API", () => {
  const gh = fakeGh({ bodies: { 15: form("#3, #4") }, states: { 3: "closed", 4: "closed" } });
  assert.deepEqual(main(["15"], gh.run), { code: 0, message: "#15: no open blockers" });
  assert.deepEqual(gh.calls.slice(1), [["api", "repos/{owner}/{repo}/issues/3"], ["api", "repos/{owner}/{repo}/issues/4"]]);
});

test("cli: one open exits 1", () => {
  const gh = fakeGh({ bodies: { 15: form("#3 #4") }, states: { 3: "closed", 4: "open" } });
  assert.deepEqual(main(["15"], gh.run), { code: 1, message: "#15: blocked by #4 (open)" });
});

test("cli: several open exits 1 and lists each", () => {
  const gh = fakeGh({ bodies: { 15: form("- #3\n- #4\n- #5") }, states: { 3: "open", 4: "closed", 5: "open" } });
  assert.deepEqual(main(["15"], gh.run), { code: 1, message: "#15: blocked by #3 (open), #5 (open)" });
});

test("cli: a nonexistent blocker exits 2 (fails closed)", () => {
  const gh = fakeGh({ bodies: { 15: form("#3, #99") }, states: { 3: "closed" } });
  const r = main(["15"], gh.run);
  assert.equal(r.code, 2);
  assert.match(r.message, /^#15: cannot check blockers: .*#99/);
});

test("cli: an API error on a blocker exits 2", () => {
  const gh = fakeGh({ bodies: { 15: form("#3") }, fail: [3] });
  const r = main(["15"], gh.run);
  assert.equal(r.code, 2);
  assert.match(r.message, /^#15: cannot check blockers: .*#3/);
});

test("edge: an unreadable blocker exits 2 even when another blocker is open", () => {
  const gh = fakeGh({ bodies: { 15: form("#3, #99") }, states: { 3: "open" } });
  assert.equal(main(["15"], gh.run).code, 2);
});

test("cli: a malformed Blocked by field exits 2", () => {
  const gh = fakeGh({ bodies: { 15: form("after the gate lands") } });
  const r = main(["15"], gh.run);
  assert.equal(r.code, 2);
  assert.match(r.message, /^#15: cannot check blockers: blocked by/);
  assert.equal(gh.calls.length, 1);
});

test("edge: a missing Blocked by field exits 2, not 0", () => {
  const body = form("none").replace("### Blocked by\n\nnone\n\n", "");
  const r = main(["15"], fakeGh({ bodies: { 15: body } }).run);
  assert.equal(r.code, 2);
  assert.match(r.message, /blocked by/);
});

test("edge: a duplicated Blocked by heading exits 2", () => {
  const r = main(["15"], fakeGh({ bodies: { 15: `${form("none")}\n\n### Blocked by\n\n#3` } }).run);
  assert.equal(r.code, 2);
  assert.match(r.message, /duplicate heading: blocked by/);
});

test("edge: an unrelated form error does not block the check", () => {
  const body = form("#3").replace("### Goal\n\ng", "### Goal\n\n_No response_");
  assert.equal(main(["15"], fakeGh({ bodies: { 15: body }, states: { 3: "closed" } }).run).code, 0);
});

test("cli: a missing issue N exits 2", () => {
  const r = main(["404"], fakeGh().run);
  assert.equal(r.code, 2);
  assert.match(r.message, /^#404: cannot check blockers: /);
});

test("edge: an issue body gh returns as non-JSON exits 2", () => {
  const r = main(["15"], () => "<html>");
  assert.equal(r.code, 2);
  assert.match(r.message, /^#15: cannot check blockers: /);
});

test("edge: a missing or non-numeric issue argument exits 2 without calling gh", () => {
  for (const argv of [[], ["abc"], ["15; rm -rf /"], ["0"], ["-1"], ["1.5"]]) {
    const gh = fakeGh();
    const r = main(argv, gh.run);
    assert.equal(r.code, 2, `argv ${JSON.stringify(argv)}`);
    assert.match(r.message, /cannot check blockers: usage/);
    assert.equal(gh.calls.length, 0);
  }
});

test("edge: a leading # on the issue argument is accepted", () => {
  assert.equal(main(["#15"], fakeGh({ bodies: { 15: form("none") } }).run).code, 0);
});

test("edge: a blocker listed twice is read once", () => {
  const gh = fakeGh({ bodies: { 15: form("#3, #3") }, states: { 3: "open" } });
  assert.deepEqual(main(["15"], gh.run), { code: 1, message: "#15: blocked by #3 (open)" });
  assert.equal(gh.calls.length, 2);
});
