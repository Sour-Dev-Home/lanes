// scripts/lanes/queue.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadBudget } from "./lane-cost.mjs";
import { planTick } from "./queue.mjs";
import { liveLanes } from "./status.mjs";

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
test("planTick returns { launch, waiting, idle, lines, skipped } from plain data", () => {
  const out = tick({ issues: [issue(1, ["src/a.mjs"]), issue(2, ["src/a.mjs"])] });
  assert.deepEqual(Object.keys(out).sort(), ["idle", "launch", "lines", "skipped", "waiting"]);
  assert.deepEqual(out.launch, [1]);
  assert.deepEqual(out.skipped, [{ number: 2, reason: "overlaps #1 on src/a.mjs" }]);
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
  const out = tick({ prs: [pr(60, 6, ["src/x.mjs"], [gate("PENDING", "waiting for a code-owner review in GitHub")])] });
  assert.deepEqual(out.waiting, [{ number: 60, reason: "waiting for a code-owner review in GitHub" }]);
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
  assert.equal(tick({ prs: [pr(60, 6, ["src/x.mjs"], [gate("PENDING", "waiting for a code-owner review in GitHub")])] }).idle, false);
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
  const waitingPr = pr(60, 6, ["src/x.mjs"], [gate("PENDING", "waiting for a code-owner review in GitHub")]);
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

test("edge: a session named other than lane-<N> inside a lane worktree is not that lane (#494)", () => {
  const owner = { ...session(4), name: "owner-session catch-up" };
  // Not in flight: the issue may start; not a leftover: nothing for cleanup to remove.
  assert.equal(tick({ issues: [issue(4, ["src/a.mjs"])], sessions: [owner], maxLanes: 1 }).launch.length, 1);
  assert.equal(tick({ sessions: [owner] }).idle, true);
  const lane = { ...session(4), name: "lane-4" };
  assert.deepEqual(tick({ issues: [issue(4, ["src/a.mjs"])], sessions: [lane], maxLanes: 1 }).launch, [], "a lane-<N> session still holds it");
  const laneAtRoot = { kind: "background", cwd: "/repo", name: "lane-4" };
  assert.deepEqual(tick({ issues: [issue(4, ["src/a.mjs"])], sessions: [laneAtRoot], maxLanes: 1 }).launch, []);
});

test("the budget's per-lane and 24-hour counts leave out a session with another name in a lane worktree (#494)", () => {
  const u = (input, output) => JSON.stringify({ type: "assistant", message: { id: "m", usage: { input_tokens: input, output_tokens: output } } });
  const files = { owner: u(5000, 5000), lane: u(10, 10) };
  const agent = (id, name) => ({ kind: "background", id, name, sessionId: id, cwd: "/repo/.claude/worktrees/issue-4-x", startedAt: 1 });
  const load = (agents) => loadBudget({
    root: "/repo", lanes: liveLanes(agents, "/repo"), perNightTokens: 1000, perLaneTokens: 100, now: Date.now(), home: "/home",
    readCosts: () => "", read: (f) => files[/([^/\\]+)\.jsonl$/.exec(f)[1]],
  });
  const withOwner = load([agent("owner", "owner-session catch-up")]);
  assert.deepEqual([withOwner.spent24h, withOwner.over, withOwner.lanesOver], [0, false, []]);
  const both = load([agent("owner", "owner-session catch-up"), agent("lane", "lane-4")]);
  assert.deepEqual([both.spent24h, both.lanesOver], [20, []]);
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
  const p = { ...pr(67, 6, ["src/x.mjs"], [{ context: "lanes/gate", state: "PENDING" }]), gateDescription: "waiting for a code-owner review in GitHub" };
  assert.deepEqual(tick({ prs: [p] }).waiting, [{ number: 67, reason: "waiting for a code-owner review in GitHub" }]);
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
  const out = tick({ issues, prs: [pr(60, 6, ["src/x.mjs"], [gate("PENDING", "waiting for a code-owner review in GitHub")])] });
  assert.deepEqual(out.lines, [
    "#1: launch",
    "#2: skipped: overlaps #1 on src/a.mjs",
    "PR #60: needs the owner: waiting for a code-owner review in GitHub",
    "1 in flight, 1 to launch, 1 waiting on the owner",
  ]);
});

// #97 (from #122): waiting comes from status.mjs's prStage, so the queue and /status agree on every lane PR.
test("a PR status.mjs puts in the owner or failing stage is exactly one planTick lists in waiting", async () => {
  const { prStage } = await import("./status.mjs");
  const rollups = [
    [gate("PENDING", "waiting for a code-owner review in GitHub")], // owner
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
  prs.push({ ...pr(120, 30, ["src/q.mjs"], [{ context: "lanes/gate", state: "PENDING" }]), gateDescription: "waiting for a code-owner review in GitHub" });
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
const IDLE_TICK_MS = 15 * 60 * 1000;
const STAMP = /^\d\d:\d\d:\d\d /;
const QUEUE_TEAM = { profile: "team", app: { id: 11, installationId: 22, botLogin: "sour-dev-lanes[bot]" } };

// The team profile's owner-side steps (start.mjs's `teamSteps`), faked; `removed` collects the directories removed.
function fakeTeamSteps({ key = "/keys/app.pem", mintFail = false, botIdFail = false, removed = [] } = {}) {
  return {
    keyFile: () => key,
    readable: () => {},
    repo: () => "lanes",
    makeDir: (n) => ({ dir: `/tmp/lane-${n}`, emptyConfig: `/tmp/lane-${n}/empty` }),
    removeDir: (dir) => removed.push(dir),
    writeSettings: () => {},
    mintInto: () => {
      if (mintFail) throw new Error("HTTP 401");
    },
    botUserId: () => {
      if (botIdFail) throw new Error("HTTP 401");
      return "336249257";
    },
  };
}

// A fake GitHub and claude. `world.issues`, `world.prs` and `world.sessions` are read each tick; `onSleep(tickNo)`
// changes them between ticks. A launch adds a background session in the issue's worktree.
function fakeRun(world, { onSleep = () => {}, env = {}, maxTicks = 20, launchFails = () => false, ghFails = () => false, spawnChild = null, labelFails = () => false, recordFails = false, idleContinues = false } = {}) {
  const sleeps = [];
  const recorded = [];
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
      if (args[0] === "api") return JSON.stringify({ data: { repository: { pullRequests: { nodes: world.gateNodes ?? [] } } } });
      if (args[0] === "run" && world.runs) return JSON.stringify(world.runs);
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
    // ADR 0025: team is the only profile, so every fake run is a team run with the team steps faked.
    config: () => ({ start: { maxLanes: 3 }, identity: QUEUE_TEAM }),
    team: fakeTeamSteps(),
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
    // ADR 0026: the queue never exits when idle, so a test run ends at the first long idle sleep (as Ctrl+C would), or
    // when `onSleep` throws a QUEUE_STOP error; that sleep is not counted as a tick.
    sleep: async (ms) => {
      sleeps.push(ms);
      if (ms === IDLE_TICK_MS && !idleContinues) throw Object.assign(new Error("stop"), { code: "QUEUE_STOP" });
      clock += ms;
      ticks += 1;
      if (ticks > maxTicks) throw new Error("the queue never stopped");
      onSleep(ticks);
    },
    print: (line) => out.push(line),
    // #483: what the queue asked to record, as [root, line] pairs; `recordFails` makes every write throw.
    recordStarts: (root, lines) => {
      if (recordFails) throw new Error("EACCES");
      for (const line of lines) recorded.push([root, line]);
    },
  };
  return { deps, out, calls, launched, reapers, logs, labeled, recorded, sleeps, ticks: () => ticks };
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

// ADR 0030 parts 1 and 3 (#675): the queue refuses inside Claude (each variable) and from a lane worktree's copy, with
// the one message and exit 2, before it reads or launches anything; a plain run is unaffected.
const REFUSAL = "lanes are launched only by the owner's queue in their own terminal (ADR 0030)";

test("CLI: exits 2 with the one-line refusal when CLAUDECODE or CLAUDE_CODE_CHILD_SESSION is set, each on its own", async () => {
  const { main } = await import("./queue.mjs");
  for (const env of [{ CLAUDECODE: "1" }, { CLAUDE_CODE_CHILD_SESSION: "1" }]) {
    const run = fakeRun({ issues: [issue(1, ["src/a.mjs"])], prs: [], sessions: [] }, { env });
    assert.equal(await main([], run.deps), 2, JSON.stringify(env));
    assert.deepEqual(run.out, [REFUSAL]);
    assert.deepEqual(run.calls, []);
  }
});

test("CLI: a queue.mjs under .claude/worktrees exits 2 with the refusal, whatever the working directory is", async () => {
  const { main } = await import("./queue.mjs");
  for (const file of ["/repo/.claude/worktrees/issue-5-x/scripts/lanes/queue.mjs", "file:///repo/.claude/worktrees/issue-5-x/scripts/lanes/queue.mjs", "C:\\repo\\.claude\\worktrees\\issue-5-x\\scripts\\lanes\\queue.mjs"]) {
    const run = fakeRun({ issues: [issue(1, ["src/a.mjs"])], prs: [], sessions: [] });
    assert.equal(await main([], { ...run.deps, file }), 2, file);
    assert.deepEqual(run.out, [REFUSAL]);
    assert.deepEqual(run.calls, []);
  }
});

test("CLI: a plain run from the main checkout is not refused, and the refusal comes before the usage check", async () => {
  const { main } = await import("./queue.mjs");
  const world = { issues: [issue(1, ["src/a.mjs"])], prs: [], sessions: [] };
  const plain = fakeRun(world, { onSleep: (t) => t === 1 && (world.issues = []) });
  assert.equal(await main([], { ...plain.deps, file: "file:///repo/scripts/lanes/queue.mjs" }), 0);
  assert.ok(!plain.out.includes(REFUSAL));
  const withArgs = fakeRun({ issues: [], prs: [], sessions: [] }, { env: { CLAUDECODE: "1" } });
  assert.equal(await main(["x"], withArgs.deps), 2);
  assert.deepEqual(withArgs.out, [REFUSAL]);
});

// #675: /start is gone, so the recovery for a lane with an idle session and no PR is to stop it; the queue then
// relaunches the issue (status.mjs names that recovery).
test("CLI: an issue whose idle lane session has no PR is not launched while the session lives, and is relaunched once it is stopped", async () => {
  const { main } = await import("./queue.mjs");
  const world = { issues: [issue(1, ["src/a.mjs"])], prs: [], sessions: [{ ...session(1), id: "idle-1", status: "idle", state: "done" }] };
  const run = fakeRun(world, {
    onSleep: (t) => {
      if (t === 1) world.sessions = []; // `claude stop idle-1`, as /status says
      if (t === 3) world.issues = [];
    },
  });
  assert.equal(await main([], run.deps), 0, run.out.join("\n"));
  assert.deepEqual(run.launched.map((l) => [l.n, l.tick >= 1]), [[1, true]], "launched once, only after the session was gone");
  assert.equal(run.launched[0].args.at(-1), "/lane 1");
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

// #577: the queue passes each issue's label names to launchLane, as /start does.
const modelArg = (args) => args[args.indexOf("--model") + 1];
async function queuedLaunch(labels) {
  const { main } = await import("./queue.mjs");
  const world = { issues: [issue(1, ["src/a.mjs"], { labels })], prs: [], sessions: [] };
  const run = fakeRun(world, { onSleep: (t) => t === 1 && (world.issues = []) });
  assert.equal(await main([], run.deps), 0);
  assert.equal(run.launched.length, 1);
  return run;
}

test("#577: a model:opus issue launches with --model opus over the tier's model", async () => {
  const run = await queuedLaunch(["ready", "tier:quick", "model:opus"]);
  assert.equal(modelArg(run.launched[0].args), "opus");
  assert.ok(!run.out.some((l) => l.includes("ignored label")), run.out.join("\n"));
});

test("#577: another model:* label is logged once and ignored", async () => {
  const plain = await queuedLaunch(["ready", "tier:quick"]);
  const run = await queuedLaunch(["ready", "tier:quick", "model:haiku"]);
  assert.deepEqual(run.launched[0].args, plain.launched[0].args);
  assert.equal(run.out.filter((l) => l.endsWith(" #1: ignored label model:haiku")).length, 1, run.out.join("\n"));
});

test("#577: edge: an issue with no model:* label launches with the same arguments and no ignored-label line", async () => {
  const run = await queuedLaunch(["ready", "tier:quick"]);
  assert.notEqual(modelArg(run.launched[0].args), "opus");
  assert.ok(!run.out.some((l) => l.includes("ignored label")), run.out.join("\n"));
});

test("#577: edge: model:opus alongside another model:* label still launches on Opus and logs the other", async () => {
  const run = await queuedLaunch(["ready", "tier:quick", "model:opus", "model:haiku"]);
  assert.equal(modelArg(run.launched[0].args), "opus");
  assert.equal(run.out.filter((l) => l.endsWith(" #1: ignored label model:haiku")).length, 1);
});

test("#577: a resumed lane (#444) launches with its issue's labels too", async () => {
  const { main } = await import("./queue.mjs");
  const world = { issues: [{ ...issue(7, ["src/a.mjs"], { labels: ["ready", "tier:quick", "model:opus"] }) }], prs: [gatePr(70, 7, "waiting for review/security-reviewer")], sessions: [idleLane(7)] };
  const run = recoveryRun(world);
  assert.equal(await main([], run.deps), 0);
  assert.deepEqual(run.launched.map((l) => l.n), [7]);
  assert.equal(modelArg(run.launched[0].args), "opus");
});

test("CLI: the tick lengthens to 15 minutes after three idle ticks in a row, no sooner, and prints nothing new", async () => {
  const { main } = await import("./queue.mjs");
  const run = fakeRun({ issues: [], prs: [], sessions: [] });
  assert.equal(await main([], run.deps), 0);
  assert.deepEqual(run.sleeps, [TICK_MS, TICK_MS, IDLE_TICK_MS]);
  assert.equal(run.calls.filter((c) => c[0] === "cleanup").length, 3);
  assert.ok(!run.out.some((l) => /idle for|stopping/.test(l)));
});

test("CLI: an idle queue keeps polling at 15 minutes and returns to 3 minutes when work is picked", async () => {
  const { main } = await import("./queue.mjs");
  const world = { issues: [], prs: [], sessions: [] };
  const run = fakeRun(world, {
    idleContinues: true,
    maxTicks: 8,
    onSleep: (t) => {
      if (t === 5) world.issues = [issue(5, ["src/e.mjs"])];
      if (t === 6) world.issues = [];
      if (t === 7) throw Object.assign(new Error("stop"), { code: "QUEUE_STOP" });
    },
  });
  assert.equal(await main([], run.deps), 0);
  // Ticks 0-2 idle (the third sleeps long), long again, then #5 launches on tick 5, then 3 minutes until idle again.
  assert.deepEqual(run.sleeps.slice(0, 6), [TICK_MS, TICK_MS, IDLE_TICK_MS, IDLE_TICK_MS, IDLE_TICK_MS, TICK_MS]);
  assert.deepEqual(run.launched.map((l) => l.n), [5]);
  assert.ok(run.sleeps.slice(5).every((ms) => ms === TICK_MS || ms === IDLE_TICK_MS));
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
  const world = { issues: [issue(6, ["src/x.mjs"], { labels: ["tier:quick"] })], prs: [waitingPr("waiting for a code-owner review in GitHub")], sessions: [] };
  const run = fakeRun(world, {
    onSleep: (t) => {
      if (t === 3) world.prs = [waitingPr("waiting on reviewers")];
      if (t === 4) world.prs = [waitingPr("waiting for a code-owner review in GitHub")];
      if (t === 6) world.prs[0] = { ...pr(60, 6, ["src/x.mjs"], [{ name: "test", conclusion: "FAILURE" }]), title: "Add x" };
      if (t === 8) (world.prs = []), (world.issues = []);
    },
  });
  assert.equal(await main([], run.deps), 0);
  const waits = run.out.filter((l) => l.includes("#60 ")).map((l) => l.replace(STAMP, ""));
  assert.deepEqual(waits, [
    "  #60 Add x — waiting 0m — waiting for a code-owner review in GitHub",
    "  #60 Add x — waiting 0m — waiting for a code-owner review in GitHub",
    "  #60 Add x — waiting 6m — failing: test", // the age keeps running when the reason changes
  ]);
});

// #383: the digest is one block per changed tick, with ages from the gate's own time and one /approve line.
test("CLI: prints one grouped digest, oldest first, with ages and no /approve line under team, only when something changed", async () => {
  const { main } = await import("./queue.mjs");
  const now = Date.UTC(2026, 8, 28, 9, 0, 0);
  const owner = (number, n, minutesAgo, title) => ({ ...pr(number, n, [`src/${n}.mjs`], [gate("PENDING", "waiting for a code-owner review in GitHub")]), title, gateSince: now - minutesAgo * 60_000 });
  const failing = { ...pr(62, 8, ["src/8.mjs"], [{ name: "test", conclusion: "FAILURE" }]), title: "Fix y" };
  const world = { issues: [], prs: [owner(61, 7, 30, "Newer"), owner(60, 6, 190, "Older"), failing], sessions: [] };
  const run = fakeRun(world, { onSleep: (t) => t === 3 && (world.prs = []) });
  const seen = run.deps.gh;
  // The fake GitHub answers the gate query with each PR's gate time.
  run.deps.gh = (args) =>
    args[0] === "api"
      ? JSON.stringify({ data: { repository: { pullRequests: { nodes: world.prs.filter((p) => p.gateSince).map((p) => ({ number: p.number, commits: { nodes: [{ commit: { status: { context: { description: "waiting for a code-owner review in GitHub", createdAt: new Date(p.gateSince).toISOString() } } } }] } })) } } } })
      : seen(args);
  assert.equal(await main([], run.deps), 0);
  const block = run.out.map((l) => l.replace(STAMP, "")).filter((l) => /^(waiting on you|  #|\/approve)/.test(l));
  assert.deepEqual(block, [
    "waiting on you (3):",
    "  #60 Older — waiting 3h 10m — waiting for a code-owner review in GitHub",
    "  #61 Newer — waiting 30m — waiting for a code-owner review in GitHub",
    "  #62 Fix y — waiting 0m — failing: test",
  ]);
});

test("waitingDigest lists every waiting PR and never prints an /approve line", async () => {
  const { waitingDigest } = await import("./queue.mjs");
  const prs = Array.from({ length: 12 }, (_, i) => ({ ...pr(i + 1, i + 1, ["a"], [gate("PENDING", "waiting for a code-owner review in GitHub")]), title: `t${i + 1}`, gateSince: 1000 + i }));
  const waiting = prs.map((p) => ({ number: p.number, reason: "waiting for a code-owner review in GitHub" }));
  const lines = waitingDigest(prs, waiting, 1000 + 60_000);
  assert.equal(lines[0], "waiting on you (12):");
  assert.equal(lines.length, 13);
  assert.ok(!lines.join("\n").includes("/approve"));
});

test("edge: waitingDigest prints nothing when nothing waits, and no /approve line when no PR waits on the owner", async () => {
  const { waitingDigest } = await import("./queue.mjs");
  assert.deepEqual(waitingDigest([], [], 5), []);
  const failing = { ...pr(5, 5, ["a"], [{ name: "test", conclusion: "FAILURE" }]), title: "t\u001b[31m" };
  const lines = waitingDigest([failing], [{ number: 5, reason: "failing: te\u001b[2Jst" }], 60_000, new Map([[5, 0]]));
  assert.deepEqual(lines, ["waiting on you (1):", "  #5 t[31m — waiting 1m — failing: te[2Jst"]);
});

test("edge: a PR without a gate time is aged from when the queue first saw it", async () => {
  const { waitingDigest } = await import("./queue.mjs");
  const p = { ...pr(5, 5, ["a"], [gate("PENDING", "waiting for a code-owner review in GitHub")]), title: "t" };
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
  assert.match(failures[0], /HTTP 502: Bad Gateway, retrying in 1 min$/);
  assert.ok(failures.every((l) => !l.includes("more")), "only the first line of the error");
});

test("CLI: read failures back off 1, 2, 4, 8 minutes, cap at 15 and never exit, one line each naming the delay", async () => {
  const { main } = await import("./queue.mjs");
  const stopAt = 8;
  const run = fakeRun({ issues: [], prs: [], sessions: [] }, { ghFails: () => true, idleContinues: true, onSleep: (t) => {
    if (t === stopAt) throw Object.assign(new Error("stop"), { code: "QUEUE_STOP" });
  } });
  assert.equal(await main([], run.deps), 0);
  const min = 60_000;
  assert.deepEqual(run.sleeps, [1, 2, 4, 8, 15, 15, 15, 15].map((m) => m * min));
  const lines = run.out.filter((l) => /cannot read GitHub/.test(l));
  assert.equal(lines.length, 8);
  assert.match(lines[0], /retrying in 1 min$/);
  assert.match(lines[3], /retrying in 8 min$/);
  assert.match(lines[7], /retrying in 15 min$/);
});

test("CLI: a successful read resets the backoff to 1 minute", async () => {
  const { main } = await import("./queue.mjs");
  const run = fakeRun({ issues: [], prs: [], sessions: [] }, { ghFails: (t) => t < 3 || t === 4, maxTicks: 6 });
  assert.equal(await main([], run.deps), 0);
  // Fails at ticks 0-2 (1, 2, 4 min), succeeds at 3 (3 min), fails at 4 (1 min again).
  assert.deepEqual(run.sleeps.slice(0, 5).map((ms) => ms / 60_000), [1, 2, 4, 3, 1]);
});

test("backoffMs doubles from 1 minute, caps at 15 and treats 0 as the first failure", async () => {
  const { backoffMs } = await import("./queue.mjs");
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 50].map((n) => backoffMs(n) / 60_000), [1, 1, 2, 4, 8, 15, 15, 15]);
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
  run.deps.config = () => ({ start: { maxLanes: 0 }, identity: QUEUE_TEAM });
  assert.equal(await main([], run.deps), 2);
  assert.match(run.out[0], /maxLanes/);
  assert.equal(run.calls.length, 0);
});

// #556: the queue launches team lanes through start.mjs's launchLane, with the team steps faked.
function teamQueueRun(world, { key = "/keys/app.pem", mintFail = false, botIdFail = false, noTeam = false, onSleep, launchEnvNote = null } = {}) {
  const run = fakeRun(world, { onSleep });
  const removed = [];
  const envs = [];
  run.deps.config = () => ({ start: { maxLanes: 3 }, identity: QUEUE_TEAM });
  run.deps.launchEnv = () => ({ env: { PATH: "/bin", GH_TOKEN: "owner-token", LANES_APP_KEY_FILE: key ?? "" }, note: launchEnvNote });
  const claude = run.deps.claude;
  run.deps.claude = (args, opts) => {
    if (args[0] !== "agents") envs.push(opts.env);
    return claude(args, opts);
  };
  run.deps.team = noTeam ? undefined : fakeTeamSteps({ key, mintFail, botIdFail, removed });
  return { ...run, removed, envs };
}

test("#556: a team launch through the queue carries --settings and --strict-mcp-config and starts the refresher", async () => {
  const { main } = await import("./queue.mjs");
  const world = { issues: [issue(1, ["src/a.mjs"])], prs: [], sessions: [] };
  const run = teamQueueRun(world, { onSleep: (t) => t === 1 && (world.issues = []) });
  assert.equal(await main([], run.deps), 0);
  assert.deepEqual(run.launched.map((l) => l.n), [1]);
  const args = run.launched[0].args;
  assert.equal(args[args.indexOf("--settings") + 1], join("/tmp/lane-1", "settings.json"));
  assert.ok(args.includes("--strict-mcp-config"));
  assert.equal(args.includes("--mcp-config"), false);
  // The lane's environment is the App-only one: no owner token, no key file, its own gh directory.
  assert.equal(run.envs[0].GH_TOKEN, undefined);
  assert.equal(run.envs[0].LANES_APP_KEY_FILE, undefined);
  assert.equal(run.envs[0].GH_CONFIG_DIR, "/tmp/lane-1");
  const refresher = run.reapers.filter((r) => r.args.includes("--refresh-token"));
  assert.equal(refresher.length, 1);
  assert.deepEqual(refresher[0].args, [join("/repo", "scripts", "lanes", "start.mjs"), "--refresh-token", "--issue", "1", "--session", "sess-1", "--dir", "/tmp/lane-1", "--app", "11", "--installation", "22", "--repo", "lanes"]);
  assert.equal(run.reapers.filter((r) => r.args[0] === reapScript).length, 1, "the reaper still starts too");
  assert.ok(run.out.some((l) => /#1 → sess-1$/.test(l)));
  assert.ok(run.out.every((l) => !/refuses/.test(l)));
});

// #595 (ADR 0023 part 5): the queue passes each issue's Scope paths, so team prints the workflow note and still launches.
const WF_NOTE_1 = "#1: Scope names .github/workflows/: the lane opens its PR without the workflow change and hands it over in a PR comment";
test("#595: a team launch through the queue notes a Scope that names .github/workflows/ and still launches", async () => {
  const { main } = await import("./queue.mjs");
  const world = { issues: [issue(1, [".github/workflows/lanes-gate.yml"])], prs: [], sessions: [] };
  const run = teamQueueRun(world, { onSleep: (t) => t === 1 && (world.issues = []) });
  assert.equal(await main([], run.deps), 0);
  assert.deepEqual(run.launched.map((l) => l.n), [1]);
  assert.equal(run.out.filter((l) => l.endsWith(WF_NOTE_1)).length, 1, run.out.join("\n"));
});

test("#595: edge: team without a workflow path in Scope prints no note", async () => {
  const { main } = await import("./queue.mjs");
  const teamWorld = { issues: [issue(1, ["src/a.mjs"])], prs: [], sessions: [] };
  const team = teamQueueRun(teamWorld, { onSleep: (t) => t === 1 && (teamWorld.issues = []) });
  assert.equal(await main([], team.deps), 0);
  assert.equal(team.out.some((l) => l.includes("Scope names .github/workflows/")), false);
});

for (const [name, opts, step] of [
  ["no LANES_APP_KEY_FILE", { key: "" }, "LANES_APP_KEY_FILE is not set"],
  ["a mint failure", { mintFail: true }, "token mint failed: HTTP 401"],
  ["a bot id lookup failure", { botIdFail: true }, "could not read the App bot's user id for its commit identity"],
]) {
  test(`#556: under team, ${name} skips the issue with the launcher's reason, launches nothing and never retries it`, async () => {
    const { main } = await import("./queue.mjs");
    const world = { issues: [issue(1, ["src/a.mjs"])], prs: [], sessions: [] };
    const run = teamQueueRun(world, opts);
    assert.equal(await main([], run.deps), 0);
    assert.deepEqual(run.launched, [], "nothing launched, so never with the owner's environment");
    assert.equal(run.out.filter((l) => l.endsWith(`#1: launch failed: team profile: ${step}`)).length, 1, run.out.join("\n"));
    assert.deepEqual(run.reapers, []);
    assert.deepEqual(run.labeled, []);
  });
}

test("#556: edge: under team with no team steps at all the queue fails closed", async () => {
  const { main } = await import("./queue.mjs");
  const world = { issues: [issue(1, ["src/a.mjs"])], prs: [], sessions: [] };
  const run = teamQueueRun(world, { noTeam: true });
  assert.equal(await main([], run.deps), 0);
  assert.deepEqual(run.launched, []);
  assert.ok(run.out.some((l) => l.endsWith("#1: launch failed: team profile: not supported here")));
});

test("#556: edge: a launch that prints no id under team removes the lane's directory and starts no refresher", async () => {
  const { main } = await import("./queue.mjs");
  const world = { issues: [issue(1, ["src/a.mjs"])], prs: [], sessions: [] };
  const run = teamQueueRun(world);
  const claude = run.deps.claude;
  run.deps.claude = (args, opts) => (args[0] === "agents" ? claude(args, opts) : (run.launched.push({ n: 1, args }), "no id here"));
  assert.equal(await main([], run.deps), 0);
  assert.deepEqual(run.removed, ["/tmp/lane-1"]);
  assert.deepEqual(run.reapers, []);
  assert.ok(run.out.some((l) => l.endsWith("#1: launch failed: no session id in output, not retried")));
});

test("#556: edge: the queue's PATH note still prints once per team launch", async () => {
  const { main } = await import("./queue.mjs");
  const world = { issues: [issue(1, ["src/a.mjs"])], prs: [], sessions: [] };
  const run = teamQueueRun(world, { launchEnvNote: "PATH note", onSleep: (t) => t === 1 && (world.issues = []) });
  assert.equal(await main([], run.deps), 0);
  assert.equal(run.out.filter((l) => l.endsWith("#1: PATH note")).length, 1);
});

// #613 (ADR 0025): a config whose identity is not team stops the queue first, with the one message, before any read.
test("#613: a missing identity, solo, an unknown profile and a missing config stop the queue first with the one message", async () => {
  const { main } = await import("./queue.mjs");
  const { TEAM_REQUIRED_MESSAGE } = await import("./lib.mjs");
  for (const [config, found] of [
    [{ start: { maxLanes: 3 } }, "no identity profile"],
    [{ identity: { profile: "solo" } }, 'profile "solo"'],
    [{ identity: { profile: "solo", app: { id: 1, installationId: 2, botLogin: "sour-dev-lanes[bot]" } } }, 'profile "solo"'],
    [{ identity: { profile: "other" } }, 'profile "other"'],
    [{ identity: {} }, "no identity profile"],
    [undefined, "no identity profile"],
  ]) {
    const run = fakeRun({ issues: [issue(1, ["src/a.mjs"])], prs: [], sessions: [] });
    run.deps.config = () => config;
    assert.equal(await main([], run.deps), 2, JSON.stringify(config));
    assert.equal(run.out.length, 1);
    assert.equal(run.out[0], `${TEAM_REQUIRED_MESSAGE} (lanes.config.json: ${found})`);
    assert.deepEqual(run.launched, []);
    assert.deepEqual(run.calls, [], "nothing read or launched");
  }
});

test("#613: this repository's lanes.config.json passes the queue's identity check", async () => {
  const { startConfig } = await import("./start.mjs");
  const raw = JSON.parse(readFileSync("lanes.config.json", "utf8"));
  assert.equal(startConfig(raw).identity.profile, "team");
});

test("#512: edge: a malformed identity still exits 2 on the config error, not a launch", async () => {
  const { main } = await import("./queue.mjs");
  const run = fakeRun({ issues: [issue(1, ["src/a.mjs"])], prs: [], sessions: [] });
  run.deps.config = () => ({ identity: { profile: "team" } });
  assert.equal(await main([], run.deps), 2);
  assert.deepEqual(run.launched, []);
});

test("#512: edge: a mistyped profile (Team, team with a space) never launches", async () => {
  const { main } = await import("./queue.mjs");
  for (const profile of ["Team", "team ", "TEAM", ""]) {
    const run = fakeRun({ issues: [issue(1, ["src/a.mjs"])], prs: [], sessions: [] });
    run.deps.config = () => ({ identity: { profile, app: { id: 1, installationId: 2, botLogin: "sour-dev-lanes[bot]" } } });
    assert.equal(await main([], run.deps), 2, JSON.stringify(profile));
    assert.deepEqual(run.launched, []);
  }
});

test("#528: edge: a team identity without a valid botLogin exits 2 on the config error, not a launch", async () => {
  const { main } = await import("./queue.mjs");
  for (const botLogin of [undefined, "nobot", ""]) {
    const run = fakeRun({ issues: [issue(1, ["src/a.mjs"])], prs: [], sessions: [] });
    run.deps.config = () => ({ identity: { profile: "team", app: { id: 1, installationId: 2, ...(botLogin === undefined ? {} : { botLogin }) } } });
    assert.equal(await main([], run.deps), 2, JSON.stringify(botLogin));
    assert.match(run.out[0], /cannot read lanes\.config\.json: .*botLogin/, JSON.stringify(botLogin));
    assert.deepEqual(run.launched, []);
  }
});

test("edge: the config's maxLanes caps the launches", async () => {
  const { main } = await import("./queue.mjs");
  const world = { issues: [1, 2, 3].map((n) => issue(n, [`src/${n}.mjs`])), prs: [], sessions: [] };
  const run = fakeRun(world, { onSleep: (t) => t === 2 && (world.issues = []) });
  run.deps.config = () => ({ start: { maxLanes: 2 }, identity: QUEUE_TEAM });
  assert.equal(await main([], run.deps), 0);
  assert.deepEqual(run.launched.filter((l) => l.tick === 0).length, 2);
});

test("CLI: conflicting issues launch one after the other, a newly ready issue joins, then three idle ticks lengthen the tick", async () => {
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
  assert.ok(run.out.some((l) => /cannot read GitHub or the sessions:.*printed no list.*retrying in 1 min/.test(l)), run.out.join("\n"));
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
  assert.ok(run.out.some((l) => /1000\+ open issues: too many to plan from, retrying in 1 min/.test(l)), run.out.join("\n"));
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
  // Under team (ADR 0025) the lane's environment is built on the launcher's: its PATH, the lane's own gh directory.
  assert.deepEqual(seen.map((o) => o.env.PATH), ["adjusted"]);
  assert.equal(seen[0].env.GH_CONFIG_DIR, "/tmp/lane-1");
  assert.equal(seen[0].cwd, "/repo");
  assert.equal(out.filter((l) => l.endsWith(" #1: PATH not adjusted: git not found")).length, 1, out.join("\n"));
});

test("#344: edge: an adjusted env with no note prints no PATH line", async () => {
  const { out } = await launchOptions(() => ({ env: { PATH: "adjusted" }, note: null }));
  assert.ok(!out.some((l) => /PATH not adjusted/.test(l)), out.join("\n"));
});

test("#344: edge: with no launchEnv (other platforms) the team lane's environment is built on the process's own", async () => {
  const { seen } = await launchOptions(null);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].env.GH_CONFIG_DIR, "/tmp/lane-1");
  // Windows keeps the variable as `Path` in a copied env object, so the key is matched case-insensitively.
  const pathOf = (env) => env[Object.keys(env).find((k) => k.toLowerCase() === "path")];
  assert.equal(pathOf(seen[0].env), pathOf(process.env));
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
  assert.ok(seen.every((o) => o.env.PATH === "p"));
  for (const n of [1, 2]) assert.equal(run.out.filter((l) => l.endsWith(` #${n}: PATH not adjusted: git not found`)).length, 1, run.out.join("\n"));
});

// --- #251: queue-launched lanes get the reaper /start starts (ADR 0010). ---

const reapScript = join("/repo", "scripts", "lanes", "reap.mjs");

// A team launch also starts the token refresher, which logs the same way; the reaper tests look at the reapers alone.
// Each spawn follows its own reaperLog call, so `run.logs[i]` is the log of `run.reapers[i]`.
const reapersOf = (run) => run.reapers.map((reaper, i) => ({ reaper, log: run.logs[i] })).filter(({ reaper }) => reaper.args[0] === reapScript);

test("CLI: one detached, unref'd reaper per launched lane, logging to its own log", async () => {
  const { main } = await import("./queue.mjs");
  const world = { issues: [issue(1, ["src/a.mjs"]), issue(2, ["src/b.mjs"])], prs: [], sessions: [] };
  const run = fakeRun(world, { onSleep: (t) => t === 1 && (world.issues = []) });
  assert.equal(await main([], run.deps), 0);
  const reaps = reapersOf(run);
  assert.deepEqual(
    reaps.map(({ reaper }) => [reaper.cmd, reaper.args]),
    [
      [process.execPath, [reapScript, "--issue", "1", "--session", "sess-1"]],
      [process.execPath, [reapScript, "--issue", "2", "--session", "sess-2"]],
    ],
  );
  for (const { reaper, log } of reaps) {
    assert.equal(reaper.options.detached, true);
    assert.equal(reaper.options.cwd, "/repo");
    assert.deepEqual(reaper.options.stdio, ["ignore", log.fd, log.fd]);
    assert.equal(reaper.child.unrefed, true);
  }
  assert.deepEqual(reaps.map(({ log }) => [log.root, log.n, log.closed]), [["/repo", 1, true], ["/repo", 2, true]]);
});

test("CLI: a failed launch starts no reaper", async () => {
  const { main } = await import("./queue.mjs");
  const world = { issues: [issue(1, ["src/a.mjs"]), issue(2, ["src/b.mjs"])], prs: [], sessions: [] };
  const run = fakeRun(world, { launchFails: (n) => n === 1, onSleep: (t) => t === 1 && (world.issues = []) });
  assert.equal(await main([], run.deps), 0);
  assert.deepEqual(reapersOf(run).map(({ reaper }) => reaper.args[2]), ["2"]);
  assert.deepEqual(run.logs.map((l) => l.n), [2, 2], "the reaper's log and the refresher's, both for #2");
  assert.deepEqual(run.reapers.filter((r) => r.args.includes("--refresh-token")).length, 1);
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
  assert.equal(reapersOf(run).length, 1);
  assert.deepEqual(run.launched.map((l) => l.n), [1]);
});

// --- #382: a stalled or PR-less lane is stopped and relaunched once, never over unpushed work. ---

const lane = (n, over = {}) => ({ kind: "background", id: `old-${n}`, cwd: `/repo/.claude/worktrees/issue-${n}-work`, status: "busy", startedAt: 1, ...over });

// A queue run with recovery deps over `world`; `opts.workLeft` is the reason work is left (or null), `opts.stalledIssues`
// the issues stalledLanes reports, `opts.markers` a Map of issue → marker. Removing a lane drops its session.
function recoveryRun(world, { workLeft = null, stalledIssues = [], markers = new Map(), stopWorks = true } = {}) {
  const run = fakeRun(world, { onSleep: (t) => t === 3 && ((world.issues = []), (world.prs = [])) });
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
  run.deps.config = () => ({ budget: { perLaneTokens: -1 }, identity: QUEUE_TEAM });
  assert.equal(await main([], run.deps), 2);
  assert.match(run.out[0], /perLaneTokens/);
  assert.equal(run.calls.length, 0);
});

// --- #444: a lane whose session died after it opened its PR is resumed in its own worktree, never over unsaved work. ---

const idleLane = (n) => lane(n, { status: "idle" });
const gatePr = (number, n, description) => pr(number, n, ["src/a.mjs"], [gate("PENDING", description)]);
const launchDirs = (run) => run.calls.filter((c) => c[0] === "claude" && /^\/lane \d+$/.test(c.at(-2) ?? "")).map((c) => c.at(-1));

test("#444: planRecovery names a dead lane whose open PR waits on a missing review, and no other", async () => {
  const { planRecovery } = await import("./queue.mjs");
  const issues = [issue(7, ["src/a.mjs"]), issue(8, ["src/b.mjs"]), issue(9, ["src/c.mjs"]), issue(10, ["src/d.mjs"])];
  const prs = [gatePr(70, 7, "waiting for review/security-reviewer"), gatePr(80, 8, "waiting for a code-owner review in GitHub"), gatePr(90, 9, "waiting for review/test-hunter"), pr(100, 10, ["src/d.mjs"], [gate("SUCCESS")])];
  const sessions = [idleLane(7), idleLane(8), lane(9), idleLane(10)];
  const out = planRecovery({ issues, prs, sessions });
  assert.deepEqual(out.map((r) => [r.number, r.resume, r.id]), [[7, true, "old-7"]]);
  assert.match(out[0].reason, /dead lane with open PR #70/);
});

test("#444: planRecovery also names a dead lane whose PR has a failing check, and one with no session left", async () => {
  const { planRecovery } = await import("./queue.mjs");
  const issues = [issue(7, ["src/a.mjs"]), issue(8, ["src/b.mjs"])];
  const failing = pr(70, 7, ["src/a.mjs"], [{ name: "verify", conclusion: "FAILURE" }, gate("PENDING", "x")]);
  const out = planRecovery({ issues, prs: [failing, gatePr(80, 8, "waiting for review/test-hunter")], sessions: [idleLane(7)] });
  assert.deepEqual(out.map((r) => [r.number, r.id, r.branch]), [[7, "old-7", "issue-7-work"], [8, null, "issue-8-work"]]);
});

test("#444: planRecovery leaves an issue with a marker for this session alone and reports another as again", async () => {
  const { planRecovery } = await import("./queue.mjs");
  const input = { issues: [issue(7, ["src/a.mjs"])], prs: [gatePr(70, 7, "waiting for review/test-hunter")], sessions: [idleLane(7)] };
  assert.deepEqual(planRecovery({ ...input, marker: () => ({ session: "old-7" }) }), []);
  assert.deepEqual(planRecovery({ ...input, marker: () => ({ session: "other" }) }).map((r) => r.again), [true]);
});

test("#444: a dead lane with an open PR is relaunched once, in its own worktree", async () => {
  const { main } = await import("./queue.mjs");
  const world = { issues: [issue(7, ["src/a.mjs"])], prs: [gatePr(70, 7, "waiting for review/security-reviewer")], sessions: [idleLane(7)] };
  const run = recoveryRun(world);
  assert.equal(await main([], run.deps), 0);
  assert.deepEqual(run.launched.map((l) => l.n), [7]);
  assert.deepEqual(launchDirs(run), ["/repo/.claude/worktrees/issue-7-work"]);
  assert.deepEqual(run.stopped, []);
  assert.deepEqual(run.removed, []);
  assert.equal(run.markers.get(7).outcome, "resume");
  assert.ok(run.out.some((l) => / #7: dead lane with open PR #70.*resuming once$/.test(l)), run.out.join("\n"));
});

test("#444: a dead lane whose worktree has unsaved work is not relaunched, and says so", async () => {
  const { main } = await import("./queue.mjs");
  const world = { issues: [issue(7, ["src/a.mjs"])], prs: [gatePr(70, 7, "waiting for review/security-reviewer")], sessions: [idleLane(7)] };
  const run = recoveryRun(world, { workLeft: "uncommitted changes" });
  assert.equal(await main([], run.deps), 0);
  assert.deepEqual(run.launched, []);
  assert.deepEqual(run.removed, []);
  assert.equal(run.out.filter((l) => l.endsWith(" #7: not recovered: unsaved work in /repo/.claude/worktrees/issue-7-work")).length, 1, run.out.join("\n"));
});

test("#444: a live lane session, or a PR waiting only on /approve, is left alone", async () => {
  const { main } = await import("./queue.mjs");
  for (const [sessions, description] of [[[lane(7)], "waiting for review/security-reviewer"], [[idleLane(7)], "waiting for a code-owner review in GitHub"]]) {
    const world = { issues: [issue(7, ["src/a.mjs"])], prs: [gatePr(70, 7, description)], sessions };
    const run = recoveryRun(world);
    assert.equal(await main([], run.deps), 0);
    assert.deepEqual([run.launched, run.stopped, run.removed], [[], [], []], description);
  }
});

test("#444: edge: a dead lane with no worktree found is left for the owner", async () => {
  const { main } = await import("./queue.mjs");
  const world = { issues: [issue(7, ["src/a.mjs"])], prs: [gatePr(70, 7, "waiting for review/security-reviewer")], sessions: [] };
  const run = recoveryRun(world);
  run.deps.recovery.worktree = () => null;
  assert.equal(await main([], run.deps), 0);
  assert.deepEqual(run.launched, []);
  assert.ok(run.out.some((l) => / #7: dead lane with open PR, worktree not found, left for the owner$/.test(l)), run.out.join("\n"));
});

test("#444: edge: the worktree is looked up by the PR's branch when the session is gone", async () => {
  const { main } = await import("./queue.mjs");
  const world = { issues: [issue(7, ["src/a.mjs"])], prs: [gatePr(70, 7, "waiting for review/security-reviewer")], sessions: [] };
  const run = recoveryRun(world);
  const seen = [];
  const worktree = run.deps.recovery.worktree;
  run.deps.recovery.worktree = (n, cwd, branch) => (seen.push([n, cwd, branch]), worktree(n, cwd, branch));
  await main([], run.deps);
  assert.deepEqual(seen[0], [7, undefined, "issue-7-work"]);
  assert.deepEqual(run.launched.map((l) => l.n), [7]);
});

test("#444: edge: a fork PR reusing a lane's branch name is not resumed", async () => {
  const { planRecovery } = await import("./queue.mjs");
  const fork = { ...gatePr(70, 7, "waiting for review/test-hunter"), isCrossRepository: true };
  assert.deepEqual(planRecovery({ issues: [issue(7, ["src/a.mjs"])], prs: [fork], sessions: [] }), []);
});

test("#444: edge: control characters in a check name never reach the printed line", async () => {
  const { main } = await import("./queue.mjs");
  const bad = pr(70, 7, ["src/a.mjs"], [{ name: "ver\u001b[31mify", conclusion: "FAILURE" }, gate("PENDING", "x")]);
  const world = { issues: [issue(7, ["src/a.mjs"])], prs: [bad], sessions: [idleLane(7)] };
  const run = recoveryRun(world);
  await main([], run.deps);
  const line = run.out.find((l) => l.includes("resuming once"));
  assert.ok(line, run.out.join("\n"));
  assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(line));
});

test("#444: edge: over the token budget a dead lane is not relaunched and keeps no marker", async () => {
  const { main } = await import("./queue.mjs");
  const world = { issues: [issue(7, ["src/a.mjs"])], prs: [gatePr(70, 7, "waiting for review/security-reviewer")], sessions: [idleLane(7)] };
  const run = recoveryRun(world);
  run.deps.budget = () => ({ over: true, spent24h: 9, perNightTokens: 5, lanesOver: [] });
  await main([], run.deps);
  assert.deepEqual(run.launched, []);
  assert.equal(run.markers.size, 0);
});

test("#444: edge: a worktree lookup that throws is reported once and nothing is relaunched", async () => {
  const { main } = await import("./queue.mjs");
  const world = { issues: [issue(7, ["src/a.mjs"])], prs: [gatePr(70, 7, "waiting for review/security-reviewer")], sessions: [idleLane(7)] };
  const run = recoveryRun(world);
  run.deps.recovery.worktree = () => {
    throw new Error("git broke");
  };
  assert.equal(await main([], run.deps), 0);
  assert.deepEqual(run.launched, []);
  assert.equal(run.out.filter((l) => / #7: recovery failed: git broke$/.test(l)).length, 1, run.out.join("\n"));
});

test("#444: edge: a marker that cannot be written stops the resume before any launch", async () => {
  const { main } = await import("./queue.mjs");
  const world = { issues: [issue(7, ["src/a.mjs"])], prs: [gatePr(70, 7, "waiting for review/security-reviewer")], sessions: [idleLane(7)] };
  const run = recoveryRun(world);
  run.deps.recovery.marker.write = () => {
    throw new Error("disk full");
  };
  assert.equal(await main([], run.deps), 0);
  assert.deepEqual(run.launched, []);
  assert.ok(run.out.some((l) => / #7: recovery failed: disk full$/.test(l)), run.out.join("\n"));
});

// #483: the queue logs each started issue, and each skip once until its reason changes.
test("#483: a started issue and a skipped one are recorded with the documented fields, a repeated skip only once", async () => {
  const { main } = await import("./queue.mjs");
  const world = { issues: [issue(1, ["src/a.mjs"]), issue(2, ["src/b.mjs"], { labels: ["ready"] })], prs: [], sessions: [] };
  const run = fakeRun(world, { onSleep: (t) => t === 3 && (world.issues = []) });
  assert.equal(await main([], run.deps), 0);
  assert.ok(run.ticks() >= 3, "several ticks ran");
  assert.ok(run.recorded.every(([root]) => root === "/repo"));
  const lines = run.recorded.map(([, l]) => l);
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0], { at: "2026-09-28T09:00:00.000Z", issue: 1, outcome: "started" });
  assert.deepEqual(lines[1], { at: "2026-09-28T09:00:00.000Z", issue: 2, outcome: "skipped", reason: "not-ready" });
});

test("#483: edge: an overlap skip records the other issue, and a changed reason is recorded again", async () => {
  const { main } = await import("./queue.mjs");
  const world = { issues: [issue(1, ["src/a.mjs"]), issue(2, ["src/a.mjs"])], prs: [], sessions: [] };
  const run = fakeRun(world, { onSleep: (t) => t === 2 && (world.issues = []) });
  assert.equal(await main([], run.deps), 0);
  const lines = run.recorded.map(([, l]) => l);
  assert.deepEqual(lines.map((l) => [l.issue, l.outcome, l.reason, l.with]), [
    [1, "started", undefined, undefined],
    [2, "skipped", "overlap", 1],
    [2, "skipped", "overlap", 1],
  ]);
});

test("#483: edge: a failed write never changes a launch", async () => {
  const { main } = await import("./queue.mjs");
  const world = { issues: [issue(1, ["src/a.mjs"])], prs: [], sessions: [] };
  const run = fakeRun(world, { onSleep: (t) => t === 1 && (world.issues = []), recordFails: true });
  assert.equal(await main([], run.deps), 0);
  assert.deepEqual(run.launched.map((l) => l.n), [1]);
  assert.deepEqual(run.recorded, []);
});

// #522: the owner claims an issue it will do itself by assigning it; the queue never launches a lane on it.
test("an assigned ready issue is skipped with the assignee's login, not launched", () => {
  const out = tick({ issues: [{ ...issue(1, ["src/a.mjs"]), assignees: [{ login: "owner" }] }, issue(2, ["src/b.mjs"])] });
  assert.deepEqual(out.launch, [2]);
  assert.ok(out.lines.some((l) => l === "#1: skipped: assigned to owner"));
});

test("edge: an unassigned issue (empty assignees) is launched as before", () => {
  const out = tick({ issues: [{ ...issue(1, ["src/a.mjs"]), assignees: [] }, issue(2, ["src/b.mjs"])] });
  assert.deepEqual(out.launch, [1, 2]);
});

test("edge: a malformed assignees field still claims the issue (fail closed)", () => {
  for (const assignees of [[{}], [null], "owner", { login: "owner" }]) {
    const out = tick({ issues: [{ ...issue(1, ["src/a.mjs"]), assignees }] });
    assert.deepEqual(out.launch, []);
    assert.ok(out.lines.some((l) => l.startsWith("#1: skipped: assigned to ")));
  }
});

test("edge: several assignees are all named, and an assigned issue without ready is not listed", () => {
  const out = tick({ issues: [{ ...issue(1, ["src/a.mjs"]), assignees: [{ login: "a" }, { login: "b" }] }, { ...issue(2, ["src/b.mjs"], { labels: ["tier:quick"] }), assignees: [{ login: "a" }] }] });
  assert.deepEqual(out.launch, []);
  assert.ok(out.lines.some((l) => l === "#1: skipped: assigned to a, b"));
  assert.ok(!out.lines.some((l) => l.startsWith("#2:")));
});

// #535: a queue keeps the lanes scripts it loaded, so it stops when a merge changes them.
function fakeGit({ head = "aaaaaaa1111", remote = "aaaaaaa1111", changed = [], fetchFails = false, branch = "main", dirty = "", pullFails = false, pullLands = true } = {}) {
  const state = { head, remote, changed, fetchFails, branch, dirty, pullFails, pullLands, calls: [] };
  state.git = (args) => {
    state.calls.push(args);
    if (args[0] === "fetch") {
      if (state.fetchFails) throw Object.assign(new Error("git failed"), { stderr: "fatal: unable to access remote\nmore" });
      return "";
    }
    if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return `${state.branch}\n`;
    if (args[0] === "status") return state.dirty;
    if (args[0] === "pull") {
      if (state.pullFails) throw Object.assign(new Error("git failed"), { stderr: "fatal: Not possible to fast-forward, aborting.\nmore" });
      if (state.pullLands) state.head = state.remote;
      return "";
    }
    if (args[0] === "rev-parse") return `${args[1] === "HEAD" ? state.head : state.remote}\n`;
    if (args[0] === "diff") {
      const specs = args.slice(args.indexOf("--") + 1);
      return state.changed.filter((f) => specs.some((s) => f === s || (s.endsWith("/") && f.startsWith(s)))).join("\n");
    }
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
  return state;
}
const RESTART_LINE = /queue: lanes scripts changed \(aaaaaaa -> bbbbbbb\), pulled, restarting \(#1\)$/;
const CANNOT_RESTART = /lanes scripts changed \(aaaaaaa\.\.bbbbbbb\) but cannot restart: /;

test("scripts unchanged since the queue started: it fetches origin/main and launches as before", async () => {
  const { main } = await import("./queue.mjs");
  const world = { issues: [issue(1, ["src/a.mjs"])], prs: [], sessions: [] };
  const git = fakeGit({ remote: "bbbbbbb2222", changed: [] });
  const run = fakeRun(world, { onSleep: (t) => t === 1 && (world.issues = []) });
  assert.equal(await main([], { ...run.deps, git: git.git }), 0);
  assert.deepEqual(run.launched.map((l) => l.n), [1]);
  assert.ok(git.calls.some((c) => c[0] === "fetch" && c.includes("origin")));
});

test("a change under scripts/lanes/ pulls and exits 10 with the one restart line, launching nothing", async () => {
  const { main } = await import("./queue.mjs");
  const run = fakeRun({ issues: [issue(1, ["src/a.mjs"])], prs: [], sessions: [] });
  const git = fakeGit({ remote: "bbbbbbb2222", changed: ["scripts/lanes/queue.mjs"] });
  assert.equal(await main([], { ...run.deps, git: git.git }), 10);
  assert.deepEqual(run.launched, []);
  assert.equal(run.out.filter((l) => RESTART_LINE.test(l)).length, 1);
  assert.ok(git.calls.some((c) => c[0] === "pull" && c.includes("--ff-only")));
});

test("a change to lanes.config.json restarts the same way", async () => {
  const { main } = await import("./queue.mjs");
  const run = fakeRun({ issues: [issue(1, ["src/a.mjs"])], prs: [], sessions: [] });
  const git = fakeGit({ remote: "bbbbbbb2222", changed: ["lanes.config.json"] });
  assert.equal(await main([], { ...run.deps, git: git.git }), 10);
  assert.deepEqual(run.launched, []);
  assert.ok(run.out.some((l) => RESTART_LINE.test(l)));
});

test("the restart line counts restarts in this run from LANES_QUEUE_RESTARTS", async () => {
  const { main } = await import("./queue.mjs");
  const run = fakeRun({ issues: [], prs: [], sessions: [] }, { env: { LANES_QUEUE_CHILD: "1", LANES_QUEUE_RESTARTS: "2" } });
  const git = fakeGit({ remote: "bbbbbbb2222", changed: ["scripts/lanes/pick.mjs"] });
  assert.equal(await main([], { ...run.deps, git: git.git }), 10);
  assert.match(run.out.at(-1), /pulled, restarting \(#3\)$/);
});

// Each restart precondition (ADR 0026 part 2): it names the failed one, exits 3 (4 for a pull that cannot fast-forward),
// launches nothing, and never pulls past a failed check.
for (const [name, opts, code, message, pulled] of [
  ["not on main", { branch: "feature" }, 3, /on feature, not main/, false],
  ["a detached HEAD", { branch: "" }, 3, /on no branch, not main/, false],
  ["a dirty checkout", { dirty: " M scripts/lanes/pick.mjs\n" }, 3, /uncommitted changes/, false],
  ["a pull that cannot fast-forward", { pullFails: true }, 4, /git pull --ff-only failed \(fatal: Not possible to fast-forward, aborting\.\)/, true],
  ["HEAD not origin/main after the pull", { pullLands: false }, 3, /HEAD is not origin\/main after the pull/, true],
]) {
  test(`restart precondition: ${name} exits ${code} naming it, launching nothing`, async () => {
    const { main } = await import("./queue.mjs");
    const run = fakeRun({ issues: [issue(1, ["src/a.mjs"])], prs: [], sessions: [] });
    const git = fakeGit({ remote: "bbbbbbb2222", changed: ["scripts/lanes/queue.mjs"], ...opts });
    assert.equal(await main([], { ...run.deps, git: git.git }), code);
    assert.deepEqual(run.launched, []);
    assert.match(run.out.at(-1), CANNOT_RESTART);
    assert.match(run.out.at(-1), message);
    assert.ok(!run.out.some((l) => RESTART_LINE.test(l)));
    assert.equal(git.calls.some((c) => c[0] === "pull"), pulled);
  });
}

test("edge: a git read that throws while checking a restart precondition exits 3 naming it, not a crash", async () => {
  const { main } = await import("./queue.mjs");
  const run = fakeRun({ issues: [issue(1, ["src/a.mjs"])], prs: [], sessions: [] });
  const git = fakeGit({ remote: "bbbbbbb2222", changed: ["scripts/lanes/queue.mjs"] });
  const inner = git.git;
  const flaky = (args) => {
    if (args[0] === "status") throw new Error("status exploded");
    return inner(args);
  };
  assert.equal(await main([], { ...run.deps, git: flaky }), 3);
  assert.match(run.out.at(-1), CANNOT_RESTART);
  assert.match(run.out.at(-1), /status exploded/);
  assert.deepEqual(run.launched, []);
});

test("edge: a sleep that rejects with something other than a stop request is not swallowed", async () => {
  const { main } = await import("./queue.mjs");
  const run = fakeRun({ issues: [], prs: [], sessions: [] });
  run.deps.sleep = async () => { throw new Error("timer broke"); };
  await assert.rejects(main([], run.deps), /timer broke/);
});

test("the supervisor spawns one new child with the same arguments after a child exits 10, and exits with the next code", async () => {
  const { main } = await import("./queue.mjs");
  const run = fakeRun({ issues: [], prs: [], sessions: [] });
  const spawned = [];
  const codes = [10, 10, 0];
  const runChild = async (argv, env) => {
    spawned.push({ argv, env });
    return codes[spawned.length - 1];
  };
  assert.equal(await main([], { ...run.deps, runChild }), 0);
  assert.equal(spawned.length, 3);
  assert.ok(spawned.every((s) => s.argv.length === 0 && s.env.LANES_QUEUE_CHILD === "1"));
  assert.deepEqual(spawned.map((s) => s.env.LANES_QUEUE_RESTARTS), ["0", "1", "2"]);
  assert.deepEqual(run.calls, [], "the supervisor itself reads nothing");
});

test("no chain of waiting parents: after several restarts only the supervisor and one child are ever alive", async () => {
  const { main } = await import("./queue.mjs");
  const run = fakeRun({ issues: [], prs: [], sessions: [] });
  let alive = 0;
  let peak = 0;
  let n = 0;
  const runChild = async () => {
    alive += 1;
    peak = Math.max(peak, alive);
    await Promise.resolve();
    alive -= 1;
    return (n += 1) < 6 ? 10 : 4;
  };
  assert.equal(await main([], { ...run.deps, runChild }), 4);
  assert.equal(n, 6);
  assert.equal(peak, 1, "one child at a time beside the supervisor: two processes");
});

test("the supervisor returns a child's other exit code (2, 3, 4) unchanged and reports a child that cannot start as 2", async () => {
  const { main } = await import("./queue.mjs");
  for (const code of [0, 2, 3, 4]) {
    const run = fakeRun({ issues: [], prs: [], sessions: [] });
    assert.equal(await main([], { ...run.deps, runChild: async () => code }), code);
  }
  const run = fakeRun({ issues: [], prs: [], sessions: [] });
  const failing = async () => {
    throw Object.assign(new Error("spawn node ENOENT"), { stderr: "" });
  };
  assert.equal(await main([], { ...run.deps, runChild: failing }), 2);
  assert.match(run.out.at(-1), /cannot start the queue: spawn node ENOENT/);
});

test("exit 2 inside Claude in both processes, before anything else: no child is spawned and nothing is read", async () => {
  const { main } = await import("./queue.mjs");
  let spawned = 0;
  const runChild = async () => (spawned += 1, 0);
  for (const env of [{ CLAUDECODE: "1" }, { CLAUDECODE: "1", LANES_QUEUE_CHILD: "1" }]) {
    const run = fakeRun({ issues: [], prs: [], sessions: [] }, { env });
    assert.equal(await main([], { ...run.deps, runChild, git: fakeGit().git }), 2);
    assert.deepEqual(run.out, [REFUSAL]);
    assert.deepEqual(run.calls, []);
  }
  assert.equal(spawned, 0);
});

test("a child (LANES_QUEUE_CHILD set) never supervises, even when runChild is available", async () => {
  const { main } = await import("./queue.mjs");
  let spawned = 0;
  const run = fakeRun({ issues: [], prs: [], sessions: [] }, { env: { LANES_QUEUE_CHILD: "1" } });
  assert.equal(await main([], { ...run.deps, runChild: async () => (spawned += 1, 0) }), 0);
  assert.equal(spawned, 0);
  assert.ok(run.calls.length > 0);
});

test("a merge that lands mid-run stops it on the next tick, before that tick launches", async () => {
  const { main } = await import("./queue.mjs");
  const world = { issues: [issue(1, ["src/a.mjs"])], prs: [], sessions: [] };
  const git = fakeGit();
  const run = fakeRun(world, {
    onSleep: (t) => {
      if (t !== 1) return;
      git.remote = "bbbbbbb2222";
      git.changed = ["scripts/lanes/pick.mjs"];
      world.issues.push(issue(2, ["src/b.mjs"]));
    },
  });
  assert.equal(await main([], { ...run.deps, git: git.git }), 10);
  assert.deepEqual(run.launched.map((l) => l.n), [1]);
  assert.ok(run.out.some((l) => RESTART_LINE.test(l)));
});

test("a change elsewhere (docs, src, a lookalike path) does not stop the queue", async () => {
  const { main } = await import("./queue.mjs");
  const world = { issues: [issue(1, ["src/a.mjs"])], prs: [], sessions: [] };
  const git = fakeGit({ remote: "bbbbbbb2222", changed: ["docs/USING.md", "src/a.mjs", "scripts/lanes-other/x.mjs", "lanes.config.json.bak"] });
  const run = fakeRun(world, { onSleep: (t) => t === 1 && (world.issues = []) });
  assert.equal(await main([], { ...run.deps, git: git.git }), 0);
  assert.deepEqual(run.launched.map((l) => l.n), [1]);
  assert.ok(!run.out.some((l) => /scripts changed/.test(l)));
});

test("a failed fetch is reported and launches nothing that tick, without exiting", async () => {
  const { main } = await import("./queue.mjs");
  const world = { issues: [issue(1, ["src/a.mjs"])], prs: [], sessions: [] };
  const git = fakeGit();
  git.fetchFails = true;
  const run = fakeRun(world, {
    onSleep: (t) => {
      if (t === 2) git.fetchFails = false;
      if (t === 3) world.issues = [];
    },
  });
  assert.equal(await main([], { ...run.deps, git: git.git }), 0);
  assert.ok(run.out.some((l) => /cannot fetch origin\/main: fatal: unable to access remote.*launching nothing/.test(l)));
  assert.deepEqual(run.launched.map((l) => ({ n: l.n, tick: l.tick })), [{ n: 1, tick: 2 }]);
});

test("edge: a startup commit that cannot be read exits 2 before reading GitHub", async () => {
  const { main } = await import("./queue.mjs");
  const run = fakeRun({ issues: [issue(1, ["src/a.mjs"])], prs: [], sessions: [] });
  const git = () => {
    throw Object.assign(new Error("x"), { stderr: "fatal: not a git repository" });
  };
  assert.equal(await main([], { ...run.deps, git }), 2);
  assert.deepEqual(run.launched, []);
  assert.ok(run.out.some((l) => /cannot read the lanes scripts commit/.test(l)));
});

test("edge: a diff that cannot be read launches nothing that tick, like a failed fetch", async () => {
  const { main } = await import("./queue.mjs");
  const world = { issues: [issue(1, ["src/a.mjs"])], prs: [], sessions: [] };
  const git = fakeGit({ remote: "bbbbbbb2222" });
  const base = git.git;
  let broken = true;
  git.git = (args) => {
    if (args[0] === "diff" && broken) throw new Error("bad object");
    return base(args);
  };
  const run = fakeRun(world, {
    onSleep: (t) => {
      if (t === 1) broken = false;
      if (t === 2) world.issues = [];
    },
  });
  assert.equal(await main([], { ...run.deps, git: git.git }), 0);
  assert.deepEqual(run.launched.map((l) => l.tick), [1]);
});

const teamGate = "waiting for a code-owner review in GitHub";
const teamRows = (nums) => nums.map((n) => ({ ...pr(n, n, ["a"], [gate("PENDING", teamGate)]), title: `t${n}`, url: `https://github.com/o/r/pull/${n}`, gateSince: 0 }));

test("#604: under team the digest lists each review wait with its files URL and prints no /approve line", async () => {
  const { waitingDigest } = await import("./queue.mjs");
  const prs = teamRows([5, 6]);
  const lines = waitingDigest(prs, prs.map((p) => ({ number: p.number, reason: teamGate })), 60_000, new Map());
  assert.deepEqual(lines, [
    "waiting on you (2):",
    `  #5 t5 — waiting 1m — ${teamGate} — https://github.com/o/r/pull/5/files`,
    `  #6 t6 — waiting 1m — ${teamGate} — https://github.com/o/r/pull/6/files`,
  ]);
});

test("edge: a review wait whose PR has no https URL gets no URL and no /approve line", async () => {
  const { waitingDigest } = await import("./queue.mjs");
  const prs = teamRows([5]).map((p) => ({ ...p, url: "http://github.com/o/r/pull/5" }));
  const lines = waitingDigest(prs, [{ number: 5, reason: teamGate }], 60_000);
  assert.ok(!lines.join("\n").includes("http"));
  assert.ok(!lines.join("\n").includes("/approve"));
});

test("edge: under team a digest with nothing waiting is empty, and a failing PR gets no URL", async () => {
  const { waitingDigest } = await import("./queue.mjs");
  assert.deepEqual(waitingDigest([], [], 5, new Map()), []);
  const failing = { ...pr(5, 5, ["a"], [{ name: "test", conclusion: "FAILURE" }]), title: "t", url: "https://github.com/o/r/pull/5" };
  assert.deepEqual(waitingDigest([failing], [{ number: 5, reason: "failing: test" }], 60_000, new Map([[5, 0]]), true), ["waiting on you (1):", "  #5 t — waiting 1m — failing: test"]);
});

test("#604: planTick treats the team gate wording as a wait on the owner", async () => {
  const { planTick } = await import("./queue.mjs");
  const plan = planTick({ issues: [], prs: teamRows([5]), sessions: [] });
  assert.deepEqual(plan.waiting, [{ number: 5, reason: teamGate }]);
});

test("edge: under team a review wait with a missing or non-https url gets no link", async () => {
  const { waitingDigest } = await import("./queue.mjs");
  for (const url of [undefined, null, 5, "http://github.com/o/r/pull/5", "javascript:alert(1)"]) {
    const prs = teamRows([5]).map((p) => ({ ...p, url }));
    const lines = waitingDigest(prs, [{ number: 5, reason: teamGate }], 60_000, new Map());
    assert.equal(lines.length, 2);
    assert.ok(!lines[1].includes("/files"), String(url));
  }
});

// #621: a PR the merge queue removed is reported once, with the failed merge-group check when it can be read.
const queueNode = (number, ...events) => ({ number, timelineItems: { nodes: events.map(([t, at]) => ({ __typename: t, createdAt: at })) } });
const REMOVED = "RemovedFromMergeQueueEvent";
const ADDED = "AddedToMergeQueueEvent";
const titled = (n) => ({ ...pr(n, n, ["a"]), title: `pr ${n}` });
const failedLines = (run) => run.out.map((l) => l.replace(STAMP, "")).filter((l) => l.includes("[queue failed]"));

test("#621: the queue prints one [queue failed] line, with the failed check and run link, when a PR is removed", async () => {
  const { main } = await import("./queue.mjs");
  const world = {
    issues: [],
    prs: [titled(5)],
    sessions: [],
    gateNodes: [queueNode(5, [ADDED, "2026-10-02T02:30:00Z"], [REMOVED, "2026-10-02T02:36:12Z"])],
    runs: [{ databaseId: 1, headBranch: "gh-readonly-queue/main/pr-5-abc", workflowName: "verify", url: "https://github.com/o/r/actions/runs/1", createdAt: "2026-10-02T02:35:00Z" }],
  };
  const run = fakeRun(world, { onSleep: (t) => t === 3 && (world.prs = []) });
  await main([], run.deps);
  assert.deepEqual(failedLines(run), ["#5 [queue failed] pr 5 — removed from the merge queue at 2026-10-02 02:36 UTC: verify failed in the merge group (https://github.com/o/r/actions/runs/1)"]);
});

test("#621: a removal is still reported, without a check, when the run list cannot be read", async () => {
  const { main } = await import("./queue.mjs");
  const world = { issues: [], prs: [titled(5)], sessions: [], gateNodes: [queueNode(5, [REMOVED, "2026-10-02T02:36:12Z"])] };
  const run = fakeRun(world, { onSleep: (t) => t === 3 && (world.prs = []) });
  await main([], run.deps);
  assert.deepEqual(failedLines(run), ["#5 [queue failed] pr 5 — removed from the merge queue at 2026-10-02 02:36 UTC"]);
});

test("#621: removed then re-added, or never removed, prints nothing", async () => {
  const { main } = await import("./queue.mjs");
  const world = {
    issues: [],
    prs: [pr(5, 5, ["a"]), pr(6, 6, ["b"])],
    sessions: [],
    gateNodes: [queueNode(5, [REMOVED, "2026-10-02T02:36:00Z"], [ADDED, "2026-10-02T02:40:00Z"]), queueNode(6)],
  };
  const run = fakeRun(world, { onSleep: (t) => t === 3 && (world.prs = []) });
  await main([], run.deps);
  assert.deepEqual(failedLines(run), []);
});

// --- #630: the heartbeat comment on the lanes-health issue (ADR 0027 part 2). ---

const BOT = { login: "sour-dev-lanes[bot]" };
// A health.mjs-shaped client over one health issue (#900). `comments` is the issue's comments; `calls` records every operation.
function fakeHealthClient({ comments = [], issues = [{ number: 900, state: "OPEN", body: "", lastWriter: null }], failEdit = false } = {}) {
  const calls = [];
  let nextId = 5000;
  return {
    calls,
    comments,
    async listIssues(label) {
      calls.push(["listIssues", label]);
      return issues;
    },
    async createLabel(label) {
      calls.push(["createLabel", label]);
    },
    async createIssue(issueArgs) {
      calls.push(["createIssue", issueArgs.labels]);
      return 901;
    },
    async listComments(number) {
      calls.push(["listComments", number]);
      return comments;
    },
    async comment(number, text) {
      calls.push(["comment", number]);
      const id = nextId++;
      comments.push({ id, body: text, author: BOT });
      return id;
    },
    async editComment(id, text) {
      calls.push(["editComment", id]);
      if (failEdit) throw new Error("HTTP 404");
      comments.find((c) => c.id === id).body = text;
    },
  };
}
const beatPayload = (findings = [], at = "2026-09-28T09:00:00.000Z") => ({ at, commit: "abc1234", findings, paused: false });
const blockOf = (text) => JSON.parse(/\{[\s\S]*\}/.exec(text.slice(text.indexOf("-->") + 3))[0]);

// Criterion 1
test("heartbeat: the first write creates one comment starting the marker, holding time, commit and findings", async () => {
  const { heartbeatWriter } = await import("./queue.mjs");
  const client = fakeHealthClient();
  await heartbeatWriter(() => client, QUEUE_TEAM)(beatPayload(["queue-stopped:disk full"]));
  assert.deepEqual(client.calls.filter(([op]) => op === "comment"), [["comment", 900]]);
  assert.equal(client.comments.length, 1);
  assert.ok(client.comments[0].body.startsWith("<!-- lanes:heartbeat -->"));
  assert.deepEqual(blockOf(client.comments[0].body), beatPayload(["queue-stopped:disk full"]));
});

test("heartbeat: later writes edit that comment and never post a second one", async () => {
  const { heartbeatWriter } = await import("./queue.mjs");
  const client = fakeHealthClient();
  const write = heartbeatWriter(() => client, QUEUE_TEAM);
  await write(beatPayload([], "2026-09-28T09:00:00.000Z"));
  await write(beatPayload(["stalled-lane:issue 7"], "2026-09-28T09:03:00.000Z"));
  await write(beatPayload([], "2026-09-28T09:06:00.000Z"));
  assert.equal(client.comments.length, 1);
  assert.equal(client.calls.filter(([op]) => op === "comment").length, 1);
  assert.deepEqual(client.calls.filter(([op]) => op === "editComment"), [["editComment", 5000], ["editComment", 5000]]);
  assert.equal(client.calls.filter(([op]) => op === "listComments").length, 1, "the comment is found once, then remembered");
  assert.equal(blockOf(client.comments[0].body).at, "2026-09-28T09:06:00.000Z");
});

// Criterion 2
test("heartbeat: it finds the health issue with findOrCreateHealthIssue, creating it when there is none", async () => {
  const { heartbeatWriter } = await import("./queue.mjs");
  const client = fakeHealthClient({ issues: [] });
  await heartbeatWriter(() => client, QUEUE_TEAM)(beatPayload());
  assert.deepEqual(client.calls.slice(0, 3), [["listIssues", "lanes-health"], ["createLabel", "lanes-health"], ["createIssue", ["lanes-health"]]]);
  assert.deepEqual(client.calls.filter(([op]) => op === "comment"), [["comment", 901]]);
});

test("heartbeat: an existing lane-bot heartbeat is edited, and other comments, even with the marker, are never touched", async () => {
  const { heartbeatWriter } = await import("./queue.mjs");
  const marker = "<!-- lanes:heartbeat -->\n{}";
  const comments = [
    { id: 11, body: "Recovered: lanes is healthy again.", author: BOT },
    { id: 12, body: marker, author: { login: "someone-else" } },
    { id: 13, body: marker, author: BOT },
    { id: 14, body: marker, author: { login: "sour-dev-lanes" } },
    { id: 15, body: "no marker here", author: BOT },
  ];
  const before = comments.map((c) => c.body);
  const client = fakeHealthClient({ comments });
  await heartbeatWriter(() => client, QUEUE_TEAM)(beatPayload());
  assert.deepEqual(client.calls.filter(([op]) => op === "editComment" || op === "comment"), [["editComment", 13]]);
  assert.deepEqual(comments.map((c) => c.body).filter((_, i) => i !== 2), before.filter((_, i) => i !== 2));
  assert.ok(client.calls.every(([op, arg]) => (op !== "listComments" && op !== "comment") || arg === 900), "only the health issue is read or commented on");
});

test("edge: a heartbeat written for the wrong bot identity is not adopted: a new comment is made", async () => {
  const { heartbeatWriter } = await import("./queue.mjs");
  const client = fakeHealthClient({ comments: [{ id: 12, body: "<!-- lanes:heartbeat -->\n{}", author: { login: "other[bot]" } }] });
  await heartbeatWriter(() => client, QUEUE_TEAM)(beatPayload());
  assert.deepEqual(client.calls.filter(([op]) => op === "editComment"), []);
  assert.equal(client.comments.length, 2);
});

test("heartbeat: a failed write throws and forgets the comment, so the next write looks again", async () => {
  const { heartbeatWriter } = await import("./queue.mjs");
  const client = fakeHealthClient({ comments: [{ id: 13, body: "<!-- lanes:heartbeat -->\n{}", author: BOT }], failEdit: true });
  const write = heartbeatWriter(() => client, QUEUE_TEAM);
  await assert.rejects(write(beatPayload()), /HTTP 404/);
  await assert.rejects(write(beatPayload()), /HTTP 404/);
  assert.equal(client.calls.filter(([op]) => op === "listComments").length, 2);
});

test("edge: a created comment that comes back with no id is an error, not a later edit of undefined", async () => {
  const { heartbeatWriter } = await import("./queue.mjs");
  const client = { ...fakeHealthClient(), comment: async () => undefined };
  await assert.rejects(heartbeatWriter(() => client, QUEUE_TEAM)(beatPayload()), /without an id/);
});

test("edge: an asynchronous getClient that rejects (no token) is a failed write", async () => {
  const { heartbeatWriter } = await import("./queue.mjs");
  await assert.rejects(heartbeatWriter(async () => { throw new Error("key file unreadable"); }, QUEUE_TEAM)(beatPayload()), /key file unreadable/);
});

test("the heartbeat block is what health.mjs readHeartbeat reads from the lane bot", async () => {
  const { heartbeatBody } = await import("./queue.mjs");
  const { readHeartbeat } = await import("./health.mjs");
  const body = heartbeatBody(beatPayload(["idle-lane:issue 5", "queue-stopped:cannot restart dirty"]));
  const got = readHeartbeat([{ body, author: BOT, updatedAt: "2026-09-28T09:00:00Z" }], QUEUE_TEAM);
  assert.deepEqual(got, { at: Date.parse("2026-09-28T09:00:00.000Z"), findings: ["idle-lane:issue 5", "queue-stopped:cannot restart dirty"], paused: false });
});

// Criterion 1: each finding
test("findings: a lane session idle with no PR, a stalled lane, and a stop with its reason", async () => {
  const { heartbeatFindings } = await import("./queue.mjs");
  const prs = [pr(50, 5, ["src/a.mjs"])];
  assert.deepEqual(heartbeatFindings({ idle: new Map([[5, 40], [6, 50]]), prs }), ["idle-lane:issue 6"], "issue 5 has a PR");
  assert.deepEqual(heartbeatFindings({ stalled: new Map([[7, 45]]) }), ["stalled-lane:issue 7"]);
  assert.deepEqual(heartbeatFindings({ stop: "cannot restart: the checkout is on feature, not main" }), ["queue-stopped:cannot restart the checkout is on feature not main"]);
  assert.deepEqual(heartbeatFindings({}), []);
});

test("edge: a stop's reason is cut to the finding alphabet and 80 characters, and the stop survives the cap", async () => {
  const { heartbeatFindings } = await import("./queue.mjs");
  const [stop, ...rest] = heartbeatFindings({ stop: `@owner #1 \`rm\` ${"x".repeat(200)}`, stalled: new Map(Array.from({ length: 30 }, (_, i) => [i + 1, 40])) });
  assert.match(stop, /^queue-stopped:[A-Za-z0-9 ._/()-]{1,80}$/);
  assert.ok(!/[@#`]/.test(stop));
  assert.equal(rest.length, 19, "20 findings at most");
  assert.deepEqual(heartbeatFindings({ stop: "" }), ["queue-stopped"]);
});

test("edge: the 20-finding cap and the 80-character cut hold at the exact boundary", async () => {
  const { heartbeatFindings } = await import("./queue.mjs");
  const stalled = (n) => new Map(Array.from({ length: n }, (_, i) => [i + 1, 40]));
  assert.equal(heartbeatFindings({ stalled: stalled(19) }).length, 19);
  assert.equal(heartbeatFindings({ stalled: stalled(20) }).length, 20);
  assert.equal(heartbeatFindings({ stalled: stalled(21) }).length, 20);
  assert.equal(heartbeatFindings({ stop: "stop", stalled: stalled(20) })[0], "queue-stopped:stop");
  assert.equal(heartbeatFindings({ stop: "stop", stalled: stalled(20) }).length, 20);
  const reasonOf = (n) => heartbeatFindings({ stop: "x".repeat(n) })[0].slice("queue-stopped:".length);
  assert.equal(reasonOf(79).length, 79);
  assert.equal(reasonOf(80).length, 80);
  assert.equal(reasonOf(81).length, 80);
});

// Criterion 1 and 2, through main
function heartbeatRun(world, { failWith = null, idle, stalledIssues = [], ...options } = {}) {
  const run = fakeRun(world, options);
  const beats = [];
  run.deps.heartbeat = ({ identity }) => {
    beats.push({ identity });
    return async (payload) => {
      if (failWith) throw new Error(failWith);
      beats.push(payload);
    };
  };
  if (idle) run.deps.idle = idle;
  if (stalledIssues.length) run.deps.recovery = recoveryRun(world, { stalledIssues }).deps.recovery;
  return { ...run, beats, written: () => beats.filter((b) => b.at) };
}

test("main: every tick writes one heartbeat with the time and the script commit", async () => {
  const { main } = await import("./queue.mjs");
  const run = heartbeatRun({ issues: [], prs: [], sessions: [] }, { idleContinues: true, maxTicks: 3 });
  const git = fakeGit({ head: "abc1234def", remote: "abc1234def" });
  await assert.rejects(main([], { ...run.deps, git: git.git }), /never stopped/);
  assert.deepEqual(run.beats[0].identity, QUEUE_TEAM);
  assert.equal(run.written().length, 4);
  assert.deepEqual(run.written()[0], { at: "2026-09-28T09:00:00.000Z", commit: "abc1234def", findings: [], paused: false });
  assert.equal(run.written()[1].at, "2026-09-28T09:03:00.000Z");
});

test("main: a lane session idle with no PR and a stalled lane are reported; an idle lane with a PR is not", async () => {
  const { main } = await import("./queue.mjs");
  const world = { issues: [issue(4, ["src/d.mjs"])], prs: [pr(50, 5, ["src/a.mjs"])], sessions: [session(4), session(5), session(7)] };
  const stop = () => {
    throw Object.assign(new Error("stop"), { code: "QUEUE_STOP" });
  };
  const run = heartbeatRun(world, { idle: () => new Map([[4, 40], [5, 40]]), stalledIssues: [7], onSleep: stop });
  await main([], run.deps);
  assert.deepEqual(run.written()[0].findings, ["idle-lane:issue 4", "stalled-lane:issue 7"]);
});

test("main: an idle check that throws says so, and the heartbeat still goes out without that finding", async () => {
  const { main } = await import("./queue.mjs");
  const run = heartbeatRun({ issues: [], prs: [], sessions: [] }, { idle: () => { throw new Error("EPERM"); } });
  assert.equal(await main([], run.deps), 0);
  assert.ok(run.out.some((l) => l.endsWith("idle check failed: EPERM")));
  assert.deepEqual(run.written()[0].findings, []);
});

test("main: a stop it is about to make is in the heartbeat with its reason, before it exits", async () => {
  const { main } = await import("./queue.mjs");
  const run = heartbeatRun({ issues: [], prs: [], sessions: [] });
  const git = fakeGit({ remote: "bbbbbbb2222", changed: ["scripts/lanes/queue.mjs"], branch: "feature" });
  assert.equal(await main([], { ...run.deps, git: git.git }), 3);
  assert.deepEqual(run.written().map((b) => b.findings), [["queue-stopped:cannot restart the checkout is on feature not main"]]);
});

test("main: a restart is not a stop, so it writes no heartbeat finding", async () => {
  const { main } = await import("./queue.mjs");
  const run = heartbeatRun({ issues: [], prs: [], sessions: [] });
  const git = fakeGit({ remote: "bbbbbbb2222", changed: ["scripts/lanes/queue.mjs"] });
  assert.equal(await main([], { ...run.deps, git: git.git }), 10);
  assert.deepEqual(run.written(), []);
});

test("main: a failed heartbeat write prints one line, repeats nothing, and never stops the queue", async () => {
  const { main } = await import("./queue.mjs");
  const world = { issues: [issue(1, ["src/a.mjs"])], prs: [], sessions: [] };
  const run = heartbeatRun(world, { failWith: "HTTP 502: Bad Gateway", onSleep: (t) => t === 3 && (world.issues = []) });
  assert.equal(await main([], run.deps), 0);
  assert.deepEqual(run.launched.map((l) => l.n), [1], "launching goes on");
  assert.ok(run.ticks() >= 3);
  assert.equal(run.out.filter((l) => l.endsWith("heartbeat not written: HTTP 502: Bad Gateway")).length, 1, run.out.join("\n"));
});

test("main: a failed write is said again after a write that worked, and without a heartbeat dep nothing is written", async () => {
  const { main } = await import("./queue.mjs");
  const run = fakeRun({ issues: [], prs: [], sessions: [] }, { idleContinues: true, maxTicks: 5 });
  let n = 0;
  run.deps.heartbeat = () => async () => {
    n += 1;
    if (n === 1 || n === 3) throw new Error("HTTP 500");
  };
  await assert.rejects(main([], run.deps), /never stopped/);
  assert.equal(run.out.filter((l) => l.endsWith("heartbeat not written: HTTP 500")).length, 2);
  const plain = fakeRun({ issues: [], prs: [], sessions: [] });
  assert.equal(await main([], plain.deps), 0);
  assert.ok(plain.out.every((l) => !/heartbeat/.test(l)));
});

test("main: the heartbeat touches no other issue: the queue's own gh calls are unchanged", async () => {
  const { main } = await import("./queue.mjs");
  const withBeat = heartbeatRun({ issues: [], prs: [], sessions: [] });
  const without = fakeRun({ issues: [], prs: [], sessions: [] });
  await main([], withBeat.deps);
  await main([], without.deps);
  assert.deepEqual(withBeat.calls, without.calls);
});

// --- #645 (ADR 0028): the pause switch. ---
const PAUSED_STATE = { paused: true, since: "2026-10-02T08:30:00.000Z", by: "owner", reason: "maintenance" };
const pausedLine = (out) => out.filter((l) => / paused since /.test(l));

test("#645: while paused nothing launches, one line is printed, and the queue keeps polling; it resumes with one line", async () => {
  const { main } = await import("./queue.mjs");
  const world = { issues: [issue(1, ["src/a.mjs"])], prs: [], sessions: [] };
  const run = fakeRun(world, { onSleep: (t) => t === 4 && (world.issues = []) });
  run.deps.control = () => (run.ticks() < 3 ? PAUSED_STATE : { paused: false });
  assert.equal(await main([], run.deps), 0);
  assert.deepEqual(run.launched.map((l) => [l.n, l.tick]), [[1, 3]]);
  assert.equal(pausedLine(run.out).length, 1, run.out.join("\n"));
  assert.match(pausedLine(run.out)[0], / paused since 2026-10-02 08:30 UTC by owner: maintenance$/);
  assert.equal(run.out.filter((l) => / resumed$/.test(l)).length, 1);
  assert.ok(run.ticks() >= 3, "kept polling");
});

test("#645: a queue that starts running prints neither paused nor resumed", async () => {
  const { main } = await import("./queue.mjs");
  const world = { issues: [issue(1, ["src/a.mjs"])], prs: [], sessions: [] };
  const run = fakeRun(world, { onSleep: (t) => t === 1 && (world.issues = []) });
  run.deps.control = () => ({ paused: false });
  assert.equal(await main([], run.deps), 0);
  assert.deepEqual(run.launched.map((l) => l.n), [1]);
  assert.ok(!run.out.some((l) => /paused|resumed/.test(l)));
});

test("#645: a dead lane is not resumed while paused, and is resumed after the pause lifts", async () => {
  const { main } = await import("./queue.mjs");
  const world = { issues: [issue(7, ["src/a.mjs"])], prs: [gatePr(70, 7, "waiting for review/security-reviewer")], sessions: [idleLane(7)] };
  const run = recoveryRun(world);
  run.deps.control = () => (run.ticks() < 2 ? PAUSED_STATE : { paused: false });
  assert.equal(await main([], run.deps), 0);
  assert.deepEqual(run.launched.map((l) => [l.n, l.tick]), [[7, 2]]);
  assert.deepEqual(run.removed, []);
  assert.equal(run.markers.get(7).outcome, "resume");
});

test("#645: a stalled lane is not stopped or removed while paused", async () => {
  const { main } = await import("./queue.mjs");
  const world = { issues: [issue(7, ["src/a.mjs"])], prs: [], sessions: [lane(7)] };
  const run = recoveryRun(world, { stalledIssues: [7] });
  run.deps.control = () => PAUSED_STATE;
  const stop = async () => {
    throw Object.assign(new Error("stop"), { code: "QUEUE_STOP" });
  };
  assert.equal(await main([], { ...run.deps, sleep: stop }), 0);
  assert.deepEqual([run.stopped, run.removed, run.launched], [[], [], []]);
});

test("#645: a control read that throws is paused, fail closed, with the reason named", async () => {
  const { main } = await import("./queue.mjs");
  const world = { issues: [issue(1, ["src/a.mjs"])], prs: [], sessions: [] };
  const run = fakeRun(world, { onSleep: (t) => t === 2 && (world.issues = []) });
  run.deps.control = async () => {
    throw new Error("HTTP 403: rate limit exceeded\nmore");
  };
  assert.equal(await main([], run.deps), 0);
  assert.deepEqual(run.launched, []);
  assert.match(pausedLine(run.out)[0], / by lanes: the pause state cannot be read: HTTP 403: rate limit exceeded$/);
});

test("edge: #645 a control state with an odd shape is paused, and a changed reason prints a new line", async () => {
  const { main } = await import("./queue.mjs");
  const world = { issues: [issue(1, ["src/a.mjs"])], prs: [], sessions: [] };
  const run = fakeRun(world, { onSleep: (t) => t === 2 && (world.issues = []) });
  run.deps.control = () => (run.ticks() < 1 ? undefined : { ...PAUSED_STATE, reason: "second reason", since: "not a date" });
  assert.equal(await main([], run.deps), 0);
  assert.deepEqual(run.launched, []);
  assert.equal(pausedLine(run.out).length, 2, run.out.join("\n"));
  assert.match(pausedLine(run.out)[1], / by owner: second reason$/);
});

test("#645: the queue reads the pause state with its default gh login, never the App token (the App has no actions permission)", () => {
  const src = readFileSync(new URL("./queue.mjs", import.meta.url), "utf8");
  const body = /function pauseState\(\) \{[\s\S]*?\n\}/.exec(src)[0];
  assert.match(body, /readControlState/);
  assert.doesNotMatch(body, /GH_TOKEN|GITHUB_TOKEN|tokenNow|mintInstallationToken|appHeartbeat/);
});

test("#645: the self-restart still happens while paused", async () => {
  const { main, RESTART_CODE } = await import("./queue.mjs");
  const run = fakeRun({ issues: [], prs: [], sessions: [] });
  run.deps.control = () => PAUSED_STATE;
  const git = fakeGit({ head: "aaaaaaa1111", remote: "bbbbbbb2222", changed: ["scripts/lanes/queue.mjs"] });
  assert.equal(await main([], { ...run.deps, git: git.git }), RESTART_CODE);
});

test("#645: the heartbeat carries paused, true while paused and false after", async () => {
  const { main } = await import("./queue.mjs");
  const run = heartbeatRun({ issues: [], prs: [], sessions: [] }, { idleContinues: true, maxTicks: 3 });
  run.deps.control = () => (run.ticks() < 2 ? PAUSED_STATE : { paused: false });
  await assert.rejects(main([], { ...run.deps, git: fakeGit({ head: "abc1234def", remote: "abc1234def" }).git }), /never stopped/);
  assert.deepEqual(run.written().map((b) => b.paused), [true, true, false, false]);
});

// --- #724: a lane that stopped before its PR is resumed in its worktree once needs-owner is removed. ---

const tree = (n, slug = "work") => ({ path: `/repo/.claude/worktrees/issue-${n}-${slug}`, branch: `issue-${n}-${slug}` });

// recoveryRun plus the worktree list and a log saver; `saved` records the sessions whose log was saved.
function resumeRun(world, { trees = [tree(7)], ...options } = {}) {
  const run = recoveryRun(world, options);
  const saved = [];
  run.deps.recovery.worktrees = () => trees;
  run.deps.recovery.saveLog = (id, n) => (saved.push(id), `.lanes/logs/issue-${n}-${id}.txt`);
  return { ...run, saved };
}

test("#724: a stopped lane with no session is resumed in its worktree, once", async () => {
  const { main } = await import("./queue.mjs");
  const world = { issues: [issue(7, ["src/a.mjs"])], prs: [], sessions: [] };
  const run = resumeRun(world);
  assert.equal(await main([], run.deps), 0);
  assert.deepEqual(run.launched.map((l) => l.n), [7]);
  assert.deepEqual(launchDirs(run), ["/repo/.claude/worktrees/issue-7-work"]);
  assert.deepEqual([run.stopped, run.removed], [[], []]);
  assert.equal(run.out.filter((l) => l.endsWith(" #7: resumed in its worktree (no PR yet)")).length, 1, run.out.join("\n"));
});

test("#724: a blocked session is stopped with its log saved, then the lane is resumed", async () => {
  const { main } = await import("./queue.mjs");
  const world = { issues: [issue(7, ["src/a.mjs"])], prs: [], sessions: [lane(7, { status: undefined, state: "blocked" })] };
  const run = resumeRun(world);
  assert.equal(await main([], run.deps), 0);
  assert.deepEqual(run.stopped, ["old-7"]);
  assert.deepEqual(run.saved, ["old-7"]);
  assert.deepEqual(run.removed, []);
  assert.deepEqual(run.launched.map((l) => l.n), [7]);
  assert.deepEqual(launchDirs(run), ["/repo/.claude/worktrees/issue-7-work"]);
  assert.ok(run.out.some((l) => l.includes("session log saved to .lanes/logs/issue-7-old-7.txt")), run.out.join("\n"));
});

test("#724: an idle session recovery already handled and left is stopped, then resumed", async () => {
  const { main } = await import("./queue.mjs");
  const world = { issues: [issue(7, ["src/a.mjs"])], prs: [], sessions: [idleLane(7)] };
  const run = resumeRun(world, { markers: new Map([[7, { session: "old-7" }]]) });
  assert.equal(await main([], run.deps), 0);
  assert.deepEqual(run.stopped, ["old-7"]);
  assert.deepEqual(run.launched.map((l) => l.n), [7]);
});

test("#724: a working session is not touched and the issue stays in flight", async () => {
  const { main } = await import("./queue.mjs");
  for (const status of ["working", "busy"]) {
    const world = { issues: [issue(7, ["src/a.mjs"])], prs: [], sessions: [lane(7, { status })] };
    const run = resumeRun(world);
    assert.equal(await main([], run.deps), 0);
    assert.deepEqual([run.launched, run.stopped, run.saved], [[], [], []], status);
  }
});

// --- #730: today's `claude agents --json` has `state` (working, blocked, done) and no `status`. ---

test("#730: the #713 case: a done session (no status) in front of a resumable worktree is stopped and the lane resumed", async () => {
  const { main } = await import("./queue.mjs");
  // A done session is one recovery already handled and left (its marker names it); a blocked one is not recovery's.
  for (const state of ["done", "blocked"]) {
    const world = { issues: [issue(7, ["src/a.mjs"])], prs: [], sessions: [lane(7, { status: undefined, state })] };
    const run = resumeRun(world, state === "done" ? { markers: new Map([[7, { session: "old-7" }]]) } : {});
    assert.equal(await main([], run.deps), 0);
    assert.deepEqual(run.stopped, ["old-7"], state);
    assert.deepEqual(run.launched.map((l) => l.n), [7], state);
    assert.deepEqual(launchDirs(run), ["/repo/.claude/worktrees/issue-7-work"], state);
  }
});

test("#730: a working or unknown-state session (no status) is left alone and the issue stays in flight", async () => {
  const { main } = await import("./queue.mjs");
  for (const state of ["working", "paused", undefined]) {
    const world = { issues: [issue(7, ["src/a.mjs"])], prs: [], sessions: [lane(7, { status: undefined, state })] };
    const run = resumeRun(world);
    assert.equal(await main([], run.deps), 0);
    assert.deepEqual([run.launched, run.stopped, run.saved], [[], [], []], String(state));
  }
});

test("#730: planRecovery names a lane whose session is done (no status) with an open PR waiting on a review, and not a working one", async () => {
  const { planRecovery } = await import("./queue.mjs");
  const issues = [issue(7, ["src/a.mjs"]), issue(9, ["src/c.mjs"])];
  const prs = [gatePr(70, 7, "waiting for review/security-reviewer"), gatePr(90, 9, "waiting for review/test-hunter")];
  const sessions = [lane(7, { status: undefined, state: "done" }), lane(9, { status: undefined, state: "working" })];
  assert.deepEqual(planRecovery({ issues, prs, sessions }).map((r) => [r.number, r.resume, r.id]), [[7, true, "old-7"]]);
});

test("#724: needs-owner still present: nothing is resumed", async () => {
  const { main } = await import("./queue.mjs");
  const world = { issues: [issue(7, ["src/a.mjs"], { labels: ["ready", "tier:quick", "needs-owner"] })], prs: [], sessions: [] };
  const run = resumeRun(world);
  assert.equal(await main([], run.deps), 0);
  assert.deepEqual(run.launched, []);
});

test("#724: two worktrees for the issue: skipped with a reason, nothing launched", async () => {
  const { main } = await import("./queue.mjs");
  const world = { issues: [issue(7, ["src/a.mjs"])], prs: [], sessions: [] };
  const run = resumeRun(world, { trees: [tree(7), tree(7, "again")] });
  assert.equal(await main([], run.deps), 0);
  assert.deepEqual(run.launched, []);
  assert.equal(run.out.filter((l) => l.endsWith(" #7: skipped: several worktrees")).length, 1, run.out.join("\n"));
});

test("#724: edge: a dirty worktree is still resumed, lane.md step 3b reports it", async () => {
  const { main } = await import("./queue.mjs");
  const world = { issues: [issue(7, ["src/a.mjs"])], prs: [], sessions: [] };
  const run = resumeRun(world, { workLeft: "uncommitted changes" });
  assert.equal(await main([], run.deps), 0);
  assert.deepEqual(run.launched.map((l) => l.n), [7]);
});

test("#724: edge: an issue with an open PR, or another issue's worktree, is not resumed by this path", async () => {
  const { planWorktreeResume } = await import("./queue.mjs");
  const base = { issues: [issue(7, ["src/a.mjs"])], worktrees: [tree(7)] };
  assert.deepEqual(planWorktreeResume({ ...base, prs: [gatePr(70, 7, "waiting for review/security-reviewer")] }).resume, []);
  assert.deepEqual(planWorktreeResume({ ...base, worktrees: [tree(8)] }).resume, []);
  assert.deepEqual(planWorktreeResume({ ...base, worktrees: [{ path: "/repo/x", branch: "worktree-issue-7-x" }] }).resume, []);
});

test("#724: edge: a session with an unsafe id is left alone", async () => {
  const { planWorktreeResume } = await import("./queue.mjs");
  const input = { issues: [issue(7, ["src/a.mjs"])], worktrees: [tree(7)], sessions: [lane(7, { id: "--all", status: undefined, state: "blocked" })] };
  assert.deepEqual(planWorktreeResume(input), { resume: [], skipped: [] });
});

test("#724: the maxLanes cap counts the lanes still running, and a stopped session does not count", async () => {
  const { planWorktreeResume } = await import("./queue.mjs");
  const issues = [1, 2, 7, 8].map((n) => issue(n, [`src/${n}.mjs`]));
  const worktrees = [tree(7), tree(8)];
  const sessions = [lane(1), lane(2), lane(7, { status: undefined, state: "blocked" })];
  const out = planWorktreeResume({ issues, prs: [], sessions, worktrees, maxLanes: 3 });
  assert.deepEqual(out.resume.map((r) => r.number), [7]);
  assert.deepEqual(out.skipped, [{ number: 8, reason: "at maxLanes" }]);
  assert.deepEqual(planWorktreeResume({ issues, prs: [], sessions, worktrees, maxLanes: 2 }).resume, []);
});

test("#724: edge: an issue planRecovery already handles this tick is left to it", async () => {
  const { planWorktreeResume } = await import("./queue.mjs");
  const input = { issues: [issue(7, ["src/a.mjs"])], worktrees: [tree(7)], sessions: [], handled: new Set([7]) };
  assert.deepEqual(planWorktreeResume(input).resume, []);
});

test("#724: edge: a session that will not stop is left for the owner, nothing launched", async () => {
  const { main } = await import("./queue.mjs");
  const world = { issues: [issue(7, ["src/a.mjs"])], prs: [], sessions: [lane(7, { status: undefined, state: "blocked" })] };
  const run = resumeRun(world, { stopWorks: false });
  assert.equal(await main([], run.deps), 0);
  assert.deepEqual(run.launched, []);
  assert.equal(run.out.filter((l) => l.includes("#7: could not stop session old-7")).length, 1, run.out.join("\n"));
});

test("#724: edge: a stop that throws is reported once and nothing is launched afresh", async () => {
  const { main } = await import("./queue.mjs");
  const world = { issues: [issue(7, ["src/a.mjs"])], prs: [], sessions: [lane(7, { status: undefined, state: "blocked" })] };
  const run = resumeRun(world);
  const prior = run.deps.claude;
  run.deps.claude = (args, opts) => {
    if (args[0] === "stop") throw new Error("stop refused");
    return prior(args, opts);
  };
  assert.equal(await main([], run.deps), 0);
  assert.deepEqual(run.launched, [], run.out.join("\n"));
  assert.equal(run.out.filter((l) => l.includes("#7: recovery failed: stop refused")).length, 1, run.out.join("\n"));
});

test("#724: edge: a worktree listing that throws is reported and nothing is resumed", async () => {
  const { main } = await import("./queue.mjs");
  const run = resumeRun({ issues: [issue(7, ["src/a.mjs"])], prs: [], sessions: [] });
  run.deps.recovery.worktrees = () => {
    throw new Error("git broke");
  };
  assert.equal(await main([], run.deps), 0);
  assert.ok(run.out.some((l) => l.includes("worktrees cannot be listed") && l.includes("git broke")), run.out.join("\n"));
  assert.ok(!launchDirs(run).some((dir) => dir.includes("/worktrees/")), "no lane is launched in a worktree");
});

// Found by the test-hunter: an `attempted` issue must be held, or planTick launches it fresh from the repo root.
test("#724: edge: a resumed lane that vanishes without a PR is not launched afresh from the repo root in the same run", async () => {
  const { main } = await import("./queue.mjs");
  const world = { issues: [issue(7, ["src/a.mjs"])], prs: [], sessions: [] };
  const run = resumeRun(world);
  const prior = run.deps.sleep;
  run.deps.sleep = async (ms) => {
    if (run.launched.length === 1 && world.sessions.length) world.sessions = [];
    return prior(ms);
  };
  assert.equal(await main([], run.deps), 0);
  assert.deepEqual(run.launched.map((l) => l.n), [7], run.out.join("\n"));
});

// #739: a marker is cleared when the owner removed `needs-owner` after it was written, so a lane that stopped a second
// time is resumed again; a marker never cleared by an events error, an older removal or a label never set.
function clearedRun(cleared) {
  const world = { issues: [issue(7, ["src/a.mjs"])], prs: [], sessions: [lane(7, { status: "idle" })] };
  const markers = new Map([[7, { issue: 7, session: "old-7", reason: "session ended with no open PR", time: "2026-10-04T17:00:00.000Z" }]]);
  const run = recoveryRun(world, { markers });
  run.deps.recovery.ownerClearedAt = typeof cleared === "function" ? cleared : () => cleared;
  return run;
}

test("#739: a marker older than the latest needs-owner removal is cleared and the lane recovered again", async () => {
  const { main } = await import("./queue.mjs");
  const run = clearedRun("2026-10-04T17:16:00.000Z");
  assert.equal(await main([], run.deps), 0);
  assert.deepEqual(run.stopped, ["old-7"]);
  assert.equal(run.launched.length, 1, run.out.join("\n"));
  assert.notEqual(run.markers.get(7).time, "2026-10-04T17:00:00.000Z");
});

test("#739: a marker newer than the needs-owner removal is kept and the session skipped", async () => {
  const { main } = await import("./queue.mjs");
  const run = clearedRun("2026-10-04T16:00:00.000Z");
  assert.equal(await main([], run.deps), 0);
  assert.deepEqual([run.stopped, run.removed, run.launched], [[], [], []]);
  assert.equal(run.markers.get(7).time, "2026-10-04T17:00:00.000Z");
});

test("#739: edge: an issue that never had needs-owner keeps its marker", async () => {
  const { main } = await import("./queue.mjs");
  const run = clearedRun(null);
  assert.equal(await main([], run.deps), 0);
  assert.deepEqual([run.stopped, run.removed, run.launched], [[], [], []]);
});

test("#739: edge: an events read error keeps the marker and says nothing is resumed", async () => {
  const { main } = await import("./queue.mjs");
  const run = clearedRun(() => {
    throw new Error("API rate limit");
  });
  assert.equal(await main([], run.deps), 0);
  assert.deepEqual([run.stopped, run.removed, run.launched], [[], [], []]);
  assert.equal(run.markers.get(7).time, "2026-10-04T17:00:00.000Z");
});

test("#739: edge: a marker with no readable time or an unparseable removal time is kept", async () => {
  const { main } = await import("./queue.mjs");
  for (const [time, cleared] of [[undefined, "2026-10-04T17:16:00.000Z"], ["2026-10-04T17:00:00.000Z", "not a date"]]) {
    const run = clearedRun("2026-10-04T17:16:00.000Z");
    run.markers.set(7, { issue: 7, session: "old-7", reason: "x", time });
    run.deps.recovery.ownerClearedAt = () => cleared;
    assert.equal(await main([], run.deps), 0);
    assert.deepEqual(run.launched, []);
  }
});
