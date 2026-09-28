import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cleanableCount, formatStep, parseWorktrees, pidRunning, planCleanup, render, runCleanup, sessionsFrom } from "./cleanup.mjs";

const ROOT = "C:/repo";
const HEAD = "a".repeat(40);
const main = { path: ROOT, branch: "main", head: "f".repeat(40), dirty: false, main: true };
const wt = (branch, extra = {}) => ({ path: `${ROOT}/.claude/worktrees/${branch}`, branch, head: HEAD, dirty: false, ...extra });
const merged = (branch, extra = {}) => ({ number: 90, state: "MERGED", headRefName: branch, headRefOid: HEAD, ...extra });
const session = (id, dir, extra = {}) => ({ id, cwd: `C:\\repo\\.claude\\worktrees\\${dir}`, issue: Number(/issue-(\d+)/.exec(dir)[1]), state: "idle", ...extra });
const cmds = (entry) => entry.steps.map(formatStep);

test("a merged, clean lane with a session: claude rm, then git worktree remove, then git branch -D", () => {
  const [entry] = planCleanup({ worktrees: [main, wt("issue-7-x")], sessions: [session("s7", "issue-7-x")], prs: [merged("issue-7-x")] });
  assert.equal(entry.branch, "issue-7-x");
  assert.equal(entry.skip, undefined);
  assert.deepEqual(cmds(entry), ["claude rm s7", `git worktree remove ${ROOT}/.claude/worktrees/issue-7-x`, "git branch -D issue-7-x"]);
});

test("the plan never uses --discard-unpushed, --force-remove-worktree or --force", () => {
  const [entry] = planCleanup({ worktrees: [wt("issue-7-x")], sessions: [session("s7", "issue-7-x")], prs: [merged("issue-7-x")] });
  for (const step of entry.steps) assert.ok(!step.args.some((a) => /^--?(force|discard-unpushed|force-remove-worktree|f)$/.test(a)), formatStep(step));
});

test("a branch whose PR is open, closed unmerged or missing is skipped: not merged", () => {
  const plan = planCleanup({
    worktrees: [wt("issue-1-open"), wt("issue-2-closed"), wt("issue-3-none")],
    sessions: [],
    prs: [merged("issue-1-open", { state: "OPEN" }), merged("issue-2-closed", { state: "CLOSED" })],
  });
  assert.deepEqual(plan.map((e) => [e.branch, e.skip]), [["issue-1-open", "not merged"], ["issue-2-closed", "not merged"], ["issue-3-none", "not merged"]]);
});

test("a merged branch whose local tip is not the PR's merged head is skipped", () => {
  const [entry] = planCleanup({ worktrees: [wt("issue-7-x", { head: "b".repeat(40) })], sessions: [], prs: [merged("issue-7-x")] });
  assert.equal(entry.skip, "local commits after the merged head");
  assert.equal(entry.steps, undefined);
});

test("a merged lane whose worktree has uncommitted or untracked changes is skipped: dirty worktree", () => {
  const [entry] = planCleanup({ worktrees: [wt("issue-7-x", { dirty: true })], sessions: [session("s7", "issue-7-x")], prs: [merged("issue-7-x")] });
  assert.equal(entry.skip, "dirty worktree");
});

test("no session (worktree only): git worktree remove, then git branch -D", () => {
  const [entry] = planCleanup({ worktrees: [wt("issue-7-x")], sessions: [], prs: [merged("issue-7-x")] });
  assert.deepEqual(cmds(entry), [`git worktree remove ${ROOT}/.claude/worktrees/issue-7-x`, "git branch -D issue-7-x"]);
});

test("session only (worktree and branch already gone): claude rm alone, once its issue's PR merged", () => {
  const plan = planCleanup({ worktrees: [main], sessions: [session("s7", "issue-7-x")], prs: [merged("issue-7-other")] });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].issue, 7);
  assert.deepEqual(cmds(plan[0]), ["claude rm s7"]);
});

test("session only is skipped while its issue has an open PR or none merged", () => {
  const open = planCleanup({ worktrees: [], sessions: [session("s7", "issue-7-x")], prs: [merged("issue-7-a"), merged("issue-7-b", { state: "OPEN" })] });
  const none = planCleanup({ worktrees: [], sessions: [session("s8", "issue-8-x")], prs: [merged("issue-80-x")] });
  assert.equal(open[0].skip, "not merged");
  assert.equal(none[0].skip, "not merged");
});

