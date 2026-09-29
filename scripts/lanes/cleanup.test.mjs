import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  SESSION_ID, USAGE, argsOutcome, cleanableCount, cleanupMerged, findOrphans, formatStep, loadCleanupInputs, parseWorktrees, pidRunning, planCleanup, removeEmptyDir, render, runCleanup,
  recordSessionCost, saveSessionLog, sessionEnded, sessionsFrom, shOptions, waitForStop,
} from "./cleanup.mjs";

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

test("sessionsFrom keeps each background session's status and state, marks one with no id unreadable, and drops others", () => {
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
    { unreadableId: true, cwd: "C:/repo/.claude/worktrees/issue-10-q", issue: 10, status: undefined, state: undefined },
  ]);
});

test("sessionsFrom reads a lane-<N> name as the issue whatever its cwd, and ignores other names (#341)", () => {
  const agents = [
    { kind: "background", id: "s338", cwd: "C:/repo", name: "lane-338", status: "idle" },
    { kind: "background", id: "s9", cwd: "C:/repo", name: "reactapps-dc", status: "idle" },
  ];
  assert.deepEqual(sessionsFrom(agents, "C:/repo"), [
    { id: "s338", cwd: "C:/repo", issue: 338, status: "idle", state: undefined, name: "lane-338" },
    { id: "s9", cwd: "C:/repo", issue: null, status: "idle", state: undefined },
  ]);
});

test("a lane-<N> session at the repository root is stopped when #N's PR merged, and its worktree goes after it (#341)", () => {
  const named = { id: "s338", cwd: "C:\\repo", issue: 338, state: "idle", name: "lane-338", alive: true };
  const [entry] = planCleanup({ worktrees: [main, wt("issue-338-x")], sessions: [named], prs: [merged("issue-338-x")] });
  assert.equal(entry.skip, undefined);
  assert.deepEqual(cmds(entry).slice(0, 2), ["claude stop s338", "claude rm s338"]);
  assert.ok(cmds(entry).includes(`git worktree remove ${ROOT}/.claude/worktrees/issue-338-x`));
});

test("never removes a worktree while a lane-<N> session for that issue is working, whatever its cwd (#341)", () => {
  const named = { id: "s338", cwd: "C:\\repo", issue: 338, status: "busy", state: "working", name: "lane-338" };
  const plan = planCleanup({ worktrees: [main, wt("issue-338-x")], sessions: [named], prs: [merged("issue-338-x")] });
  assert.equal(plan.length, 1, "the session is placed with the worktree, not planned twice");
  assert.equal(plan[0].skip, "session still working");
});

test("edge: a session with neither a lane name nor an issue folder is ignored; another issue's name does not block", () => {
  const other = { id: "s1", cwd: "C:\\repo", issue: null, status: "busy", state: "working" };
  const elsewhere = { id: "s2", cwd: "C:\\repo", issue: 9, status: "busy", state: "working", name: "lane-9" };
  const [entry] = planCleanup({ worktrees: [main, wt("issue-338-x")], sessions: [other, elsewhere], prs: [merged("issue-338-x")] });
  assert.equal(entry.skip, undefined);
});

test("edge: an orphan lane folder is not removed while a lane-<N> session for its issue is running (#341)", () => {
  const named = { id: "s338", cwd: "C:\\repo", issue: 338, state: "idle", name: "lane-338" };
  const orphan = { path: `${ROOT}/.claude/worktrees/issue-338-x`, files: 0 };
  const plan = planCleanup({ sessions: [named], orphans: [orphan] });
  assert.match(plan.find((e) => e.orphan).skip, /session s338 is in it/);
});

