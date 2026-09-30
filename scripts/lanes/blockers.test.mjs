// scripts/lanes/blockers.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { blockerReport, main, parseBlockedBy, readBlockerReport } from "./blockers.mjs";

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

test("cli: a thrown network error on a blocker names its cause and keeps the prefix", () => {
  const run = (args) => {
    if (args[0] === "issue") return JSON.stringify({ body: form("#441") });
    throw new Error("error connecting to api.github.com\nsecond line");
  };
  const r = main(["468"], run);
  assert.equal(r.code, 2);
  assert.equal(r.message, "#468: cannot check blockers: #441 not found or unreadable (error connecting to api.github.com)");
});

test("cli: a thrown not-found error on a blocker names its cause", () => {
  const gh = fakeGh({ bodies: { 15: form("#99") } });
  const r = main(["15"], gh.run);
  assert.equal(r.code, 2);
  assert.equal(r.message, "#15: cannot check blockers: #99 not found or unreadable (gh: Not Found (HTTP 404))");
});

test("cli: an unknown state names the state and still fails closed", () => {
  const gh = fakeGh({ bodies: { 15: form("#3") }, states: { 3: "merged" } });
  const r = main(["15"], gh.run);
  assert.equal(r.code, 2);
  assert.equal(r.message, "#15: cannot check blockers: #3 not found or unreadable (state: merged)");
});

test("edge: control characters in a read error are stripped and each unreadable blocker gets its own reason", () => {
  const run = (args) => {
    if (args[0] === "issue") return JSON.stringify({ body: form("#3, #4") });
    if (args[1].endsWith("/3")) throw new Error("bad\u001b[31m\u0007 thing");
    return JSON.stringify({ state: "closed" });
  };
  const r = main(["15"], run);
  assert.equal(r.code, 2);
  assert.equal(r.message, "#15: cannot check blockers: #3 not found or unreadable (bad[31m thing)");
});

test("edge: bidi overrides and line separators are stripped and a long error is capped", () => {
  const run = (args) => {
    if (args[0] === "issue") return JSON.stringify({ body: form("#3") });
    throw new Error(`a‮b c${"x".repeat(500)}`);
  };
  const r = main(["15"], run);
  assert.equal(r.message, `#15: cannot check blockers: #3 not found or unreadable (abc${"x".repeat(197)})`);
});

test("edge: the read-error cap keeps exactly 200 characters and cuts 201 to 200", () => {
  const at = (len) => {
    const run = (args) => {
      if (args[0] === "issue") return JSON.stringify({ body: form("#3") });
      throw new Error("y".repeat(len));
    };
    return main(["15"], run).message;
  };
  const line = (len) => `#15: cannot check blockers: #3 not found or unreadable (${"y".repeat(len)})`;
  assert.equal(at(199), line(199));
  assert.equal(at(200), line(200));
  assert.equal(at(201), line(200));
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

test("edge: a multi-line gh error reduces to its first line, keeping the printed message one line", () => {
  const run = () => {
    const err = new Error("boom");
    err.stderr = "GraphQL: Could not resolve to an issue (repository.issue)\nsome.query:1\nextra trailer line";
    throw err;
  };
  const r = main(["15"], run);
  assert.equal(r.code, 2);
  assert.equal(r.message, "#15: cannot check blockers: issue #15 not found or unreadable (GraphQL: Could not resolve to an issue (repository.issue))");
  assert.doesNotMatch(r.message, /\n/);
  assert.doesNotMatch(r.message, /trailer/);
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

// #36: one reader shared by this CLI and lanes/gate.
const reader = (states) => {
  const calls = [];
  const read = (b) => {
    calls.push(b);
    if (!(b in states)) throw new Error("404");
    return states[b];
  };
  return { read, calls };
};

test("readBlockerReport: no blockers is ok and reads nothing", () => {
  const r = reader({});
  assert.deepEqual(readBlockerReport(form("none"), r.read), { ok: true, open: [], unreadable: [] });
  assert.equal(r.calls.length, 0);
});

test("readBlockerReport: open, closed and unreadable blockers are reported", () => {
  assert.deepEqual(readBlockerReport(form("#3, #4, #5"), reader({ 3: "open", 4: "closed" }).read), { ok: false, open: [3], unreadable: [5] });
  assert.deepEqual(readBlockerReport(form("#4"), reader({ 4: "closed" }).read), { ok: true, open: [], unreadable: [] });
});

test("readBlockerReport: a state other than open or closed is unreadable", () => {
  assert.deepEqual(readBlockerReport(form("#3"), reader({ 3: "weird" }).read), { ok: false, open: [], unreadable: [3] });
});

test("readBlockerReport: a repeated blocker is read once", () => {
  const r = reader({ 3: "open" });
  readBlockerReport(form("#3, #3"), r.read);
  assert.deepEqual(r.calls, [3]);
});

test("readBlockerReport: a missing or malformed field gives an error and reads nothing", () => {
  for (const body of [undefined, "### Goal\n\ng\n", form("soon")]) {
    const r = reader({});
    const report = readBlockerReport(body, r.read);
    assert.equal(report.ok, false, String(body));
    assert.match(report.error, /blocked by/, String(body));
    assert.equal(r.calls.length, 0);
  }
});

test("parseBlockedBy: the distinct blockers, or the field's error", () => {
  assert.deepEqual(parseBlockedBy(form("#3, #3, #4")), { blockedBy: [3, 4] });
  assert.deepEqual(parseBlockedBy(form("none")), { blockedBy: [] });
  assert.match(parseBlockedBy("### Goal\n\ng\n").error, /missing: blocked by/);
});
