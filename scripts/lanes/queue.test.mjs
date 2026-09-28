// scripts/lanes/queue.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { planTick } from "./queue.mjs";

// A task issue body naming `inPaths` in its Scope and blocked by `blockedBy`.
const body = (inPaths, blockedBy = []) =>
  `### Goal\ng\n### Acceptance criteria\n- [ ] a\n### Interface contract\nnone\n### Scope\nIn: ${inPaths.map((p) => `\`${p}\``).join(", ")}.\nOut: \`elsewhere/x.mjs\`.\n### Blocked by\n${blockedBy.length ? blockedBy.map((n) => `#${n}`).join(", ") : "none"}\n### Tier\nquick\n`;
// An open issue as `gh issue list --json number,labels,body` returns it; `ready` by default.
const issue = (number, inPaths, { blockedBy = [], labels = ["ready", "tier:quick"] } = {}) => ({
  number,
  labels: labels.map((name) => ({ name })),
  body: body(inPaths, blockedBy),
});
const gate = (state, description = "") => ({ context: "lanes/gate", state, description });
// An open lane PR for issue `n`, changing `files`.
const pr = (number, n, files, rollup = [gate("PENDING", "waiting on reviewers")]) => ({
  number,
  headRefName: `issue-${n}-work`,
  files: files.map((path) => ({ path })),
  statusCheckRollup: rollup,
});
const session = (n) => ({ kind: "background", cwd: `/repo/.claude/worktrees/issue-${n}-work` });
const tick = (over = {}) => planTick({ issues: [], prs: [], sessions: [], maxLanes: 3, softPaths: [], ...over });

// Criterion 1
test("planTick returns { launch, waiting, idle, lines } from plain data", () => {
  const out = tick({ issues: [issue(1, ["src/a.mjs"])] });
  assert.deepEqual(Object.keys(out).sort(), ["idle", "launch", "lines", "waiting"]);
  assert.deepEqual(out.launch, [1]);
  assert.deepEqual(out.waiting, []);
  assert.equal(out.idle, false);
  assert.ok(Array.isArray(out.lines) && out.lines.every((l) => typeof l === "string"));
});

test("planTick does no I/O: the module imports nothing that reads or runs anything, and inputs stay untouched", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("./queue.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(src, /node:(child_process|fs|net|http|https)|process\.|fetch\(/);
  const input = { issues: [issue(1, ["src/a.mjs"])], prs: [pr(10, 2, ["src/b.mjs"])], sessions: [session(3)], maxLanes: 3, softPaths: [] };
  const before = JSON.stringify(input);
  assert.deepEqual(planTick(input), planTick(input));
  assert.equal(JSON.stringify(input), before);
});

// Criterion 2
test("candidates are open ready unblocked issues not in flight; launch is pickStartable's start for them", () => {
  const issues = [
    issue(1, ["src/a.mjs"]),
    issue(2, ["src/b.mjs"], { labels: ["tier:quick"] }), // not ready
    issue(3, ["src/c.mjs"], { blockedBy: [1] }), // blocked by open #1
    issue(4, ["src/d.mjs"]), // in flight via its PR
    issue(5, ["src/e.mjs"]), // in flight via its session
    issue(6, ["src/f.mjs"], { blockedBy: [99] }), // blocker closed (not open)
  ];
  const out = tick({ issues, prs: [pr(40, 4, ["src/d.mjs"])], sessions: [session(5)], maxLanes: 8 });
  assert.deepEqual(out.launch, [1, 6]);
});

test("launch respects the global cap counting every lane in flight", () => {
  const issues = [issue(1, ["src/a.mjs"]), issue(2, ["src/b.mjs"]), issue(3, ["src/c.mjs"]), issue(4, ["src/d.mjs"]), issue(9, ["src/z.mjs"], { labels: [] })];
  const out = tick({ issues, prs: [pr(40, 4, ["src/d.mjs"])], sessions: [session(9)], maxLanes: 3 });
  assert.deepEqual(out.launch, [1]);
});

test("launch never overlaps a path claimed in flight, by a PR or by a running issue's Scope", () => {
  const issues = [issue(1, ["src/a.mjs"]), issue(2, ["src/b.mjs"]), issue(3, ["src/b.mjs"]), issue(4, ["src/c.mjs"])];
  const out = tick({ issues, prs: [pr(50, 7, ["src/a.mjs"])], sessions: [session(3)], maxLanes: 8 });
  // #1 overlaps PR #50; #2 overlaps running #3's Scope; #4 is free.
  assert.deepEqual(out.launch, [4]);
});

