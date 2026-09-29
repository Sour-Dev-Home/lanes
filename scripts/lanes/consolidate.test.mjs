// scripts/lanes/consolidate.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { consolidateGroups, formatGroups, parseArgs } from "./consolidate.mjs";

const body = (inPaths) =>
  `### Goal\ng\n### Acceptance criteria\n- [ ] a\n### Interface contract\nnone\n### Scope\nIn: ${inPaths.map((p) => `\`${p}\``).join(", ")}.\n### Blocked by\nnone\n### Tier\nquick\n`;
const issue = (number, inPaths, labels = ["ready"]) => ({ number, title: `issue ${number}`, labels: labels.map((name) => ({ name })), body: body(inPaths) });
const soft = ["^README\\.md$"];

test("no overlap: no groups", () => {
  assert.deepEqual(consolidateGroups({ issues: [issue(1, ["a.mjs"]), issue(2, ["b.mjs"])], softPaths: soft }), []);
  assert.equal(formatGroups([]), "no merge candidates");
});

test("one pair: a group with the shared path and its issues", () => {
  const [g, ...rest] = consolidateGroups({ issues: [issue(1, ["a.mjs", "x.mjs"]), issue(2, ["a.mjs"]), issue(3, ["c.mjs"])], softPaths: soft });
  assert.equal(rest.length, 0);
  assert.deepEqual(g.issues.map((i) => i.number), [1, 2]);
  assert.deepEqual(g.paths, ["a.mjs"]);
  assert.equal(g.laneFiled, false);
});

test("transitive: A-B and B-C put all three in one group", () => {
  const groups = consolidateGroups({ issues: [issue(1, ["a.mjs"]), issue(2, ["a.mjs", "b.mjs"]), issue(3, ["b.mjs"])], softPaths: soft });
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].issues.map((i) => i.number), [1, 2, 3]);
  assert.deepEqual(groups[0].paths, ["a.mjs", "b.mjs"]);
});

test("an issue without Scope paths is never grouped", () => {
  const bare = (number, b) => ({ number, title: "t", labels: [{ name: "ready" }], body: b });
  assert.deepEqual(consolidateGroups({ issues: [bare(1, "no form"), bare(2, ""), bare(3, undefined)], softPaths: soft }), []);
});

test("edge: only ready and lane-filed issues are read", () => {
  assert.deepEqual(consolidateGroups({ issues: [issue(1, ["a.mjs"]), issue(2, ["a.mjs"], ["bug"])], softPaths: soft }), []);
});

test("a soft-path-only overlap is not grouped", () => {
  assert.deepEqual(consolidateGroups({ issues: [issue(1, ["README.md"]), issue(2, ["README.md"])], softPaths: soft }), []);
});

test("edge: a directory scope overlaps a file inside it", () => {
  const groups = consolidateGroups({ issues: [issue(1, ["docs/"]), issue(2, ["docs/a.md"])], softPaths: soft });
  assert.equal(groups.length, 1);
});

test("--lane-filed keeps only groups with a lane-filed issue", () => {
  const issues = [issue(1, ["a.mjs"]), issue(2, ["a.mjs"]), issue(3, ["b.mjs"]), issue(4, ["b.mjs"], ["lane-filed"])];
  assert.equal(consolidateGroups({ issues, softPaths: soft }).length, 2);
  const only = consolidateGroups({ issues, softPaths: soft, laneFiledOnly: true });
  assert.equal(only.length, 1);
  assert.deepEqual(only[0].issues.map((i) => i.number), [3, 4]);
  assert.equal(only[0].laneFiled, true);
  assert.equal(consolidateGroups({ issues: issues.slice(0, 2), softPaths: soft, laneFiledOnly: true }).length, 0);
});

test("formatGroups prints numbers, titles, shared paths and the lane-filed flag", () => {
  const out = formatGroups(consolidateGroups({ issues: [issue(1, ["a.mjs"], ["lane-filed"]), issue(2, ["a.mjs"])], softPaths: soft }));
  assert.match(out, /#1 issue 1/);
  assert.match(out, /#2 issue 2/);
  assert.match(out, /a\.mjs/);
  assert.match(out, /lane-filed: yes/);
});

test("edge: parseArgs accepts --lane-filed and refuses anything else", () => {
  assert.deepEqual(parseArgs([]), { laneFiledOnly: false });
  assert.deepEqual(parseArgs(["--lane-filed"]), { laneFiledOnly: true });
  assert.throws(() => parseArgs(["--nope"]), /usage/);
});
