// scripts/lanes/pick.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { claimedPaths, pickStartable } from "./pick.mjs";

// A task issue body naming `inPaths` in its Scope and blocked by `blockedBy`.
const body = (inPaths, blockedBy = []) =>
  `### Goal\ng\n### Acceptance criteria\n- [ ] a\n### Interface contract\nnone\n### Scope\nIn: ${inPaths.map((p) => `\`${p}\``).join(", ")}.\nOut: \`elsewhere/x.mjs\`.\n### Blocked by\n${blockedBy.length ? blockedBy.map((n) => `#${n}`).join(", ") : "none"}\n### Tier\nquick\n`;
const issue = (number, inPaths, blockedBy = []) => ({ number, body: body(inPaths, blockedBy) });
const pick = (over = {}) =>
  pickStartable({ candidates: [], claimed: [], openIssues: [], maxLanes: 3, inFlightCount: 0, softPaths: [], ...over });

test("claimedPaths: each open PR's files by PR number, each running issue's paths by issue number", () => {
  const claimed = claimedPaths({
    openPrs: [{ number: 70, files: [{ path: "src/a.mjs" }, { path: "src/b.mjs" }] }],
    runningIssues: [issue(12, ["src/c.mjs", "docs/"])],
  });
  assert.deepEqual(claimed, [
    { path: "src/a.mjs", by: 70 },
    { path: "src/b.mjs", by: 70 },
    { path: "src/c.mjs", by: 12 },
    { path: "docs/", by: 12 },
  ]);
});

test("pickStartable returns { start, skipped }", () => {
  assert.deepEqual(pick(), { start: [], skipped: [] });
});

test("disjoint candidates all start", () => {
  const r = pick({ candidates: [issue(1, ["a.mjs"]), issue(2, ["b.mjs"])] });
  assert.deepEqual(r, { start: [1, 2], skipped: [] });
});

test("two overlapping candidates: the higher priority starts, the other names it", () => {
  const r = pick({ candidates: [issue(5, ["src/x.mjs"]), issue(4, ["src/x.mjs", "y.mjs"])] });
  assert.deepEqual(r.start, [4]);
  assert.deepEqual(r.skipped, [{ number: 5, reason: "overlaps #4 on src/x.mjs" }]);
});

test("an overlap with an open PR's file is skipped", () => {
  const claimed = claimedPaths({ openPrs: [{ number: 80, files: [{ path: "src/x.mjs" }] }], runningIssues: [] });
  const r = pick({ candidates: [issue(3, ["src/x.mjs"])], claimed });
  assert.deepEqual(r, { start: [], skipped: [{ number: 3, reason: "overlaps running #80 on src/x.mjs" }] });
});

test("an overlap with a running issue's Scope is skipped, directories included", () => {
  const claimed = claimedPaths({ openPrs: [], runningIssues: [issue(9, ["src/"])] });
  const r = pick({ candidates: [issue(3, ["src/deep/x.mjs"])], claimed });
  assert.deepEqual(r.skipped, [{ number: 3, reason: "overlaps running #9 on src/deep/x.mjs" }]);
});

test("a shared soft path is not an overlap", () => {
  const softPaths = ["^CHANGELOG\\.md$"];
  const claimed = [{ path: "CHANGELOG.md", by: 80 }];
  const r = pick({ candidates: [issue(1, ["a.mjs", "CHANGELOG.md"]), issue(2, ["b.mjs", "CHANGELOG.md"])], claimed, softPaths });
  assert.deepEqual(r, { start: [1, 2], skipped: [] });
});

test("a shared .claude/commands/lane.md is an overlap (.md is not soft by default)", () => {
  const r = pick({ candidates: [issue(1, [".claude/commands/lane.md"]), issue(2, [".claude/commands/lane.md"])], softPaths: ["^CHANGELOG\\.md$"] });
  assert.deepEqual(r.start, [1]);
  assert.deepEqual(r.skipped, [{ number: 2, reason: "overlaps #1 on .claude/commands/lane.md" }]);
});

test("a chain root beats an older leaf", () => {
  // #20 blocks #21, which blocks #22; #10 blocks nothing.
  const openIssues = [issue(10, ["x.mjs"]), issue(20, ["x.mjs"]), issue(21, ["z.mjs"], [20]), issue(22, ["w.mjs"], [21])];
  const r = pick({ candidates: [issue(10, ["x.mjs"]), issue(20, ["x.mjs"])], openIssues });
  assert.deepEqual(r.start, [20]);
  assert.deepEqual(r.skipped, [{ number: 10, reason: "overlaps #20 on x.mjs" }]);
});

test("start lists chain roots first", () => {
  const openIssues = [issue(30, ["q.mjs"], [7])];
  const r = pick({ candidates: [issue(2, ["a.mjs"]), issue(7, ["b.mjs"])], openIssues });
  assert.deepEqual(r.start, [7, 2]);
});

