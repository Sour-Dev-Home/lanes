// scripts/lanes/reap.mjs
// One lane's reaper (ADR 0010): each poll it reads the issue, its `issue-N-*` PRs and the lane's session, and
// `reapTick` says whether to wait, remove the lane (through cleanup.mjs's own logic), or give up and leave it for the
// next /start or /health. This file holds only the pure decision so far; the poll loop and lock come later.

// The ADR's defaults, which the owner may tune without another ADR.
export const GIVE_UP_MS = 48 * 60 * 60 * 1000;
export const GIVE_UP_FAILURES = 3;

// The same patterns as cleanup.mjs: a lane's branch is `issue-<N>-<slug>`, its worktree folder `issue-<N>[-<slug>]`.
const LANE_BRANCH = /^issue-(\d+)-./;
const LANE_FOLDER = /^issue-(\d+)(?:-.*)?$/;

// As in cleanup.mjs: `status` says whether a session is running now; `state` can keep saying "working" after it
// stopped (#83), so it only counts when there is no status this script knows.
const stillWorking = (s) => (s.status === "idle" ? false : s.status === "busy" ? true : s.state === "working");

// The issue number of the first lane-folder segment in a session's cwd, or null.
const cwdIssue = (cwd) =>
  Number(
    cwd
      .split(/[\\/]+/)
      .map((seg) => LANE_FOLDER.exec(seg)?.[1])
      .find(Boolean),
  ) || null;

const time = (v, name) => {
  const ms = v instanceof Date ? v.getTime() : v;
  if (typeof ms !== "number" || !Number.isFinite(ms)) throw new TypeError(`reapTick: ${name} must be a time in ms or a Date`);
  return ms;
};

/**
 * What the reaper does on one poll. Pure: no I/O, and the input is not changed.
 * @param {object} input
 * @param {number} input.issue the lane's issue number
 * @param {string} input.session the lane's session id
 * @param {"OPEN"|"CLOSED"|null} input.issueState the issue's state; null or undefined when it could not be read
 * @param {{ number: number, state: "OPEN"|"MERGED"|"CLOSED", headRefName: string }[] | null} input.prs PRs to look
 *   through (any others than `issue-<issue>-*` heads are ignored); null or undefined when they could not be read
 * @param {{ id: string, cwd?: string, status?: string, state?: string }[] | null} input.sessions background sessions
 *   (`claude agents --json` entries or cleanup.mjs's `sessionsFrom`); null or undefined when they could not be read
 * @param {number|Date} input.startedAt when the reaper started
 * @param {number|Date} input.now this poll's time
 * @param {number} [input.failures] consecutive polls whose reads failed, counting this one; default 0
 * @returns {{ action: "wait"|"remove"|"give-up", reason: string }}
 *   give-up at `GIVE_UP_MS` or `GIVE_UP_FAILURES`, or when the session is gone or its cwd is not an `issue-<issue>`
 *   worktree; otherwise wait while anything is unread, a lane PR is open, the issue is open with no merged lane PR,
 *   or the session is busy; otherwise remove (a lane PR merged or the issue closed, and the session is not busy).
 * @throws {TypeError} on a malformed issue, session, time or failure count
 */
export function reapTick({ issue, session, issueState, prs, sessions, startedAt, now, failures = 0 } = {}) {
  if (!Number.isInteger(issue) || issue < 1) throw new TypeError("reapTick: issue must be a positive integer");
  if (typeof session !== "string" || session === "") throw new TypeError("reapTick: session must be a non-empty string");
  if (!Number.isInteger(failures) || failures < 0) throw new TypeError("reapTick: failures must be a non-negative integer");
  const age = time(now, "now") - time(startedAt, "startedAt");

  if (failures >= GIVE_UP_FAILURES) return { action: "give-up", reason: `${failures} consecutive failed polls` };
  if (age >= GIVE_UP_MS) return { action: "give-up", reason: `still not done after ${GIVE_UP_MS / 3_600_000} hours` };
  if (sessions == null) return { action: "wait", reason: "session list not read" };

  // A mismatched or missing target session is a give-up on its own (ADR 0010's correctness check against a
  // mismatched pair), so it outranks an issue state or PR list that could not be read: those never make the pair
  // any less wrong.
  const target = sessions.find((s) => s?.id === session);
  if (!target) return { action: "give-up", reason: `session ${session} not found` };
  if (typeof target.cwd !== "string" || cwdIssue(target.cwd) !== issue) {
    return { action: "give-up", reason: `session ${session}'s cwd is not an issue-${issue} worktree` };
  }

  if (issueState == null) return { action: "wait", reason: "issue state not read" };
  if (prs == null) return { action: "wait", reason: "PR list not read" };

  const lanePrs = prs.filter((p) => Number(LANE_BRANCH.exec(p?.headRefName ?? "")?.[1]) === issue);
  const open = lanePrs.find((p) => p.state === "OPEN");
  if (open) return { action: "wait", reason: `PR #${open.number} is open` };
  const merged = lanePrs.find((p) => p.state === "MERGED");
  if (!merged && issueState !== "CLOSED") return { action: "wait", reason: `issue #${issue} is open` };
  const done = merged ? `PR #${merged.number} merged` : `issue #${issue} closed`;
  if (stillWorking(target)) return { action: "wait", reason: `${done}; session ${session} is busy` };
  return { action: "remove", reason: `${done}; session ${session} is not busy` };
}