test("a local branch without a worktree: git branch -D alone", () => {
  const [entry] = planCleanup({ worktrees: [{ path: null, branch: "issue-7-x", head: HEAD, dirty: false }], sessions: [], prs: [merged("issue-7-x")] });
  assert.deepEqual(cmds(entry), ["git branch -D issue-7-x"]);
});

test("worktree and branch removal only run if still there after claude rm, which may already have removed them", () => {
  const [entry] = planCleanup({ worktrees: [wt("issue-7-x")], sessions: [session("s7", "issue-7-x")], prs: [merged("issue-7-x")] });
  assert.deepEqual(entry.steps.map((s) => s.onlyIf), [undefined, { path: `${ROOT}/.claude/worktrees/issue-7-x` }, { branch: "issue-7-x" }]);
});

test("a failed step skips that lane's later steps and reports the error; other lanes continue", () => {
  const plan = planCleanup({
    worktrees: [wt("issue-7-x"), wt("issue-8-y")],
    sessions: [session("s7", "issue-7-x")],
    prs: [merged("issue-7-x"), merged("issue-8-y")],
  });
  const ran = [];
  const run = (cmd, args) => {
    ran.push(`${cmd} ${args.join(" ")}`);
    if (args[0] === "rm") throw new Error("session has unpushed commits");
  };
  const results = runCleanup(plan, { run, stillThere: () => true });
  assert.deepEqual(ran, ["claude rm s7", `git worktree remove ${ROOT}/.claude/worktrees/issue-8-y`, "git branch -D issue-8-y"]);
  assert.equal(results[0].status, "failed");
  assert.equal(results[0].failedStep, "claude rm s7");
  assert.match(results[0].error, /unpushed commits/);
  assert.equal(results[1].status, "removed");
});

test("a step whose target is already gone is not run and does not fail the lane", () => {
  const plan = planCleanup({ worktrees: [wt("issue-7-x")], sessions: [session("s7", "issue-7-x")], prs: [merged("issue-7-x")] });
  const ran = [];
  const results = runCleanup(plan, { run: (cmd, args) => ran.push(`${cmd} ${args[0]}`), stillThere: (onlyIf) => !onlyIf.path });
  assert.deepEqual(ran, ["claude rm", "git branch"]);
  assert.equal(results[0].status, "removed");
  assert.deepEqual(results[0].ran, ["claude rm s7", "git branch -D issue-7-x"]);
});

