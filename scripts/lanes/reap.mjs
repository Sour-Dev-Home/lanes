// scripts/lanes/reap.mjs
// One lane's reaper (ADR 0010): each poll it reads the issue, its `issue-N-*` PRs and the lane's session, and
// `reapTick` says whether to wait, remove the lane (through cleanup.mjs's own logic), or give up and leave it for the
// next /start or /health. One reaper per issue holds `.lanes/reap/<issue>.json` and logs to `.lanes/reap/<issue>.log`.
// Usage: node scripts/lanes/reap.mjs --issue N --session ID
// Exit: 0 removed (or another reaper already holds the lock), 1 gave up, 2 bad arguments.
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SESSION_ID, cleanupMerged, loadCleanupInputs, pidRunning, sessionsFrom } from "./cleanup.mjs";

// The ADR's defaults, which the owner may tune without another ADR.
export const GIVE_UP_MS = 48 * 60 * 60 * 1000;
export const GIVE_UP_FAILURES = 3;
export const POLL_MS = 5 * 60 * 1000;
// A lane starts at the repository root and only then enters its `issue-N` worktree (#201), so the reaper (spawned at
// launch) does not poll for FIRST_POLL_MS and, for STARTUP_GRACE_MS, waits for a session that is not listed yet or has
// not left the root. Past the grace, or for a session already in another issue's worktree, that is a give-up.
export const FIRST_POLL_MS = 60 * 1000;
export const STARTUP_GRACE_MS = 30 * 60 * 1000;

// The same patterns as cleanup.mjs: a lane's branch is `issue-<N>-<slug>`, its worktree folder `issue-<N>[-<slug>]`.
const LANE_BRANCH = /^issue-(\d+)-./;
const LANE_FOLDER = /^issue-(\d+)(?:-.*)?$/;

// As in cleanup.mjs: `status` says whether a session is running now; `state` can keep saying "working" after it
// stopped (#83), so it only counts when there is no status this script knows.
const stillWorking = (s) => (s.status === "idle" ? false : s.status === "busy" ? true : s.state === "working");

