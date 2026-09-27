import { test } from "node:test";
import assert from "node:assert/strict";
import { issuePaths, mergeQueueEntries, pathsOverlap, render, summarize } from "./status.mjs";

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

const stageOf = (s, n) => s.inFlight.find((i) => i.number === n);

test("a PR in the merge queue is queued with its position, even with autoMergeRequest null", () => {
  const s = summarize({ prs: [pr(8, [gate("SUCCESS", "ok")])], issues: [], merged: [], mergeQueue: [{ number: 9, position: 1 }, { number: 8, position: 2 }] });
  assert.deepEqual(stageOf(s, 8), { number: 8, title: "pr 8", stage: "queued", note: "in merge queue, position 2" });
});

test("auto-merge on and not yet in the queue still reads as queued, auto-merge on", () => {
  const s = summarize({ prs: [pr(8, [gate("SUCCESS", "ok")], { autoMergeRequest: {} })], issues: [], merged: [], mergeQueue: [{ number: 9, position: 1 }] });
  assert.deepEqual([stageOf(s, 8).stage, stageOf(s, 8).note], ["queued", "auto-merge on"]);
});

test("a green PR neither queued nor on auto-merge is ready, auto-merge is off", () => {
  const s = summarize({ prs: [pr(8, [gate("SUCCESS", "ok")])], issues: [], merged: [], mergeQueue: [] });
  assert.deepEqual([stageOf(s, 8).stage, stageOf(s, 8).note], ["ready", "auto-merge is off"]);
});

test("no merge queue on the branch behaves as before", () => {
  const prs = [pr(8, [gate("SUCCESS", "ok")]), pr(9, [gate("SUCCESS", "ok")], { autoMergeRequest: {} })];
  for (const mergeQueue of [undefined, null]) {
    const s = summarize({ prs, issues: [], merged: [], mergeQueue });
    assert.deepEqual(s.inFlight.map((i) => [i.number, i.stage, i.note]), [[8, "ready", "auto-merge is off"], [9, "queued", "auto-merge on"]]);
  }
});

test("mergeQueueEntries reads PR numbers and positions from the GraphQL reply, [] when the branch has no queue", () => {
  const reply = { data: { repository: { mergeQueue: { entries: { nodes: [{ state: "QUEUED", position: 1, pullRequest: { number: 7 } }] } } } } };
  assert.deepEqual(mergeQueueEntries(reply), [{ number: 7, position: 1 }]);
  assert.deepEqual(mergeQueueEntries({ data: { repository: { mergeQueue: null } } }), []);
});

test("a PR whose body needs the owner is waiting on him even mid-review", () => {
  const s = summarize({ prs: [pr(6, [gate("PENDING", "waiting for review/test-hunter")], { body: body("pick a name for the package") })], issues: [], merged: [] });
  assert.deepEqual(s.waitingOnOwner.map((i) => [i.number, i.note]), [[6, "needs: pick a name for the package"]]);
});

const issueBody = (blockedBy = "none", scope = "s", contract = "none") =>
  `### Goal\ng\n### Acceptance criteria\n- [ ] a\n### Interface contract\n${contract}\n### Scope\n${scope}\n### Blocked by\n${blockedBy}\n### Tier\nquick`;
