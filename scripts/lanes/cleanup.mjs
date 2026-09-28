// Removes each merged lane's background session, worktree and local branch. Unmerged or dirty work is never touched.
// Usage: node scripts/lanes/cleanup.mjs [--dry-run]
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const LANE_BRANCH = /^issue-(\d+)-./;
// A lane's worktree folder: `issue-<N>-<slug>`, or bare `issue-<N>` when the lane skipped the slug (#134).
const LANE_FOLDER = /^issue-(\d+)(?:-.*)?$/;
const PR_LIMIT = 1000;

const normalPath = (p) => {
  const slashed = p.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[a-z]:\//i.test(slashed) ? slashed.toLowerCase() : slashed;
};
const inside = (dir, p) => p === dir || p.startsWith(`${dir}/`);

export const formatStep = (step) => `${step.cmd} ${step.args.join(" ")}`;

// A lock Claude Code puts on a session's worktree; the session has ended once no process has that pid.
const SESSION_LOCK = /^claude session .* \(pid (\d+)\)$/;
const lockPid = (locked) => Number(SESSION_LOCK.exec(locked ?? "")?.[1]) || null;

// `git worktree list --porcelain` → `[{ path, branch, head, main, locked? }]`; the first entry is the main worktree, a
// detached one has branch null, and a locked one has its lock reason ("" when it has none).
export function parseWorktrees(text) {
  return text
    .split(/\r?\n\r?\n/)
    .map((block) => block.split(/\r?\n/))
    .filter((lines) => lines[0]?.startsWith("worktree "))
    .map((lines, i) => {
      const value = (key) => lines.find((l) => l.startsWith(`${key} `))?.slice(key.length + 1);
      const tree = { path: value("worktree"), branch: value("branch")?.replace(/^refs\/heads\//, "") ?? null, head: value("HEAD"), main: i === 0 };
      const lock = lines.find((l) => l === "locked" || l.startsWith("locked "));
      return lock === undefined ? tree : { ...tree, locked: lock.slice("locked ".length) };
    });
}

// Whether a process with this pid exists now (EPERM: it exists but belongs to someone else).
export function pidRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

// Whether a lane is merged: `{ pr }` for the merged PR whose head is `head`, else `{ skip }`. An open PR on the lane
// means it is not done, whatever merged before it.
function mergedPr(prs, head) {
  if (prs.some((p) => p.state === "OPEN")) return { skip: "not merged" };
  const done = prs.filter((p) => p.state === "MERGED");
  if (done.length === 0) return { skip: "not merged" };
  if (head === undefined) return { pr: done[0].number };
  const exact = done.find((p) => p.headRefOid === head);
  return exact ? { pr: exact.number } : { skip: "local commits after the merged head" };
}

// `status` says whether a session is running now; `state` can keep saying "working" after it stopped (#83). A session
// with no status, or one this script does not know, falls back to its state.
const stillWorking = (s) => (s.status === "idle" ? false : s.status === "busy" ? true : s.state === "working");

// One entry per `issue-<N>-…` local branch, plus one per session whose worktree and branch are already gone:
// `{ branch, issue, pr, steps }` to clean, or `{ branch, issue, skip }` with the reason not to.
//   worktrees: local branches, each `{ path, branch, head, dirty, main, locked?, lockRunning? }`; path null for a branch
//              with no worktree, dirty null when its status could not be read, lockRunning whether the pid in a
//              Claude session lock is running (unknown counts as running). Non-lane worktrees are passed too, to
//              place sessions.
//   sessions:  background sessions in this repo, `{ id, cwd, issue, status, state }` (issue from an `issue-<N>` or `issue-<N>-…` folder).
//   prs:       `{ number, state, headRefName, headRefOid }`.
// A lane is cleaned only when its PR merged at exactly the local branch tip (squash merges are not ancestors, so
// that equality is what makes `git branch -D` safe), and its worktree is clean.
export function planCleanup({ worktrees = [], sessions = [], prs = [] } = {}) {
  const placed = new Set();
  const sessionOf = new Map();
  const withPath = worktrees.filter((w) => w.path).map((w) => ({ w, dir: normalPath(w.path) }));
  for (const s of sessions) {
    const cwd = normalPath(s.cwd);
    const holder = withPath.filter(({ dir }) => inside(dir, cwd)).sort((a, b) => b.dir.length - a.dir.length)[0];
    // A cwd only the main checkout holds is a lane folder whose worktree is gone: that session stands alone below.
    if (!holder || holder.w.main) continue;
    placed.add(s);
    // More than one session can share a worktree (a stale entry beside a fresh one); keep all of them so a
    // still-working one is never shadowed by an idle one that happens to sort later.
    if (!sessionOf.has(holder.w)) sessionOf.set(holder.w, []);
    sessionOf.get(holder.w).push(s);
  }

  const plan = [];
  for (const w of worktrees) {
    const issue = Number(LANE_BRANCH.exec(w.branch ?? "")?.[1]);
    if (!issue) continue;
    const sessionsHere = sessionOf.get(w) ?? [];
    const entry = { branch: w.branch, issue };
    const pid = lockPid(w.locked);
    const merge = mergedPr(prs.filter((p) => p.headRefName === w.branch), w.head);
    if (merge.skip) plan.push({ ...entry, skip: merge.skip });
    else if (w.main) plan.push({ ...entry, skip: "checked out in the main worktree" });
    else if (w.dirty === null) plan.push({ ...entry, skip: "cannot read worktree status" });
    else if (w.dirty) plan.push({ ...entry, skip: "dirty worktree" });
    else if (sessionsHere.some(stillWorking)) plan.push({ ...entry, skip: "session still working" });
    else if (pid && w.lockRunning !== false) plan.push({ ...entry, skip: `locked by running pid ${pid}` });
    else {
      const steps = [];
      for (const s of sessionsHere) steps.push({ cmd: "claude", args: ["rm", s.id] });
      // `claude rm` may already have removed the worktree, so these run only if their target is still there.
      if (w.path && pid) steps.push({ cmd: "git", args: ["worktree", "unlock", w.path], onlyIf: { path: w.path } });
      if (w.path) steps.push({ cmd: "git", args: ["worktree", "remove", w.path], onlyIf: { path: w.path } });
      steps.push({ cmd: "git", args: ["branch", "-D", w.branch], onlyIf: { branch: w.branch } });
      plan.push({ ...entry, pr: merge.pr, steps });
    }
  }

  for (const s of sessions) {
    if (placed.has(s) || !s.issue) continue;
    const entry = { branch: null, issue: s.issue };
    const merge = mergedPr(prs.filter((p) => Number(LANE_BRANCH.exec(p.headRefName ?? "")?.[1]) === s.issue));
    if (merge.skip) plan.push({ ...entry, skip: merge.skip });
    else if (stillWorking(s)) plan.push({ ...entry, skip: "session still working" });
    else plan.push({ ...entry, pr: merge.pr, steps: [{ cmd: "claude", args: ["rm", s.id] }] });
  }
  return plan;
}

export const cleanableCount = (plan) => plan.filter((e) => e.steps).length;

// `claude rm` refuses while another session's entry claims the same worktree; the claimant id is plain, never a flag.
const CLAIMED = /Another running background session \(([A-Za-z0-9][A-Za-z0-9_-]*)\) claims this worktree/;
const isRm = (step) => step.cmd === "claude" && step.args[0] === "rm";

// Runs each lane's steps in order; a failed step skips that lane's later steps, and other lanes continue.
// `run(cmd, args)` throws on failure; `stillThere(onlyIf)` says whether a step's target still exists;
// `sessionEnded(id)`, when given, says whether a session claiming the worktree has ended: an ended claimant is
// removed and the refused `claude rm` retried once, and a running one is reported, never stopped.
export function runCleanup(plan, { run, stillThere, sessionEnded, dryRun = false }) {
  return plan.map((entry) => {
    const base = { branch: entry.branch, issue: entry.issue, pr: entry.pr };
    if (entry.skip) return { ...base, status: "skipped", skip: entry.skip };
    if (dryRun) return { ...base, status: "planned", ran: entry.steps.map(formatStep) };
    const ran = [];
    const fail = (step, error) => ({ ...base, status: "failed", ran, failedStep: formatStep(step), error });
    for (const step of entry.steps) {
      if (step.onlyIf && !stillThere(step.onlyIf)) continue;
      // A claimant cleared below may be one of this worktree's own sessions; it is gone already.
      if (isRm(step) && ran.includes(formatStep(step))) continue;
      try {
        run(step.cmd, step.args);
      } catch (err) {
        const claimant = isRm(step) && sessionEnded ? CLAIMED.exec(errorOutput(err))?.[1] : undefined;
        if (!claimant) return fail(step, errorText(err, step));
        if (!sessionEnded(claimant)) return fail(step, `${errorText(err, step)} (session ${claimant} is still running; it was not stopped)`);
        const clear = { cmd: "claude", args: ["rm", claimant] };
        try {
          run(clear.cmd, clear.args);
        } catch (clearErr) {
          return fail(clear, errorText(clearErr, clear));
        }
        ran.push(formatStep(clear));
        try {
          run(step.cmd, step.args);
        } catch (retryErr) {
          return fail(step, errorText(retryErr, step));
        }
      }
      ran.push(formatStep(step));
    }
    return { ...base, status: "removed", ran };
  });
}

const errorOutput = (err) => `${err.stderr ?? ""}\n${err.stdout ?? ""}\n${err.message ?? ""}`;

// Windows refuses to delete a worktree while any process has a file in it open.
const OPEN_FILES_HINT = "(a process still has files open in the worktree; close it and re-run)";

function errorText(err, step) {
  const line = (String(err.stderr ?? "").trim() || err.message).split(/\r?\n/)[0];
  const removing = step.args[0] === "worktree" && step.args[1] === "remove";
  return removing && /Permission denied/i.test(line) ? `${line} ${OPEN_FILES_HINT}` : line;
}

export function render(results) {
  if (results.length === 0) return "no lanes to clean up";
  return results
    .map((r) => {
      const name = `${r.branch ?? `#${r.issue} session`}${r.pr ? ` (PR #${r.pr})` : ""}`;
      if (r.status === "skipped") return `skipped ${name}: ${r.skip}`;
      if (r.status === "planned") return `would remove ${name}: ${r.ran.join("; ")}`;
      if (r.status === "failed") return `failed ${name} at ${r.failedStep}: ${r.error}`;
      return `removed ${name}: ${r.ran.join("; ") || "nothing left to remove"}`;
    })
    .join("\n");
}

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000, ...opts });

