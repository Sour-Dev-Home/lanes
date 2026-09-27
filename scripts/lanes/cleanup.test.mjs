import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanableCount, formatStep, parseWorktrees, planCleanup, render, runCleanup } from "./cleanup.mjs";

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
    { path: "C:/repo/.claude/worktrees/issue-7-x", branch: "issue-7-x", head: HEAD, main: false },
    { path: "C:/repo/d", branch: null, head: HEAD, main: false },
  ]);
  assert.deepEqual(parseWorktrees(""), []);
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