test("--dry-run prints the plan and runs nothing", () => {
  const plan = planCleanup({ worktrees: [wt("issue-7-x"), wt("issue-8-y", { dirty: true })], sessions: [], prs: [merged("issue-7-x"), merged("issue-8-y")] });
  const run = () => assert.fail("dry run must not run anything");
  const results = runCleanup(plan, { run, stillThere: () => assert.fail("dry run must not probe"), dryRun: true });
  const text = render(results, { dryRun: true });
  assert.match(text, /would remove issue-7-x \(PR #90\): git worktree remove .*issue-7-x; git branch -D issue-7-x/);
  assert.match(text, /skipped issue-8-y: dirty worktree/);
});

test("render reports removed, skipped and failed lanes, and a line when there is nothing to do", () => {
  const text = render([
    { branch: "issue-7-x", pr: 90, status: "removed", ran: ["git branch -D issue-7-x"] },
    { branch: "issue-8-y", status: "skipped", skip: "not merged" },
    { branch: "issue-9-z", pr: 91, status: "failed", ran: [], failedStep: "claude rm s9", error: "boom" },
  ]);
  assert.match(text, /^removed issue-7-x \(PR #90\): git branch -D issue-7-x$/m);
  assert.match(text, /^skipped issue-8-y: not merged$/m);
  assert.match(text, /^failed issue-9-z \(PR #91\) at claude rm s9: boom$/m);
  assert.equal(render([]), "no lanes to clean up");
});

test("cleanableCount counts the lanes the plan would clean", () => {
  const plan = planCleanup({ worktrees: [wt("issue-7-x"), wt("issue-8-y", { dirty: true })], sessions: [], prs: [merged("issue-7-x"), merged("issue-8-y")] });
  assert.equal(cleanableCount(plan), 1);
});

// Edge cases found while implementing.

test("edge: worktrees on non-lane branches (main, detached, other names) are ignored", () => {
  const plan = planCleanup({
    worktrees: [main, wt("feature-x"), { path: `${ROOT}/d`, branch: null, head: HEAD, dirty: false }, wt("issue-x-y"), wt("issue-7")],
    sessions: [],
    prs: [merged("feature-x")],
  });
  assert.deepEqual(plan, []);
});

test("edge: a lane branch checked out in the main worktree is skipped, never removed", () => {
  const [entry] = planCleanup({ worktrees: [{ ...main, branch: "issue-7-x", head: HEAD }], sessions: [], prs: [merged("issue-7-x")] });
  assert.equal(entry.skip, "checked out in the main worktree");
});

test("edge: a worktree whose status could not be read (dirty null) is skipped", () => {
  const [entry] = planCleanup({ worktrees: [wt("issue-7-x", { dirty: null })], sessions: [], prs: [merged("issue-7-x")] });
  assert.equal(entry.skip, "cannot read worktree status");
});

test("edge: a session still working is skipped rather than removed mid-turn", () => {
  const [entry] = planCleanup({ worktrees: [wt("issue-7-x")], sessions: [session("s7", "issue-7-x", { state: "working" })], prs: [merged("issue-7-x")] });
  assert.equal(entry.skip, "session still working");
});

test("edge: a session goes with the deepest worktree holding its cwd, not the main checkout that contains it", () => {
  const plan = planCleanup({ worktrees: [main, wt("issue-7-x")], sessions: [session("s7", "issue-7-x\\sub")], prs: [merged("issue-7-x")] });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].steps[0].args[1], "s7");
});

test("edge: a session inside a non-lane worktree is left alone even if its folder is named issue-N-…", () => {
  const plan = planCleanup({ worktrees: [wt("issue-7-x", { branch: "worktree-issue-7-x" })], sessions: [session("s7", "issue-7-x")], prs: [merged("issue-7-x")] });
  assert.deepEqual(plan, []);
});

test("edge: an open PR on a branch that also had a merged PR keeps it: not merged", () => {
  const [entry] = planCleanup({ worktrees: [wt("issue-7-x")], sessions: [], prs: [merged("issue-7-x"), merged("issue-7-x", { number: 95, state: "OPEN" })] });
  assert.equal(entry.skip, "not merged");
});

test("edge: a branch merged twice is cleaned when its tip equals either merged head", () => {
  const [entry] = planCleanup({ worktrees: [wt("issue-7-x")], sessions: [], prs: [merged("issue-7-x", { headRefOid: "c".repeat(40) }), merged("issue-7-x", { number: 96 })] });
  assert.equal(entry.skip, undefined);
  assert.equal(entry.pr, 96);
});

test("edge: two sessions sharing a worktree: a working one blocks cleanup even when an idle one is listed later", () => {
  const [entry] = planCleanup({
    worktrees: [wt("issue-7-x")],
    sessions: [session("s7a", "issue-7-x", { state: "working" }), session("s7b", "issue-7-x", { state: "idle" })],
    prs: [merged("issue-7-x")],
  });
  assert.equal(entry.skip, "session still working");
});

test("edge: two idle sessions sharing a worktree are both removed with claude rm", () => {
  const [entry] = planCleanup({
    worktrees: [wt("issue-7-x")],
    sessions: [session("s7a", "issue-7-x"), session("s7b", "issue-7-x")],
    prs: [merged("issue-7-x")],
  });
  assert.deepEqual(cmds(entry), ["claude rm s7a", "claude rm s7b", `git worktree remove ${ROOT}/.claude/worktrees/issue-7-x`, "git branch -D issue-7-x"]);
});

test("edge: a session's cwd matches its worktree case-insensitively on a Windows drive path", () => {
  const [entry] = planCleanup({
    worktrees: [{ path: "C:/Repo/.claude/worktrees/issue-7-x", branch: "issue-7-x", head: HEAD, dirty: false }],
    sessions: [{ id: "s7", cwd: "c:\\repo\\.claude\\worktrees\\issue-7-x", issue: 7, state: "working" }],
    prs: [merged("issue-7-x")],
  });
  assert.equal(entry.skip, "session still working");
});

// #83: `claude agents --json` can leave `state: "working"` on a session that has stopped; `status` says whether it runs.
test("a merged lane whose session is idle is removed whatever its state says (working, blocked, done)", () => {
  for (const state of ["working", "blocked", "done"]) {
    const [entry] = planCleanup({ worktrees: [wt("issue-7-x")], sessions: [session("s7", "issue-7-x", { status: "idle", state })], prs: [merged("issue-7-x")] });
    assert.equal(entry.skip, undefined, state);
    assert.deepEqual(cmds(entry), ["claude rm s7", `git worktree remove ${ROOT}/.claude/worktrees/issue-7-x`, "git branch -D issue-7-x"], state);
  }
});

test("a merged lane whose session is busy is skipped: session still working", () => {
  for (const state of ["working", "blocked", undefined]) {
    const [entry] = planCleanup({ worktrees: [wt("issue-7-x")], sessions: [session("s7", "issue-7-x", { status: "busy", state })], prs: [merged("issue-7-x")] });
    assert.equal(entry.skip, "session still working", String(state));
  }
});

test("a busy session sharing the worktree with an idle/working one blocks cleanup", () => {
  const [entry] = planCleanup({
    worktrees: [wt("issue-7-x")],
    sessions: [session("s7a", "issue-7-x", { status: "idle", state: "working" }), session("s7b", "issue-7-x", { status: "busy", state: "working" })],
    prs: [merged("issue-7-x")],
  });
  assert.equal(entry.skip, "session still working");
});

test("the other skip reasons are unchanged when the session is idle/working", () => {
  const idle = (dir) => session(`s-${dir}`, dir, { status: "idle", state: "working" });
  const plan = planCleanup({
    worktrees: [wt("issue-1-open"), wt("issue-2-dirty", { dirty: true }), wt("issue-3-ahead", { head: "b".repeat(40) })],
    sessions: [idle("issue-1-open"), idle("issue-2-dirty"), idle("issue-3-ahead")],
    prs: [merged("issue-1-open", { state: "OPEN" }), merged("issue-2-dirty"), merged("issue-3-ahead")],
  });
  assert.deepEqual(plan.map((e) => e.skip), ["not merged", "dirty worktree", "local commits after the merged head"]);
});

test("a session-only lane (worktree gone) is removed when idle/working and skipped when busy", () => {
  const plan = (status) => planCleanup({ worktrees: [], sessions: [session("s7", "issue-7-x", { status, state: "working" })], prs: [merged("issue-7-x")] })[0];
  assert.deepEqual(cmds(plan("idle")), ["claude rm s7"]);
  assert.equal(plan("busy").skip, "session still working");
});

test("edge: a session with no status falls back to its state (working skips, blocked cleans)", () => {
  const plan = (state) => planCleanup({ worktrees: [wt("issue-7-x")], sessions: [session("s7", "issue-7-x", { status: undefined, state })], prs: [merged("issue-7-x")] })[0];
  assert.equal(plan("working").skip, "session still working");
  assert.equal(plan("blocked").skip, undefined);
});

test("edge: an unknown status falls back to its state rather than being read as idle", () => {
  const plan = (state) => planCleanup({ worktrees: [wt("issue-7-x")], sessions: [session("s7", "issue-7-x", { status: "paused", state })], prs: [merged("issue-7-x")] })[0];
  assert.equal(plan("working").skip, "session still working");
  assert.equal(plan("done").skip, undefined);
});

test("edge: a session with neither status nor state is treated as not working, not as still working", () => {
  const [entry] = planCleanup({ worktrees: [wt("issue-7-x")], sessions: [session("s7", "issue-7-x", { status: undefined, state: undefined })], prs: [merged("issue-7-x")] });
  assert.equal(entry.skip, undefined);
  assert.deepEqual(cmds(entry), ["claude rm s7", `git worktree remove ${ROOT}/.claude/worktrees/issue-7-x`, "git branch -D issue-7-x"]);
});

test("sessionsFrom keeps each background session's status and state, and drops others", () => {
  const agents = [
    { kind: "background", id: "s7", cwd: "C:\\repo\\.claude\\worktrees\\issue-7-x", status: "idle", state: "working" },
    { kind: "background", id: "s8", cwd: "C:/repo/.claude/worktrees/issue-8-y", state: "blocked" },
    { kind: "interactive", id: "i1", cwd: "C:/repo", status: "idle" },
    { kind: "background", id: "o1", cwd: "D:/other/issue-9-z", status: "busy", state: "working" },
    { kind: "background", cwd: "C:/repo/.claude/worktrees/issue-10-q" },
    null,
  ];
  assert.deepEqual(sessionsFrom(agents, "C:/repo"), [
    { id: "s7", cwd: "C:\\repo\\.claude\\worktrees\\issue-7-x", issue: 7, status: "idle", state: "working" },
    { id: "s8", cwd: "C:/repo/.claude/worktrees/issue-8-y", issue: 8, status: undefined, state: "blocked" },
  ]);
});

test("edge: empty inputs plan nothing", () => {
  assert.deepEqual(planCleanup({ worktrees: [], sessions: [], prs: [] }), []);
  assert.deepEqual(planCleanup({}), []);
});

test("edge: parseWorktrees reads porcelain output, marks the first as main and a detached one as branchless", () => {
  const text = [
    "worktree C:/repo", "HEAD " + "f".repeat(40), "branch refs/heads/main", "",
    "worktree C:/repo/.claude/worktrees/issue-7-x", "HEAD " + HEAD, "branch refs/heads/issue-7-x", "locked claude session x (pid 1)", "",
    "worktree C:/repo/d", "HEAD " + HEAD, "detached", "",
  ].join("\n");
  assert.deepEqual(parseWorktrees(text), [
    { path: "C:/repo", branch: "main", head: "f".repeat(40), main: true },
    { path: "C:/repo/.claude/worktrees/issue-7-x", branch: "issue-7-x", head: HEAD, main: false, locked: "claude session x (pid 1)" },
    { path: "C:/repo/d", branch: null, head: HEAD, main: false },
  ]);
  assert.deepEqual(parseWorktrees(""), []);
});

const lockedBy = (pid, lockRunning) => ({ locked: `claude session issue-7-x (pid ${pid})`, lockRunning });

test("a merged lane locked by an ended Claude session is unlocked, then removed", () => {
  const [entry] = planCleanup({ worktrees: [wt("issue-7-x", lockedBy(18124, false))], prs: [merged("issue-7-x")] });
  const path = `${ROOT}/.claude/worktrees/issue-7-x`;
  assert.deepEqual(cmds(entry), [`git worktree unlock ${path}`, `git worktree remove ${path}`, "git branch -D issue-7-x"]);
  assert.deepEqual(entry.steps[0].onlyIf, { path });
});

test("a merged lane locked by a running Claude session is skipped: locked by running pid N", () => {
  const [entry] = planCleanup({ worktrees: [wt("issue-7-x", lockedBy(18124, true))], prs: [merged("issue-7-x")] });
  assert.deepEqual(entry, { branch: "issue-7-x", issue: 7, skip: "locked by running pid 18124" });
});

test("a Permission denied from git worktree remove is explained, and the branch is not deleted", () => {
  const path = `${ROOT}/.claude/worktrees/issue-7-x`;
  const plan = planCleanup({ worktrees: [wt("issue-7-x")], prs: [merged("issue-7-x")] });
  const ran = [];
  const run = (cmd, args) => {
    if (args[1] === "remove") throw Object.assign(new Error("exit 1"), { stderr: `error: failed to delete '${path}': Permission denied\n` });
    ran.push(`${cmd} ${args.join(" ")}`);
  };
  const results = runCleanup(plan, { run, stillThere: () => true });
  assert.deepEqual(ran, []);
  assert.equal(results[0].status, "failed");
  assert.equal(
    render(results),
    `failed issue-7-x (PR #90) at git worktree remove ${path}: error: failed to delete '${path}': Permission denied ` +
      "(a process still has files open in the worktree; close it and re-run)",
  );
});

test("edge: a lock held by a session whose liveness is unknown is treated as running and skipped", () => {
  const [entry] = planCleanup({ worktrees: [wt("issue-7-x", lockedBy(5, undefined))], prs: [merged("issue-7-x")] });
  assert.equal(entry.skip, "locked by running pid 5");
});

test("edge: a stale lock on an unmerged or dirty lane still skips for that reason, and nothing is unlocked", () => {
  const [open] = planCleanup({ worktrees: [wt("issue-7-x", lockedBy(5, false))], prs: [merged("issue-7-x", { state: "OPEN" })] });
  assert.equal(open.skip, "not merged");
  const [dirty] = planCleanup({ worktrees: [wt("issue-7-x", { ...lockedBy(5, false), dirty: true })], prs: [merged("issue-7-x")] });
  assert.equal(dirty.skip, "dirty worktree");
});

test("edge: a lock with any other reason is not unlocked (git worktree remove reports it)", () => {
  for (const locked of ["", "manual hold", "claude session x (pid abc)", "claude session x (pid 5) extra"]) {
    const [entry] = planCleanup({ worktrees: [wt("issue-7-x", { locked })], prs: [merged("issue-7-x")] });
    assert.ok(!cmds(entry).some((c) => c.includes("unlock")), locked);
  }
});

test("edge: a stale lock is unlocked after claude rm of the lane's idle session", () => {
  const [entry] = planCleanup({
    worktrees: [wt("issue-7-x", lockedBy(9, false))],
    sessions: [session("s7", "issue-7-x")],
    prs: [merged("issue-7-x")],
  });
  assert.deepEqual(cmds(entry).slice(0, 2), ["claude rm s7", `git worktree unlock ${ROOT}/.claude/worktrees/issue-7-x`]);
});

test("edge: a failure other than Permission denied keeps its message without the open-files hint", () => {
  const plan = planCleanup({ worktrees: [wt("issue-7-x")], prs: [merged("issue-7-x")] });
  const run = (cmd, args) => {
    if (args[1] === "remove") throw Object.assign(new Error("exit 1"), { stderr: "fatal: cannot remove a locked working tree" });
  };
  const [r] = runCleanup(plan, { run, stillThere: () => true });
  assert.equal(r.error, "fatal: cannot remove a locked working tree");
});

test("edge: a Permission denied from a step other than git worktree remove gets no open-files hint", () => {
  const plan = planCleanup({ worktrees: [wt("issue-7-x")], prs: [merged("issue-7-x")] });
  const run = (cmd, args) => {
    if (args[0] === "branch") throw Object.assign(new Error("exit 1"), { stderr: "error: Permission denied" });
  };
  const [r] = runCleanup(plan, { run, stillThere: () => true });
  assert.equal(r.error, "error: Permission denied");
});

test("edge: pidRunning is false for a pid no process has and true for this process; bad pids are not running", () => {
  assert.equal(pidRunning(process.pid), true);
  assert.equal(pidRunning(2 ** 30), false);
  for (const bad of [0, -1, NaN, 1.5]) assert.equal(pidRunning(bad), false, String(bad));
});

test("edge: pidRunning treats EPERM (a pid owned by someone else) as running, not absent", () => {
  const original = process.kill;
  process.kill = () => { throw Object.assign(new Error("no permission"), { code: "EPERM" }); };
  try {
    assert.equal(pidRunning(123), true);
  } finally {
    process.kill = original;
  }
});

test("/health runs cleanup.mjs and states it as its one exception; /status only shows output and runs nothing", async () => {
  const { readFileSync } = await import("node:fs");
  const read = (name) => readFileSync(new URL(`../../.claude/commands/${name}`, import.meta.url), "utf8");
  const health = read("health.md");
  assert.match(health, /`node scripts\/lanes\/cleanup\.mjs`/);
  assert.match(health, /Do not fix anything in this session, with one exception/);
  assert.match(read("status.md"), /Do not act on anything it lists/);
  assert.doesNotMatch(read("status.md"), /cleanup\.mjs/);
});

// cleanupMerged with fake inputs: `load()` returns planCleanup's inputs, `run` records each command.
function cleanupFakes({ inputs = { worktrees: [main], sessions: [], prs: [] }, fail = [], gone = [] } = {}) {
  const ran = [];
  const deps = {
    load: () => inputs,
    run: (cmd, args) => {
      const line = `${cmd} ${args.join(" ")}`;
      if (fail.includes(line)) throw Object.assign(new Error("exit 1"), { stderr: "fatal: cannot remove\nmore" });
      ran.push(line);
    },
    stillThere: (onlyIf) => !gone.includes(onlyIf.path ?? onlyIf.branch),
  };
  return { deps, ran };
}

test("cleanupMerged returns the rendered lines as an array: nothing to clean", async () => {
  const { cleanupMerged } = await import("./cleanup.mjs");
  const { deps, ran } = cleanupFakes();
  assert.deepEqual(cleanupMerged({ deps }), ["no lanes to clean up"]);
  assert.deepEqual(ran, []);
});

test("cleanupMerged removes one merged lane and returns one line per lane, as render prints it", async () => {
  const { cleanupMerged } = await import("./cleanup.mjs");
  const inputs = { worktrees: [main, wt("issue-7-x"), wt("issue-8-y")], sessions: [session("s7", "issue-7-x")], prs: [merged("issue-7-x"), { ...merged("issue-8-y"), state: "OPEN" }] };
  const { deps, ran } = cleanupFakes({ inputs });
  const lines = cleanupMerged({ dryRun: false, deps });
  const path = `${ROOT}/.claude/worktrees/issue-7-x`;
  assert.deepEqual(ran, ["claude rm s7", `git worktree remove ${path}`, "git branch -D issue-7-x"]);
  assert.deepEqual(lines, [
    `removed issue-7-x (PR #90): claude rm s7; git worktree remove ${path}; git branch -D issue-7-x`,
    "skipped issue-8-y: not merged",
  ]);
  const results = runCleanup(planCleanup(inputs), { run: () => {}, stillThere: () => true });
  assert.deepEqual(lines, render(results).split("\n"));
});

test("cleanupMerged with dryRun: true runs nothing and says what it would remove", async () => {
  const { cleanupMerged } = await import("./cleanup.mjs");
  const { deps, ran } = cleanupFakes({ inputs: { worktrees: [main, wt("issue-7-x")], sessions: [], prs: [merged("issue-7-x")] } });
  const lines = cleanupMerged({ dryRun: true, deps });
  assert.deepEqual(ran, []);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^would remove issue-7-x \(PR #90\): git worktree remove .*; git branch -D issue-7-x$/);
});

test("cleanupMerged throws when its inputs cannot be read, and returns a failed step as a failed line", async () => {
  const { cleanupMerged } = await import("./cleanup.mjs");
  assert.throws(() => cleanupMerged({ deps: { load: () => { throw new Error("gh: not logged in"); } } }), /gh: not logged in/);
  const path = `${ROOT}/.claude/worktrees/issue-7-x`;
  const { deps, ran } = cleanupFakes({ inputs: { worktrees: [main, wt("issue-7-x")], sessions: [], prs: [merged("issue-7-x")] }, fail: [`git worktree remove ${path}`] });
  assert.deepEqual(cleanupMerged({ deps }), [`failed issue-7-x (PR #90) at git worktree remove ${path}: fatal: cannot remove`]);
  assert.deepEqual(ran, []);
});

test("edge: cleanupMerged skips a step whose target is already gone", async () => {
  const { cleanupMerged } = await import("./cleanup.mjs");
  const path = `${ROOT}/.claude/worktrees/issue-7-x`;
  const { deps, ran } = cleanupFakes({ inputs: { worktrees: [main, wt("issue-7-x")], sessions: [], prs: [merged("issue-7-x")] }, gone: [path] });
  assert.deepEqual(cleanupMerged({ deps }), ["removed issue-7-x (PR #90): git branch -D issue-7-x"]);
  assert.deepEqual(ran, ["git branch -D issue-7-x"]);
});

test("cleanup.mjs's CLI calls cleanupMerged and keeps its output and exit code", () => {
  const src = readFileSync(new URL("./cleanup.mjs", import.meta.url), "utf8");
  const cli = src.slice(src.indexOf("function main("));
  assert.match(cli, /cleanupMerged\(\{ dryRun: argv\.includes\("--dry-run"\) \}\)/);
  assert.match(cli, /console\.log\(lines\.join\("\\n"\)\)/);
  assert.match(cli, /process\.exitCode = 1/);
  assert.doesNotMatch(cli, /planCleanup|runCleanup/);
});