test("softPaths never count as overlaps", () => {
  const issues = [issue(1, ["README.md", "src/a.mjs"])];
  const out = tick({ issues, prs: [pr(50, 7, ["README.md"])], softPaths: ["^README\\.md$"] });
  assert.deepEqual(out.launch, [1]);
});

// Criterion 3
test("waiting lists each in-flight PR needing review/owner, with the gate's reason", () => {
  const out = tick({ prs: [pr(60, 6, ["src/x.mjs"], [gate("PENDING", "waiting on owner: review/owner")])] });
  assert.deepEqual(out.waiting, [{ number: 60, reason: "waiting on owner: review/owner" }]);
});

test("waiting lists a PR with a failing check or review", () => {
  const out = tick({
    prs: [
      pr(61, 6, ["src/x.mjs"], [{ name: "test", conclusion: "FAILURE" }, gate("PENDING", "waiting on reviewers")]),
      pr(62, 7, ["src/y.mjs"], [{ context: "review/test-hunter", state: "FAILURE" }, gate("PENDING", "waiting on reviewers")]),
    ],
  });
  assert.deepEqual(out.waiting, [
    { number: 61, reason: "failing: test" },
    { number: 62, reason: "failing: review/test-hunter" },
  ]);
});

test("a PR still in review, starting or queued is not waiting on the owner", () => {
  const out = tick({
    prs: [
      pr(63, 6, ["src/x.mjs"]),
      pr(64, 7, ["src/y.mjs"], []),
      { ...pr(65, 8, ["src/z.mjs"], [gate("SUCCESS", "all reviews passed")]), autoMergeRequest: { enabledAt: "t" } },
    ],
  });
  assert.deepEqual(out.waiting, []);
});

// Criterion 4
test("idle only when nothing is in flight and launch is empty", () => {
  assert.equal(tick().idle, true);
  assert.equal(tick({ issues: [issue(1, ["src/a.mjs"], { labels: ["tier:quick"] })] }).idle, true);
  assert.equal(tick({ issues: [issue(1, ["src/a.mjs"])] }).idle, false);
  assert.equal(tick({ sessions: [session(4)], issues: [issue(4, ["src/a.mjs"])] }).idle, false);
  assert.equal(tick({ prs: [pr(60, 6, ["src/x.mjs"], [gate("PENDING", "waiting on owner: review/owner")])] }).idle, false);
});