const issue = (number, blockedBy, { ready = true, tier = "quick", scope, contract } = {}) => ({
  number,
  title: `issue ${number}`,
  body: issueBody(blockedBy, scope, contract),
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

test("paths overlap when equal or when one is a directory containing the other", () => {
  assert.equal(pathsOverlap(["a/b.mjs"], ["a/b.mjs"]), true);
  assert.equal(pathsOverlap(["a/"], ["a/b/c.mjs"]), true);
  assert.equal(pathsOverlap(["a/b/c.mjs"], ["a/"]), true);
  assert.equal(pathsOverlap(["a/b.mjs"], ["a/c.mjs"]), false);
  assert.equal(pathsOverlap(["ab/"], ["a/b.mjs", "abc/d.mjs"]), false);
});

const hints = (s) => s.ready.map((i) => [i.number, i.parallel, i.overlapsWith, i.note]);
const scoped = (number, scope, extra = {}) => issue(number, "none", { scope, ...extra });

test("disjoint scopes run in parallel", () => {
  const s = summarize({ prs: [], issues: [scoped(90, "In: `a/x.mjs`"), scoped(91, "In: `b/y.mjs`")], merged: [] });
  assert.deepEqual(hints(s), [[90, true, [], "parallel"], [91, true, [], "parallel"]]);
});

test("a shared file makes both one at a time, naming each other", () => {
  const s = summarize({ prs: [], issues: [scoped(92, "In: `a/x.mjs`"), scoped(93, "In: a/x.mjs, `c.md`"), scoped(94, "In: `c.md`")], merged: [] });
  assert.deepEqual(hints(s), [
    [92, false, [93], "one at a time with #93"],
    [93, false, [92, 94], "one at a time with #92, #94"],
    [94, false, [93], "one at a time with #93"],
  ]);
});

test("a directory containing another issue's file overlaps", () => {
  const s = summarize({ prs: [], issues: [scoped(95, "In: `src/`"), scoped(96, "In: `src/app/main.ts`")], merged: [] });
  assert.deepEqual(hints(s), [[95, false, [96], "one at a time with #96"], [96, false, [95], "one at a time with #95"]]);
});

test("a shared contract file overlaps even when the Scope files differ", () => {
  const s = summarize({
    prs: [],
    issues: [scoped(97, "In: `a.mjs`", { contract: "`contracts/api.ts`" }), scoped(98, "In: `b.mjs`", { contract: "`contracts/api.ts`" })],
    merged: [],
  });
  assert.deepEqual(hints(s).map((h) => h.slice(0, 3)), [[97, false, [98]], [98, false, [97]]]);
});

test("an issue whose Scope names no paths is one at a time", () => {
  const s = summarize({ prs: [], issues: [scoped(99, "tidy the docs", { contract: "`x/y.ts`" }), scoped(100, "In: `z.mjs`")], merged: [] });
  assert.deepEqual(hints(s), [[99, false, [], "one at a time (scope names no paths)"], [100, true, [], "parallel"]]);
});

test("a scopeless issue's Interface contract path never leaks into another issue's overlapsWith", () => {
  const s = summarize({
    prs: [],
    issues: [scoped(110, "tidy the docs", { contract: "`shared/thing.mjs`" }), scoped(111, "In: `shared/thing.mjs`")],
    merged: [],
  });
  assert.deepEqual(hints(s), [
    [110, false, [], "one at a time (scope names no paths)"],
    [111, true, [], "parallel"],
  ]);
});

test("paths after Out: never cause an overlap", () => {
  const s = summarize({ prs: [], issues: [scoped(101, "In: `a.mjs`\nOut: `b.mjs`"), scoped(102, "In: `b.mjs`")], merged: [] });
  assert.deepEqual(hints(s).map((h) => h[1]), [true, true]);
});

test("only startable issues are compared; blocked ones get no parallel note", () => {
  const s = summarize({
    prs: [],
    issues: [scoped(103, "In: `a.mjs`"), issue(104, "#103", { scope: "In: `a.mjs`" }), scoped(105, "In: `a.mjs`", { ready: false })],
    merged: [],
  });
  assert.deepEqual(hints(s), [[103, true, [], "parallel"]]);
  assert.equal(s.blocked[0].note, "blocked by #103");
  assert.equal("parallel" in s.blocked[0], false);
});

test("render puts a heuristic disclaimer under READY TO START", () => {
  const text = render(summarize({ prs: [], issues: [scoped(106, "In: `a.mjs`")], merged: [] }), "24h");
  assert.match(text, /READY TO START \(1\)\n  [^\n]*heuristic[^\n]*not a guarantee[^\n]*\n  #106 \[quick\] issue 106 — parallel\n/);
});