test("edge: a working lane-<N> session whose cwd is inside another issue's worktree still blocks issue N's worktree (#341)", () => {
  const named = { id: "s11", cwd: `${ROOT}/.claude/worktrees/issue-10-x`, issue: 11, status: "busy", state: "working", name: "lane-11" };
  const plan = planCleanup({ worktrees: [main, wt("issue-10-x"), wt("issue-11-y")], sessions: [named], prs: [merged("issue-11-y")] });
  assert.equal(plan.find((e) => e.issue === 11).skip, "session still working");
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

// A `run` whose `claude rm <id>` refuses while another session claims the worktree, until that session is removed.
const CLAIM = (x) => Object.assign(new Error("exit 1"), { stderr: `Error: Another running background session (${x}) claims this worktree.\n` });
function claimedRun(claimant) {
  const ran = [];
  const run = (cmd, args) => {
    const line = `${cmd} ${args.join(" ")}`;
    if (line === "claude rm s7" && !ran.includes(`claude rm ${claimant}`)) throw CLAIM(claimant);
    ran.push(line);
  };
  return { run, ran };
}
const claimedPlan = () =>
  planCleanup({ worktrees: [wt("issue-7-x")], sessions: [session("s7", "issue-7-x")], prs: [merged("issue-7-x")] });

test("a stale second session claiming the worktree is removed, then claude rm is retried once and the lane cleaned", () => {
  const { run, ran } = claimedRun("x9");
  const asked = [];
  const sessionEnded = (id) => (asked.push(id), true);
  const [r] = runCleanup(claimedPlan(), { run, stillThere: () => true, sessionEnded });
  assert.deepEqual(asked, ["x9"]);
  assert.deepEqual(ran, ["claude rm x9", "claude rm s7", `git worktree remove ${ROOT}/.claude/worktrees/issue-7-x`, "git branch -D issue-7-x"]);
  assert.equal(r.status, "removed");
});

test("a still-running session claiming the worktree is reported and never stopped", () => {
  const { run, ran } = claimedRun("x9");
  const [r] = runCleanup(claimedPlan(), { run, stillThere: () => true, sessionEnded: () => false });
  assert.deepEqual(ran, []);
  assert.equal(r.status, "failed");
  assert.equal(r.failedStep, "claude rm s7");
  assert.match(r.error, /claims this worktree\. \(session x9 is still running; it was not stopped\)$/);
});

test("edge: claude rm is retried only once; a second refusal is reported as it is", () => {
  const ran = [];
  const run = (cmd, args) => {
    const line = `${cmd} ${args.join(" ")}`;
    if (line === "claude rm s7") throw CLAIM(ran.length === 0 ? "x9" : "x10");
    ran.push(line);
  };
  const [r] = runCleanup(claimedPlan(), { run, stillThere: () => true, sessionEnded: () => true });
  assert.deepEqual(ran, ["claude rm x9"]);
  assert.equal(r.status, "failed");
  assert.match(r.error, /\(x10\) claims this worktree/);
});

test("edge: a claimant that is also listed in the worktree is not removed a second time by its own step", () => {
  const plan = planCleanup({
    worktrees: [wt("issue-7-x")],
    sessions: [session("s7", "issue-7-x"), session("x9", "issue-7-x")],
    prs: [merged("issue-7-x")],
  });
  const { run, ran } = claimedRun("x9");
  const [r] = runCleanup(plan, { run, stillThere: () => true, sessionEnded: () => true });
  assert.deepEqual(ran.filter((l) => l === "claude rm x9"), ["claude rm x9"]);
  assert.equal(r.status, "removed");
});

test("edge: a claimant that fails to be removed stops the lane at that step", () => {
  const run = (cmd, args) => {
    if (args[1] === "x9") throw Object.assign(new Error("exit 1"), { stderr: "Error: cannot remove x9" });
    if (args[1] === "s7") throw CLAIM("x9");
  };
  const [r] = runCleanup(claimedPlan(), { run, stillThere: () => true, sessionEnded: () => true });
  assert.equal(r.failedStep, "claude rm x9");
  assert.equal(r.error, "Error: cannot remove x9");
});

test("edge: a claim refusal is left as it is without sessionEnded, or on a step other than claude rm", () => {
  const { run } = claimedRun("x9");
  const [r] = runCleanup(claimedPlan(), { run, stillThere: () => true });
  assert.match(r.error, /claims this worktree\.$/);
  const plan = planCleanup({ worktrees: [wt("issue-7-x")], prs: [merged("issue-7-x")] });
  const asked = [];
  const run2 = (cmd, args) => {
    if (args[1] === "remove") throw CLAIM("x9");
  };
  runCleanup(plan, { run: run2, stillThere: () => true, sessionEnded: (id) => (asked.push(id), true) });
  assert.deepEqual(asked, []);
});

test("edge: a claimant id that is not a plain session id is never passed to claude", () => {
  for (const bad of ["-rf", "a b", "x;y"]) {
    const asked = [];
    const run = (cmd, args) => {
      if (args[1] === "s7") throw CLAIM(bad);
    };
    const [r] = runCleanup(claimedPlan(), { run, stillThere: () => true, sessionEnded: (id) => (asked.push(id), true) });
    assert.deepEqual(asked, [], bad);
    assert.equal(r.status, "failed");
  }
});

test("sessionEnded: ended when its pid is not running, or claude logs finds no job; running otherwise", () => {
  const noJob = () => {
    throw Object.assign(new Error("exit 1"), { stderr: "No job matching 'x9'. Run 'claude agents' to list running sessions." });
  };
  const logsOk = () => "recent output";
  const sessions = [{ id: "x9", pid: 41 }];
  assert.equal(sessionEnded("x9", { sessions, run: logsOk, isRunning: () => false }), true);
  assert.equal(sessionEnded("x9", { sessions, run: logsOk, isRunning: () => true }), false);
  assert.equal(sessionEnded("x9", { sessions: [], run: noJob }), true);
  assert.equal(sessionEnded("x9", { sessions: [], run: () => { throw Object.assign(new Error("x"), { stderr: "Error: job not found" }); } }), true);
  assert.equal(sessionEnded("x9", { sessions: [], run: logsOk }), false);
});

test("edge: sessionEnded treats any other claude logs failure as still running", () => {
  const timeout = () => { throw Object.assign(new Error("spawnSync claude ETIMEDOUT"), { stderr: "" }); };
  assert.equal(sessionEnded("x9", { sessions: [], run: timeout }), false);
  assert.equal(sessionEnded("x9", { sessions: [{ id: "x9" }], run: timeout }), false);
});

test("edge: sessionsFrom keeps each session's pid", () => {
  const agents = [{ kind: "background", id: "s7", cwd: `${ROOT}/.claude/worktrees/issue-7-x`, pid: 41, status: "idle" }];
  assert.equal(sessionsFrom(agents, ROOT)[0].pid, 41);
});

test("cleanupMerged retries a claimed claude rm with a sessionEnded dep, and reports a live claimant as failed", () => {
  const inputs = { worktrees: [main, wt("issue-7-x")], sessions: [session("s7", "issue-7-x")], prs: [merged("issue-7-x")] };
  const { run } = claimedRun("x9");
  const lines = cleanupMerged({ deps: { load: () => inputs, run, stillThere: () => true, sessionEnded: () => false } });
  assert.match(lines[0], /^failed issue-7-x \(PR #90\) at claude rm s7: .*session x9 is still running/);
});

test("edge: cleanupMerged's default sessionEnded consults the loaded sessions and run, not a stub", () => {
  const inputs = { worktrees: [main, wt("issue-7-x")], sessions: [session("s7", "issue-7-x")], prs: [merged("issue-7-x")] };
  const path = `${ROOT}/.claude/worktrees/issue-7-x`;
  const ran = [];
  const run = (cmd, args) => {
    const line = `${cmd} ${args.join(" ")}`;
    if (line === "claude rm s7" && !ran.includes("claude rm x9")) throw CLAIM("x9");
    if (line === "claude logs x9") throw Object.assign(new Error("exit 1"), { stderr: "No job matching 'x9'." });
    ran.push(line);
  };
  const lines = cleanupMerged({ deps: { load: () => inputs, run, stillThere: () => true } });
  assert.deepEqual(ran, ["claude rm x9", "claude rm s7", `git worktree remove ${path}`, "git branch -D issue-7-x", "gh issue edit 7 --remove-label lane:running"]);
  assert.match(lines[0], /^removed issue-7-x \(PR #90\)/);
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
  assert.deepEqual(ran, ["claude rm s7", `git worktree remove ${path}`, "git branch -D issue-7-x", "gh issue edit 7 --remove-label lane:running"]);
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
  assert.deepEqual(cleanupMerged({ deps }), ["removed issue-7-x (PR #90): git branch -D issue-7-x; worktree already removed"]);
  assert.deepEqual(ran, ["git branch -D issue-7-x", "gh issue edit 7 --remove-label lane:running"]);
});

test("cleanup.mjs's CLI calls cleanupMerged and keeps its output and exit code", () => {
  const src = readFileSync(new URL("./cleanup.mjs", import.meta.url), "utf8");
  const cli = src.slice(src.indexOf("function main("));
  assert.match(cli, /cleanupMerged\(\{ dryRun: argv\.includes\("--dry-run"\) \}\)/);
  assert.match(cli, /console\.log\(lines\.join\("\\n"\)\)/);
  assert.match(cli, /process\.exitCode = 1/);
  assert.doesNotMatch(cli, /planCleanup|runCleanup/);
});

// #134: a lane whose worktree folder is `issue-<N>` with no slug is still that issue's lane.
test("sessionsFrom maps both issue-<N> and issue-<N>-<slug> folders to N, and never a look-alike number", () => {
  const agents = ["issue-104", "issue-106/src", "issue-7-slug", "issue-5x", "issue-5x-slug", "issue-", "issue-9-", "issue-80"]
    .map((dir, i) => ({ kind: "background", id: `s${i}`, cwd: `C:/repo/.claude/worktrees/${dir}` }));
  assert.deepEqual(sessionsFrom(agents, ROOT).map((s) => s.issue), [104, 106, 7, null, null, null, 9, 80]);
});

test("a merged lane in a bare issue-<N> folder (branch issue-<N>-...) is removed: session, worktree, branch", () => {
  const tree = { path: `${ROOT}/.claude/worktrees/issue-7`, branch: "issue-7-x", head: HEAD, dirty: false };
  const sessions = sessionsFrom([{ kind: "background", id: "s7", cwd: "C:\\repo\\.claude\\worktrees\\issue-7", state: "idle" }], ROOT);
  const [entry] = planCleanup({ worktrees: [main, tree], sessions, prs: [merged("issue-7-x")] });
  assert.equal(entry.skip, undefined);
  assert.deepEqual(cmds(entry), ["claude rm s7", `git worktree remove ${ROOT}/.claude/worktrees/issue-7`, "git branch -D issue-7-x"]);
});

test("edge: a merged lane's leftover session in a bare issue-<N> folder whose worktree is gone is still removed", () => {
  const sessions = sessionsFrom([{ kind: "background", id: "s7", cwd: "C:/repo/.claude/worktrees/issue-7", state: "idle" }], ROOT);
  const plan = planCleanup({ worktrees: [main], sessions, prs: [merged("issue-7-x")] });
  assert.deepEqual(plan.map(cmds), [["claude rm s7"]]);
});

// Not covered by the acceptance criteria or the listed edge cases: a bare-folder leftover session whose issue is
// not yet merged must still be skipped, not removed just because sessionsFrom could read its issue number.
test("edge: a leftover session in a bare issue-<N> folder is skipped, not removed, while its issue has no merged PR", () => {
  const sessions = sessionsFrom([{ kind: "background", id: "s7", cwd: "C:/repo/.claude/worktrees/issue-7", state: "idle" }], ROOT);
  const plan = planCleanup({ worktrees: [main], sessions, prs: [merged("issue-7-x", { state: "OPEN" })] });
  assert.equal(plan[0].skip, "not merged");
  assert.equal(plan[0].steps, undefined);
});

// #143: idle-but-alive sessions, orphan folders, closed-issue lanes, and each removed session's log.
const TREE7 = `${ROOT}/.claude/worktrees/issue-7-x`;
const ORPHAN = `${ROOT}/.claude/worktrees/issue-9-gone`;
const closedIssue = (number) => ({ number, state: "CLOSED" });
const aliveLock = { locked: "claude session issue-7-x (pid 41)", lockRunning: true };
const aliveIdle = (extra = {}) => session("s7", "issue-7-x", { status: "idle", pid: 41, alive: true, ...extra });

test("an idle session of a merged lane whose process is alive is stopped, then removed with its lane", () => {
  const [entry] = planCleanup({ worktrees: [main, wt("issue-7-x", aliveLock)], sessions: [aliveIdle()], prs: [merged("issue-7-x")] });
  assert.deepEqual(cmds(entry), ["claude stop s7", "claude rm s7", `git worktree unlock ${TREE7}`, `git worktree remove ${TREE7}`, "git branch -D issue-7-x"]);
});

test("a busy session of a merged lane is never stopped: session still working", () => {
  const [entry] = planCleanup({ worktrees: [main, wt("issue-7-x", aliveLock)], sessions: [aliveIdle({ status: "busy" })], prs: [merged("issue-7-x")] });
  assert.equal(entry.skip, "session still working");
  assert.equal(entry.steps, undefined);
});

test("edge: a lock held by a running pid that no listed session has is still skipped: locked by running pid", () => {
  const [entry] = planCleanup({ worktrees: [main, wt("issue-7-x", aliveLock)], sessions: [aliveIdle({ pid: 99, alive: false })], prs: [merged("issue-7-x")] });
  assert.equal(entry.skip, "locked by running pid 41");
});

test("edge: an alive idle session whose worktree is already gone is stopped, then removed", () => {
  const plan = planCleanup({ worktrees: [main], sessions: [aliveIdle()], prs: [merged("issue-7-x")] });
  assert.deepEqual(plan.map(cmds), [["claude stop s7", "claude rm s7"]]);
});

test("an empty orphan folder under .claude/worktrees is removed", () => {
  const plan = planCleanup({ worktrees: [main], orphans: [{ path: ORPHAN, files: 0 }] });
  assert.deepEqual(plan.map(cmds), [[`rmdir ${ORPHAN}`]]);
  const removed = [];
  const results = runCleanup(plan, { run: () => assert.fail("no command runs"), stillThere: () => true, removeDir: (p) => removed.push(p) });
  assert.deepEqual(removed, [ORPHAN]);
  assert.equal(render(results), `removed orphan folder ${ORPHAN}: rmdir ${ORPHAN}`);
});

test("an orphan folder that still holds files is reported and never deleted", () => {
  const plan = planCleanup({ worktrees: [main], orphans: [{ path: ORPHAN, files: 3 }] });
  const results = runCleanup(plan, { run: () => assert.fail("no command runs"), stillThere: () => true, removeDir: () => assert.fail("never deleted") });
  assert.equal(render(results), `orphan folder ${ORPHAN} has 3 files; left in place`);
});

test("edge: an orphan folder whose files cannot be counted, or that holds a session's cwd, is left in place", () => {
  const plan = planCleanup({ worktrees: [main], sessions: [session("s9", "issue-9-gone", { status: "busy" })], orphans: [{ path: ORPHAN, files: 0 }, { path: `${ROOT}/.claude/worktrees/x`, files: null }] });
  assert.deepEqual(plan.filter((e) => e.orphan).map((e) => e.skip), ["session s9 is in it", "cannot count its files"]);
});

test("a closed issue's lane with no open or merged PR, clean and not busy, is removed like a merged lane", () => {
  const [entry] = planCleanup({ worktrees: [main, wt("issue-7-x", { unpushed: 0 })], sessions: [session("s7", "issue-7-x", { status: "idle" })], prs: [], issues: [closedIssue(7)] });
  assert.deepEqual(cmds(entry), ["claude rm s7", `git worktree remove ${TREE7}`, "git branch -D issue-7-x"]);
  const results = runCleanup([entry], { run: () => {}, stillThere: () => true });
  assert.match(render(results), /^removed issue-7-x \(issue #7 closed\): claude rm s7/);
});

test("a closed issue's lane with commits not on any remote is kept and reported", () => {
  const [entry] = planCleanup({ worktrees: [main, wt("issue-7-x", { unpushed: 2 })], prs: [], issues: [closedIssue(7)] });
  assert.equal(entry.skip, "2 commits not on any remote");
});

test("edge: closed-issue lanes: an open PR, a busy session, a dirty tree or unreadable unpushed count keeps them; a closed-unmerged PR does not", () => {
  const plan = (tree, extra = {}) => planCleanup({ worktrees: [main, wt("issue-7-x", { unpushed: 0, ...tree })], prs: [], issues: [closedIssue(7)], ...extra })[0];
  assert.equal(plan({}, { prs: [merged("issue-7-x", { state: "OPEN" })] }).skip, "not merged");
  assert.equal(plan({}, { sessions: [session("s7", "issue-7-x", { status: "busy" })] }).skip, "session still working");
  assert.equal(plan({ dirty: true }).skip, "dirty worktree");
  assert.equal(plan({ unpushed: null }).skip, "cannot read unpushed commits");
  assert.equal(plan({ unpushed: undefined }).skip, "cannot read unpushed commits");
  assert.equal(plan({ unpushed: 1 }).skip, "1 commit not on any remote");
  assert.ok(plan({}, { prs: [merged("issue-7-x", { state: "CLOSED" })] }).steps);
  assert.equal(plan({}, { issues: [{ number: 7, state: "OPEN" }] }).skip, "not merged");
  assert.equal(plan({}, { issues: [] }).skip, "not merged");
});

test("edge: a closed issue's leftover session whose worktree is gone is removed; a busy one is kept", () => {
  const plan = (status) => planCleanup({ worktrees: [main], sessions: [session("s7", "issue-7-x", { status })], issues: [closedIssue(7)] })[0];
  assert.deepEqual(cmds(plan("idle")), ["claude rm s7"]);
  assert.equal(plan("busy").skip, "session still working");
});

test("--dry-run lists every kind of removal and deletes nothing", () => {
  const plan = planCleanup({
    worktrees: [main, wt("issue-7-x", aliveLock), wt("issue-8-y", { unpushed: 0 })],
    sessions: [aliveIdle()],
    prs: [merged("issue-7-x")], issues: [closedIssue(8)], orphans: [{ path: ORPHAN, files: 0 }, { path: `${ORPHAN}2`, files: 1 }],
  });
  const never = () => assert.fail("dry run touches nothing");
  const lines = render(runCleanup(plan, { dryRun: true, run: never, stillThere: never, removeDir: never, saveLog: never })).split("\n");
  assert.deepEqual(lines, [
    `would remove issue-7-x (PR #90): claude stop s7; claude rm s7; git worktree unlock ${TREE7}; git worktree remove ${TREE7}; git branch -D issue-7-x`,
    `would remove issue-8-y (issue #8 closed): git worktree remove ${ROOT}/.claude/worktrees/issue-8-y; git branch -D issue-8-y`,
    `would remove orphan folder ${ORPHAN}: rmdir ${ORPHAN}`,
    `orphan folder ${ORPHAN}2 has 1 file; left in place`,
  ]);
});

test("each session's log is saved before it is stopped or removed, and the result line names the file", () => {
  const plan = planCleanup({ worktrees: [main, wt("issue-7-x", aliveLock)], sessions: [aliveIdle()], prs: [merged("issue-7-x")] });
  const order = [];
  const results = runCleanup(plan, {
    run: (cmd, args) => order.push(`${cmd} ${args.join(" ")}`),
    stillThere: () => true,
    saveLog: (id, issue) => {
      order.push(`save ${id} ${issue}`);
      return `.lanes/logs/issue-${issue}-${id}.txt`;
    },
  });
  assert.deepEqual(order.slice(0, 3), ["save s7 7", "claude stop s7", "claude rm s7"]);
  assert.match(render(results), /^removed issue-7-x \(PR #90\): log saved to \.lanes\/logs\/issue-7-s7\.txt; claude stop s7; claude rm s7;/);
});

test("edge: a log that cannot be written is reported and the session is still removed", () => {
  const plan = planCleanup({ worktrees: [main], sessions: [session("s7", "issue-7-x", { status: "idle" })], prs: [merged("issue-7-x")] });
  const ran = [];
  const saveLog = () => {
    throw new Error("EACCES: permission denied");
  };
  const results = runCleanup(plan, { run: (cmd, args) => ran.push(`${cmd} ${args.join(" ")}`), stillThere: () => true, saveLog });
  assert.deepEqual(ran, ["claude rm s7"]);
  assert.equal(render(results), "removed #7 session (PR #90): log not saved (EACCES: permission denied); claude rm s7");
});

test("edge: a claimant session removed to clear a claim has its log saved first", () => {
  const { run } = claimedRun("x9");
  const saved = [];
  const saveLog = (id) => {
    saved.push(id);
    return `.lanes/logs/issue-7-${id}.txt`;
  };
  const [result] = runCleanup(claimedPlan(), { run, stillThere: () => true, sessionEnded: () => true, saveLog });
  assert.equal(result.status, "removed");
  assert.deepEqual(saved, ["s7", "x9"]);
});

// saveSessionLog, findOrphans and removeEmptyDir against a real temporary folder.
const tempRoot = (t) => {
  const dir = mkdtempSync(join(tmpdir(), "lanes-cleanup-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const readLog = (root, name) => readFileSync(join(root, ".lanes", "logs", name), "utf8");

test("saveSessionLog writes the last 200 lines of claude logs to .lanes/logs/issue-<N>-<id>.txt", (t) => {
  const root = tempRoot(t);
  const lines = Array.from({ length: 250 }, (_, i) => `line ${i + 1}`);
  const calls = [];
  const run = (cmd, args) => {
    calls.push(`${cmd} ${args.join(" ")}`);
    return `${lines.join("\r\n")}\r\n`;
  };
  assert.equal(saveSessionLog("s7", 7, { root, run }), ".lanes/logs/issue-7-s7.txt");
  assert.deepEqual(calls, ["claude logs s7"]);
  const text = readLog(root, "issue-7-s7.txt").split("\n").filter(Boolean);
  assert.equal(text.length, 200);
  assert.equal(text[0], "line 51");
  assert.equal(text.at(-1), "line 250");
});

test("saveSessionLog strips terminal escape codes", (t) => {
  const root = tempRoot(t);
  const raw = "\x1b[1m\x1b[32mdone\x1b[0m ok\n\x1b]0;title\x07state: \x1b[31mblocked\x1b[39m\nbar 10%\rbar 100%\n\x1b[2K\x1b[1Gend\x07\n";
  saveSessionLog("s7", 7, { root, run: () => raw });
  const text = readLog(root, "issue-7-s7.txt");
  assert.doesNotMatch(text, /[\x00-\x08\x0b-\x1f\x7f]/);
  assert.deepEqual(text.split("\n").filter(Boolean), ["done ok", "state: blocked", "bar 10%", "bar 100%", "end"]);
});

test("saveSessionLog writes one line when claude logs fails, and still returns the file", (t) => {
  const root = tempRoot(t);
  const run = () => {
    throw Object.assign(new Error("exit 1"), { stderr: "No job matching 's7'.\nmore" });
  };
  assert.equal(saveSessionLog("s7", 7, { root, run }), ".lanes/logs/issue-7-s7.txt");
  assert.equal(readLog(root, "issue-7-s7.txt"), "claude logs s7 failed: No job matching 's7'.\n");
});

test("edge: saveSessionLog notes empty output, and never lets a session id leave .lanes/logs", (t) => {
  const root = tempRoot(t);
  assert.equal(saveSessionLog("s7", 7, { root, run: () => "" }), ".lanes/logs/issue-7-s7.txt");
  assert.equal(readLog(root, "issue-7-s7.txt"), "claude logs s7 printed nothing\n");
  assert.equal(saveSessionLog("../../x", 7, { root, run: () => "hi" }), ".lanes/logs/issue-7-______x.txt");
  assert.deepEqual(readdirSync(join(root, ".lanes", "logs")).sort(), ["issue-7-______x.txt", "issue-7-s7.txt"]);
});

test("saveSessionLog keeps the 50 newest files in .lanes/logs and deletes older ones", (t) => {
  const root = tempRoot(t);
  const dir = join(root, ".lanes", "logs");
  mkdirSync(join(dir, "keep-dir"), { recursive: true });
  for (let i = 0; i < 55; i++) {
    const file = join(dir, `old-${String(i).padStart(2, "0")}.txt`);
    writeFileSync(file, "x");
    utimesSync(file, 1_000_000 + i, 1_000_000 + i);
  }
  saveSessionLog("s7", 7, { root, run: () => "hi" });
  const left = readdirSync(dir).filter((f) => f !== "keep-dir");
  assert.equal(left.length, 50);
  assert.ok(left.includes("issue-7-s7.txt"));
  assert.ok(!left.includes("old-05.txt") && left.includes("old-06.txt") && left.includes("old-54.txt"));
  assert.ok(existsSync(join(dir, "keep-dir")));
});

test("findOrphans lists untracked folders under .claude/worktrees with their file counts", (t) => {
  const root = tempRoot(t);
  const base = join(root, ".claude", "worktrees");
  for (const d of ["tracked", "empty", "nested/deeper", "full/sub"]) mkdirSync(join(base, d), { recursive: true });
  writeFileSync(join(base, "full", "a.txt"), "x");
  writeFileSync(join(base, "full", "sub", "b.txt"), "x");
  writeFileSync(join(base, "stray.txt"), "x");
  const tracked = [root, join(base, "tracked").replace(/\\/g, "/")];
  const orphans = findOrphans(root, tracked).map((o) => ({ ...o, path: o.path.replace(/\\/g, "/").split("/").pop() }));
  assert.deepEqual(orphans.sort((a, b) => a.path.localeCompare(b.path)), [{ path: "empty", files: 0 }, { path: "full", files: 2 }, { path: "nested", files: 0 }]);
  assert.deepEqual(findOrphans(join(root, "none"), []), []);
});

test("edge: a folder under .claude/worktrees that holds a tracked worktree deeper down is not an orphan", (t) => {
  const root = tempRoot(t);
  const deep = join(root, ".claude", "worktrees", "group", "issue-7-x");
  mkdirSync(deep, { recursive: true });
  writeFileSync(join(deep, "a.txt"), "x");
  assert.deepEqual(findOrphans(root, [root, deep]), []);
});

test("edge: cleanupMerged saves each removed session's log under the loaded root and names it in the line", (t) => {
  const root = tempRoot(t);
  const inputs = { root, worktrees: [main], sessions: [session("s7", "issue-7-x", { status: "idle" })], prs: [merged("issue-7-x")] };
  const run = (cmd, args) => (args[0] === "logs" ? "\x1b[31mblocked\x1b[0m: waiting\n" : "");
  const lines = cleanupMerged({ deps: { load: () => inputs, run, stillThere: () => true, unmark: () => {} } });
  assert.deepEqual(lines, ["removed #7 session (PR #90): log saved to .lanes/logs/issue-7-s7.txt; claude rm s7"]);
  assert.equal(readLog(root, "issue-7-s7.txt"), "blocked: waiting\n");
});

test("removeEmptyDir deletes a folder with no files and refuses one that holds files", (t) => {
  const root = tempRoot(t);
  mkdirSync(join(root, "empty", "sub"), { recursive: true });
  mkdirSync(join(root, "full"));
  writeFileSync(join(root, "full", "a.txt"), "x");
  removeEmptyDir(join(root, "empty"));
  assert.ok(!existsSync(join(root, "empty")));
  assert.throws(() => removeEmptyDir(join(root, "full")), /has 1 file; left in place/);
  assert.ok(existsSync(join(root, "full", "a.txt")));
});

// An orphan folder git pruned, leaving only its `.git` pointer file: `pointer` is the gitdir it names.
const pointerDir = (root, name, pointer, ...others) => {
  const dir = join(root, ".claude", "worktrees", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".git"), `gitdir: ${pointer}\n`);
  for (const f of others) writeFileSync(join(dir, f), "x");
  return dir;
};

test("a folder holding only a stale .git pointer is counted empty, planned for removal and deleted", (t) => {
  const root = tempRoot(t);
  const dir = pointerDir(root, "issue-36-x", join(root, ".git", "worktrees", "issue-36-x"));
  assert.deepEqual(findOrphans(root, [root]).map((o) => o.files), [0]);
  const plan = planCleanup({ orphans: findOrphans(root, [root]) });
  assert.equal(cleanableCount(plan), 1);
  removeEmptyDir(dir);
  assert.ok(!existsSync(dir));
});

test("a .git pointer at a gitdir that still exists keeps its folder and is reported", (t) => {
  const root = tempRoot(t);
  const live = join(root, ".git", "worktrees", "issue-36-x");
  mkdirSync(live, { recursive: true });
  const dir = pointerDir(root, "issue-36-x", live);
  assert.deepEqual(findOrphans(root, [root]).map((o) => o.files), [1]);
  assert.match(planCleanup({ orphans: findOrphans(root, [root]) })[0].skip, /has 1 file; left in place/);
  assert.throws(() => removeEmptyDir(dir), /has 1 file; left in place/);
  assert.ok(existsSync(join(dir, ".git")));
});

test("a stale .git pointer beside another file keeps its folder and both files", (t) => {
  const root = tempRoot(t);
  const dir = pointerDir(root, "issue-36-x", join(root, "gone"), "notes.txt");
  assert.deepEqual(findOrphans(root, [root]).map((o) => o.files), [1]);
  assert.match(planCleanup({ orphans: findOrphans(root, [root]) })[0].skip, /has 1 file; left in place/);
  assert.throws(() => removeEmptyDir(dir), /has 1 file; left in place/);
  assert.ok(existsSync(join(dir, ".git")) && existsSync(join(dir, "notes.txt")));
});

test("edge: a relative stale gitdir resolves against the folder; a relative live one keeps it", (t) => {
  const root = tempRoot(t);
  const stale = pointerDir(root, "stale", "../nowhere");
  const live = pointerDir(root, "live", "../stale");
  assert.equal(findOrphans(root, [root]).find((o) => o.path === stale).files, 0);
  assert.equal(findOrphans(root, [root]).find((o) => o.path === live).files, 1);
});

test("edge: a .git file that is not a gitdir pointer, an empty one, or a .git folder is not stale", (t) => {
  const root = tempRoot(t);
  const base = join(root, ".claude", "worktrees");
  for (const [name, text] of [["junk", "hello\n"], ["blank", ""]]) {
    mkdirSync(join(base, name), { recursive: true });
    writeFileSync(join(base, name, ".git"), text);
  }
  mkdirSync(join(base, "dir", ".git"), { recursive: true });
  writeFileSync(join(base, "dir", ".git", "HEAD"), "x");
  const counts = Object.fromEntries(findOrphans(root, [root]).map((o) => [o.path.replace(/\\/g, "/").split("/").pop(), o.files]));
  assert.deepEqual(counts, { junk: 1, blank: 1, dir: 1 });
  assert.throws(() => removeEmptyDir(join(base, "junk")), /has 1 file; left in place/);
});

test("edge: a gitdir line that is not the first line is not a pointer; CRLF and forward slashes still are", (t) => {
  const root = tempRoot(t);
  const base = join(root, ".claude", "worktrees");
  const liveDir = join(root, "live-gitdir");
  mkdirSync(liveDir);
  const cases = { later: "notes\ngitdir: /nowhere\n", crlf: "gitdir: /nowhere/x\r\n", fwd: `gitdir: ${liveDir.replace(/\\/g, "/")}\n` };
  for (const [name, text] of Object.entries(cases)) {
    mkdirSync(join(base, name), { recursive: true });
    writeFileSync(join(base, name, ".git"), text);
  }
  const counts = Object.fromEntries(findOrphans(root, [root]).map((o) => [o.path.replace(/\\/g, "/").split("/").pop(), o.files]));
  assert.deepEqual(counts, { later: 1, crlf: 0, fwd: 1 });
});

test("edge: a stale .git pointer in a subfolder still counts as a file", (t) => {
  const root = tempRoot(t);
  const dir = join(root, ".claude", "worktrees", "issue-36-x");
  mkdirSync(join(dir, "sub"), { recursive: true });
  writeFileSync(join(dir, "sub", ".git"), `gitdir: ${join(root, "gone")}\n`);
  assert.deepEqual(findOrphans(root, [root]).map((o) => o.files), [1]);
  assert.throws(() => removeEmptyDir(dir), /has 1 file; left in place/);
});

test("edge: removeEmptyDir deletes a stale pointer folder with empty subfolders too", (t) => {
  const root = tempRoot(t);
  const dir = pointerDir(root, "issue-36-x", join(root, "gone"));
  mkdirSync(join(dir, "sub", "deeper"), { recursive: true });
  removeEmptyDir(dir);
  assert.ok(!existsSync(dir));
});

test("edge: removeEmptyDir never deletes a file that appears after it counted none", (t) => {
  const root = tempRoot(t);
  mkdirSync(join(root, "late", "a", "b"), { recursive: true });
  removeEmptyDir(join(root, "late"));
  assert.ok(!existsSync(join(root, "late")));
  const src = readFileSync(new URL("./cleanup.mjs", import.meta.url), "utf8");
  const body = src.slice(src.indexOf("export function removeEmptyDir"), src.indexOf("export const LOG_LINES"));
  assert.doesNotMatch(body, /rmSync\(/);
  assert.match(body, /rmdirSync\(dir\)/);
});

// #179: a failed step says why, and `claude rm` right after `claude stop` waits for the session to finish exiting.
const stopRmPlan = () => [{ branch: "issue-7-x", issue: 7, steps: [{ cmd: "claude", args: ["stop", "s7"] }, { cmd: "claude", args: ["rm", "s7"] }] }];
const failure = (stderr, extra = {}) => Object.assign(new Error("Command failed: claude rm s7"), { stderr, ...extra });
const agentsJson = (status) => JSON.stringify(status === undefined ? [] : [{ kind: "background", id: "s7", cwd: "C:\\repo", status }]);
const AGENTS = "claude agents --json";

test("a failed step's line carries the command's stderr, not only Command failed", () => {
  const run = () => { throw failure("Error: session s7 is still exiting\n"); };
  const [r] = runCleanup(stopRmPlan(), { run, stillThere: () => true });
  assert.equal(r.status, "failed");
  assert.equal(r.error, "Error: session s7 is still exiting");
  assert.match(render([r]), /^failed issue-7-x at claude stop s7: Error: session s7 is still exiting$/);
});

test("edge: the failure text is one line of at most 200 characters, from stderr, else stdout, else the message", () => {
  const first = (err) => runCleanup(stopRmPlan(), { run: () => { throw err; }, stillThere: () => true })[0].error;
  const long = first(failure(`${"x".repeat(300)}\nmore`));
  assert.equal(long.length, 200);
  assert.ok(long.endsWith("…"));
  assert.equal(first(failure("   \n\nsecond line\nthird")), "second line");
  assert.equal(first(failure("", { stdout: "Error: from stdout\n" })), "Error: from stdout");
  assert.equal(first(failure("  ", { stdout: "" })), "Command failed: claude rm s7");
  assert.equal(first(new Error("spawn claude ENOENT")), "spawn claude ENOENT");
});

test("edge: control characters and lone carriage returns are dropped from the failure line", () => {
  const first = (err) => runCleanup(stopRmPlan(), { run: () => { throw err; }, stillThere: () => true })[0].error;
  assert.equal(first(failure("\u001b[31mError: red\u001b[0m\u0008\u0007")), "[31mError: red[0m");
  assert.equal(first(failure("\rfirst\rsecond")), "first");
});

test("edge: a waitStopped that throws does not fail the stop step, and rm still runs", () => {
  const log = [];
  const run = (cmd, args) => { log.push(args[0]); };
  const [r] = runCleanup(stopRmPlan(), { run, stillThere: () => true, waitStopped: () => { throw new Error("boom"); } });
  assert.deepEqual(log, ["stop", "rm"]);
  assert.equal(r.status, "removed");
});

test("claude rm right after claude stop waits for the session to stop, then removes it", () => {
  const log = [];
  const run = (cmd, args) => { log.push(`${cmd} ${args.join(" ")}`); };
  const waitStopped = (id) => (log.push(`wait ${id}`), true);
  const [r] = runCleanup(stopRmPlan(), { run, stillThere: () => true, waitStopped, sleep: (ms) => log.push(`sleep ${ms}`) });
  assert.deepEqual(log, ["claude stop s7", "wait s7", "claude rm s7"]);
  assert.equal(r.status, "removed");
});

test("edge: no wait when claude stop failed, and none before a claude rm with no stop ahead of it", () => {
  const waited = [];
  const waitStopped = (id) => (waited.push(id), true);
  const stopFails = (cmd, args) => { if (args[0] === "stop") throw failure("nope"); };
  runCleanup(stopRmPlan(), { run: stopFails, stillThere: () => true, waitStopped });
  const rmOnly = [{ branch: "issue-7-x", issue: 7, steps: [{ cmd: "claude", args: ["rm", "s7"] }] }];
  runCleanup(rmOnly, { run: () => {}, stillThere: () => true, waitStopped });
  assert.deepEqual(waited, []);
});

test("claude rm is retried once after 2 seconds when it fails, and the lane is removed when the retry works", () => {
  const log = [];
  let rmTries = 0;
  const run = (cmd, args) => {
    log.push(`${cmd} ${args.join(" ")}`);
    if (args[0] === "rm" && ++rmTries === 1) throw failure("Error: session is still exiting");
  };
  const [r] = runCleanup(stopRmPlan(), { run, stillThere: () => true, sleep: (ms) => log.push(`sleep ${ms}`) });
  assert.deepEqual(log, ["claude stop s7", "claude rm s7", "sleep 2000", "claude rm s7"]);
  assert.equal(r.status, "removed");
  assert.deepEqual(r.ran, ["claude stop s7", "claude rm s7"]);
});

test("claude rm gives up after the one retry and shows the stderr of the retry", () => {
  const log = [];
  let rmTries = 0;
  const run = (cmd, args) => {
    log.push(`${cmd} ${args.join(" ")}`);
    if (args[0] === "rm") throw failure(`Error: attempt ${++rmTries} failed`);
  };
  const [r] = runCleanup(stopRmPlan(), { run, stillThere: () => true, sleep: (ms) => log.push(`sleep ${ms}`) });
  assert.deepEqual(log, ["claude stop s7", "claude rm s7", "sleep 2000", "claude rm s7"]);
  assert.equal(r.status, "failed");
  assert.equal(r.failedStep, "claude rm s7");
  assert.equal(r.error, "Error: attempt 2 failed");
});

test("edge: only claude rm is retried, and not at all without a sleep dep", () => {
  const calls = [];
  const gitFails = (cmd) => { calls.push(cmd); if (cmd === "git") throw failure("fatal: locked"); };
  const plan = [{ branch: "b", issue: 7, steps: [{ cmd: "git", args: ["branch", "-D", "b"] }] }];
  runCleanup(plan, { run: gitFails, stillThere: () => true, sleep: () => {} });
  assert.deepEqual(calls, ["git"]);
  const rmCalls = [];
  const rmFails = (cmd, args) => { rmCalls.push(args[0]); if (args[0] === "rm") throw failure("x"); };
  runCleanup(stopRmPlan(), { run: rmFails, stillThere: () => true });
  assert.deepEqual(rmCalls, ["stop", "rm"]);
});

test("waitForStop checks the agents list every second and stops once the session is not busy or running", () => {
  const seen = ["busy", "running", "idle"];
  const log = [];
  const run = (cmd, args) => { log.push(`${cmd} ${args.join(" ")}`); return agentsJson(seen.shift()); };
  assert.equal(waitForStop("s7", { run, sleep: (ms) => log.push(`sleep ${ms}`) }), true);
  assert.deepEqual(log, [AGENTS, "sleep 1000", AGENTS, "sleep 1000", AGENTS]);
});

test("waitForStop returns true once the session is gone from the list", () => {
  const seen = ["busy", undefined];
  const run = () => agentsJson(seen.shift());
  assert.equal(waitForStop("s7", { run, sleep: () => {} }), true);
});

test("waitForStop gives up after 10 seconds of a still-busy session", () => {
  let checks = 0;
  const sleeps = [];
  const run = () => (checks++, agentsJson("busy"));
  assert.equal(waitForStop("s7", { run, sleep: (ms) => sleeps.push(ms) }), false);
  assert.equal(sleeps.length, 10);
  assert.ok(sleeps.every((ms) => ms === 1000));
  assert.equal(checks, 11);
});

test("edge: waitForStop stops waiting when the agents list fails or is unparseable, and ignores a lingering working state", () => {
  const noSleep = () => assert.fail("must not sleep");
  const broken = () => { throw failure("no daemon"); };
  assert.equal(waitForStop("s7", { run: broken, sleep: noSleep }), false);
  assert.equal(waitForStop("s7", { run: () => "not json", sleep: noSleep }), false);
  assert.equal(waitForStop("s7", { run: () => JSON.stringify({ not: "a list" }), sleep: noSleep }), false);
  const stopped = () => JSON.stringify([{ id: "s7", status: "idle", state: "working" }, { id: "other", status: "busy" }]);
  assert.equal(waitForStop("s7", { run: stopped, sleep: noSleep }), true);
});

test("cleanupMerged waits for the stop and retries rm through its default deps", () => {
  const log = [];
  let rmTries = 0;
  const inputs = { worktrees: [], sessions: [session("s7", "issue-7-x", { status: "idle", state: "working", pid: 1, alive: true })], prs: [merged("issue-7-x")] };
  const deps = {
    load: () => inputs,
    run: (cmd, args) => {
      const line = `${cmd} ${args.join(" ")}`;
      log.push(line);
      if (line === AGENTS) return agentsJson("idle");
      if (line === "claude rm s7" && ++rmTries === 1) throw failure("Error: still exiting");
    },
    stillThere: () => true,
    sleep: (ms) => log.push(`sleep ${ms}`),
  };
  const lines = cleanupMerged({ deps });
  assert.match(lines[0], /^removed /);
  assert.deepEqual(log.filter((l) => /stop|agents|rm|sleep/.test(l)), ["claude stop s7", AGENTS, "claude rm s7", "sleep 2000", "claude rm s7"]);
});

test("edge: a claimed-worktree refusal is handled by the claimant path, not the 2 second retry, even with a sleep dep", () => {
  const { run, ran } = claimedRun("x9");
  const sleeps = [];
  const [r] = runCleanup(claimedPlan(), { run, stillThere: () => true, sessionEnded: () => true, sleep: (ms) => sleeps.push(ms) });
  assert.deepEqual(sleeps, []);
  assert.deepEqual(ran.slice(0, 2), ["claude rm x9", "claude rm s7"]);
  assert.equal(r.status, "removed");
});

// #186: a session id is passed to `claude stop` and `claude rm` as an argv item, so one starting with `-` would be
// read as a flag. sessionsFrom keeps only ids matching the claimant-id pattern.
const agentWith = (id) => ({ kind: "background", id, cwd: "C:/repo/.claude/worktrees/issue-7-x", state: "idle" });

test("sessionsFrom keeps a session whose id is a valid name", () => {
  assert.deepEqual(sessionsFrom([agentWith("s7"), agentWith("A_b-9")], ROOT).map((s) => s.id), ["s7", "A_b-9"]);
});

const UNREADABLE = "session with an unreadable id is in it";
const stopsOrRemoves = (plan) => plan.flatMap((e) => (e.steps ? cmds(e) : [])).filter((c) => /^claude (stop|rm)/.test(c));

test("sessionsFrom keeps an id that starts with a dash only as an unreadable session, so it never reaches claude stop or claude rm", () => {
  const sessions = sessionsFrom([agentWith("--force"), agentWith("-x")], ROOT);
  assert.deepEqual(sessions.map((s) => [s.id, s.unreadableId]), [[undefined, true], [undefined, true]]);
  const plan = planCleanup({ worktrees: [main, wt("issue-7-x")], sessions, prs: [merged("issue-7-x")] });
  assert.deepEqual(stopsOrRemoves(plan), []);
});

test("edge: sessionsFrom marks an empty id unreadable", () => {
  assert.deepEqual(sessionsFrom([agentWith("")], ROOT).map((s) => [s.id, s.unreadableId]), [[undefined, true]]);
});

test("edge: sessionsFrom marks a non-string id unreadable", () => {
  const sessions = sessionsFrom([agentWith(7), agentWith(null), agentWith(undefined), agentWith(["s7"])], ROOT);
  assert.equal(sessions.length, 4);
  assert.ok(sessions.every((s) => s.unreadableId === true && s.id === undefined));
});

test("edge: sessionsFrom marks ids with spaces, slashes, dots or a trailing newline unreadable, and keeps a valid neighbour", () => {
  const ids = ["a b", "a/b", "a.b", "s7\n", "_x", "ok"];
  const sessions = sessionsFrom(ids.map(agentWith), ROOT);
  assert.deepEqual(sessions.filter((s) => !s.unreadableId).map((s) => s.id), ["ok"]);
  assert.equal(sessions.filter((s) => s.unreadableId).length, 5);
});

test("edge: an unreadable-id session keeps its cwd, issue, status, state and pid; a valid one has no unreadableId", () => {
  const [bad, good] = sessionsFrom([{ ...agentWith("-x"), status: "busy", pid: 41 }, agentWith("s7")], ROOT);
  assert.deepEqual(bad, { unreadableId: true, cwd: "C:/repo/.claude/worktrees/issue-7-x", issue: 7, status: "busy", state: "idle", pid: 41 });
  assert.equal("unreadableId" in good, false);
});

test("edge: sessionsFrom still drops a malformed-id session outside the repo, a non-background one, or one with no cwd", () => {
  const agents = [
    { ...agentWith("-x"), cwd: "D:/elsewhere/issue-7-x" },
    { ...agentWith("-x"), kind: "foreground" },
    { ...agentWith("-x"), cwd: undefined },
  ];
  assert.deepEqual(sessionsFrom(agents, ROOT), []);
});

// #209: a session dropped for a malformed id was invisible, so a merged worktree it sat in had no "session is in it" skip.
test("a merged, clean worktree holding a session with a malformed id is skipped, with no claude stop or claude rm", () => {
  const sessions = sessionsFrom([agentWith("--force")], ROOT);
  const plan = planCleanup({ worktrees: [main, wt("issue-7-x")], sessions, prs: [merged("issue-7-x")] });
  assert.deepEqual(plan, [{ branch: "issue-7-x", issue: 7, skip: UNREADABLE }]);
  assert.equal(cleanableCount(plan), 0);
});

test("a worktree that also holds a valid idle session is not removed either: the unreadable one may still be in it", () => {
  const sessions = sessionsFrom([agentWith("s7"), agentWith("-x")], ROOT);
  const plan = planCleanup({ worktrees: [main, wt("issue-7-x")], sessions, prs: [merged("issue-7-x")] });
  assert.deepEqual(plan.map((e) => e.skip), [UNREADABLE]);
  assert.deepEqual(stopsOrRemoves(plan), []);
});

test("an unreadable-id session skips its worktree even when its process is dead or its status is idle", () => {
  const plan = planCleanup({ worktrees: [main, wt("issue-7-x")], sessions: [{ unreadableId: true, cwd: `${ROOT}/.claude/worktrees/issue-7-x`, issue: 7, status: "idle", pid: 41, alive: false }], prs: [merged("issue-7-x")] });
  assert.equal(plan[0].skip, UNREADABLE);
});

test("edge: an unreadable-id session in one lane's worktree does not stop another lane's cleanup", () => {
  const sessions = sessionsFrom([agentWith("-x"), { ...agentWith("s8"), cwd: "C:/repo/.claude/worktrees/issue-8-y" }], ROOT);
  const plan = planCleanup({ worktrees: [main, wt("issue-7-x"), wt("issue-8-y")], sessions, prs: [merged("issue-7-x"), merged("issue-8-y", { number: 91 })] });
  assert.deepEqual(plan.map((e) => [e.branch, e.skip]), [["issue-7-x", UNREADABLE], ["issue-8-y", undefined]]);
  assert.deepEqual(stopsOrRemoves(plan), ["claude rm s8"]);
});

test("edge: an unreadable-id session whose worktree is gone is skipped, never removed", () => {
  const sessions = sessionsFrom([agentWith("-x")], ROOT);
  const plan = planCleanup({ worktrees: [main], sessions, prs: [merged("issue-7-x")] });
  assert.deepEqual(plan, [{ branch: null, issue: 7, skip: UNREADABLE }]);
});

test("edge: a worktree with a working session and an unreadable one is skipped either way, never planned", () => {
  const sessions = sessionsFrom([{ ...agentWith("s7"), status: "busy" }, agentWith("-x")], ROOT);
  const [entry] = planCleanup({ worktrees: [main, wt("issue-7-x")], sessions, prs: [merged("issue-7-x")] });
  assert.equal(entry.steps, undefined);
  assert.ok(entry.skip);
});

test("edge: an unreadable-id session keeps an unmerged lane's skip reason", () => {
  const sessions = sessionsFrom([agentWith("-x")], ROOT);
  assert.deepEqual(planCleanup({ worktrees: [main, wt("issue-7-x")], sessions, prs: [] }), [{ branch: "issue-7-x", issue: 7, skip: "not merged" }]);
});

test("edge: an empty orphan folder holding an unreadable-id session is left in place", () => {
  const orphan = { path: `${ROOT}/.claude/worktrees/issue-7-x`, files: 0 };
  const sessions = sessionsFrom([agentWith("-x")], ROOT);
  const plan = planCleanup({ worktrees: [main], sessions, prs: [], orphans: [orphan] });
  assert.deepEqual(plan.find((e) => e.orphan), { branch: null, issue: null, orphan: orphan.path, skip: UNREADABLE });
});

test("edge: planCleanup itself refuses a raw session whose id is unsafe, so the guarantee does not rest on sessionsFrom", () => {
  const raw = [{ id: "--force", cwd: `${ROOT}/.claude/worktrees/issue-7-x`, issue: 7, state: "idle" }];
  const plan = planCleanup({ worktrees: [main, wt("issue-7-x")], sessions: raw, prs: [merged("issue-7-x")] });
  assert.deepEqual(plan.map((e) => e.skip), [UNREADABLE]);
  assert.deepEqual(stopsOrRemoves(plan), []);
});

test("render names an unreadable-id skip like any other skip", () => {
  const plan = planCleanup({ worktrees: [main, wt("issue-7-x")], sessions: sessionsFrom([agentWith("-x")], ROOT), prs: [merged("issue-7-x")] });
  assert.match(render(runCleanup(plan, { run: () => "", stillThere: () => true })), new RegExp(`skipped issue-7-x.*: ${UNREADABLE}`));
});

// #209: the session-id pattern is defined once, in cleanup.mjs, and everything else uses that one.
test("SESSION_ID accepts plain names and rejects flags, empties and punctuation", () => {
  for (const id of ["s7", "A_b-9", "0", "a"]) assert.ok(SESSION_ID.test(id), id);
  for (const id of ["", "-x", "--force", "_x", "a b", "a/b", "a.b", "s7\n"]) assert.ok(!SESSION_ID.test(id), JSON.stringify(id));
});

test("the session-id pattern is written out once across cleanup.mjs and reap.mjs", () => {
  const literal = "[A-Za-z0-9][A-Za-z0-9_-]*";
  const count = (file) => readFileSync(new URL(file, import.meta.url), "utf8").split(literal).length - 1;
  assert.equal(count("./cleanup.mjs"), 1);
  assert.equal(count("./reap.mjs"), 0);
});

// CLAIMED is built from SESSION_ID.source with its anchors sliced off, which only works for this plain form.
test("edge: SESSION_ID stays a plain anchored pattern with no flags, so CLAIMED can be built from its source", () => {
  assert.equal(SESSION_ID.flags, "");
  assert.match(SESSION_ID.source, /^\^[^|^$]*\$$/);
});

test("the CLAIMED capture takes the claimant id by SESSION_ID: a valid id is captured, a flag-like one is not", () => {
  const plan = () => [{ branch: "issue-7-x", issue: 7, pr: 90, steps: [{ cmd: "claude", args: ["rm", "s7"] }] }];
  for (const [claimant, expected] of [["x9", "claude rm x9"], ["-x9", undefined]]) {
    const ran = [];
    const run = (cmd, args) => {
      ran.push(`${cmd} ${args.join(" ")}`);
      if (ran.length === 1) throw Object.assign(new Error("fail"), { stderr: `Another running background session (${claimant}) claims this worktree` });
      return "";
    };
    runCleanup(plan(), { run, stillThere: () => true, sessionEnded: () => true });
    assert.equal(ran.includes("claude rm x9") || ran.includes("claude rm -x9"), expected !== undefined, `${claimant}: ${ran.join("; ")}`);
  }
});

// #209: cleanup.mjs runs dozens of git, gh and claude commands per removal; none may open a console window on Windows.
test("shOptions sets windowsHide, and a caller's options cannot switch it off", () => {
  assert.equal(shOptions().windowsHide, true);
  assert.equal(shOptions({ cwd: "/r" }).cwd, "/r");
  assert.equal(shOptions({ windowsHide: false }).windowsHide, true);
});

test("edge: shOptions keeps the output capture, timeout and buffer cleanup relies on", () => {
  const options = shOptions();
  assert.equal(options.encoding, "utf8");
  assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
  assert.equal(options.timeout, 60_000);
  assert.ok(options.maxBuffer >= 1024 * 1024);
});

test("edge: shOptions lets a caller set its own timeout", () => {
  assert.equal(shOptions({ timeout: 5 }).timeout, 5);
});

// The text of each execFileSync, spawnSync or spawn call in a source file, from the name to its closing parenthesis.
function processCalls(source) {
  const code = source.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n");
  const calls = [];
  for (const m of code.matchAll(/\b(execFileSync|spawnSync|spawn)\(/g)) {
    let depth = 0;
    let end = m.index + m[0].length - 1;
    for (; end < code.length; end++) {
      if (code[end] === "(") depth++;
      else if (code[end] === ")" && --depth === 0) break;
    }
    calls.push(code.slice(m.index, end + 1));
  }
  return calls;
}

test("no execFileSync, spawnSync or spawn call in cleanup.mjs or reap.mjs runs without windowsHide: true", () => {
  for (const file of ["./cleanup.mjs", "./reap.mjs"]) {
    const calls = processCalls(readFileSync(new URL(file, import.meta.url), "utf8"));
    assert.ok(calls.length >= 1, `${file} has process calls`);
    for (const call of calls) assert.match(call, /windowsHide: true|,\s*(shOptions|runOptions)\([^()]*\)\s*\)$/, `${file}: ${call.slice(0, 80)}`);
  }
});

test("edge: the sh runner the default deps use builds its execFileSync options through shOptions", () => {
  const source = readFileSync(new URL("./cleanup.mjs", import.meta.url), "utf8");
  assert.match(source, /const sh = \(cmd, args, opts\) => execFileSync\(cmd, args, shOptions\(opts\)\);/);
});

test("edge: the call scanner flags a call left without windowsHide", () => {
  const bad = processCalls('const a = execFileSync("git", ["x"], { encoding: "utf8" });\nspawn("node", []);');
  assert.equal(bad.length, 2);
  assert.ok(bad.every((c) => !/windowsHide/.test(c)));
});

test("edge: the call scanner reads a multi-line call, and skips comments and the import line", () => {
  const src = '// execFileSync(\nimport { execFileSync } from "node:child_process";\nexecFileSync("git", [\n  "a",\n], {\n  windowsHide: true,\n});';
  const calls = processCalls(src);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /windowsHide: true/);
});

test("sessionsFrom keeps a session whose cwd is the repository root, with no issue", () => {
  for (const cwd of ["C:/repo", "C:\\repo", "c:/repo/"]) {
    const [s, ...rest] = sessionsFrom([{ kind: "background", id: "s1", cwd, status: "busy", state: "working" }], ROOT);
    assert.equal(rest.length, 0, cwd);
    assert.deepEqual({ id: s.id, issue: s.issue, cwd: s.cwd }, { id: "s1", issue: null, cwd });
  }
  assert.deepEqual(sessionsFrom([{ kind: "background", id: "s2", cwd: "C:/repo-other" }], ROOT), [], "a sibling folder is not the root");
});

test("planCleanup leaves a session at the repository root alone", () => {
  const sessions = sessionsFrom([{ kind: "background", id: "s1", cwd: ROOT, status: "busy", state: "working" }], ROOT);
  const worktrees = [{ path: ROOT, branch: "main", head: HEAD, main: true, dirty: false }];
  assert.deepEqual(planCleanup({ worktrees, sessions }), []);
});

test("loadCleanupInputs reads git, gh and claude only through the injected run", () => {
  const calls = [];
  const run = (cmd, args) => {
    calls.push(cmd);
    if (cmd === "git" && args[0] === "worktree") return `worktree ${ROOT}\nHEAD ${HEAD}\nbranch refs/heads/main\n`;
    if (cmd === "git") return "";
    if (cmd === "gh") return "[]";
    if (cmd === "claude") return JSON.stringify([{ kind: "background", id: "s1", cwd: ROOT, status: "busy", state: "working" }]);
    throw new Error(`unexpected ${cmd}`);
  };
  const inputs = loadCleanupInputs(ROOT, run);
  assert.equal(inputs.root, ROOT);
  assert.equal(inputs.worktrees.length, 1);
  assert.equal(inputs.sessions.length, 1);
  assert.deepEqual([...new Set(calls)].sort(), ["claude", "gh", "git"]);
});

test("edge: loadCleanupInputs finds the repository root through the injected run when none is given", () => {
  const seen = [];
  const run = (cmd, args) => {
    seen.push(args[0]);
    if (args[0] === "rev-parse") return `${ROOT}/.git\n`;
    if (args[0] === "worktree") return "";
    if (cmd === "git") return "";
    if (cmd === "gh") return "[]";
    return "[]";
  };
  assert.equal(loadCleanupInputs(undefined, run).root, ROOT);
  assert.ok(seen.includes("rev-parse"));
});

test("cleanupMerged with only a run injected reads every input through it", () => {
  const seen = new Set();
  const run = (cmd, args) => {
    seen.add(cmd);
    if (args[0] === "rev-parse") return `${ROOT}/.git\n`;
    if (args[0] === "worktree") return `worktree ${ROOT}\nHEAD ${HEAD}\nbranch refs/heads/main\n`;
    if (cmd === "git") return "";
    return "[]";
  };
  assert.doesNotThrow(() => cleanupMerged({ dryRun: true, deps: { run } }));
  assert.deepEqual([...seen].sort(), ["claude", "gh", "git"]);
});

test("edge: loadCleanupInputs lets an injected run's failure through", () => {
  assert.throws(() => loadCleanupInputs(ROOT, () => { throw new Error("gh down"); }), /gh down/);
});

// Lane cost (#243): each removed session's token usage is recorded before it is stopped or removed.
const costTranscript = (id, out) => JSON.stringify({ message: { id, role: "assistant", model: "claude-opus-5-5", usage: { input_tokens: 1, output_tokens: out, cache_read_input_tokens: 2, cache_creation_input_tokens: 3 } } });

test("recordCost runs once per session, after its log and before it is stopped or removed", () => {
  const plan = planCleanup({ worktrees: [main, wt("issue-7-x", aliveLock)], sessions: [aliveIdle()], prs: [merged("issue-7-x")] });
  const order = [];
  runCleanup(plan, {
    run: (cmd, args) => order.push(`${cmd} ${args.join(" ")}`),
    stillThere: () => true,
    saveLog: (id) => (order.push(`save ${id}`), ".lanes/logs/x.txt"),
    recordCost: (id, issue) => order.push(`cost ${id} ${issue}`),
  });
  assert.deepEqual(order.slice(0, 4), ["save s7", "cost s7 7", "claude stop s7", "claude rm s7"]);
  assert.equal(order.filter((o) => o.startsWith("cost")).length, 1);
});

test("edge: a cost that cannot be recorded is reported and the session is still removed", () => {
  const plan = planCleanup({ worktrees: [main], sessions: [session("s7", "issue-7-x", { status: "idle" })], prs: [merged("issue-7-x")] });
  const ran = [];
  const recordCost = () => {
    throw new Error("EACCES: permission denied");
  };
  const results = runCleanup(plan, { run: (cmd, args) => ran.push(`${cmd} ${args.join(" ")}`), stillThere: () => true, recordCost });
  assert.deepEqual(ran, ["claude rm s7"]);
  assert.equal(render(results), "removed #7 session (PR #90): cost not recorded (EACCES: permission denied); claude rm s7");
});

test("edge: a claimant session removed to clear a claim has its cost recorded too", () => {
  const { run } = claimedRun("x9");
  const recorded = [];
  const [result] = runCleanup(claimedPlan(), { run, stillThere: () => true, sessionEnded: () => true, recordCost: (id) => recorded.push(id) });
  assert.equal(result.status, "removed");
  assert.deepEqual(recorded, ["s7", "x9"]);
});

test("sessionsFrom keeps a session's transcript id and launch time", () => {
  const [s] = sessionsFrom([{ id: "s7", kind: "background", cwd: `${ROOT}/.claude/worktrees/issue-7-x`, sessionId: "uuid-1", startedAt: 1000 }], ROOT);
  assert.equal(s.sessionId, "uuid-1");
  assert.equal(s.startedAt, 1000);
  const [bare] = sessionsFrom([{ id: "s8", kind: "background", cwd: `${ROOT}/.claude/worktrees/issue-8-x`, sessionId: 5, startedAt: "x" }], ROOT);
  assert.equal("sessionId" in bare || "startedAt" in bare, false);
});

const costFixture = () => {
  const dir = mkdtempSync(join(tmpdir(), "cleanup-cost-"));
  const home = join(dir, "home");
  const root = join(dir, "repo");
  const folder = join(home, ".claude", "projects", root.replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(folder, { recursive: true });
  mkdirSync(root, { recursive: true });
  const inputs = { root, sessions: [{ id: "s7", sessionId: "uuid-7", startedAt: Date.UTC(2026, 8, 1) }, { id: "s8", sessionId: "uuid-8" }], issues: [{ number: 7, state: "CLOSED", labels: [{ name: "ready" }, { name: "tier:full" }] }] };
  return { dir, home, root, folder, inputs };
};
const costLines = (root) => readFileSync(join(root, ".lanes", "costs.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("recordSessionCost appends the lane's tokens, tier and times to .lanes/costs.jsonl, with no path or text", () => {
  const f = costFixture();
  try {
    writeFileSync(join(f.folder, "uuid-7.jsonl"), [costTranscript("a", 10), costTranscript("a", 12), "not json"].join("\n"));
    recordSessionCost("s7", 7, f.inputs, { home: f.home, now: () => Date.UTC(2026, 8, 2) });
    const [line] = costLines(f.root);
    assert.deepEqual(line, {
      issue: 7, tier: "full", sessionId: "uuid-7", model: "claude-opus-5-5",
      launchedAt: "2026-09-01T00:00:00.000Z", removedAt: "2026-09-02T00:00:00.000Z",
      tokens: { input: 1, output: 12, cacheRead: 2, cacheCreation: 3, total: 18 },
    });
    assert.ok(!JSON.stringify(line).includes("cleanup-cost-"));
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("recordSessionCost with a missing transcript writes tokens null and a reason, and does not throw", () => {
  const f = costFixture();
  try {
    recordSessionCost("s8", 8, f.inputs, { home: f.home });
    const [line] = costLines(f.root);
    assert.equal(line.tokens, null);
    assert.equal(line.reason, "transcript not found");
    assert.equal(line.tier, null);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("cleanupMerged records a cost line for each removed session and still removes the lane", () => {
  const f = costFixture();
  try {
    const inputs = { ...f.inputs, worktrees: [main, wt("issue-7-x")], prs: [merged("issue-7-x")], sessions: [session("s7", "issue-7-x", { status: "idle", sessionId: "no-such-uuid" })] };
    const lines = cleanupMerged({ deps: { load: () => inputs, run: () => "", stillThere: () => true, saveLog: () => ".lanes/logs/x.txt" } });
    assert.match(lines[0], /^removed issue-7-x/);
    const [line] = costLines(f.root);
    assert.equal(line.issue, 7);
    assert.equal(line.tier, "full");
    assert.equal(line.reason, "transcript not found");
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

// --- #361 (ADR 0014): the lane:running label comes off when the lane is removed. ---

test("runCleanup removes lane:running from the issue of each removed lane, and not from a skipped one", () => {
  const plan = planCleanup({ worktrees: [main, wt("issue-7-x"), wt("issue-8-y")], sessions: [], prs: [merged("issue-7-x"), { ...merged("issue-8-y"), state: "OPEN" }] });
  const unmarked = [];
  const results = runCleanup(plan, { run: () => {}, stillThere: () => true, unmark: (n) => unmarked.push(n) });
  assert.deepEqual(unmarked, [7]);
  assert.equal(results[0].status, "removed");
});

test("edge: a label removal that fails is reported and the lane is still removed", () => {
  const plan = planCleanup({ worktrees: [main, wt("issue-7-x")], sessions: [], prs: [merged("issue-7-x")] });
  const [r] = runCleanup(plan, { run: () => {}, stillThere: () => true, unmark: () => { throw Object.assign(new Error("x"), { stderr: "HTTP 502\nmore" }); } });
  assert.equal(r.status, "removed");
  assert.ok(r.ran.includes("lane:running not removed (HTTP 502)"), r.ran.join("; "));
});

test("edge: an orphan folder has no issue, so no label is touched", () => {
  const plan = planCleanup({ worktrees: [main], sessions: [], prs: [], orphans: [{ path: `${ROOT}/.claude/worktrees/issue-9-z`, files: 0 }] });
  const unmarked = [];
  runCleanup(plan, { run: () => {}, stillThere: () => true, removeDir: () => {}, unmark: (n) => unmarked.push(n) });
  assert.deepEqual(unmarked, []);
});

// --- #382: the dirty and unpushed checks and the removal steps queue.mjs reuses to recover a stalled lane. ---

const fakeGit = ({ status = "", unpushed = "0", failStatus = false, failCount = false } = {}) => (cmd, args) => {
  if (args.includes("status")) {
    if (failStatus) throw new Error("git status failed");
    return status;
  }
  if (args[0] === "rev-list") {
    if (failCount) throw new Error("bad ref");
    return `${unpushed}\n`;
  }
  return "";
};

test("#382: laneWorkLeft: a clean, fully pushed worktree has no work left", async () => {
  const { laneWorkLeft } = await import("./cleanup.mjs");
  assert.equal(laneWorkLeft("/w/issue-5-x", "issue-5-x", fakeGit()), null);
});

test("#382: laneWorkLeft: uncommitted changes and unpushed commits are named", async () => {
  const { laneWorkLeft } = await import("./cleanup.mjs");
  assert.match(laneWorkLeft("/w", "issue-5-x", fakeGit({ status: " M a.mjs\n" })), /uncommitted/);
  assert.equal(laneWorkLeft("/w", "issue-5-x", fakeGit({ unpushed: "2" })), "2 commits not on any remote");
  assert.equal(laneWorkLeft("/w", "issue-5-x", fakeGit({ unpushed: "1" })), "1 commit not on any remote");
});

test("#382: edge: laneWorkLeft treats unreadable status or commit counts as work left", async () => {
  const { laneWorkLeft } = await import("./cleanup.mjs");
  assert.match(laneWorkLeft("/w", "b", fakeGit({ failStatus: true })), /cannot read/);
  assert.match(laneWorkLeft("/w", "b", fakeGit({ failCount: true })), /cannot read/);
  assert.match(laneWorkLeft("/w", "b", fakeGit({ unpushed: "abc" })), /cannot read/);
});

test("#382: removeLaneWorktree: claude rm, git worktree remove, git branch -D, never forced", async () => {
  const { removeLaneWorktree } = await import("./cleanup.mjs");
  const log = [];
  removeLaneWorktree({ id: "s1", path: "/w/issue-5-x", branch: "issue-5-x" }, (cmd, args) => log.push([cmd, ...args]));
  assert.deepEqual(log, [["claude", "rm", "s1"], ["git", "worktree", "remove", "/w/issue-5-x"], ["git", "branch", "-D", "issue-5-x"]]);
});

test("#382: edge: removeLaneWorktree stops at the first failing step", async () => {
  const { removeLaneWorktree } = await import("./cleanup.mjs");
  const log = [];
  const run = (cmd, args) => { log.push(args[0]); if (args[0] === "worktree") throw new Error("busy"); };
  assert.throws(() => removeLaneWorktree({ id: "s1", path: "/w", branch: "b" }, run), /busy/);
  assert.deepEqual(log, ["rm", "worktree"]);
});

const noJob = (id) => Object.assign(new Error("Command failed"), { stderr: `No job matching '${id}'\n` });
const stopPlan = () => planCleanup({ worktrees: [wt("issue-7-x")], sessions: [session("s7", "issue-7-x", { alive: true })], prs: [merged("issue-7-x")] });

test("#399: a session gone between plan and stop counts as already stopped and the lane's later steps run", () => {
  const ran = [];
  const run = (cmd, args) => {
    ran.push(`${cmd} ${args[0]}`);
    if (cmd === "claude") throw noJob("s7");
  };
  const [r] = runCleanup(stopPlan(), { run, stillThere: () => true });
  assert.equal(r.status, "removed");
  assert.ok(ran.includes("git worktree") && ran.includes("git branch"));
  assert.deepEqual(r.already, ["session"]);
  assert.match(render([r]), /removed issue-7-x \(PR #90\): .*session already removed/);
});

test("#399: a worktree folder gone before removal is already removed, not a failure", () => {
  const plan = planCleanup({ worktrees: [wt("issue-7-x", { gone: true })], sessions: [], prs: [merged("issue-7-x")] });
  assert.ok(plan[0].steps, "a vanished folder is not skipped as unreadable");
  const ran = [];
  const [r] = runCleanup(plan, { run: (cmd, args) => ran.push(`${cmd} ${args.join(" ")}`), stillThere: (o) => !o.path });
  assert.equal(r.status, "removed");
  assert.deepEqual(ran, ["git worktree prune", "git branch -D issue-7-x"]);
  assert.deepEqual(r.already, ["worktree"]);
});

test("#399: a branch already deleted is already removed", () => {
  const plan = planCleanup({ worktrees: [wt("issue-7-x")], sessions: [], prs: [merged("issue-7-x")] });
  const [r] = runCleanup(plan, { run: () => {}, stillThere: (o) => !o.branch });
  assert.equal(r.status, "removed");
  assert.deepEqual(r.already, ["branch"]);
});

test("#399: session, worktree and branch all gone reads as done by someone else", () => {
  const run = (cmd) => {
    if (cmd === "claude") throw noJob("s7");
  };
  const [r] = runCleanup(stopPlan(), { run, stillThere: () => false });
  assert.equal(render([r]), "removed issue-7-x (PR #90): session, worktree and branch already removed");
});

test("#399: a real claude stop failure is still reported and stops the lane", () => {
  const run = (cmd) => {
    if (cmd === "claude") throw Object.assign(new Error("x"), { stderr: "permission denied\n" });
    assert.fail("later steps must not run");
  };
  const [r] = runCleanup(stopPlan(), { run, stillThere: () => true });
  assert.equal(r.status, "failed");
  assert.match(render([r]), /^failed issue-7-x \(PR #90\) at claude stop s7: permission denied/);
});

test("edge: a worktree and branch missing after our own claude rm are not reported as already removed", () => {
  const plan = planCleanup({ worktrees: [wt("issue-7-x")], sessions: [session("s7", "issue-7-x")], prs: [merged("issue-7-x")] });
  const [r] = runCleanup(plan, { run: () => {}, stillThere: () => false });
  assert.equal(r.already, undefined);
});

test("edge: a gone worktree with unpushed work on a closed issue is still skipped, and a dirty one stays dirty", () => {
  const closed = { number: 7, state: "CLOSED" };
  const [a] = planCleanup({ worktrees: [wt("issue-7-x", { gone: true, unpushed: 2 })], issues: [closed] });
  assert.match(a.skip, /not on any remote/);
  const [b] = planCleanup({ worktrees: [wt("issue-7-x", { dirty: true })], prs: [merged("issue-7-x")] });
  assert.equal(b.skip, "dirty worktree");
});

test("edge: parseWorktrees marks a prunable entry gone, and loadCleanupInputs reads a missing unreadable folder as gone", () => {
  const list = `worktree ${ROOT}\nHEAD ${HEAD}\nbranch refs/heads/main\n\nworktree ${ROOT}/.claude/worktrees/issue-7-x\nHEAD ${HEAD}\nbranch refs/heads/issue-7-x\nprunable gone\n`;
  assert.equal(parseWorktrees(list)[1].gone, true);
  const run = (cmd, args) => {
    if (cmd === "git" && args[0] === "worktree") return list;
    if (cmd === "git" && args[0] === "-C") throw new Error("cannot chdir");
    if (cmd === "git" && args[0] === "for-each-ref") return "";
    if (cmd === "git") return "0";
    return "[]";
  };
  const lane = loadCleanupInputs(ROOT, run).worktrees.find((w) => w.branch === "issue-7-x");
  assert.equal(lane.gone, true);
  assert.equal(lane.dirty, false);
});

test("argsOutcome: --help and -h stop with the usage and exit 0", () => {
  for (const argv of [["--help"], ["-h"], ["--dry-run", "--help"], ["--bogus", "-h"]]) assert.deepEqual(argsOutcome(argv), { code: 0, stdout: USAGE });
});

test("argsOutcome: an unknown argument exits 2 naming it, with the usage", () => {
  for (const [argv, name] of [[["--dryrun"], "--dryrun"], [["--dry-run", "extra"], "extra"], [["-x"], "-x"], [[""], ""]]) {
    assert.deepEqual(argsOutcome(argv), { code: 2, stderr: `unknown argument: ${name}\n${USAGE}` }, JSON.stringify(argv));
  }
});

test("argsOutcome: no argument and --dry-run let the cleanup run", () => {
  assert.equal(argsOutcome([]), null);
  assert.equal(argsOutcome(["--dry-run"]), null);
});

// The CLI itself: both refusals return before loadCleanupInputs, so no git, gh or claude command runs.
test("cleanup.mjs --help and an unknown flag run no git, gh or claude command", () => {
  const script = fileURLToPath(new URL("./cleanup.mjs", import.meta.url));
  const help = spawnSync(process.execPath, [script, "--help"], { encoding: "utf8", env: { ...process.env, PATH: "" } });
  assert.equal(help.status, 0);
  assert.equal(help.stdout.trim(), USAGE);
  const bad = spawnSync(process.execPath, [script, "--force"], { encoding: "utf8", env: { ...process.env, PATH: "" } });
  assert.equal(bad.status, 2);
  assert.equal(bad.stderr.trim(), `unknown argument: --force\n${USAGE}`);
  assert.equal(bad.stdout, "");
});