// The issue number of a session's lane folder, or null. The folder directly under the last `.claude/worktrees` in the
// cwd is the lane's worktree, whatever lane-shaped folders sit above it (the repo's own parent folders) or below it
// (the lane's own files); a cwd with no `.claude/worktrees` falls back to its first lane-shaped folder.
function cwdIssue(cwd) {
  const segs = cwd.split(/[\\/]+/);
  const at = segs.findLastIndex((seg, i) => seg === "worktrees" && segs[i - 1] === ".claude");
  const lane = (seg) => Number(LANE_FOLDER.exec(seg ?? "")?.[1]) || null;
  return at >= 0 ? lane(segs[at + 1]) : (segs.map(lane).find(Boolean) ?? null);
}

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
 * @param {{ id?: string, cwd?: string, status?: string, state?: string }[] | null} input.sessions background sessions
 *   (`claude agents --json` entries or cleanup.mjs's `sessionsFrom`); null or undefined when they could not be read
 * @param {number|Date} input.startedAt when the reaper started
 * @param {number|Date} input.now this poll's time
 * @param {number} [input.failures] consecutive polls whose reads failed, counting this one; default 0
 * @returns {{ action: "wait"|"remove"|"give-up", reason: string }}
 *   give-up at `GIVE_UP_MS` or `GIVE_UP_FAILURES`, or when the session's cwd is another issue's worktree; a session
 *   not listed yet or in no worktree yet (the repository root) waits for `STARTUP_GRACE_MS`, then gives up; otherwise wait while anything is unread, a lane PR is open, the issue is open with no merged lane PR,
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
  // any less wrong. A session in another issue's worktree is a mismatch at once; one not listed yet or not in any
  // worktree yet (the root) is only a give-up once the startup grace is over.
  const starting = age < STARTUP_GRACE_MS;
  const target = sessions.find((s) => s?.id === session);
  if (!target) {
    return starting ? { action: "wait", reason: `session ${session} is not listed yet` } : { action: "give-up", reason: `session ${session} not found` };
  }
  const at = typeof target.cwd === "string" ? cwdIssue(target.cwd) : null;
  if (at !== issue) {
    if (at === null && starting) return { action: "wait", reason: `session ${session} is not in an issue-${issue} worktree yet` };
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

const laneOf = (branch) => Number(LANE_BRANCH.exec(branch ?? "")?.[1]) || null;

/**
 * cleanup.mjs's inputs narrowed to one lane, so its planCleanup removes that lane and nothing else: other lanes'
 * branches and sessions and every orphan folder are dropped; non-lane worktrees stay, since planCleanup uses them to
 * place sessions and never removes them. The input is not changed.
 * @param {{ worktrees?: object[], sessions?: object[], orphans?: object[] }} inputs loadCleanupInputs's result
 * @param {number} issue
 */
export function laneInputs(inputs, issue) {
  return {
    ...inputs,
    worktrees: (inputs.worktrees ?? []).filter((w) => [null, issue].includes(laneOf(w.branch))),
    sessions: (inputs.sessions ?? []).filter((s) => s.issue === issue),
    orphans: [],
  };
}

// Everything below does I/O.

const USAGE = "usage: node scripts/lanes/reap.mjs --issue N --session ID";
// A lock older than any reaper can live is stale even if its pid now belongs to some other process.
const LOCK_MAX_AGE = GIVE_UP_MS + 2 * POLL_MS;

// `{ issue, session }` from exactly `--issue N --session ID` in either order, or null.
function parseArgs(argv) {
  if (argv.length !== 4) return null;
  const opts = {};
  for (let i = 0; i < 4; i += 2) {
    if (!["--issue", "--session"].includes(argv[i]) || argv[i] in opts) return null;
    opts[argv[i]] = argv[i + 1];
  }
  const issue = /^[1-9]\d*$/.test(opts["--issue"] ?? "") ? Number(opts["--issue"]) : NaN;
  if (!Number.isSafeInteger(issue) || !SESSION_ID.test(opts["--session"] ?? "")) return null;
  return { issue, session: opts["--session"] };
}

// One line, control characters out, so a log line stays one line.
const oneLine = (text) =>
  String(text)
    .split(/\r?\n|\r|\u2028|\u2029/)[0]
    .replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, "")
    .trim();
const errLine = (err) => oneLine(String(err?.stderr ?? "").trim() || err?.message || err);

function readLock(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// Writes the lock unless a live reaper holds it; `{ held }` names that reaper. A stale lock (malformed, its pid not
// running, or older than any reaper lives) is replaced.
function takeLock(file, lock, { isRunning, now }) {
  mkdirSync(dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, `${JSON.stringify(lock)}\n`, { flag: "wx" });
      return {};
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
    }
    const held = readLock(file);
    const started = Date.parse(held?.started);
    const live = Number.isInteger(held?.pid) && isRunning(held.pid) && Number.isFinite(started) && now - started < LOCK_MAX_AGE;
    if (live) return { held };
    rmSync(file, { force: true });
  }
  return { held: readLock(file) ?? {} };
}

// Removes the lock only while it is still this reaper's.
function releaseLock(file, lock) {
  const held = readLock(file);
  if (held?.pid === lock.pid && held?.session === lock.session && held?.started === lock.started) rmSync(file, { force: true });
}

// This poll's reads; each one that fails is null, with its error line in `errors`.
function readState({ issue, root, run }) {
  const errors = [];
  const read = (label, fn) => {
    try {
      return fn();
    } catch (err) {
      errors.push(`${label}: ${errLine(err)}`);
      return null;
    }
  };
  const issueState = read("gh issue view", () => {
    const state = String(run("gh", ["issue", "view", String(issue), "--json", "state", "--jq", ".state"])).trim();
    if (state !== "OPEN" && state !== "CLOSED") throw new Error(`unexpected state ${JSON.stringify(state.slice(0, 40))}`);
    return state;
  });
  const prs = read("gh pr list", () => {
    const list = JSON.parse(run("gh", ["pr", "list", "--state", "all", "--limit", "1000", "--json", "number,state,headRefName"]));
    if (!Array.isArray(list)) throw new Error("not a list");
    return list;
  });
  const sessions = read("claude agents", () => {
    const agents = JSON.parse(run("claude", ["agents", "--json"]));
    if (!Array.isArray(agents)) throw new Error("not a list");
    return sessionsFrom(agents, root);
  });
  return { issueState, prs, sessions, errors };
}

// Removes the one lane through cleanup.mjs: `{ removed }`, `{ skipped }` (cleanup's own rules refused it), or
// `{ failed }` (a step failed or the inputs could not be read).
function removeLane(issue, { root, cleanupDeps = {} }) {
  const load = cleanupDeps.load ?? (() => loadCleanupInputs(root));
  let lines;
  try {
    lines = cleanupMerged({ deps: { ...cleanupDeps, load: () => laneInputs(load(), issue) } });
  } catch (err) {
    return { failed: `cleanup: ${errLine(err)}` };
  }
  const failed = lines.filter((l) => l.startsWith("failed "));
  if (failed.length > 0) return { failed: failed.join("; ") };
  const removed = lines.filter((l) => l.startsWith("removed ")).map((l) => l.slice("removed ".length));
  if (removed.length > 0) return { removed: removed.join("; ") };
  const skipped = lines.filter((l) => l.startsWith("skipped "));
  if (skipped.length > 0) return { skipped: `cleanup ${skipped.join("; ")}` };
  return { removed: "nothing left to remove" };
}

