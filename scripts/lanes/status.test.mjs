import { test } from "node:test";
import assert from "node:assert/strict";
import { render, summarize } from "./status.mjs";

const body = (needs = "nothing") => `Closes #1\n## What changed\nx\n## Contract changes\nnone\n## Tests added\nx\n## Reviewer results\nx\n## Needs the owner\n${needs}\n## Not done\nnothing`;
const gate = (state, description) => ({ __typename: "StatusContext", context: "lanes/gate", state, description });
const pr = (number, rollup, extra = {}) => ({ number, title: `pr ${number}`, body: body(), statusCheckRollup: rollup, autoMergeRequest: null, closingIssuesReferences: [], ...extra });

test("stages come from lanes/gate and failing checks", () => {
  const s = summarize({
    prs: [
      pr(1, [gate("PENDING", "waiting on owner (/approve)")]),
      pr(2, [gate("PENDING", "waiting for review/test-hunter")]),
      pr(3, [gate("SUCCESS", "ok")], { autoMergeRequest: {} }),
      pr(4, [{ __typename: "CheckRun", name: "verify", status: "COMPLETED", conclusion: "FAILURE" }]),
      pr(5, []),
    ],
    issues: [],
    merged: [],
  });
  assert.deepEqual(s.waitingOnOwner.map((i) => i.number), [1]);
  assert.deepEqual(s.inFlight.map((i) => [i.number, i.stage]), [[2, "review"], [3, "queued"], [4, "failing"], [5, "starting"]]);
  assert.match(s.inFlight.find((i) => i.number === 4).note, /verify/);
});

test("a PR whose body needs the owner is waiting on him even mid-review", () => {
  const s = summarize({ prs: [pr(6, [gate("PENDING", "waiting for review/test-hunter")], { body: body("pick a name for the package") })], issues: [], merged: [] });
  assert.deepEqual(s.waitingOnOwner.map((i) => [i.number, i.note]), [[6, "needs: pick a name for the package"]]);
});

const issueBody = (blockedBy = "none") => `### Goal\ng\n### Acceptance criteria\n- [ ] a\n### Interface contract\nnone\n### Scope\ns\n### Blocked by\n${blockedBy}\n### Tier\nquick`;
const issue = (number, blockedBy, { ready = true, tier = "quick" } = {}) => ({
  number,
  title: `issue ${number}`,
  body: issueBody(blockedBy),
  labels: [{ name: `tier:${tier}` }, ...(ready ? [{ name: "ready" }] : [])],
});
const sections = (s) => ({ ready: s.ready.map((i) => i.number), blocked: s.blocked.map((i) => [i.number, i.blockedBy]) });

test("ready issues exclude ones an open PR already closes", () => {
  const s = summarize({
    prs: [pr(7, [], { closingIssuesReferences: [{ number: 10 }, { number: 12 }] })],
    issues: [issue(10), issue(11, "none", { tier: "skip" }), issue(12, "#13"), issue(13, "none", { ready: false })],
    merged: [],
  });
  assert.deepEqual(s.ready.map((i) => [i.number, i.stage]), [[11, "skip"]]);
  assert.deepEqual(s.blocked, []);
});

test("only issues labelled ready are listed; open unlabelled issues still count as blockers", () => {
  const s = summarize({ prs: [], issues: [issue(20, "none", { ready: false }), issue(21, "#20")], merged: [] });
  assert.deepEqual(sections(s), { ready: [], blocked: [[21, [20]]] });
});

test("an issue whose blockers are all closed is ready", () => {
  const s = summarize({ prs: [], issues: [issue(30, "#1, #2"), issue(31)], merged: [] });
  assert.deepEqual(sections(s), { ready: [30, 31], blocked: [] });
});

test("an issue with one open blocker is blocked, with a note naming it", () => {
  const s = summarize({ prs: [], issues: [issue(3), issue(4, "#2, #3", { tier: "full" })], merged: [] });
  assert.deepEqual(sections(s), { ready: [3], blocked: [[4, [3]]] });
  assert.deepEqual(s.blocked[0], { number: 4, title: "issue 4", stage: "full", note: "blocked by #3", blockedBy: [3] });
});

test("blockers are followed transitively, direct blockers first", () => {
  const s = summarize({ prs: [], issues: [issue(40), issue(41, "#40"), issue(42, "#41"), issue(43, "#42, #40")], merged: [] });
  assert.deepEqual(sections(s), { ready: [40], blocked: [[41, [40]], [42, [41, 40]], [43, [42, 40, 41]]] });
  assert.equal(s.blocked[1].note, "blocked by #41, #40");
});

test("a cycle terminates and lists both issues as blocked, the issue itself naming the cycle", () => {
  const s = summarize({ prs: [], issues: [issue(50, "#51"), issue(51, "#50"), issue(52, "#52"), issue(53, "#50")], merged: [] });
  assert.deepEqual(sections(s), { ready: [], blocked: [[50, [51, 50]], [51, [50, 51]], [52, [52]], [53, [50, 51]]] });
});

test("a blocker that is not an open issue (closed, a PR, nonexistent) counts as closed", () => {
  const s = summarize({ prs: [pr(60, [])], issues: [issue(61, "#60"), issue(62, "#999"), issue(63, "#61")], merged: [] });
  assert.deepEqual(sections(s), { ready: [61, 62], blocked: [[63, [61]]] });
});

test("an issue with no body or no Blocked by field is ready", () => {
  const s = summarize({ prs: [], issues: [{ number: 70, title: "t", labels: [{ name: "ready" }] }, { number: 71, title: "u", body: "free text #70", labels: [{ name: "ready" }] }], merged: [] });
  assert.deepEqual(sections(s), { ready: [70, 71], blocked: [] });
});

test("an issue with a null body is ready, same as no body", () => {
  const s = summarize({ prs: [], issues: [{ number: 72, title: "t", body: null, labels: [{ name: "ready" }] }], merged: [] });
  assert.deepEqual(sections(s), { ready: [72], blocked: [] });
});

test("an issue closed by an open PR still counts as an open blocker for others", () => {
  const s = summarize({
    prs: [pr(80, [], { closingIssuesReferences: [{ number: 81 }] })],
    issues: [issue(81), issue(82, "#81")],
    merged: [],
  });
  // #81 itself stays out of both sections (its PR is open), but it still blocks #82 until that PR merges.
  assert.deepEqual(sections(s), { ready: [], blocked: [[82, [81]]] });
});

test("render prints the five sections with counts, BLOCKED after READY TO START", () => {
  const text = render(
    {
      waitingOnOwner: [],
      inFlight: [{ number: 2, title: "t", stage: "review", note: "waiting for review/test-hunter" }],
      ready: [],
      blocked: [{ number: 4, title: "One-command setup", stage: "full", note: "blocked by #3", blockedBy: [3] }],
      merged: [],
    },
    "24h",
  );
  assert.match(text, /WAITING ON YOU \(0\)/);
  assert.match(text, /IN FLIGHT \(1\)\n  #2 \[review\] t — waiting for review\/test-hunter/);
  assert.match(text, /READY TO START \(0\)\n\nBLOCKED \(1\)\n  #4 \[full\] One-command setup — blocked by #3\n\nMERGED, last 24h \(0\)/);
});
