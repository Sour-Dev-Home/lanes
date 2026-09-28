import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { GIVE_UP_FAILURES, GIVE_UP_MS, reapTick } from "./reap.mjs";

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
  assert.equal(tick({ issueState: "CLOSED", sessions: [lane({ cwd: "/home/u/repo/.claude/worktrees/issue-7-x/scripts/" })] }).action, "remove");
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