/**
 * Runs one lane's reaper until it removes the lane or gives up; returns the exit code (0 removed or lock held by a
 * live reaper, 1 gave up, 2 bad arguments). Polls first FIRST_POLL_MS after it starts and then every POLL_MS; logs started, waiting (when the
 * reason changes), removed, gave up and error lines to `<root>/.lanes/reap/<issue>.log`. A poll fails when a read
 * fails or the removal fails; GIVE_UP_FAILURES failed polls in a row give up.
 * @param {string[]} argv
 * @param {{ root: string, pid: number, run: Function, now: () => number, sleep: (ms: number) => Promise<void>,
 *   isRunning: (pid: number) => boolean, err: (line: string) => void, trap: (release: Function) => void,
 *   cleanupDeps?: object }} deps `run(cmd, args)` returns stdout or throws; `trap(release)` arranges for the lock to
 *   be released on a signal; `cleanupDeps` go to cleanupMerged (its `load` defaults to loadCleanupInputs(root)).
 * @returns {Promise<number>}
 */
export async function main(argv, deps) {
  const args = parseArgs(argv);
  if (!args) {
    deps.err(USAGE);
    return 2;
  }
  const { issue, session } = args;
  const { root, run, now, sleep } = deps;
  const dir = join(root, ".lanes", "reap");
  const lockPath = join(dir, `${issue}.json`);
  const logPath = join(dir, `${issue}.log`);
  const startedAt = now();
  const lock = { pid: deps.pid, session, started: new Date(startedAt).toISOString() };

  const { held } = takeLock(lockPath, lock, { isRunning: deps.isRunning, now: startedAt });
  if (held) {
    deps.err(`reap: issue #${issue} already has a live reaper (pid ${held.pid ?? "unknown"}); exiting`);
    return 0;
  }
  const release = () => releaseLock(lockPath, lock);
  deps.trap(release);
  const log = (event, detail) => appendFileSync(logPath, `${new Date(now()).toISOString()} ${event}: ${oneLine(detail)}\n`);

  try {
    log("started", `issue #${issue}, session ${session}`);
    let failures = 0;
    let lastWait = null;
    const wait = (reason) => {
      if (reason !== lastWait) log("waiting", reason);
      lastWait = reason;
    };
    await sleep(FIRST_POLL_MS);
    for (;;) {
      const state = readState({ issue, root, run });
      for (const e of state.errors) log("error", e);
      let failed = state.errors.length > 0;
      const tick = reapTick({ issue, session, ...state, startedAt, now: now(), failures: failures + (failed ? 1 : 0) });
      if (tick.action === "give-up") {
        log("gave up", tick.reason);
        return 1;
      }
      if (tick.action === "wait") wait(tick.reason);
      else {
        const result = removeLane(issue, deps);
        if (result.removed) {
          log("removed", result.removed);
          return 0;
        }
        if (result.skipped) wait(result.skipped);
        else {
          log("error", result.failed);
          lastWait = null;
          failed = true;
        }
      }
      failures = failed ? failures + 1 : 0;
      if (failures >= GIVE_UP_FAILURES) {
        log("gave up", `${failures} consecutive failed polls`);
        return 1;
      }
      await sleep(POLL_MS);
    }
  } catch (err) {
    log("error", errLine(err));
    throw err;
  } finally {
    release();
  }
}

// Lanes run in worktrees of the main checkout, so the root is the common git dir's parent, not --show-toplevel.
const repoRoot = () => dirname(execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8", windowsHide: true }).trim());

// The reaper is spawned without a console, so on Windows every child it starts would open a console window unless hidden.
export const runOptions = (root) => ({ cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true });

function defaultDeps() {
  const root = repoRoot();
  return {
    root,
    pid: process.pid,
    run: (cmd, args) => execFileSync(cmd, args, runOptions(root)),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    isRunning: pidRunning,
    err: (line) => console.error(line),
    trap: (release) => {
      for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]) {
        process.once(signal, () => {
          release();
          process.exit(code);
        });
      }
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2), defaultDeps()).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(`reap: ${err?.stack ?? err}`);
      process.exitCode = 1;
    },
  );
}