test("a cycle in Blocked by terminates and counts each issue once", () => {
  // #1 -> #2 -> #3 -> #1, and #4 blocks #5 and #6.
  const openIssues = [issue(1, ["a"], [3]), issue(2, ["b"], [1]), issue(3, ["c"], [2]), issue(5, ["e"], [4]), issue(6, ["f"], [4, 5])];
  const r = pick({ candidates: [issue(1, ["s.mjs"]), issue(4, ["s.mjs"])], openIssues });
  // #1 transitively blocks #2 and #3 (2); #4 blocks #5 and #6 (2); a tie goes to the lower number.
  assert.deepEqual(r.start, [1]);
  assert.deepEqual(r.skipped, [{ number: 4, reason: "overlaps #1 on s.mjs" }]);
});

test("the cap counts lanes already in flight", () => {
  const candidates = [issue(1, ["a.mjs"]), issue(2, ["b.mjs"]), issue(3, ["c.mjs"])];
  const r = pick({ candidates, maxLanes: 3, inFlightCount: 2 });
  assert.deepEqual(r.start, [1]);
  assert.deepEqual(r.skipped, [
    { number: 2, reason: "cap of 3 lanes reached" },
    { number: 3, reason: "cap of 3 lanes reached" },
  ]);
});

test("a candidate whose Scope names no paths is skipped", () => {
  const empty = { number: 8, body: body([]).replace(/In: .*\n/, "In: nothing yet\n") };
  const r = pick({ candidates: [empty, issue(9, ["a.mjs"])] });
  assert.deepEqual(r, { start: [9], skipped: [{ number: 8, reason: "scope names no paths" }] });
});

// Edge cases found while implementing.

test("edge: in-flight count above the cap starts nothing", () => {
  const r = pick({ candidates: [issue(1, ["a.mjs"])], maxLanes: 3, inFlightCount: 5 });
  assert.deepEqual(r, { start: [], skipped: [{ number: 1, reason: "cap of 3 lanes reached" }] });
});

test("edge: a missing or empty body reads as a Scope with no paths", () => {
  const r = pick({ candidates: [{ number: 1 }, { number: 2, body: "" }] });
  assert.deepEqual(r.skipped, [
    { number: 1, reason: "scope names no paths" },
    { number: 2, reason: "scope names no paths" },
  ]);
});

test("edge: paths only in Out: or the contract don't count as a Scope", () => {
  const b = body([]).replace(/In: .*\n/, "In: nothing\n").replace("### Interface contract\nnone", "### Interface contract\n`src/api.mjs`");
  const r = pick({ candidates: [{ number: 1, body: b }] });
  assert.deepEqual(r.skipped, [{ number: 1, reason: "scope names no paths" }]);
});

test("edge: the contract's paths still count for overlaps when the Scope names some", () => {
  const b = body(["a.mjs"]).replace("### Interface contract\nnone", "### Interface contract\n`src/api.mjs`");
  const r = pick({ candidates: [{ number: 1, body: b }], claimed: [{ path: "src/api.mjs", by: 50 }] });
  assert.deepEqual(r.skipped, [{ number: 1, reason: "overlaps running #50 on src/api.mjs" }]);
});

test("edge: a candidate's own claim (its running entry) is not an overlap with itself", () => {
  const r = pick({ candidates: [issue(4, ["a.mjs"])], claimed: [{ path: "a.mjs", by: 4 }] });
  assert.deepEqual(r.start, [4]);
});

test("edge: a duplicated candidate is considered once", () => {
  const r = pick({ candidates: [issue(4, ["a.mjs"]), issue(4, ["a.mjs"])] });
  assert.deepEqual(r, { start: [4], skipped: [] });
});

test("edge: softPaths accept RegExp objects as well as strings", () => {
  const r = pick({ candidates: [issue(1, ["a.mjs", "NOTES.md"])], claimed: [{ path: "NOTES.md", by: 60 }], softPaths: [/^NOTES\.md$/] });
  assert.deepEqual(r.start, [1]);
});

test("edge: an issue blocked by closed or unknown issues adds no priority", () => {
  const openIssues = [issue(40, ["q.mjs"], [999])];
  const r = pick({ candidates: [issue(3, ["s.mjs"]), issue(2, ["s.mjs"])], openIssues });
  assert.deepEqual(r.start, [2]);
});

test("edge: a cap skip happens only after overlaps are ruled out", () => {
  const r = pick({ candidates: [issue(1, ["a.mjs"]), issue(2, ["a.mjs"]), issue(3, ["c.mjs"])], maxLanes: 1 });
  assert.deepEqual(r.skipped, [
    { number: 2, reason: "overlaps #1 on a.mjs" },
    { number: 3, reason: "cap of 1 lanes reached" },
  ]);
});

test("edge: claimedPaths accepts plain string file lists and skips running issues that already have a PR", () => {
  const claimed = claimedPaths({
    openPrs: [{ number: 70, headRefName: "issue-12-x", files: ["src/a.mjs"] }],
    runningIssues: [issue(12, ["src/c.mjs"]), issue(13, ["src/d.mjs"])],
  });
  assert.deepEqual(claimed, [
    { path: "src/a.mjs", by: 70 },
    { path: "src/d.mjs", by: 13 },
  ]);
});

test("edge: claimedPaths tolerates missing inputs and PRs without files", () => {
  assert.deepEqual(claimedPaths({}), []);
  assert.deepEqual(claimedPaths({ openPrs: [{ number: 1 }], runningIssues: [{ number: 2 }] }), []);
});