// Lanes run in worktrees of the main checkout, so the root is the common git dir's parent, not --show-toplevel.
const repoRoot = () => dirname(sh("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim());

function porcelain(path) {
  try {
    return sh("git", ["-C", path, "status", "--porcelain"]).trim() !== "";
  } catch {
    return null;
  }
}

// The inputs to planCleanup, read from git, gh and `claude agents --json`. Throws when any of them cannot be read:
// cleaning without knowing the sessions could remove a worktree from under one.
export function loadCleanupInputs(root = repoRoot()) {
  const trees = parseWorktrees(sh("git", ["worktree", "list", "--porcelain"]));
  const onBranch = new Set(trees.map((t) => t.branch));
  const worktrees = trees.map((t) => {
    const tree = { ...t, dirty: LANE_BRANCH.test(t.branch ?? "") && !t.main ? porcelain(t.path) : false };
    const pid = lockPid(t.locked);
    return pid ? { ...tree, lockRunning: pidRunning(pid) } : tree;
  });
  for (const line of sh("git", ["for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads/"]).split(/\r?\n/)) {
    const [branch, head] = line.split(" ");
    if (LANE_BRANCH.test(branch ?? "") && !onBranch.has(branch)) worktrees.push({ path: null, branch, head, dirty: false, main: false });
  }
  const prs = JSON.parse(sh("gh", ["pr", "list", "--state", "all", "--limit", String(PR_LIMIT), "--json", "number,state,headRefName,headRefOid"]));
  return { worktrees, sessions: sessionsFrom(JSON.parse(sh("claude", ["agents", "--json"])), root), prs };
}

// The background sessions under `root` from `claude agents --json`, as planCleanup's `sessions`.
export function sessionsFrom(agents, root) {
  const top = `${normalPath(root)}/`;
  const sessions = [];
  for (const a of agents) {
    if (a?.kind !== "background" || typeof a.id !== "string" || typeof a.cwd !== "string") continue;
    const cwd = normalPath(a.cwd);
    if (!cwd.startsWith(top)) continue;
    const issue = Number(cwd.slice(top.length).split("/").map((s) => LANE_FOLDER.exec(s)?.[1]).find(Boolean)) || null;
    const session = { id: a.id, cwd: a.cwd, issue, status: a.status, state: a.state };
    sessions.push(Number.isInteger(a.pid) ? { ...session, pid: a.pid } : session);
  }
  return sessions;
}

const NO_JOB = /job not found|no job matching/i;

/**
 * Whether session `id` has ended: its pid (from `sessions`) is not running, or `claude logs <id>` finds no job. Any
 * other answer, a logs failure included, counts as still running.
 * @param {string} id
 * @param {{ sessions?: { id: string, pid?: number }[], run: Function, isRunning?: (pid: number) => boolean }} deps
 */
export function sessionEnded(id, { sessions = [], run, isRunning = pidRunning }) {
  const pid = sessions.find((s) => s.id === id)?.pid;
  if (Number.isInteger(pid) && pid > 0 && !isRunning(pid)) return true;
  try {
    return NO_JOB.test(String(run("claude", ["logs", id]) ?? ""));
  } catch (err) {
    return NO_JOB.test(String(err.stderr ?? "")) || NO_JOB.test(String(err.stdout ?? ""));
  }
}

const branchExists = (branch) => {
  try {
    sh("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
};

const DEFAULT_DEPS = {
  load: () => loadCleanupInputs(),
  run: (cmd, args) => sh(cmd, args),
  stillThere: (onlyIf) => (onlyIf.path ? existsSync(onlyIf.path) : branchExists(onlyIf.branch)),
};

/**
 * Removes every merged lane (or, with `dryRun`, only plans it) and returns render's lines, one per lane or
 * `["no lanes to clean up"]`; a failed step's line starts with `failed `. Throws when the inputs cannot be read.
 * `deps` holds fakes in tests: `load()` returns planCleanup's inputs, and `run`, `stillThere` and `sessionEnded` are
 * runCleanup's (`sessionEnded` defaults to the exported one, over the loaded sessions and `run`).
 * @param {{ dryRun?: boolean, deps?: { load?: Function, run?: Function, stillThere?: Function, sessionEnded?: Function } }} [options]
 * @returns {string[]}
 */
export function cleanupMerged({ dryRun = false, deps = {} } = {}) {
  const { load, run, stillThere, sessionEnded: ended } = { ...DEFAULT_DEPS, ...deps };
  const inputs = load();
  const isEnded = ended ?? ((id) => sessionEnded(id, { sessions: inputs.sessions, run }));
  return render(runCleanup(planCleanup(inputs), { dryRun, run, stillThere, sessionEnded: isEnded })).split("\n");
}

function main(argv = process.argv.slice(2)) {
  const lines = cleanupMerged({ dryRun: argv.includes("--dry-run") });
  console.log(lines.join("\n"));
  if (lines.some((line) => line.startsWith("failed "))) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
