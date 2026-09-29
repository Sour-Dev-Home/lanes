// scripts/lanes/queue.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
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

test("planTick does no I/O: its code reads or runs nothing, and inputs stay untouched", async () => {
  // #97: the module now also holds the CLI, so only planTick's own code is checked (owner decision, 2026-09-28).
  const src = planTick.toString();
  assert.doesNotMatch(src,/node:(child_process|fs|net|http|https)|process\.|fetch\(/);
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

// Extra: none of criterion 3's tests feed PRs out of number order, so `waiting`'s sort was never exercised.
test("edge: waiting is sorted by PR number even when the snapshot lists the higher one first", () => {
  const out = tick({
    prs: [
      pr(90, 6, ["src/x.mjs"], [{ name: "test", conclusion: "FAILURE" }]),
      pr(80, 7, ["src/y.mjs"], [{ name: "test", conclusion: "FAILURE" }]),
    ],
  });
  assert.deepEqual(out.waiting.map((w) => w.number), [80, 90]);
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

// #136: a needs-owner issue is never launched, even if it still carries ready
test("a needs-owner issue that still carries ready is skipped, not launched, and says why", () => {
  const out = tick({ issues: [issue(1, ["src/a.mjs"], { labels: ["ready", "needs-owner", "tier:quick"] }), issue(2, ["src/b.mjs"])] });
  assert.deepEqual(out.launch, [2]);
  assert.ok(out.lines.some((l) => l === "#1: skipped: needs-owner"));
});

test("edge: needs-owner without ready is not launched and not listed as skipped", () => {
  const out = tick({ issues: [issue(1, ["src/a.mjs"], { labels: ["needs-owner", "tier:quick"] })] });
  assert.deepEqual(out.launch, []);
  assert.ok(!out.lines.some((l) => l.startsWith("#1:")));
});

test("edge: a needs-owner issue does not claim a lane slot from the cap", () => {
  const out = tick({ maxLanes: 1, issues: [issue(1, ["src/a.mjs"], { labels: ["ready", "needs-owner", "tier:quick"] }), issue(2, ["src/b.mjs"])] });
  assert.deepEqual(out.launch, [2]);
});

test("edge: a ready issue whose label only contains needs-owner in its name is still launched", () => {
  const out = tick({ issues: [issue(1, ["src/a.mjs"], { labels: ["ready", "not-needs-owner", "tier:quick"] })] });
  assert.deepEqual(out.launch, [1]);
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

// #97 (from #122): waiting comes from status.mjs's prStage, so the queue and /status agree on every lane PR.
test("a PR status.mjs puts in the owner or failing stage is exactly one planTick lists in waiting", async () => {
  const { prStage } = await import("./status.mjs");
  const rollups = [
    [gate("PENDING", "waiting on owner: review/owner")], // owner
    [{ name: "test", conclusion: "FAILURE" }, gate("PENDING", "waiting on reviewers")], // failing
    [{ context: "review/security-reviewer", state: "ERROR" }], // failing, no gate yet
    [{ name: "test", conclusion: "TIMED_OUT" }], // failing
    [gate("FAILURE", "tier label missing")], // contract: a failing gate, listed as before
    [gate("PENDING", "waiting on reviewers")], // review
    [gate("PENDING", "waiting for review/test-hunter")], // gate
    [], // starting
    [gate("SUCCESS", "all reviews passed")], // ready
    [{ name: "test", conclusion: "SUCCESS" }, gate("PENDING", "waiting on reviewers")], // review
  ];
  const prs = rollups.map((rollup, i) => pr(100 + i, 10 + i, [`src/p${i}.mjs`], rollup));
  prs.push({ ...pr(120, 30, ["src/q.mjs"], [{ context: "lanes/gate", state: "PENDING" }]), gateDescription: "waiting on owner: review/owner" });
  const listed = new Set(tick({ prs }).waiting.map((w) => w.number));
  const stages = new Map(prs.map((p) => [p.number, prStage(p, undefined, p.gateDescription).stage]));
  for (const p of prs) {
    const stage = stages.get(p.number);
    if (stage === "owner" || stage === "failing") assert.ok(listed.has(p.number), `PR #${p.number} (${stage}) should wait`);
    else if (stage !== "contract") assert.ok(!listed.has(p.number), `PR #${p.number} (${stage}) should not wait`);
  }
  assert.deepEqual([...stages.values()].filter((s) => s === "owner" || s === "failing").length, 5);
  assert.deepEqual(
    tick({ prs }).waiting.map((w) => w.number),
    prs.filter((p) => ["owner", "failing", "contract"].includes(stages.get(p.number))).map((p) => p.number),
  );
});

test("the queue keeps no private copy of the stage logic", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("./queue.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(src, /function ownerWait|const FAILED\b/);
  assert.match(src, /import \{[^}]*\bprStage\b[^}]*\} from "\.\/status\.mjs"/);
});

test("edge: a failing gate with no description still gives a reason", () => {
  assert.deepEqual(tick({ prs: [pr(68, 6, ["src/x.mjs"], [gate("ERROR")])] }).waiting, [{ number: 68, reason: "lanes/gate failed" }]);
});

// --- The CLI (#97): main drives ticks through fake gh, claude, clock and sleep deps. ---

const TICK_MS = 3 * 60 * 1000;
const STAMP = /^\d\d:\d\d:\d\d /;

// A fake GitHub and claude. `world.issues`, `world.prs` and `world.sessions` are read each tick; `onSleep(tickNo)`
// changes them between ticks. A launch adds a background session in the issue's worktree.
function fakeRun(world, { onSleep = () => {}, env = {}, maxTicks = 20, launchFails = () => false, ghFails = () => false, spawnChild = null, labelFails = () => false } = {}) {
  const labeled = [];
  const reapers = [];
  const logs = [];
  const out = [];
  const calls = [];
  const launched = [];
  let clock = Date.UTC(2026, 8, 28, 9, 0, 0);
  let ticks = 0;
  const deps = {
    env,
    gh: (args) => {
      calls.push(["gh", ...args]);
      if (ghFails(ticks)) throw Object.assign(new Error("gh failed"), { stderr: "HTTP 502: Bad Gateway\nmore" });
      if (args[0] === "issue" && args[1] === "edit") {
        if (labelFails(Number(args[2]))) throw Object.assign(new Error("gh failed"), { stderr: "HTTP 403: Forbidden\nmore" });
        labeled.push(Number(args[2]));
        return "";
      }
      if (args[0] === "issue") return JSON.stringify(world.issues);
      if (args[0] === "pr") return JSON.stringify(world.prs);
      if (args[0] === "api") return JSON.stringify({ data: { repository: { pullRequests: { nodes: [] } } } });
      throw new Error(`unexpected gh ${args.join(" ")}`);
    },
    claude: (args, opts) => {
      calls.push(["claude", ...args, opts?.cwd]);
      if (args[0] === "agents") return JSON.stringify(world.sessions);
      const n = Number(args.at(-1).match(/^\/lane (\d+)$/)[1]);
      launched.push({ n, tick: ticks, args });
      if (launchFails(n)) throw Object.assign(new Error("spawn failed"), { stderr: "claude: not logged in" });
      world.sessions.push(session(n));
      return `backgrounded · sess-${n}\n`;
    },
    root: () => "/repo",
    config: () => ({ start: { maxLanes: 3 } }),
    cleanup: () => {
      calls.push(["cleanup"]);
      return [];
    },
    spawn: (cmd, args, options) => {
      const child = spawnChild ? spawnChild(cmd, args, options) : { pid: 4242, on() {}, unref() { this.unrefed = true; } };
      reapers.push({ cmd, args, options, child });
      return child;
    },
    reaperLog: (root, n) => {
      const log = { root, n, fd: 100 + n, closed: false };
      logs.push(log);
      return { fd: log.fd, close: () => (log.closed = true) };
    },
    now: () => clock,
    sleep: async (ms) => {
      assert.equal(ms, TICK_MS);
      clock += ms;
      ticks += 1;
      if (ticks > maxTicks) throw new Error("the queue never stopped");
      onSleep(ticks);
    },
    print: (line) => out.push(line),
  };
  return { deps, out, calls, launched, reapers, logs, labeled, ticks: () => ticks };
}

test("CLI: any argument prints a usage line and exits 2 before reading anything", async () => {
  const { main } = await import("./queue.mjs");
  for (const argv of [["1"], ["--help"], [""]]) {
    const run = fakeRun({ issues: [], prs: [], sessions: [] });
    assert.equal(await main(argv, run.deps), 2);
    assert.equal(run.out.length, 1);
    assert.match(run.out[0], /^usage: /);
    assert.deepEqual(run.calls, []);
  }
});

test("CLI: exits 2 with a one-line reason when CLAUDECODE is set", async () => {
  const { main } = await import("./queue.mjs");
  const run = fakeRun({ issues: [issue(1, ["src/a.mjs"])], prs: [], sessions: [] }, { env: { CLAUDECODE: "1" } });
  assert.equal(await main([], run.deps), 2);
  assert.equal(run.out.length, 1);
  assert.match(run.out[0], /CLAUDECODE/);
  assert.deepEqual(run.calls, []);
});

test("CLI: each tick cleans up first, then reads, launches with claude --bg /lane N and prints time-stamped lines", async () => {
  const { main } = await import("./queue.mjs");
  const world = { issues: [issue(1, ["src/a.mjs"])], prs: [], sessions: [] };
  // #1's lane finishes (issue closed) after the first sleep.
  const run = fakeRun(world, { onSleep: (t) => t === 1 && (world.issues = []) });
  assert.equal(await main([], run.deps), 0);
  const first = run.calls.findIndex((c) => c[0] === "cleanup");
  const firstRead = run.calls.findIndex((c) => c[0] === "gh");
  assert.ok(first >= 0 && first < firstRead, "cleanup runs before the reads");
  assert.deepEqual(run.launched.map((l) => l.n), [1]);
  const launch = run.calls.find((c) => c[0] === "claude" && c.includes("--bg"));
  assert.deepEqual(launch.slice(1, 2), ["--bg"]);
  assert.equal(launch.at(-2), "/lane 1");
  assert.equal(launch.at(-1), "/repo", "launched from the repository root");
  assert.ok(run.out.length > 0 && run.out.every((l) => STAMP.test(l)), run.out.join("\n"));
  assert.ok(run.out.some((l) => / #1: launch$/.test(l)));
  assert.ok(run.out.some((l) => / #1 → sess-1$/.test(l)));
});

test("CLI: exits 0 after three idle ticks in a row, no sooner", async () => {
  const { main } = await import("./queue.mjs");
  const run = fakeRun({ issues: [], prs: [], sessions: [] });
  assert.equal(await main([], run.deps), 0);
  assert.equal(run.ticks(), 2, "three ticks: two sleeps");
  assert.equal(run.calls.filter((c) => c[0] === "cleanup").length, 3);
  assert.match(run.out.at(-1), /idle/);
});

test("CLI: a busy tick resets the idle count", async () => {
  const { main } = await import("./queue.mjs");
  const world = { issues: [], prs: [], sessions: [] };
  // Idle, idle, then a lane launches on tick 2, then idle again: 2 + 1 + 3 ticks, so 5 sleeps.
  const run = fakeRun(world, {
    onSleep: (t) => {
      if (t === 2) world.issues = [issue(5, ["src/e.mjs"])];
      if (t === 3) world.issues = [];
    },
  });
  assert.equal(await main([], run.deps), 0);
  assert.equal(run.ticks(), 5);
});

test("CLI: a failed launch is printed and that issue is not retried for the rest of the run", async () => {
  const { main } = await import("./queue.mjs");
  const world = { issues: [issue(1, ["src/a.mjs"]), issue(2, ["src/b.mjs"])], prs: [], sessions: [] };
  const run = fakeRun(world, { launchFails: (n) => n === 1, onSleep: (t) => t === 2 && (world.issues = world.issues.filter((i) => i.number !== 2)) });
  assert.equal(await main([], run.deps), 0);
  assert.deepEqual(run.launched.map((l) => l.n), [1, 2], "#1 is tried once only");
  assert.ok(run.out.some((l) => / #1: launch failed: claude: not logged in, not retried$/.test(l)), run.out.join("\n"));
});

test("edge: a launch that prints no session id counts as failed and is not retried", async () => {
  const { main } = await import("./queue.mjs");
  const world = { issues: [issue(1, ["src/a.mjs"])], prs: [], sessions: [] };
  const run = fakeRun(world);
  run.deps.claude = (args) => {
    if (args[0] === "agents") return JSON.stringify(world.sessions);
    run.launched.push({ n: 1 });
    return "something else\n";
  };
  assert.equal(await main([], run.deps), 0);
  assert.equal(run.launched.length, 1);
  assert.ok(run.out.some((l) => / #1: launch failed: no session id in output, not retried$/.test(l)));
});

test("CLI: prints each owner wait once per state change, not every tick", async () => {
  const { main } = await import("./queue.mjs");
  const waitingPr = (description) => ({ ...pr(60, 6, ["src/x.mjs"], [gate("PENDING", description)]), title: "Add x" });
  const world = { issues: [issue(6, ["src/x.mjs"], { labels: ["tier:quick"] })], prs: [waitingPr("waiting on owner: review/owner")], sessions: [] };
  const run = fakeRun(world, {
    onSleep: (t) => {
      if (t === 3) world.prs = [waitingPr("waiting on reviewers")];
      if (t === 4) world.prs = [waitingPr("waiting on owner: review/owner")];
      if (t === 6) world.prs[0] = { ...pr(60, 6, ["src/x.mjs"], [{ name: "test", conclusion: "FAILURE" }]), title: "Add x" };
      if (t === 8) (world.prs = []), (world.issues = []);
    },
  });
  assert.equal(await main([], run.deps), 0);
  const waits = run.out.filter((l) => l.includes("#60 ")).map((l) => l.replace(STAMP, ""));
  assert.deepEqual(waits, [
    "  #60 Add x — waiting 0m — waiting on owner: review/owner",
    "  #60 Add x — waiting 0m — waiting on owner: review/owner",
    "  #60 Add x — waiting 6m — failing: test", // the age keeps running when the reason changes
  ]);
});

// #383: the digest is one block per changed tick, with ages from the gate's own time and one /approve line.
test("CLI: prints one grouped digest, oldest first, with ages and a single /approve line, only when something changed", async () => {
  const { main } = await import("./queue.mjs");
  const now = Date.UTC(2026, 8, 28, 9, 0, 0);
  const owner = (number, n, minutesAgo, title) => ({ ...pr(number, n, [`src/${n}.mjs`], [gate("PENDING", "waiting on owner: review/owner")]), title, gateSince: now - minutesAgo * 60_000 });
  const failing = { ...pr(62, 8, ["src/8.mjs"], [{ name: "test", conclusion: "FAILURE" }]), title: "Fix y" };
  const world = { issues: [], prs: [owner(61, 7, 30, "Newer"), owner(60, 6, 190, "Older"), failing], sessions: [] };
  const run = fakeRun(world, { onSleep: (t) => t === 3 && (world.prs = []) });
  const seen = run.deps.gh;
  // The fake GitHub answers the gate query with each PR's gate time.
  run.deps.gh = (args) =>
    args[0] === "api"
      ? JSON.stringify({ data: { repository: { pullRequests: { nodes: world.prs.filter((p) => p.gateSince).map((p) => ({ number: p.number, commits: { nodes: [{ commit: { status: { context: { description: "waiting on owner: review/owner", createdAt: new Date(p.gateSince).toISOString() } } } }] } })) } } } })
      : seen(args);
  assert.equal(await main([], run.deps), 0);
  const block = run.out.map((l) => l.replace(STAMP, "")).filter((l) => /^(waiting on you|  #|\/approve)/.test(l));
  assert.deepEqual(block, [
    "waiting on you (3):",
    "  #60 Older — waiting 3h 10m — waiting on owner: review/owner",
    "  #61 Newer — waiting 30m — waiting on owner: review/owner",
    "  #62 Fix y — waiting 0m — failing: test",
    "/approve 60 61",
  ]);
});

test("waitingDigest caps the /approve line at 10 numbers and lists only PRs waiting on /approve in it", async () => {
  const { waitingDigest } = await import("./queue.mjs");
  const prs = Array.from({ length: 12 }, (_, i) => ({ ...pr(i + 1, i + 1, ["a"], [gate("PENDING", "waiting on owner: review/owner")]), title: `t${i + 1}`, gateSince: 1000 + i }));
  const waiting = prs.map((p) => ({ number: p.number, reason: "waiting on owner: review/owner" }));
  const lines = waitingDigest(prs, waiting, 1000 + 60_000);
  assert.equal(lines[0], "waiting on you (12):");
  assert.equal(lines.length, 14);
  assert.equal(lines.at(-1), "/approve 1 2 3 4 5 6 7 8 9 10");
});

test("edge: waitingDigest prints nothing when nothing waits, and no /approve line when no PR waits on /approve", async () => {
  const { waitingDigest } = await import("./queue.mjs");
  assert.deepEqual(waitingDigest([], [], 5), []);
  const failing = { ...pr(5, 5, ["a"], [{ name: "test", conclusion: "FAILURE" }]), title: "t\u001b[31m" };
  const lines = waitingDigest([failing], [{ number: 5, reason: "failing: te\u001b[2Jst" }], 60_000, new Map([[5, 0]]));
  assert.deepEqual(lines, ["waiting on you (1):", "  #5 t[31m — waiting 1m — failing: te[2Jst"]);
});

test("edge: a PR without a gate time is aged from when the queue first saw it", async () => {
  const { waitingDigest } = await import("./queue.mjs");
  const p = { ...pr(5, 5, ["a"], [gate("PENDING", "waiting on owner: review/owner")]), title: "t" };
  const lines = waitingDigest([p], [{ number: 5, reason: "r" }], 10 * 60_000, new Map([[5, 0]]));
  assert.match(lines[1], /waiting 10m/);
});

test("CLI: a GitHub read failure is printed and retried next tick", async () => {
  const { main } = await import("./queue.mjs");
  const world = { issues: [issue(1, ["src/a.mjs"])], prs: [], sessions: [] };
  const run = fakeRun(world, { ghFails: (t) => t === 0 || t === 2, onSleep: (t) => t === 3 && (world.issues = []) });
  assert.equal(await main([], run.deps), 0);
  assert.deepEqual(run.launched.map((l) => [l.n, l.tick]), [[1, 1]]);
  const failures = run.out.filter((l) => /cannot read GitHub/.test(l));
  assert.equal(failures.length, 2);
  assert.match(failures[0], /HTTP 502: Bad Gateway, retrying next tick$/);
  assert.ok(failures.every((l) => !l.includes("more")), "only the first line of the error");
});

test("CLI: three GitHub read failures in a row exit 1", async () => {
  const { main } = await import("./queue.mjs");
  const run = fakeRun({ issues: [], prs: [], sessions: [] }, { ghFails: () => true });
  assert.equal(await main([], run.deps), 1);
  assert.equal(run.ticks(), 2);
  assert.match(run.out.at(-1), /three .*in a row/);
});

test("edge: failures that are not in a row do not add up to an exit", async () => {
  const { main } = await import("./queue.mjs");
  const world = { issues: [issue(1, ["src/a.mjs"])], prs: [], sessions: [] };
  // Fails on ticks 0, 1, 3, 4: never three in a row. #1 launches on tick 2 and finishes after tick 5.
  const run = fakeRun(world, { ghFails: (t) => [0, 1, 3, 4].includes(t), onSleep: (t) => t === 5 && (world.issues = []) });
  assert.equal(await main([], run.deps), 0);
  assert.deepEqual(run.launched.map((l) => l.n), [1]);
});

test("edge: a cleanup failure is printed and the tick goes on", async () => {
  const { main } = await import("./queue.mjs");
  const world = { issues: [issue(1, ["src/a.mjs"])], prs: [], sessions: [] };
  const run = fakeRun(world, { onSleep: () => (world.issues = []) });
  run.deps.cleanup = () => {
    throw new Error("git worktree list failed");
  };
  assert.equal(await main([], run.deps), 0);
  assert.deepEqual(run.launched.map((l) => l.n), [1]);
  assert.ok(run.out.some((l) => /cleanup failed: git worktree list failed/.test(l)));
});

test("edge: a bad lanes.config.json exits 2 before any tick", async () => {
  const { main } = await import("./queue.mjs");
  const run = fakeRun({ issues: [], prs: [], sessions: [] });
  run.deps.config = () => ({ start: { maxLanes: 0 } });
  assert.equal(await main([], run.deps), 2);
  assert.match(run.out[0], /maxLanes/);
  assert.equal(run.calls.length, 0);
});

test("edge: the config's maxLanes caps the launches", async () => {
  const { main } = await import("./queue.mjs");
  const world = { issues: [1, 2, 3].map((n) => issue(n, [`src/${n}.mjs`])), prs: [], sessions: [] };
  const run = fakeRun(world, { onSleep: (t) => t === 2 && (world.issues = []) });
  run.deps.config = () => ({ start: { maxLanes: 2 } });
  assert.equal(await main([], run.deps), 0);
  assert.deepEqual(run.launched.filter((l) => l.tick === 0).length, 2);
});

test("CLI: conflicting issues launch one after the other, a newly ready issue joins, then three idle ticks end the run", async () => {
  const { main } = await import("./queue.mjs");
  const world = { issues: [issue(1, ["src/a.mjs"]), issue(2, ["src/a.mjs"]), issue(3, ["src/c.mjs"], { labels: ["tier:quick"] })], prs: [], sessions: [] };
  const close = (n) => (world.issues = world.issues.filter((i) => i.number !== n));
  const run = fakeRun(world, {
    onSleep: (t) => {
      if (t === 1) close(1); // #1's lane merged: #2 may start
      if (t === 2) world.issues = world.issues.map((i) => (i.number === 3 ? issue(3, ["src/c.mjs"]) : i)); // #3 made ready
      if (t === 4) (close(2), close(3));
    },
  });
  assert.equal(await main([], run.deps), 0);
  assert.deepEqual(run.launched.map((l) => [l.n, l.tick]), [[1, 0], [2, 1], [3, 2]]);
  // Ticks 0-3 busy, then three idle ticks (4, 5, 6): 6 sleeps.
  assert.equal(run.ticks(), 6);
  assert.ok(run.out.some((l) => /#2: skipped: overlaps #1 on src\/a\.mjs/.test(l)));
});

// Extra case (test-hunter, #97): `claude agents --json` printing something other than a list is not covered by any
// numbered criterion or by the notes' "edge:" list, but readSnapshot has its own guard against it and that guard
// had no test.
test("edge: claude agents --json printing something other than a list is a read failure, retried next tick", async () => {
  const { main } = await import("./queue.mjs");
  const world = { issues: [issue(1, ["src/a.mjs"])], prs: [], sessions: [] };
  let bad = true;
  const run = fakeRun(world, {
    onSleep: (t) => {
      if (t === 1) bad = false;
      if (t === 2) world.issues = [];
    },
  });
  run.deps.claude = (args, opts) => {
    run.calls.push(["claude", ...args, opts?.cwd]);
    if (args[0] === "agents") return bad ? JSON.stringify({ not: "a list" }) : JSON.stringify(world.sessions);
    const n = Number(args.at(-1).match(/^\/lane (\d+)$/)[1]);
    run.launched.push({ n, tick: run.ticks() });
    world.sessions.push(session(n));
    return `backgrounded · sess-${n}\n`;
  };
  assert.equal(await main([], run.deps), 0);
  assert.ok(run.out.some((l) => /cannot read GitHub or the sessions:.*printed no list.*retrying next tick/.test(l)), run.out.join("\n"));
  assert.deepEqual(run.launched.map((l) => l.n), [1], "the issue launches once the sessions can be read again");
});

// Extra case: the same truncation guard queue.mjs copies from start.mjs (a possibly-truncated issue list would hide
// a blocker and let a claim be lost) had no test in this file either.
test("edge: 1000+ open issues is a read failure naming the count, retried next tick", async () => {
  const { main } = await import("./queue.mjs");
  const many = Array.from({ length: 1000 }, (_, i) => issue(i + 1, [`src/${i}.mjs`]));
  const world = { issues: many, prs: [], sessions: [] };
  const run = fakeRun(world, { onSleep: (t) => t === 1 && (world.issues = []) });
  assert.equal(await main([], run.deps), 0);
  assert.ok(run.out.some((l) => /1000\+ open issues: too many to plan from, retrying next tick/.test(l)), run.out.join("\n"));
});

// --- #344: queue-launched lanes get the Git POSIX tools first on PATH, as /start lanes do (#337). ---

// Runs one launch of issue 1 and returns the options each `claude --bg` call received.
async function launchOptions(withLaunchEnv) {
  const { main } = await import("./queue.mjs");
  const world = { issues: [issue(1, ["src/a.mjs"])], prs: [], sessions: [] };
  const run = fakeRun(world, { onSleep: (t) => t === 1 && (world.issues = []) });
  const seen = [];
  const claude = run.deps.claude;
  run.deps.claude = (args, opts) => {
    if (args[0] !== "agents") seen.push(opts);
    return claude(args, opts);
  };
  if (withLaunchEnv) run.deps.launchEnv = withLaunchEnv;
  assert.equal(await main([], run.deps), 0);
  return { seen, out: run.out };
}

test("#344: a launch passes the env from deps.launchEnv to claude --bg and prints its note", async () => {
  const { seen, out } = await launchOptions(() => ({ env: { PATH: "adjusted" }, note: "PATH not adjusted: git not found" }));
  assert.deepEqual(seen.map((o) => o.env), [{ PATH: "adjusted" }]);
  assert.equal(seen[0].cwd, "/repo");
  assert.equal(out.filter((l) => l.endsWith(" #1: PATH not adjusted: git not found")).length, 1, out.join("\n"));
});

test("#344: edge: an adjusted env with no note prints no PATH line", async () => {
  const { out } = await launchOptions(() => ({ env: { PATH: "adjusted" }, note: null }));
  assert.ok(!out.some((l) => /PATH not adjusted/.test(l)), out.join("\n"));
});

test("#344: edge: with no launchEnv (other platforms) claude gets no env option and inherits", async () => {
  const { seen } = await launchOptions(null);
  assert.equal(seen.length, 1);
  assert.ok(!("env" in seen[0]), "no env key");
});

test("#344: edge: an adjusted env with no note prints exactly what no launchEnv prints", async () => {
  const plain = await launchOptions(null);
  const adjusted = await launchOptions(() => ({ env: { PATH: "adjusted" }, note: null }));
  assert.deepEqual(adjusted.out, plain.out);
});

test("#344: edge: launchEnv is not asked when nothing launches, and a two-lane tick notes and passes env for each", async () => {
  const { main } = await import("./queue.mjs");
  const idle = fakeRun({ issues: [], prs: [], sessions: [] }, {});
  let asked = 0;
  idle.deps.launchEnv = () => (asked++, { env: { PATH: "x" }, note: null });
  await main([], idle.deps);
  assert.equal(asked, 0);

  const world = { issues: [issue(1, ["src/a.mjs"]), issue(2, ["src/b.mjs"])], prs: [], sessions: [] };
  const run = fakeRun(world, { onSleep: (t) => t === 1 && (world.issues = []) });
  const seen = [];
  const claude = run.deps.claude;
  run.deps.claude = (args, opts) => (args[0] !== "agents" && seen.push(opts), claude(args, opts));
  run.deps.launchEnv = () => ({ env: { PATH: "p" }, note: "PATH not adjusted: git not found" });
  await main([], run.deps);
  assert.equal(seen.length, 2);
  assert.ok(seen.every((o) => o.env?.PATH === "p"));
  for (const n of [1, 2]) assert.equal(run.out.filter((l) => l.endsWith(` #${n}: PATH not adjusted: git not found`)).length, 1, run.out.join("\n"));
});

// --- #251: queue-launched lanes get the reaper /start starts (ADR 0010). ---

const reapScript = join("/repo", "scripts", "lanes", "reap.mjs");

test("CLI: one detached, unref'd reaper per launched lane, logging to its own log", async () => {
  const { main } = await import("./queue.mjs");
  const world = { issues: [issue(1, ["src/a.mjs"]), issue(2, ["src/b.mjs"])], prs: [], sessions: [] };
  const run = fakeRun(world, { onSleep: (t) => t === 1 && (world.issues = []) });
  assert.equal(await main([], run.deps), 0);
  assert.deepEqual(
    run.reapers.map((r) => [r.cmd, r.args]),
    [
      [process.execPath, [reapScript, "--issue", "1", "--session", "sess-1"]],
      [process.execPath, [reapScript, "--issue", "2", "--session", "sess-2"]],
    ],
  );
  for (const [i, r] of run.reapers.entries()) {
    assert.equal(r.options.detached, true);
    assert.equal(r.options.cwd, "/repo");
    assert.deepEqual(r.options.stdio, ["ignore", run.logs[i].fd, run.logs[i].fd]);
    assert.equal(r.child.unrefed, true);
  }
  assert.deepEqual(run.logs.map((l) => [l.root, l.n, l.closed]), [["/repo", 1, true], ["/repo", 2, true]]);
});

test("CLI: a failed launch starts no reaper", async () => {
  const { main } = await import("./queue.mjs");
  const world = { issues: [issue(1, ["src/a.mjs"]), issue(2, ["src/b.mjs"])], prs: [], sessions: [] };
  const run = fakeRun(world, { launchFails: (n) => n === 1, onSleep: (t) => t === 1 && (world.issues = []) });
  assert.equal(await main([], run.deps), 0);
  assert.deepEqual(run.reapers.map((r) => r.args[2]), ["2"]);
  assert.deepEqual(run.logs.map((l) => l.n), [2]);
});

test("edge: a reaper that cannot start prints one line, and the queue still launches the rest and finishes", async () => {
  const { main } = await import("./queue.mjs");
  for (const spawnChild of [() => { throw new Error("spawn EACCES"); }, () => ({ pid: undefined, on() {}, unref() {} })]) {
    const world = { issues: [issue(1, ["src/a.mjs"]), issue(2, ["src/b.mjs"])], prs: [], sessions: [] };
    const run = fakeRun(world, { spawnChild, onSleep: (t) => t === 1 && (world.issues = []) });
    assert.equal(await main([], run.deps), 0);
    assert.deepEqual(run.launched.map((l) => l.n), [1, 2]);
    assert.equal(run.out.filter((l) => /#1: reaper not started: /.test(l)).length, 1, run.out.join("\n"));
    assert.equal(run.out.filter((l) => /#2: reaper not started: /.test(l)).length, 1);
    assert.ok(run.out.some((l) => /#1 → sess-1/.test(l)));
  }
});

test("edge: a reaper log that cannot be opened prints one line and the launch still stands", async () => {
  const { main } = await import("./queue.mjs");
  const world = { issues: [issue(1, ["src/a.mjs"])], prs: [], sessions: [] };
  const run = fakeRun(world, { onSleep: (t) => t === 1 && (world.issues = []) });
  run.deps.reaperLog = () => { throw new Error("EACCES: permission denied"); };
  assert.equal(await main([], run.deps), 0);
  assert.deepEqual(run.reapers, []);
  assert.equal(run.out.filter((l) => /#1: reaper not started: EACCES/.test(l)).length, 1, run.out.join("\n"));
});

// #361 (ADR 0014): the queue's launch marks the issue lane:running, only after a launch whose session id parsed.
test("CLI: a good launch adds lane:running, a failed launch does not", async () => {
  const { main } = await import("./queue.mjs");
  const world = { issues: [issue(1, ["src/a.mjs"]), issue(2, ["src/b.mjs"])], prs: [], sessions: [] };
  const run = fakeRun(world, { launchFails: (n) => n === 1, onSleep: (t) => t === 2 && (world.issues = []) });
  assert.equal(await main([], run.deps), 0);
  assert.deepEqual(run.labeled, [2]);
});

test("edge: a launch that printed no session id is not labelled", async () => {
  const { main } = await import("./queue.mjs");
  const world = { issues: [issue(1, ["src/a.mjs"])], prs: [], sessions: [] };
  const run = fakeRun(world, { onSleep: (t) => t === 1 && (world.issues = []) });
  const claude = run.deps.claude;
  run.deps.claude = (args, opts) => (args[0] === "agents" ? claude(args, opts) : (claude(args, opts), "started, no id\n"));
  assert.equal(await main([], run.deps), 0);
  assert.deepEqual(run.labeled, []);
});

test("CLI: a label failure is printed, keeps the launch and the reaper, and does not change the exit code", async () => {
  const { main } = await import("./queue.mjs");
  const world = { issues: [issue(1, ["src/a.mjs"])], prs: [], sessions: [] };
  const run = fakeRun(world, { labelFails: () => true, onSleep: (t) => t === 1 && (world.issues = []) });
  assert.equal(await main([], run.deps), 0);
  assert.ok(run.out.some((l) => / #1 → sess-1$/.test(l)), run.out.join("\n"));
  assert.ok(run.out.some((l) => / #1: label not set: HTTP 403: Forbidden$/.test(l)), run.out.join("\n"));
  assert.equal(run.reapers.length, 1);
  assert.deepEqual(run.launched.map((l) => l.n), [1]);
});

// --- #382: a stalled or PR-less lane is stopped and relaunched once, never over unpushed work. ---

const lane = (n, over = {}) => ({ kind: "background", id: `old-${n}`, cwd: `/repo/.claude/worktrees/issue-${n}-work`, status: "busy", startedAt: 1, ...over });

// A queue run with recovery deps over `world`; `opts.workLeft` is the reason work is left (or null), `opts.stalledIssues`
// the issues stalledLanes reports, `opts.markers` a Map of issue → marker. Removing a lane drops its session.
function recoveryRun(world, { workLeft = null, stalledIssues = [], markers = new Map(), stopWorks = true } = {}) {
  const run = fakeRun(world, { onSleep: (t) => t === 3 && (world.issues = []) });
  const stopped = [];
  const removed = [];
  const claude = run.deps.claude;
  run.deps.claude = (args, opts) => {
    if (args[0] !== "stop") return claude(args, opts);
    stopped.push(args[1]);
    return "";
  };
  run.deps.recovery = {
    stalled: () => new Map(stalledIssues.map((n) => [n, 45])),
    worktree: (n) => ({ path: `/repo/.claude/worktrees/issue-${n}-work`, branch: `issue-${n}-work` }),
    workLeft: () => workLeft,
    waitStopped: () => stopWorks,
    remove: (id, tree) => {
      removed.push([id, tree.path]);
      world.sessions = world.sessions.filter((s) => s.id !== id);
    },
    marker: { read: (n) => markers.get(n) ?? null, write: (n, rec) => markers.set(n, rec) },
  };
  return { ...run, stopped, removed, markers };
}

test("#382: a stalled clean lane is stopped, its worktree removed, and the issue relaunched once", async () => {
  const { main } = await import("./queue.mjs");
  const world = { issues: [issue(7, ["src/a.mjs"])], prs: [], sessions: [lane(7)] };
  const run = recoveryRun(world, { stalledIssues: [7] });
  assert.equal(await main([], run.deps), 0);
  assert.deepEqual(run.stopped, ["old-7"]);
  assert.deepEqual(run.removed, [["old-7", "/repo/.claude/worktrees/issue-7-work"]]);
  assert.deepEqual(run.launched.map((l) => l.n), [7]);
  const marker = run.markers.get(7);
  assert.deepEqual([marker.issue, marker.session, marker.reason], [7, "old-7", "stalled for 45 minutes"]);
  assert.ok(Number.isFinite(Date.parse(marker.time)));
});

test("#382: a stalled lane with unpushed work is stopped, left untouched and not relaunched", async () => {
  const { main } = await import("./queue.mjs");
  const world = { issues: [issue(7, ["src/a.mjs"])], prs: [], sessions: [lane(7)] };
  const run = recoveryRun(world, { stalledIssues: [7], workLeft: "1 commit not on any remote" });
  assert.equal(await main([], run.deps), 0);
  assert.deepEqual(run.stopped, ["old-7"]);
  assert.deepEqual(run.removed, []);
  assert.deepEqual(run.launched, []);
  assert.equal(run.out.filter((l) => l.endsWith(" #7: stalled with unpushed work, left for the owner")).length, 1, run.out.join("\n"));
  assert.equal(run.stopped.length, 1, "later ticks leave the stopped lane alone");
});

test("#382: a lane that ended with no open PR is recovered like a stalled one", async () => {
  const { main } = await import("./queue.mjs");
  const world = { issues: [issue(7, ["src/a.mjs"])], prs: [], sessions: [lane(7, { status: "idle" })] };
  const run = recoveryRun(world);
  assert.equal(await main([], run.deps), 0);
  assert.deepEqual(run.removed.map((r) => r[0]), ["old-7"]);
  assert.deepEqual(run.launched.map((l) => l.n), [7]);
  assert.equal(run.markers.get(7).reason, "session ended with no open PR");
});

test("#382: a second stall on an issue with a marker is reported once and never retried", async () => {
  const { main } = await import("./queue.mjs");
  const world = { issues: [issue(7, ["src/a.mjs"])], prs: [], sessions: [lane(7, { id: "new-7" })] };
  const markers = new Map([[7, { issue: 7, session: "old-7", reason: "stalled for 40 minutes", time: "2026-09-29T08:00:00.000Z" }]]);
  const run = recoveryRun(world, { stalledIssues: [7], markers });
  assert.equal(await main([], run.deps), 0);
  assert.deepEqual(run.stopped, []);
  assert.deepEqual(run.removed, []);
  assert.deepEqual(run.launched, []);
  assert.equal(run.out.filter((l) => l.endsWith(" #7: stalled again after recovery: stalled for 45 minutes")).length, 1, run.out.join("\n"));
});

test("#382: a lane with an open PR is never touched, stalled or idle", async () => {
  const { main } = await import("./queue.mjs");
  for (const status of ["busy", "idle"]) {
    const world = { issues: [issue(7, ["src/a.mjs"])], prs: [pr(70, 7, ["src/a.mjs"])], sessions: [lane(7, { status })] };
    const run = recoveryRun(world, { stalledIssues: [7] });
    const sleep = run.deps.sleep;
    run.deps.sleep = async (ms) => { await sleep(ms); if (run.ticks() === 3) { world.prs = []; world.sessions = []; } };
    assert.equal(await main([], run.deps), 0);
    assert.deepEqual([run.stopped, run.removed, run.launched], [[], [], []]);
  }
});

test("#382: edge: a session waiting on a prompt, or an issue that is closed or not ready, is left alone", async () => {
  const { main } = await import("./queue.mjs");
  const cases = [
    [issue(7, ["src/a.mjs"]), lane(7, { status: "idle", state: "blocked" })],
    [issue(7, ["src/a.mjs"], { labels: ["tier:quick"] }), lane(7, { status: "idle" })],
  ];
  for (const [i, s] of cases) {
    const world = { issues: [i], prs: [], sessions: [s] };
    const run = recoveryRun(world);
    assert.equal(await main([], run.deps), 0);
    assert.deepEqual([run.stopped, run.removed], [[], []]);
  }
});

test("#382: edge: a session that will not stop is reported and its worktree left", async () => {
  const { main } = await import("./queue.mjs");
  const world = { issues: [issue(7, ["src/a.mjs"])], prs: [], sessions: [lane(7)] };
  const run = recoveryRun(world, { stalledIssues: [7], stopWorks: false });
  assert.equal(await main([], run.deps), 0);
  assert.deepEqual([run.removed, run.launched], [[], []]);
  assert.ok(run.out.some((l) => / #7: could not stop session old-7, left for the owner$/.test(l)), run.out.join("\n"));
});

test("#382: edge: a lane whose worktree cannot be found is stopped, left for the owner and not relaunched", async () => {
  const { main } = await import("./queue.mjs");
  const world = { issues: [issue(7, ["src/a.mjs"])], prs: [], sessions: [lane(7)] };
  const run = recoveryRun(world, { stalledIssues: [7] });
  run.deps.recovery.worktree = () => null;
  assert.equal(await main([], run.deps), 0);
  assert.deepEqual([run.removed, run.launched], [[], []]);
  assert.ok(run.out.some((l) => / #7: stalled, worktree not found, left for the owner$/.test(l)), run.out.join("\n"));
});

test("#382: edge: the worktree lookup gets the session's cwd", async () => {
  const { main } = await import("./queue.mjs");
  const world = { issues: [issue(7, ["src/a.mjs"])], prs: [], sessions: [lane(7)] };
  const run = recoveryRun(world, { stalledIssues: [7] });
  const seen = [];
  const worktree = run.deps.recovery.worktree;
  run.deps.recovery.worktree = (n, cwd) => (seen.push(cwd), worktree(n, cwd));
  await main([], run.deps);
  assert.deepEqual(seen, ["/repo/.claude/worktrees/issue-7-work"]);
});

test("#382: edge: a session id that is not a plain token is never passed to claude stop", async () => {
  const { main } = await import("./queue.mjs");
  const world = { issues: [issue(7, ["src/a.mjs"])], prs: [], sessions: [lane(7, { id: "--all" })] };
  const run = recoveryRun(world, { stalledIssues: [7] });
  assert.equal(await main([], run.deps), 0);
  assert.deepEqual([run.stopped, run.removed, run.launched], [[], [], []]);
});

test("#382: edge: a failing removal is printed and the issue is not relaunched", async () => {
  const { main } = await import("./queue.mjs");
  const world = { issues: [issue(7, ["src/a.mjs"])], prs: [], sessions: [lane(7)] };
  const run = recoveryRun(world, { stalledIssues: [7] });
  run.deps.recovery.remove = () => { throw Object.assign(new Error("x"), { stderr: "Permission denied\nmore" }); };
  assert.equal(await main([], run.deps), 0);
  assert.deepEqual(run.launched, []);
  assert.ok(run.out.some((l) => / #7: recovery failed: Permission denied$/.test(l)), run.out.join("\n"));
});

test("#382: edge: one attempt per issue per run even when the marker cannot be read back", async () => {
  const { main } = await import("./queue.mjs");
  const world = { issues: [issue(7, ["src/a.mjs"])], prs: [], sessions: [lane(7)] };
  const run = recoveryRun(world, { stalledIssues: [7], workLeft: "uncommitted changes" });
  run.deps.recovery.marker.read = () => null;
  assert.equal(await main([], run.deps), 0);
  assert.deepEqual(run.stopped, ["old-7"]);
});

test("#382: edge: a failing stall check is printed and touches no lane", async () => {
  const { main } = await import("./queue.mjs");
  const world = { issues: [issue(7, ["src/a.mjs"])], prs: [], sessions: [lane(7)] };
  const run = recoveryRun(world);
  run.deps.recovery.stalled = () => { throw new Error("boom\nmore"); };
  assert.equal(await main([], run.deps), 0);
  assert.deepEqual([run.stopped, run.removed], [[], []]);
  assert.ok(run.out.some((l) => / stall check failed: boom$/.test(l)), run.out.join("\n"));
});

test("#382: edge: planRecovery judges only the newest session of an issue, and skips a marker's own session", async () => {
  const { planRecovery } = await import("./queue.mjs");
  const issues = [issue(7, ["src/a.mjs"])];
  const older = lane(7, { id: "old", status: "idle", startedAt: 1 });
  const newer = lane(7, { id: "new", status: "busy", startedAt: 2 });
  assert.deepEqual(planRecovery({ issues, prs: [], sessions: [older, newer] }), []);
  assert.deepEqual(planRecovery({ issues, prs: [], sessions: [newer, older] }), []);
  const idle = lane(7, { id: "same", status: "idle" });
  assert.deepEqual(planRecovery({ issues, prs: [], sessions: [idle], marker: () => ({ session: "same" }) }), []);
  assert.deepEqual(planRecovery({ issues, prs: [], sessions: [idle], marker: () => ({ session: "other" }) }).map((r) => r.again), [true]);
});

// #416: a conflicted lane PR is an owner wait; nothing launches for its issue.
test("a conflicted lane PR is reported once as an owner wait and launches nothing for its issue", () => {
  const conflicted = { ...pr(50, 7, ["a.mjs"]), mergeable: "CONFLICTING" };
  const out = tick({ issues: [issue(7, ["a.mjs"])], prs: [conflicted] });
  assert.deepEqual(out.launch, []);
  assert.deepEqual(out.waiting, [{ number: 50, reason: "conflict: rebase needed" }]);
  assert.equal(out.lines.filter((l) => l.includes("conflict: rebase needed")).length, 1);
});
test("edge: an UNKNOWN mergeable state is not an owner wait", () => {
  const out = tick({ prs: [{ ...pr(50, 7, ["a.mjs"]), mergeable: "UNKNOWN" }] });
  assert.deepEqual(out.waiting, []);
});

// #390
const report = (spent24h, over, lanesOver = []) => ({ spent24h, perNightTokens: 100, over, lanesOver });

test("planTick launches nothing while budgetOver, and does not read the queue as idle", () => {
  const out = tick({ issues: [issue(1, ["src/a.mjs"])], budgetOver: true });
  assert.deepEqual(out.launch, []);
  assert.equal(out.idle, false);
  assert.equal(tick({ issues: [issue(1, ["src/a.mjs"])] }).launch.length, 1);
  assert.equal(tick({ budgetOver: true }).idle, true);
});

test("the queue stops launching over the budget, says so once, and resumes when it drops", async () => {
  const { main } = await import("./queue.mjs");
  const world = { issues: [issue(1, ["src/a.mjs"])], prs: [], sessions: [] };
  const states = [report(150, true), report(160, true), report(40, false)];
  let tickNo = 0;
  const run = fakeRun(world, { onSleep: (t) => t === 3 && (world.issues = []) });
  run.deps.budget = () => states[Math.min(tickNo++, 2)];
  assert.equal(await main([], run.deps), 0);
  assert.equal(run.out.filter((l) => /not launching/.test(l)).length, 1, "said once per state change, not per tick");
  assert.ok(run.out.some((l) => /budget: 150 of 100 tokens in 24 h, not launching/.test(l)));
  assert.ok(run.out.some((l) => /budget: 40 of 100 tokens in 24 h, launching again/.test(l)));
  assert.deepEqual(run.launched.map((l) => l.tick), [2], "launched only once the budget dropped");
});

test("a running lane over its own cap is printed once and never stopped", async () => {
  const { main } = await import("./queue.mjs");
  const world = { issues: [issue(1, ["src/a.mjs"])], prs: [], sessions: [session(1)] };
  const run = fakeRun(world, { onSleep: (t) => t === 2 && (world.issues = []) });
  run.deps.budget = () => report(10, false, [1]);
  await main([], run.deps);
  assert.equal(run.out.filter((l) => /#1: over its 15000000 token budget, left running/.test(l)).length, 1);
  assert.ok(!run.calls.some((c) => c[0] === "claude" && c[1] === "stop"));
});

test("edge: a budget that cannot be read is said once and launches continue", async () => {
  const { main } = await import("./queue.mjs");
  const world = { issues: [issue(1, ["src/a.mjs"])], prs: [], sessions: [] };
  const run = fakeRun(world, { onSleep: (t) => t === 2 && (world.issues = []) });
  run.deps.budget = () => { throw new Error("boom"); };
  await main([], run.deps);
  assert.equal(run.out.filter((l) => /budget: cannot be read \(boom\), not enforced/.test(l)).length, 1);
  assert.equal(run.launched.length, 1);
});

test("edge: a bad budget in lanes.config.json exits 2 before any tick", async () => {
  const { main } = await import("./queue.mjs");
  const run = fakeRun({ issues: [], prs: [], sessions: [] });
  run.deps.config = () => ({ budget: { perLaneTokens: -1 } });
  assert.equal(await main([], run.deps), 2);
  assert.match(run.out[0], /perLaneTokens/);
  assert.equal(run.calls.length, 0);
});