// Criterion 5
test("depth first: of two candidates conflicting on a file, the one blocking more open work launches", () => {
  const issues = [
    issue(10, ["src/shared.mjs"]),
    issue(20, ["src/shared.mjs"]),
    issue(21, ["src/x.mjs"], { blockedBy: [20] }),
    issue(22, ["src/y.mjs"], { blockedBy: [21] }),
  ];
  const out = tick({ issues, maxLanes: 8 });
  assert.deepEqual(out.launch, [20]);
  assert.ok(out.lines.some((l) => /#10: skipped: overlaps #20 on src\/shared\.mjs/.test(l)));
});

test("an issue skipped for a conflicting PR launches on the next tick once that PR merges", () => {
  const first = tick({ issues: [issue(1, ["src/a.mjs"]), issue(2, ["src/a.mjs"])], prs: [pr(20, 2, ["src/a.mjs"])] });
  assert.deepEqual(first.launch, []);
  // The PR merged: it left the open PRs and closed #2.
  const next = tick({ issues: [issue(1, ["src/a.mjs"])], prs: [] });
  assert.deepEqual(next.launch, [1]);
});

test("an issue that becomes ready between ticks launches on the next tick", () => {
  const before = tick({ issues: [issue(1, ["src/a.mjs"], { labels: ["tier:quick"] })] });
  assert.deepEqual(before.launch, []);
  const after = tick({ issues: [issue(1, ["src/a.mjs"])] });
  assert.deepEqual(after.launch, [1]);
});

test("owner waits do not affect launches", () => {
  const issues = [issue(1, ["src/a.mjs"]), issue(6, ["src/x.mjs"])];
  const waitingPr = pr(60, 6, ["src/x.mjs"], [gate("PENDING", "waiting on owner: review/owner")]);
  const withWait = tick({ issues, prs: [waitingPr] });
  const noWait = tick({ issues, prs: [{ ...waitingPr, statusCheckRollup: [gate("PENDING", "waiting on reviewers")] }] });
  assert.deepEqual(withWait.launch, [1]);
  assert.deepEqual(withWait.launch, noWait.launch);
  assert.equal(withWait.waiting.length, 1);
});

// Edge cases
test("edge: empty snapshot is idle with no launches, waits or skips", () => {
  const out = tick();
  assert.deepEqual(out.launch, []);
  assert.deepEqual(out.waiting, []);
  assert.ok(out.lines.length >= 1);
});

test("edge: a ready issue without exactly one tier:* label is skipped, not launched", () => {
  const out = tick({ issues: [issue(1, ["src/a.mjs"], { labels: ["ready"] }), issue(2, ["src/b.mjs"], { labels: ["ready", "tier:quick", "tier:full"] })] });
  assert.deepEqual(out.launch, []);
  assert.ok(out.lines.some((l) => l === "#1: skipped: no single tier:* label"));
});

test("edge: a malformed Blocked by field keeps the issue out", () => {
  const broken = { number: 1, labels: [{ name: "ready" }, { name: "tier:quick" }], body: body(["src/a.mjs"]).replace("### Blocked by\nnone", "### Blocked by\nsoon") };
  const out = tick({ issues: [broken] });
  assert.deepEqual(out.launch, []);
  assert.ok(out.lines.some((l) => l.startsWith("#1: skipped: ")));
});

test("edge: a closed issue in the snapshot is neither a candidate nor an open blocker", () => {
  const issues = [{ ...issue(1, ["src/a.mjs"]), state: "CLOSED" }, issue(2, ["src/b.mjs"], { blockedBy: [1] })];
  assert.deepEqual(tick({ issues }).launch, [2]);
});

test("edge: labels given as plain strings work like gh's { name } objects", () => {
  const out = tick({ issues: [{ number: 1, labels: ["ready", "tier:quick"], body: body(["src/a.mjs"]) }] });
  assert.deepEqual(out.launch, [1]);
});

test("edge: a leftover session of a closed issue with no open PR is not in flight", () => {
  const out = tick({ sessions: [session(4)] });
  assert.equal(out.idle, true);
  assert.equal(tick({ issues: [issue(1, ["src/a.mjs"])], sessions: [session(4)], maxLanes: 1 }).launch.length, 1);
});

test("edge: a non-lane PR claims its paths but is not in flight or waiting", () => {
  const other = { number: 70, headRefName: "docs-fix", files: [{ path: "src/a.mjs" }], statusCheckRollup: [{ name: "test", conclusion: "FAILURE" }] };
  const out = tick({ issues: [issue(1, ["src/a.mjs"])], prs: [other] });
  assert.deepEqual(out.launch, []);
  assert.deepEqual(out.waiting, []);
  assert.equal(out.idle, true);
});

test("edge: a failing lanes/gate waits on the owner with its description", () => {
  const out = tick({ prs: [pr(66, 6, ["src/x.mjs"], [gate("FAILURE", "tier label missing")])] });
  assert.deepEqual(out.waiting, [{ number: 66, reason: "tier label missing" }]);
});

test("edge: the gate's description falls back to gateDescription when the rollup leaves it out", () => {
  const p = { ...pr(67, 6, ["src/x.mjs"], [{ context: "lanes/gate", state: "PENDING" }]), gateDescription: "waiting on owner: review/owner" };
  assert.deepEqual(tick({ prs: [p] }).waiting, [{ number: 67, reason: "waiting on owner: review/owner" }]);
});

test("edge: maxLanes 0 launches nothing and says the cap is reached", () => {
  const out = tick({ issues: [issue(1, ["src/a.mjs"])], maxLanes: 0 });
  assert.deepEqual(out.launch, []);
  assert.ok(out.lines.some((l) => /#1: skipped: cap of 0 lanes reached/.test(l)));
});

test("edge: missing maxLanes and softPaths fall back to the start defaults", () => {
  const out = planTick({ issues: [issue(1, ["README.md"])], prs: [pr(50, 7, ["README.md"])], sessions: [] });
  assert.deepEqual(out.launch, [1]);
});

test("lines: one per launch, wait and skip, then a summary", () => {
  const issues = [issue(1, ["src/a.mjs"]), issue(2, ["src/a.mjs"]), issue(6, ["src/x.mjs"])];
  const out = tick({ issues, prs: [pr(60, 6, ["src/x.mjs"], [gate("PENDING", "waiting on owner: review/owner")])] });
  assert.deepEqual(out.lines, [
    "#1: launch",
    "#2: skipped: overlaps #1 on src/a.mjs",
    "PR #60: needs the owner: waiting on owner: review/owner",
    "1 in flight, 1 to launch, 1 waiting on the owner",
  ]);
});
