import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIRST_POLL_MS, GIVE_UP_FAILURES, GIVE_UP_MS, POLL_MS, STARTUP_GRACE_MS, laneInputs, main, reapTick, runOptions } from "./reap.mjs";

const HOUR = 60 * 60 * 1000;
const T0 = Date.UTC(2026, 8, 28, 12);
const lane = (extra = {}) => ({ id: "s7", cwd: "C:\\repo\\.claude\\worktrees\\issue-7-x", status: "idle", state: "idle", ...extra });
const pr = (state, extra = {}) => ({ number: 90, state, headRefName: "issue-7-x", ...extra });
const tick = (over = {}) =>
  reapTick({ issue: 7, session: "s7", issueState: "OPEN", prs: [], sessions: [lane()], startedAt: T0, now: T0 + HOUR, failures: 0, ...over });

// Criterion 1: the result's shape, and no I/O.
test("returns { action, reason } with a known action and a non-empty reason", () => {
  const r = tick();
  assert.deepEqual(Object.keys(r).sort(), ["action", "reason"]);
  assert.ok(["wait", "remove", "give-up"].includes(r.action));
  assert.equal(typeof r.reason, "string");
  assert.ok(r.reason.length > 0);
});

// The poll loop (a later issue) lives in the same file and does I/O, so this checks reapTick's own source and the
// pure helpers above it, which end at the "Everything below does I/O" marker when there is one.
test("reapTick and its helpers call nothing that does I/O", () => {
  const src = readFileSync(new URL("./reap.mjs", import.meta.url), "utf8").split("// Everything below does I/O")[0];
  const code = src.replace(/^import .*$/gm, "").replace(/^\s*(\/\/|\*|\/\*\*).*$/gm, "");
  assert.doesNotMatch(code, /(?<![.\w])(exec\w*|spawn\w*|fork|read\w*|write\w*|append\w*|fetch)\(|\b(process\.\w+|Date\.now|console\.\w+)/);
  assert.doesNotMatch(reapTick.toString(), /\bnew Date\(\)/);
});

test("reapTick does not change its input", () => {
  const input = { issue: 7, session: "s7", issueState: "CLOSED", prs: [pr("MERGED")], sessions: [lane()], startedAt: T0, now: T0 + HOUR, failures: 0 };
  const copy = structuredClone(input);
  reapTick(input);
  assert.deepEqual(input, copy);
});

// Criterion 2: remove only when merged or closed, and the session is not busy.
test("remove once the lane's PR merged and the session is idle", () => {
  const r = tick({ prs: [pr("MERGED")], issueState: "CLOSED" });
  assert.equal(r.action, "remove");
  assert.match(r.reason, /#90 merged/);
});

test("remove once the issue is closed with no PR, and the session is idle", () => {
  const r = tick({ issueState: "CLOSED" });
  assert.equal(r.action, "remove");
  assert.match(r.reason, /#7 closed/);
});

test("remove when the PR merged even though the issue is still open", () => {
  assert.equal(tick({ prs: [pr("MERGED")] }).action, "remove");
});

test("remove when the session's status is unknown and its state is idle", () => {
  assert.equal(tick({ issueState: "CLOSED", sessions: [lane({ status: undefined, state: "idle" })] }).action, "remove");
});

// Criterion 3: wait while the PR is open, the issue is open, or the session is busy.
test("wait while the lane's PR is open", () => {
  const r = tick({ prs: [pr("OPEN")] });
  assert.equal(r.action, "wait");
  assert.match(r.reason, /#90 is open/);
});

test("wait while the PR is open even when the issue is closed", () => {
  assert.equal(tick({ prs: [pr("OPEN")], issueState: "CLOSED" }).action, "wait");
});

test("wait while an open PR follows an earlier merged one", () => {
  assert.equal(tick({ prs: [pr("MERGED", { number: 80 }), pr("OPEN")], issueState: "CLOSED" }).action, "wait");
});

test("wait while the issue is open and nothing merged", () => {
  const r = tick();
  assert.equal(r.action, "wait");
  assert.match(r.reason, /#7 is open/);
});

test("wait while the session is busy after the PR merged", () => {
  const r = tick({ prs: [pr("MERGED")], issueState: "CLOSED", sessions: [lane({ status: "busy" })] });
  assert.equal(r.action, "wait");
  assert.match(r.reason, /busy/);
});

test("wait while the session is busy after the issue closed", () => {
  assert.equal(tick({ issueState: "CLOSED", sessions: [lane({ status: "busy" })] }).action, "wait");
});

test("busy falls back to state working when there is no status", () => {
  assert.equal(tick({ issueState: "CLOSED", sessions: [lane({ status: undefined, state: "working" })] }).action, "wait");
});

test("an idle status wins over a stale working state (#83)", () => {
  assert.equal(tick({ issueState: "CLOSED", sessions: [lane({ status: "idle", state: "working" })] }).action, "remove");
});

// Criterion 4: give up after 48 hours, 3 consecutive failures, or a mismatched session.
test("give up at 48 hours", () => {
  const r = tick({ now: T0 + 48 * HOUR });
  assert.equal(r.action, "give-up");
  assert.match(r.reason, /48 hours/);
});

test("give up at 48 hours even when the lane is done", () => {
  assert.equal(tick({ now: T0 + 48 * HOUR, prs: [pr("MERGED")], issueState: "CLOSED" }).action, "give-up");
});

test("give up after 3 consecutive failures", () => {
  const r = tick({ failures: 3 });
  assert.equal(r.action, "give-up");
  assert.match(r.reason, /3 consecutive/);
});

test("give up when the target session's cwd is another issue's worktree", () => {
  const r = tick({ sessions: [lane({ cwd: "C:\\repo\\.claude\\worktrees\\issue-8-y" })], prs: [pr("MERGED")], issueState: "CLOSED" });
  assert.equal(r.action, "give-up");
  assert.match(r.reason, /not an issue-7 worktree/);
});

test("give up when the target session's cwd is not a lane worktree at all", () => {
  assert.equal(tick({ sessions: [lane({ cwd: "C:\\repo" })] }).action, "give-up");
});

// #201: a lane starts at the repository root and only then enters its issue-N worktree, so a reaper started at launch
// waits out a startup grace for it.
const MIN = 60 * 1000;
const atRoot = () => lane({ cwd: "C:\\repo" });

test("wait when the session is not listed yet, 2 seconds after the reaper started", () => {
  const r = tick({ sessions: [], now: T0 + 2000 });
  assert.equal(r.action, "wait");
  assert.match(r.reason, /s7/);
});

test("wait when the session is still at the repository root, 5 minutes in", () => {
  const r = tick({ sessions: [atRoot()], now: T0 + 5 * MIN });
  assert.equal(r.action, "wait");
  assert.match(r.reason, /worktree/);
});

test("the session in its own worktree takes the normal path during the grace", () => {
  assert.equal(tick({ now: T0 + 2000 }).action, "wait");
  assert.equal(tick({ now: T0 + 2000, issueState: "CLOSED" }).action, "remove");
  assert.equal(tick({ now: T0 + 2000, prs: [pr("OPEN")] }).reason, "PR #90 is open");
});

test("give up at once when the session is in another issue's worktree, grace or not", () => {
  const other = lane({ cwd: "C:\\repo\\.claude\\worktrees\\issue-8-y" });
  for (const now of [T0, T0 + 2000, T0 + 5 * MIN, T0 + 29 * MIN]) {
    const r = tick({ sessions: [other], now });
    assert.equal(r.action, "give-up");
    assert.match(r.reason, /not an issue-7 worktree/);
  }
});

test("give up when the session is still at the repository root after the grace", () => {
  const r = tick({ sessions: [atRoot()], now: T0 + STARTUP_GRACE_MS });
  assert.equal(r.action, "give-up");
  assert.match(r.reason, /not an issue-7 worktree/);
});

test("give up when the session is still not listed after the grace", () => {
  const r = tick({ sessions: [], now: T0 + STARTUP_GRACE_MS });
  assert.equal(r.action, "give-up");
  assert.match(r.reason, /s7 not found/);
});

test("the startup grace is 30 minutes and the first poll waits 60 seconds", () => {
  assert.equal(STARTUP_GRACE_MS, 30 * MIN);
  assert.equal(FIRST_POLL_MS, 60 * 1000);
});

test("edge: 1 ms before the grace ends still waits, for a missing session and for one at the root", () => {
  assert.equal(tick({ sessions: [], now: T0 + STARTUP_GRACE_MS - 1 }).action, "wait");
  assert.equal(tick({ sessions: [atRoot()], now: T0 + STARTUP_GRACE_MS - 1 }).action, "wait");
});

test("edge: a session with no cwd waits during the grace", () => {
  assert.equal(tick({ sessions: [lane({ cwd: undefined })], now: T0 + MIN }).action, "wait");
});

test("edge: a lane that never showed up waits through the grace even when the issue looks done", () => {
  assert.equal(tick({ sessions: [], now: T0 + MIN, issueState: "CLOSED", prs: [pr("MERGED")] }).action, "wait");
});

test("edge: failures and the 48-hour limit still outrank the grace", () => {
  assert.equal(tick({ sessions: [], now: T0 + MIN, failures: 3 }).action, "give-up");
});

test("edge: an unread session list waits during and after the grace, as before", () => {
  assert.equal(tick({ sessions: null, now: T0 + MIN }).action, "wait");
  assert.equal(tick({ sessions: null, now: T0 + HOUR }).action, "wait");
});

test("edge: a session in a subfolder of another issue's worktree gives up during the grace, one in its own subfolder does not", () => {
  const sub = (n) => lane({ cwd: `C:\\repo\\.claude\\worktrees\\issue-${n}-y\\scripts` });
  assert.equal(tick({ sessions: [sub(8)], now: T0 + MIN }).action, "give-up");
  assert.equal(tick({ sessions: [sub(7)], now: T0 + MIN }).action, "wait");
  assert.equal(tick({ sessions: [sub(7)], now: T0 + MIN, issueState: "CLOSED" }).action, "remove");
});

test("the defaults are ADR 0010's", () => {
  assert.equal(GIVE_UP_MS, 48 * HOUR);
  assert.equal(GIVE_UP_FAILURES, 3);
});

// Edge cases.
test("edge: 1 ms before 48 hours still waits", () => {
  assert.equal(tick({ now: T0 + 48 * HOUR - 1 }).action, "wait");
});

test("edge: 2 consecutive failures do not give up", () => {
  assert.equal(tick({ failures: 2 }).action, "wait");
});

test("edge: failures default to 0 when left out", () => {
  const input = { issue: 7, session: "s7", issueState: "CLOSED", prs: [], sessions: [lane()], startedAt: T0, now: T0 + HOUR };
  assert.equal(reapTick(input).action, "remove");
});

test("edge: a bare issue-N worktree folder matches", () => {
  assert.equal(tick({ issueState: "CLOSED", sessions: [lane({ cwd: "C:/repo/.claude/worktrees/issue-7" })] }).action, "remove");
});

test("edge: a cwd inside the lane's worktree matches", () => {
  assert.equal(tick({ issueState: "CLOSED", sessions: [lane({ cwd: "/repo/.claude/worktrees/issue-7-x/scripts/" })] }).action, "remove");
});

test("edge: issue-70 is not issue-7", () => {
  assert.equal(tick({ sessions: [lane({ cwd: "C:\\repo\\.claude\\worktrees\\issue-70-x" })] }).action, "give-up");
});

test("edge: a folder that only starts with issue-7 (issue-7x) is not a lane folder", () => {
  assert.equal(tick({ sessions: [lane({ cwd: "C:\\repo\\.claude\\worktrees\\issue-7x" })] }).action, "give-up");
});

test("edge: the target session is gone from the list: give up", () => {
  const r = tick({ issueState: "CLOSED", sessions: [lane({ id: "other" })] });
  assert.equal(r.action, "give-up");
  assert.match(r.reason, /s7 not found/);
});

// The repo itself may sit under a lane-shaped folder (cloned inside an old lane's folder); the worktree folder under
// .claude/worktrees is what counts.
test("edge: an ancestor folder shaped like a lane folder does not shadow the real worktree", () => {
  const cwd = "D:\\src\\issue-99-oldclone\\repo\\.claude\\worktrees\\issue-7-x";
  assert.equal(tick({ issueState: "CLOSED", sessions: [lane({ cwd })] }).action, "remove");
});

test("edge: a lane-shaped folder inside the worktree does not shadow it either", () => {
  const cwd = "/repo/.claude/worktrees/issue-7-x/fixtures/issue-3-sample";
  assert.equal(tick({ issueState: "CLOSED", sessions: [lane({ cwd })] }).action, "remove");
});

test("edge: a cwd directly in .claude/worktrees is not a lane worktree", () => {
  assert.equal(tick({ sessions: [lane({ cwd: "/issue-7-x/.claude/worktrees" })] }).action, "give-up");
});

test("edge: a lane folder outside .claude/worktrees still counts", () => {
  assert.equal(tick({ issueState: "CLOSED", sessions: [lane({ cwd: "/lanes/issue-7-x/src" })] }).action, "remove");
});

test("edge: a session with no cwd gives up", () => {
  assert.equal(tick({ sessions: [lane({ cwd: undefined })] }).action, "give-up");
});

test("edge: other issues' PRs are ignored", () => {
  assert.equal(tick({ prs: [pr("MERGED", { headRefName: "issue-70-x" }), pr("OPEN", { headRefName: "issue-8-x" })] }).action, "wait");
  assert.equal(tick({ issueState: "CLOSED", prs: [pr("OPEN", { headRefName: "issue-70-x" })] }).action, "remove");
});

test("edge: a closed-unmerged PR on an open issue waits", () => {
  assert.equal(tick({ prs: [pr("CLOSED")] }).action, "wait");
});

test("edge: a closed-unmerged PR on a closed issue removes", () => {
  assert.equal(tick({ prs: [pr("CLOSED")], issueState: "CLOSED" }).action, "remove");
});

test("edge: a PR head of bare issue-N (no slug) is not the lane's branch", () => {
  assert.equal(tick({ prs: [pr("MERGED", { headRefName: "issue-7" })] }).action, "wait");
});

test("edge: an unread issue state, PR list or session list waits", () => {
  assert.match(tick({ issueState: null, prs: [pr("MERGED")] }).reason, /issue state/);
  assert.equal(tick({ issueState: null, prs: [pr("MERGED")] }).action, "wait");
  assert.equal(tick({ prs: null, issueState: "CLOSED" }).action, "wait");
  assert.equal(tick({ sessions: undefined, issueState: "CLOSED" }).action, "wait");
});

test("edge: give-up limits win over unread inputs", () => {
  assert.equal(tick({ failures: 3, sessions: null, prs: null, issueState: null }).action, "give-up");
  assert.equal(tick({ now: T0 + 49 * HOUR, sessions: null }).action, "give-up");
});

// Not covered by the criteria or the listed edge cases: a mismatched session's cwd must give up even when the
// issue state or PR list could not be read that same poll, since neither unread input makes the pair any less
// wrong (regression: this previously returned "wait" instead, masking the mismatch).
test("edge: a mismatched session's cwd gives up even when the issue state is unread", () => {
  const r = tick({ issueState: null, sessions: [lane({ cwd: "C:\\repo\\.claude\\worktrees\\issue-8-x" })] });
  assert.equal(r.action, "give-up");
  assert.match(r.reason, /not an issue-7 worktree/);
});

test("edge: a mismatched session's cwd gives up even when the PR list is unread", () => {
  const r = tick({ prs: null, sessions: [lane({ cwd: "C:\\repo\\.claude\\worktrees\\issue-8-x" })] });
  assert.equal(r.action, "give-up");
  assert.match(r.reason, /not an issue-7 worktree/);
});

test("edge: Date values for startedAt and now work", () => {
  assert.equal(tick({ startedAt: new Date(T0), now: new Date(T0 + 48 * HOUR) }).action, "give-up");
});

test("edge: malformed input throws a TypeError", () => {
  assert.throws(() => tick({ issue: "7" }), TypeError);
  assert.throws(() => tick({ issue: 0 }), TypeError);
  assert.throws(() => tick({ issue: 7.5 }), TypeError);
  assert.throws(() => tick({ session: "" }), TypeError);
  assert.throws(() => tick({ startedAt: "yesterday" }), TypeError);
  assert.throws(() => tick({ now: NaN }), TypeError);
  assert.throws(() => tick({ failures: -1 }), TypeError);
  assert.throws(() => reapTick(), TypeError);
});

test("edge: a clock that runs backwards waits instead of giving up", () => {
  assert.equal(tick({ now: T0 - HOUR }).action, "wait");
});

// ---- The CLI: main() driven with fake gh, claude, clock and files (#163) ----

const MY_PID = 4242;

// A world the fake `run` answers from. `issue`, `prs` and `agents` are the current answers (an Error is thrown), and
// each sleep advances the clock and applies the next entry of `polls`.
function world(root, { issue = "OPEN", prs = [], agents, polls = [] } = {}) {
  const cwd = join(root, ".claude", "worktrees", "issue-7-x");
  const cwd8 = join(root, ".claude", "worktrees", "issue-8-y");
  const state = { issue, prs, agents: agents ?? [{ kind: "background", id: "s7", cwd, status: "idle", state: "idle" }] };
  const calls = [];
  const order = [];
  let clock = T0;
  let poll = 0;
  const answer = (v) => {
    if (v instanceof Error) throw v;
    return typeof v === "string" ? v : JSON.stringify(v);
  };
  const run = (cmd, args) => {
    calls.push(`${cmd} ${args.join(" ")}`);
    if (cmd === "gh" && args[0] === "issue") return answer(state.issue instanceof Error ? state.issue : `${state.issue}\n`);
    if (cmd === "gh" && args[0] === "pr") return answer(state.prs);
    if (cmd === "claude" && args[0] === "agents") return answer(state.agents);
    if (cmd === "claude" || cmd === "git") {
      order.push(`${cmd} ${args[0]}`);
      return "";
    }
    throw new Error(`unexpected ${cmd} ${args.join(" ")}`);
  };
  const cleanupLoads = [];
  const inputs = () => ({
    root,
    worktrees: [
      { path: root, branch: "main", head: "m", main: true, dirty: false },
      { path: cwd, branch: "issue-7-x", head: "h7", main: false, dirty: false, unpushed: 0 },
      { path: cwd8, branch: "issue-8-y", head: "h8", main: false, dirty: false, unpushed: 0 },
    ],
    sessions: [
      { id: "s7", cwd, issue: 7, status: "idle", state: "idle" },
      { id: "s8", cwd: cwd8, issue: 8, status: "idle", state: "idle" },
    ],
    prs: [...(Array.isArray(state.prs) ? state.prs : []), { number: 91, state: "MERGED", headRefName: "issue-8-y", headRefOid: "h8" }],
    issues: [],
    orphans: [{ path: join(root, ".claude", "worktrees", "old"), files: 0 }],
  });
  const errs = [];
  const deps = {
    root,
    pid: MY_PID,
    run,
    now: () => clock,
    sleep: async (ms) => {
      calls.push(`sleep ${ms}`);
      clock += ms;
      Object.assign(state, polls[poll++] ?? {});
    },
    isRunning: (pid) => pid === MY_PID,
    err: (line) => errs.push(line),
    trap: () => {},
    cleanupDeps: {
      load: () => {
        cleanupLoads.push(clock);
        return inputs();
      },
      run,
      stillThere: () => true,
      removeDir: (p) => order.push(`rmdir ${p}`),
      saveLog: (id) => {
        order.push(`log ${id}`);
        return `.lanes/logs/${id}.txt`;
      },
    },
  };
  return { deps, calls, order, errs, cleanupLoads, state, cwd };
}

async function withRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), "reap-test-"));
  try {
    await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const ARGS = ["--issue", "7", "--session", "s7"];
const lockFile = (root) => join(root, ".lanes", "reap", "7.json");
const logLines = (root) => readFileSync(join(root, ".lanes", "reap", "7.log"), "utf8").trimEnd().split("\n");
const merged = [{ number: 90, state: "MERGED", headRefName: "issue-7-x", headRefOid: "h7" }];
const open = [{ number: 90, state: "OPEN", headRefName: "issue-7-x", headRefOid: "h7" }];
const writeLock = (root, lock) => {
  mkdirSync(join(root, ".lanes", "reap"), { recursive: true });
  writeFileSync(lockFile(root), typeof lock === "string" ? lock : JSON.stringify(lock));
};

// Criterion 1: bad arguments.
for (const argv of [
  [],
  ["--issue", "7"],
  ["--session", "s7"],
  ["--issue", "x", "--session", "s7"],
  ["--issue", "0", "--session", "s7"],
  ["--issue", "7.5", "--session", "s7"],
  ["--issue", "07", "--session", "s7"],
  ["--issue", "7", "--session", ""],
  ["--issue", "7", "--session", "--rm"],
  ["--issue", "7", "--session", "s 7"],
  ["--issue", "7", "--session", "s7", "--extra"],
  ["--issue", "7", "--issue", "8", "--session", "s7"],
  ["--issue", "7", "--session"],
]) {
  test(`refuses ${JSON.stringify(argv)} with a usage line and exit 2`, () =>
    withRoot(async (root) => {
      const w = world(root);
      assert.equal(await main(argv, w.deps), 2);
      assert.match(w.errs.join("\n"), /^usage: node scripts\/lanes\/reap\.mjs --issue N --session ID$/m);
      assert.deepEqual(w.calls, []);
      assert.equal(existsSync(join(root, ".lanes", "reap")), false);
    }));
}

test("edge: the flags may come in either order", () =>
  withRoot(async (root) => {
    const w = world(root, { issue: "CLOSED", prs: merged });
    assert.equal(await main(["--session", "s7", "--issue", "7"], w.deps), 0);
  }));

// Criterion 2: the lock.
test("holds .lanes/reap/<issue>.json with pid, session and started while it runs, and removes it on exit", () =>
  withRoot(async (root) => {
    const w = world(root, { polls: [{ prs: merged }] });
    let seen;
    const sleep = w.deps.sleep;
    w.deps.sleep = async (ms) => {
      seen = JSON.parse(readFileSync(lockFile(root), "utf8"));
      await sleep(ms);
    };
    assert.equal(await main(ARGS, w.deps), 0);
    assert.deepEqual(seen, { pid: MY_PID, session: "s7", started: new Date(T0).toISOString() });
    assert.equal(existsSync(lockFile(root)), false);
  }));

test("a second reaper exits at once when a live reaper holds the lock, and leaves the lock alone", () =>
  withRoot(async (root) => {
    const held = JSON.stringify({ pid: 999, session: "s7", started: new Date(T0).toISOString() });
    writeLock(root, held);
    const w = world(root);
    w.deps.isRunning = (pid) => pid === 999;
    assert.equal(await main(ARGS, w.deps), 0);
    assert.deepEqual(w.calls, []);
    assert.equal(readFileSync(lockFile(root), "utf8"), held);
    assert.match(w.errs.join("\n"), /pid 999/);
  }));

test("edge: a lock whose pid is not running is taken over", () =>
  withRoot(async (root) => {
    writeLock(root, { pid: 999, session: "s7", started: new Date(T0).toISOString() });
    const w = world(root, { issue: "CLOSED", prs: merged });
    assert.equal(await main(ARGS, w.deps), 0);
    assert.equal(w.cleanupLoads.length, 1);
    assert.equal(existsSync(lockFile(root)), false);
  }));

test("edge: a malformed lock file is taken over", () =>
  withRoot(async (root) => {
    writeLock(root, "{not json");
    const w = world(root, { issue: "CLOSED", prs: merged });
    assert.equal(await main(ARGS, w.deps), 0);
    assert.equal(w.cleanupLoads.length, 1);
  }));

test("edge: a live pid in a lock older than any reaper can run is taken as reused, and taken over", () =>
  withRoot(async (root) => {
    writeLock(root, { pid: 999, session: "s7", started: new Date(T0 - GIVE_UP_MS - HOUR).toISOString() });
    const w = world(root, { issue: "CLOSED", prs: merged });
    w.deps.isRunning = () => true;
    assert.equal(await main(ARGS, w.deps), 0);
    assert.equal(w.cleanupLoads.length, 1);
  }));

test("edge: on exit it does not remove a lock another reaper wrote over its own", () =>
  withRoot(async (root) => {
    const other = JSON.stringify({ pid: 555, session: "s7", started: new Date(T0).toISOString() });
    const w = world(root, { polls: [{ prs: merged }] });
    const sleep = w.deps.sleep;
    w.deps.sleep = async (ms) => {
      writeFileSync(lockFile(root), other);
      await sleep(ms);
    };
    assert.equal(await main(ARGS, w.deps), 0);
    assert.equal(readFileSync(lockFile(root), "utf8"), other);
  }));

test("edge: an unexpected throw is logged as an error and the lock is still removed", () =>
  withRoot(async (root) => {
    const w = world(root);
    w.deps.sleep = async () => {
      throw new Error("boom");
    };
    await assert.rejects(main(ARGS, w.deps), /boom/);
    assert.equal(existsSync(lockFile(root)), false);
    assert.match(logLines(root).at(-1), / error: boom$/);
  }));

test("edge: the trap it registers releases the lock", () =>
  withRoot(async (root) => {
    const w = world(root);
    let release;
    w.deps.trap = (fn) => {
      release = fn;
    };
    w.deps.sleep = async () => {
      assert.equal(existsSync(lockFile(root)), true);
      release();
      assert.equal(existsSync(lockFile(root)), false);
      throw new Error("stop");
    };
    await assert.rejects(main(ARGS, w.deps), /stop/);
  }));

// Criteria 3 and 5: polls every 5 minutes; a lane merged after two polls is removed once.
test("a lane merged after two polls is removed once, through cleanup's rules, log saved first", () =>
  withRoot(async (root) => {
    const w = world(root, { prs: open, polls: [{}, {}, { prs: merged, issue: "CLOSED" }] });
    assert.equal(await main(ARGS, w.deps), 0);
    assert.deepEqual(w.calls.filter((c) => c.startsWith("sleep")), [`sleep ${FIRST_POLL_MS}`, `sleep ${POLL_MS}`, `sleep ${POLL_MS}`]);
    assert.equal(w.calls.filter((c) => c.startsWith("gh issue view 7")).length, 3);
    assert.deepEqual(w.cleanupLoads, [T0 + FIRST_POLL_MS + 2 * POLL_MS]);
    // Only lane 7: lane 8 (merged too) and the empty orphan folder are left for cleanup.mjs itself.
    assert.deepEqual(w.order, ["log s7", "claude rm", "git worktree", "git branch"]);
    assert.ok(w.calls.includes("claude rm s7"));
    assert.ok(!w.calls.some((c) => /s8|issue-8/.test(c)));
    const log = logLines(root);
    assert.match(log[0], /^2026-09-28T12:00:00\.000Z started: issue #7, session s7$/);
    assert.match(log.at(-1), /^2026-09-28T12:11:00\.000Z removed: /);
    assert.equal(log.filter((l) => / removed: /.test(l)).length, 1);
  }));

test("a merged lane whose session is busy waits for the session before removing", () =>
  withRoot(async (root) => {
    const w = world(root, { issue: "CLOSED", prs: merged });
    w.state.agents = [{ kind: "background", id: "s7", cwd: w.cwd, status: "busy", state: "working" }];
    let sleeps = 0;
    w.deps.sleep = async (ms) => {
      w.calls.push(`sleep ${ms}`);
      if (++sleeps > 1) w.state.agents = [{ kind: "background", id: "s7", cwd: w.cwd, status: "idle", state: "idle" }];
    };
    assert.equal(await main(ARGS, w.deps), 0);
    assert.equal(w.cleanupLoads.length, 1);
    assert.match(logLines(root).join("\n"), / waiting: PR #90 merged; session s7 is busy/);
  }));

// Criterion 4: one line per event.
test("logs started, waiting and removed with ISO time stamps, a repeated wait only once", () =>
  withRoot(async (root) => {
    const w = world(root, { prs: open, polls: [{}, {}, { prs: merged }] });
    assert.equal(await main(ARGS, w.deps), 0);
    const log = logLines(root);
    assert.deepEqual(log.map((l) => l.split(" ")[1]), ["started:", "waiting:", "removed:"]);
    for (const line of log) assert.match(line, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z (started|waiting|removed|gave up|error): \S/);
  }));

test("three read failures in a row give up with a log line", () =>
  withRoot(async (root) => {
    const w = world(root, { issue: new Error("HTTP 502\nsecond line") });
    assert.equal(await main(ARGS, w.deps), 1);
    const log = logLines(root);
    assert.equal(log.filter((l) => / error: /.test(l)).length, 3);
    assert.match(log.find((l) => / error: /.test(l)), /error: gh issue view: HTTP 502$/);
    assert.match(log.at(-1), / gave up: 3 consecutive failed polls$/);
    assert.equal(w.cleanupLoads.length, 0);
    assert.equal(existsSync(lockFile(root)), false);
  }));

test("edge: a good poll between failures resets the count", () =>
  withRoot(async (root) => {
    const bad = new Error("down");
    const w = world(root, { issue: bad, polls: [{}, { issue: bad }, { issue: "OPEN" }, { issue: bad }, { issue: bad }] });
    assert.equal(await main(ARGS, w.deps), 1);
    assert.equal(logLines(root).filter((l) => / error: /.test(l)).length, 5);
  }));

test("edge: unparsable gh or claude output counts as a read failure", () =>
  withRoot(async (root) => {
    const w = world(root, { prs: "not json" });
    w.state.agents = "{";
    assert.equal(await main(ARGS, w.deps), 1);
    const log = logLines(root).join("\n");
    assert.match(log, /error: gh pr list: /);
    assert.match(log, /error: claude agents: /);
  }));

test("edge: an issue state other than OPEN or CLOSED counts as a read failure", () =>
  withRoot(async (root) => {
    const w = world(root, { issue: "MAYBE" });
    assert.equal(await main(ARGS, w.deps), 1);
    assert.match(logLines(root).join("\n"), /error: gh issue view: unexpected state/);
  }));

// #201: the first poll is FIRST_POLL_MS after start, and a lane that has not entered its worktree yet is waited for.
test("the first poll happens no sooner than 60 seconds after start", () =>
  withRoot(async (root) => {
    const w = world(root, { issue: "CLOSED", prs: merged });
    assert.equal(await main(ARGS, w.deps), 0);
    assert.equal(w.calls[0], `sleep ${FIRST_POLL_MS}`);
    assert.deepEqual(w.cleanupLoads, [T0 + FIRST_POLL_MS]);
  }));

test("a session that appears on the second poll, first at the root and then in its worktree, is later removed", () =>
  withRoot(async (root) => {
    const at = (cwd) => [{ kind: "background", id: "s7", cwd, status: "busy", state: "working" }];
    const inWorktree = [{ kind: "background", id: "s7", cwd: join(root, ".claude", "worktrees", "issue-7-x"), status: "idle", state: "idle" }];
    // Polls: not listed at 60 s, then in a folder of the repo that is no worktree, then in its worktree with an open
    // PR, then merged. (A session at the root itself is dropped by sessionsFrom, so it reads as not listed.)
    const w = world(root, { agents: [], prs: open, polls: [{}, { agents: at(root) }, { agents: at(join(root, "scripts")) }, { agents: inWorktree }, { prs: merged, issue: "CLOSED" }] });
    assert.equal(await main(ARGS, w.deps), 0);
    assert.deepEqual(w.cleanupLoads, [T0 + FIRST_POLL_MS + 4 * POLL_MS]);
    const log = logLines(root);
    assert.match(log.join("\n"), / waiting: session s7 is not listed yet/);
    assert.match(log.join("\n"), / waiting: session s7 is not in an issue-7 worktree yet/);
    assert.doesNotMatch(log.join("\n"), / gave up: /);
    assert.match(log.at(-1), / removed: /);
    assert.deepEqual(w.order, ["log s7", "claude rm", "git worktree", "git branch"]);
  }));

test("a session that never appears gives up at the first poll past the 30-minute grace", () =>
  withRoot(async (root) => {
    const w = world(root, { agents: [] });
    assert.equal(await main(ARGS, w.deps), 1);
    const log = logLines(root);
    assert.match(log.at(-1), /^2026-09-28T12:31:00\.000Z gave up: session s7 not found$/);
    assert.equal(log.filter((l) => / waiting: /.test(l)).length, 1);
    assert.equal(w.cleanupLoads.length, 0);
    assert.equal(existsSync(lockFile(root)), false);
  }));

test("a session that stays outside any worktree gives up after the grace", () =>
  withRoot(async (root) => {
    const w = world(root, { agents: [{ kind: "background", id: "s7", cwd: join(root, "scripts"), status: "busy", state: "working" }] });
    assert.equal(await main(ARGS, w.deps), 1);
    assert.match(logLines(root).at(-1), /^2026-09-28T12:31:00\.000Z gave up: session s7's cwd is not an issue-7 worktree$/);
  }));

test("edge: a session in another issue's worktree gives up at the first poll, grace or not", () =>
  withRoot(async (root) => {
    const w = world(root, { agents: [{ kind: "background", id: "s7", cwd: join(root, ".claude", "worktrees", "issue-8-y"), status: "idle" }] });
    assert.equal(await main(ARGS, w.deps), 1);
    assert.match(logLines(root).at(-1), /^2026-09-28T12:01:00\.000Z gave up: session s7's cwd is not an issue-7 worktree$/);
    assert.deepEqual(w.calls.filter((c) => c.startsWith("sleep")), [`sleep ${FIRST_POLL_MS}`]);
  }));

test("edge: a session outside this repo counts as not listed, so gives up after the grace", () =>
  withRoot(async (root) => {
    const w = world(root, { agents: [{ kind: "background", id: "s7", cwd: "/elsewhere/.claude/worktrees/issue-7-x", status: "idle" }] });
    assert.equal(await main(ARGS, w.deps), 1);
    assert.match(logLines(root).at(-1), /^2026-09-28T12:31:00\.000Z gave up: session s7 not found$/);
  }));

test("edge: a claude agents read failure during the grace still counts toward 3 failed polls", () =>
  withRoot(async (root) => {
    const w = world(root, { agents: new Error("claude down") });
    assert.equal(await main(ARGS, w.deps), 1);
    assert.match(logLines(root).at(-1), /^2026-09-28T12:11:00\.000Z gave up: 3 consecutive failed polls$/);
  }));

test("edge: gives up after 48 hours of waiting", () =>
  withRoot(async (root) => {
    const w = world(root, { prs: open });
    assert.equal(await main(ARGS, w.deps), 1);
    assert.match(logLines(root).at(-1), / gave up: still not done after 48 hours$/);
    assert.equal(w.calls.filter((c) => c.startsWith("sleep")).length, 1 + GIVE_UP_MS / POLL_MS);
  }));

test("edge: a failed removal is logged as an error and retried on the next poll", () =>
  withRoot(async (root) => {
    const w = world(root, { issue: "CLOSED", prs: merged });
    let fails = 1;
    const run = w.deps.cleanupDeps.run;
    w.deps.cleanupDeps.run = (cmd, args) => {
      if (cmd === "git" && args[0] === "worktree" && fails-- > 0) throw Object.assign(new Error("x"), { stderr: "Permission denied" });
      return run(cmd, args);
    };
    assert.equal(await main(ARGS, w.deps), 0);
    const log = logLines(root);
    assert.match(log.join("\n"), / error: failed issue-7-x \(PR #90\) at git worktree remove .*Permission denied/);
    assert.match(log.at(-1), / removed: /);
    assert.equal(w.cleanupLoads.length, 2);
  }));

test("edge: three failed removals in a row give up", () =>
  withRoot(async (root) => {
    const w = world(root, { issue: "CLOSED", prs: merged });
    w.deps.cleanupDeps.load = () => {
      throw new Error("git worktree list failed");
    };
    assert.equal(await main(ARGS, w.deps), 1);
    const log = logLines(root);
    assert.equal(log.filter((l) => / error: cleanup: git worktree list failed$/.test(l)).length, 3);
    assert.match(log.at(-1), / gave up: 3 consecutive failed polls$/);
  }));

test("edge: a lane cleanup skips (a dirty worktree) keeps waiting, then gives up at 48 hours", () =>
  withRoot(async (root) => {
    const w = world(root, { issue: "CLOSED", prs: merged });
    const load = w.deps.cleanupDeps.load;
    w.deps.cleanupDeps.load = () => {
      const inputs = load();
      inputs.worktrees[1].dirty = true;
      return inputs;
    };
    assert.equal(await main(ARGS, w.deps), 1);
    const log = logLines(root);
    assert.equal(log.filter((l) => / waiting: cleanup skipped issue-7-x: dirty worktree$/.test(l)).length, 1);
    assert.match(log.at(-1), / gave up: /);
    assert.deepEqual(w.order, []);
  }));

test("edge: a lane already cleaned by someone else counts as removed", () =>
  withRoot(async (root) => {
    const w = world(root, { issue: "CLOSED", prs: merged });
    w.deps.cleanupDeps.load = () => ({ root, worktrees: [{ path: root, branch: "main", head: "m", main: true, dirty: false }], sessions: [], prs: [], issues: [], orphans: [] });
    assert.equal(await main(ARGS, w.deps), 0);
    assert.match(logLines(root).at(-1), / removed: nothing left to remove$/);
  }));

test("edge: a log detail with control characters stays on one line", () =>
  withRoot(async (root) => {
    const w = world(root, { issue: new Error("bad\u001b[31m red\r\nnext") });
    assert.equal(await main(ARGS, w.deps), 1);
    for (const line of logLines(root)) assert.doesNotMatch(line, /[\x00-\x1f\x7f]/);
  }));

test("edge: a Unicode line separator in a log detail ends the detail", () =>
  withRoot(async (root) => {
    const [ls, ps] = [String.fromCharCode(0x2028), String.fromCharCode(0x2029)];
    const w = world(root, { issue: new Error(`first${ls}forged 2026 removed: x${ps}more`) });
    assert.equal(await main(ARGS, w.deps), 1);
    const log = readFileSync(join(root, ".lanes", "reap", "7.log"), "utf8");
    assert.ok(!log.includes(ls) && !log.includes(ps));
    assert.doesNotMatch(log, /forged/);
    assert.match(log, / error: gh issue view: first$/m);
  }));

test("laneInputs keeps only the one lane's worktrees and sessions, no orphans, and does not change its input", () => {
  const inputs = {
    root: "/r",
    worktrees: [
      { path: "/r", branch: "main", main: true },
      { path: "/r/.claude/worktrees/issue-7-x", branch: "issue-7-x" },
      { path: null, branch: "issue-7-old" },
      { path: "/r/.claude/worktrees/issue-70-z", branch: "issue-70-z" },
      { path: "/r/.claude/worktrees/feature", branch: "feature" },
      { path: "/r/.claude/worktrees/detached", branch: null },
    ],
    sessions: [
      { id: "a", issue: 7 },
      { id: "b", issue: 70 },
      { id: "c", issue: null },
    ],
    prs: [{ number: 1 }],
    issues: [{ number: 7, state: "CLOSED" }],
    orphans: [{ path: "/r/.claude/worktrees/old", files: 0 }],
  };
  const copy = structuredClone(inputs);
  const out = laneInputs(inputs, 7);
  assert.deepEqual(inputs, copy);
  assert.deepEqual(out.worktrees.map((w) => w.branch), ["main", "issue-7-x", "issue-7-old", "feature", null]);
  assert.deepEqual(out.sessions.map((s) => s.id), ["a"]);
  assert.deepEqual(out.orphans, []);
  assert.deepEqual(out.prs, inputs.prs);
  assert.deepEqual(out.issues, inputs.issues);
});

test("the CLI's run options hide the console window on Windows", () => {
  const options = runOptions("/r");
  assert.equal(options.windowsHide, true);
  assert.equal(options.cwd, "/r");
});

test("edge: the run options keep the output capture, timeout and buffer the polls rely on", () => {
  const options = runOptions("/r");
  assert.equal(options.encoding, "utf8");
  assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
  assert.equal(options.timeout, 60_000);
  assert.ok(options.maxBuffer >= 1024 * 1024);
});

test("edge: every execFileSync call in reap.mjs hides the console window", () => {
  const source = readFileSync(new URL("./reap.mjs", import.meta.url), "utf8");
  const calls = source.split("\n").filter((line) => /\bexecFileSync\(/.test(line));
  assert.ok(calls.length >= 2);
  for (const line of calls) assert.match(line, /windowsHide: true|runOptions\(/, line.trim());
});
