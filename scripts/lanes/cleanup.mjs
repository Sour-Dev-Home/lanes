// Removes each merged lane's background session, worktree and local branch, each closed issue's lane that has no PR
// and nothing unpushed, and each empty orphan folder under .claude/worktrees. Unmerged, dirty or unpushed work is never
// touched. Each removed session's log is saved to .lanes/logs first (git-ignored, never posted).
// Usage: node scripts/lanes/cleanup.mjs [--dry-run]
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { recordLaneCost } from "./lane-cost.mjs";
import { laneIssueOf, sessionPhase } from "./lib.mjs";
const LANE_BRANCH = /^issue-(\d+)-./;
// A lane's worktree folder: `issue-<N>-<slug>`, or bare `issue-<N>` when the lane skipped the slug (#134).
// A `start-lane-<N>` session (the queue's launcher) is a lane's session too (#717).
const laneNamed = (s) => Boolean(s.issue) && (s.name === `lane-${s.issue}` || s.name === `start-lane-${s.issue}`);
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
      const base = { path: value("worktree"), branch: value("branch")?.replace(/^refs\/heads\//, "") ?? null, head: value("HEAD"), main: i === 0 };
      // git marks an entry whose folder is missing `prunable` (#399).
      const tree = lines.some((l) => l === "prunable" || l.startsWith("prunable ")) ? { ...base, gone: true } : base;
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
// A tip that is not a merged head still counts when `diffs[<merged head>]` says its tree is the same (#717: a lane
// whose workflow change went through the ADR 0023 hand-over is merged under the owner's commit, not the lane's).
function mergedPr(prs, head, diffs = {}) {
  if (prs.some((p) => p.state === "OPEN")) return { skip: "not merged" };
  const done = prs.filter((p) => p.state === "MERGED");
  if (done.length === 0) return { skip: "not merged" };
  if (head === undefined) return { pr: done[0].number };
  const exact = done.find((p) => p.headRefOid === head);
  if (exact) return { pr: exact.number };
  const same = done.find((p) => diffs[p.headRefOid]?.files === 0);
  if (same) return { pr: same.number };
  const results = done.map((p) => diffs[p.headRefOid]);
  const failed = results.find((r) => typeof r?.error === "string");
  if (failed) return { skip: `cannot compare with the merged head (${failed.error})` };
  const files = Math.min(...results.map((r) => r?.files).filter(Number.isInteger));
  return { skip: Number.isFinite(files) ? `local commits after the merged head (${files} files differ)` : "local commits after the merged head" };
}

// Whether a lane is done: merged as above, or `{ closed: true }` when its issue is closed and it has no open or
// merged PR (a closed-unmerged one does not count).
function laneDone(prs, head, issueClosed, diffs) {
  const merge = mergedPr(prs, head, diffs);
  if (merge.skip !== "not merged" || !issueClosed || prs.some((p) => p.state === "OPEN")) return merge;
  return { closed: true };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

const UNREADABLE_SKIP = "session with an unreadable id is in it";

// A session to remove: stopped first when its process is still alive (only an idle one gets here), then removed.
const sessionSteps = (s, stop) => [...(stop ? [{ cmd: "claude", args: ["stop", s.id] }] : []), { cmd: "claude", args: ["rm", s.id] }];

// A session is still working while sessionPhase (status.mjs, #730) calls it running: an unknown one counts as working.
const stillWorking = (s) => sessionPhase(s) === "running";

// One entry per `issue-<N>-…` local branch, plus one per session whose worktree and branch are already gone:
// `{ branch, issue, pr, steps }` to clean, or `{ branch, issue, skip }` with the reason not to.
//   worktrees: local branches, each `{ path, branch, head, dirty, main, locked?, lockRunning? }`; path null for a branch
//              with no worktree, dirty null when its status could not be read, lockRunning whether the pid in a
//              Claude session lock is running (unknown counts as running). Non-lane worktrees are passed too, to
//              place sessions.
//              unpushed: how many of the branch's commits are on no remote (null when unreadable).
//   sessions:  background sessions in this repo, `{ id, cwd, issue, status, state, pid?, alive? }` (issue from an
//              `issue-<N>` or `issue-<N>-…` folder; alive whether its pid is running).
//   prs:       `{ number, state, headRefName, headRefOid }`.
//   issues:    `{ number, state }`; a lane of a CLOSED issue with no open or merged PR is done too.
//   orphans:   `{ path, files }` for each folder under .claude/worktrees that git no longer tracks (files null when
//              they could not be counted); `{ orphan, steps }` or `{ orphan, files?, skip }`.
// A lane is cleaned only when its PR merged at exactly the local branch tip (squash merges are not ancestors, so
// that equality is what makes `git branch -D` safe), or its issue closed with none of its commits unpushed, and its
// worktree is clean. An idle session whose process is still alive is stopped first; a busy one is never touched.
export function planCleanup({ worktrees = [], sessions = [], prs = [], issues = [], orphans = [] } = {}) {
  const closedIssues = new Set(issues.filter((i) => i.state === "CLOSED").map((i) => i.number));
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
  // A `lane-<N>` session belongs to issue N's worktree whatever cwd it reports (a lane that entered its worktree by
  // path can still report the repository root, #341), so that worktree is never removed under it.
  for (const s of sessions) {
    if (!laneNamed(s)) continue;
    const w = worktrees.find((x) => x.path && !x.main && Number(LANE_BRANCH.exec(x.branch ?? "")?.[1]) === s.issue);
    if (!w || sessionOf.get(w)?.includes(s)) continue;
    // One already placed by its cwd in another issue's worktree stays there too, and is stopped only once.
    placed.add(s);
    if (!sessionOf.has(w)) sessionOf.set(w, []);
    sessionOf.get(w).push(s);
  }

  const plan = [];
  const stopped = new Set();
  for (const w of worktrees) {
    const issue = Number(LANE_BRANCH.exec(w.branch ?? "")?.[1]);
    if (!issue) continue;
    const sessionsHere = sessionOf.get(w) ?? [];
    const entry = { branch: w.branch, issue };
    const pid = lockPid(w.locked);
    const lockAlive = Boolean(pid) && w.lockRunning !== false;
    // A running lock held by one of this worktree's own idle sessions is released by stopping that session.
    const holder = lockAlive ? sessionsHere.find((s) => s.pid === pid) : undefined;
    const own = prs.filter((p) => p.headRefName === w.branch);
    const done = laneDone(own, w.head, closedIssues.has(issue), w.treeDiffs);
    const other = own.length === 0 && !w.main && !sessionsHere.some(stillWorking) ? otherLanePr(prs, issue, w.branch) : undefined;
    if (other) plan.push({ ...entry, leftover: { folder: folderOf(w), pr: other.number, branch: other.headRefName }, skip: "leftover" });
    else if (done.skip) plan.push({ ...entry, skip: done.skip });
    else if (w.main) plan.push({ ...entry, skip: "checked out in the main worktree" });
    else if (w.dirty === null && !w.gone) plan.push({ ...entry, skip: "cannot read worktree status" });
    else if (w.dirty) plan.push({ ...entry, skip: "dirty worktree" });
    else if (sessionsHere.some(unreadableId)) plan.push({ ...entry, skip: UNREADABLE_SKIP });
    else if (sessionsHere.some(stillWorking)) plan.push({ ...entry, skip: "session still working" });
    // #494: a session that does not map to this issue (the owner session, a coordinator) is never stopped or removed,
    // and the worktree under it stays.
    else if (sessionsHere.some((s) => s.issue !== issue)) plan.push({ ...entry, skip: `session ${sessionsHere.find((s) => s.issue !== issue).id} is in it` });
    else if (done.closed && !Number.isInteger(w.unpushed)) plan.push({ ...entry, skip: "cannot read unpushed commits" });
    else if (done.closed && w.unpushed > 0) plan.push({ ...entry, skip: `${plural(w.unpushed, "commit")} not on any remote` });
    else if (lockAlive && !holder) plan.push({ ...entry, skip: `locked by running pid ${pid}` });
    else {
      const steps = [];
      for (const s of sessionsHere) {
        if (stopped.has(s)) continue;
        stopped.add(s);
        steps.push(...sessionSteps(s, s.alive === true || s === holder));
      }
      // `claude rm` may already have removed the worktree, so these run only if their target is still there.
      if (w.path && pid) steps.push({ cmd: "git", args: ["worktree", "unlock", w.path], onlyIf: { path: w.path } });
      // A vanished folder leaves git's entry behind, which would refuse `branch -D`; prune drops only such entries.
      if (w.path && w.gone) steps.push({ cmd: "git", args: ["worktree", "prune"] });
      else if (w.path) steps.push({ cmd: "git", args: ["worktree", "remove", w.path], onlyIf: { path: w.path } });
      steps.push({ cmd: "git", args: ["branch", "-D", w.branch], onlyIf: { branch: w.branch } });
      plan.push({ ...entry, ...doneAs(done), steps });
    }
  }

  for (const s of sessions) {
    if (placed.has(s) || !s.issue) continue;
    const entry = { branch: null, issue: s.issue };
    const done = laneDone(prs.filter((p) => Number(LANE_BRANCH.exec(p.headRefName ?? "")?.[1]) === s.issue), undefined, closedIssues.has(s.issue));
    if (done.skip) plan.push({ ...entry, skip: done.skip });
    else if (unreadableId(s)) plan.push({ ...entry, skip: UNREADABLE_SKIP });
    else if (stillWorking(s)) plan.push({ ...entry, skip: "session still working" });
    else plan.push({ ...entry, ...doneAs(done), steps: sessionSteps(s, s.alive === true) });
  }

  // A session removed above may be what still sits in an orphan folder; the folder goes after it, if still there.
  const removedIds = new Set(plan.flatMap((e) => e.steps ?? []).filter(isRm).map((step) => step.args[1]));
  for (const o of orphans) {
    const entry = { branch: null, issue: null, orphan: o.path };
    const dir = normalPath(o.path);
    const orphanIssue = laneIssueOf({ kind: "background", cwd: o.path });
    const user = sessions.find((s) => !removedIds.has(s.id) && (inside(dir, normalPath(s.cwd)) || (orphanIssue && laneNamed(s) && s.issue === orphanIssue)));
    if (!Number.isInteger(o.files)) plan.push({ ...entry, skip: "cannot count its files" });
    else if (o.files > 0) plan.push({ ...entry, files: o.files, skip: `has ${plural(o.files, "file")}; left in place` });
    else if (user) plan.push({ ...entry, skip: unreadableId(user) ? UNREADABLE_SKIP : `session ${user.id} is in it` });
    else plan.push({ ...entry, steps: [{ cmd: "rmdir", args: [o.path], onlyIf: { path: o.path } }] });
  }
  return plan;
}

// The issue's open or merged lane PR on a branch other than `branch` (an open one first), or undefined. A worktree
// whose own branch has no PR but whose issue does has commits no PR carries (#476).
function otherLanePr(prs, issue, branch) {
  const others = prs.filter((p) => p.headRefName !== branch && Number(LANE_BRANCH.exec(p.headRefName ?? "")?.[1]) === issue);
  return others.find((p) => p.state === "OPEN") ?? others.find((p) => p.state === "MERGED");
}

const folderOf = (w) => (w.path ? normalPath(w.path).split("/").at(-1) : w.branch);

const doneAs = (done) => (done.closed ? { closed: true } : { pr: done.pr });

export const cleanableCount = (plan) => plan.filter((e) => e.steps).length;

// A session id is passed to `claude stop` and `claude rm` as an argv item, so it must not start with `-` (a flag).
// The one place the pattern is written out: reap.mjs and CLAIMED use this.
export const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const unreadableId = (s) => s.unreadableId === true || typeof s.id !== "string" || !SESSION_ID.test(s.id);

// `claude rm` refuses while another session's entry claims the same worktree; the claimant id is plain, never a flag.
const CLAIMED = new RegExp(`Another running background session \\((${SESSION_ID.source.slice(1, -1)})\\) claims this worktree`);
const isRm = (step) => step.cmd === "claude" && step.args[0] === "rm";
const isStop = (step) => step.cmd === "claude" && step.args[0] === "stop";
const RM_RETRY_MS = 2000;
const isSessionStep = (step) => step.cmd === "claude" && (step.args[0] === "rm" || step.args[0] === "stop");

// Runs each lane's steps in order; a failed step skips that lane's later steps, and other lanes continue.
// `run(cmd, args)` throws on failure; `stillThere(onlyIf)` says whether a step's target still exists;
// `sessionEnded(id)`, when given, says whether a session claiming the worktree has ended: an ended claimant is
// removed and the refused `claude rm` retried once, and a running one is reported, never stopped.
// `saveLog(id, issue)`, when given, saves a session's log before it is first stopped or removed and returns the file;
// a throw is reported in the result and the session is still removed. `removeDir(path)` runs an orphan's `rmdir`.
// `waitStopped(id)`, when given, runs after each successful `claude stop`, so the `claude rm` that follows finds the
// session gone; `sleep(ms)`, when given, lets a failed `claude rm` be retried once after RM_RETRY_MS (#179).
// `recordCost(id, issue)`, when given, records the session's token usage (lane-cost.mjs) right after its log is saved;
// a throw is reported and never stops the removal. `unmark(issue)`, when given, removes the issue's `lane:running`
// label once its lane is removed (ADR 0014); a throw is reported in the result and never fails the removal.
export function runCleanup(plan, { run, stillThere, sessionEnded, saveLog, recordCost, removeDir, waitStopped, sleep, unmark, dryRun = false }) {
  return plan.map((entry) => {
    const base = { branch: entry.branch, issue: entry.issue, pr: entry.pr, closed: entry.closed, orphan: entry.orphan, files: entry.files, leftover: entry.leftover };
    if (entry.skip) return { ...base, status: "skipped", skip: entry.skip };
    if (dryRun) return { ...base, status: "planned", ran: entry.steps.map(formatStep) };
    const ran = [];
    const logged = new Set();
    const logFirst = (id) => {
      if ((!saveLog && !recordCost) || logged.has(id)) return;
      logged.add(id);
      if (saveLog) {
        try {
          ran.push(`log saved to ${saveLog(id, entry.issue)}`);
        } catch (err) {
          ran.push(`log not saved (${String(err.message).split(/\r?\n/)[0]})`);
        }
      }
      if (recordCost) {
        try {
          recordCost(id, entry.issue);
        } catch (err) {
          ran.push(`cost not recorded (${errorText(err, { args: [] })})`);
        }
      }
    };
    const exec = (step) => {
      if (step.cmd !== "rmdir") return run(step.cmd, step.args);
      if (!removeDir) throw new Error("no removeDir to delete a folder with");
      return removeDir(step.args[0]);
    };
    const fail = (step, error) => ({ ...base, status: "failed", ran, failedStep: formatStep(step), error });
    // #399: what someone else (a reaper, the owner) had already removed, reported instead of a failure.
    const already = [];
    const gone = (kind) => already.includes(kind) || already.push(kind);
    const ourRm = () => ran.some((s) => s.startsWith("claude rm"));
    for (const step of entry.steps) {
      if (step.onlyIf && !stillThere(step.onlyIf)) {
        // After our own `claude rm` a missing folder or branch is that command's doing, not someone else's.
        if (step.cmd === "git" && step.args[1] !== "unlock" && !ourRm()) gone(step.onlyIf.path ? "worktree" : "branch");
        continue;
      }
      // A claimant cleared below may be one of this worktree's own sessions; it is gone already.
      if (isRm(step) && ran.includes(formatStep(step))) continue;
      if (isSessionStep(step)) logFirst(step.args[1]);
      try {
        exec(step);
      } catch (err) {
        if (isSessionStep(step) && /No job matching/i.test(errorOutput(err))) {
          gone("session");
          continue;
        }
        const claimant = isRm(step) && sessionEnded ? CLAIMED.exec(errorOutput(err))?.[1] : undefined;
        if (!claimant && isRm(step) && sleep) {
          // The session may still be exiting; one more try shortly after usually finds it gone.
          sleep(RM_RETRY_MS);
          try {
            exec(step);
          } catch (retryErr) {
            return fail(step, errorText(retryErr, step));
          }
          ran.push(formatStep(step));
          continue;
        }
        if (!claimant) return fail(step, errorText(err, step));
        if (!sessionEnded(claimant)) return fail(step, `${errorText(err, step)} (session ${claimant} is still running; it was not stopped)`);
        const clear = { cmd: "claude", args: ["rm", claimant] };
        logFirst(claimant);
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
      if (step.cmd === "git" && step.args[1] === "prune") gone("worktree");
      if (isStop(step) && waitStopped) {
        try {
          waitStopped(step.args[1]);
        } catch {
          // A wait that breaks must not fail a stop that worked; the `claude rm` retry covers a session still exiting.
        }
      }
    }
    // ADR 0014: the lane is gone, so its `lane:running` mark goes too. A failure is reported and never fails the removal.
    if (unmark && Number.isInteger(entry.issue)) {
      try {
        unmark(entry.issue);
      } catch (err) {
        ran.push(`lane:running not removed (${errorText(err, { args: [] })})`);
      }
    }
    return { ...base, status: "removed", ran, ...(already.length ? { already } : {}) };
  });
}

const errorOutput = (err) => `${err.stderr ?? ""}\n${err.stdout ?? ""}\n${err.message ?? ""}`;

// Windows refuses to delete a worktree while any process has a file in it open.
const OPEN_FILES_HINT = "(a process still has files open in the worktree; close it and re-run)";

const MAX_ERROR_CHARS = 200;
// Other control characters (an ANSI escape, a backspace) are dropped: the line is echoed to the owner's terminal.
const firstLine = (text) =>
  String(text ?? "").split(/\r\n|\r|\n/).map((l) => l.replace(/[\x00-\x1f\x7f]/g, "").trim()).find(Boolean);

// The command's own words on why it failed: its stderr, else its stdout (some claude commands print errors there),
// else the error's message; one line of at most MAX_ERROR_CHARS characters.
function errorText(err, step) {
  const said = firstLine(err.stderr) ?? firstLine(err.stdout) ?? firstLine(err.message) ?? "command failed";
  const line = said.length > MAX_ERROR_CHARS ? `${said.slice(0, MAX_ERROR_CHARS - 1)}…` : said;
  const removing = step.args[0] === "worktree" && step.args[1] === "remove";
  return removing && /Permission denied/i.test(line) ? `${line} ${OPEN_FILES_HINT}` : line;
}

export function render(results) {
  if (results.length === 0) return "no lanes to clean up";
  return results
    .map((r) => {
      const done = r.pr ? ` (PR #${r.pr})` : r.closed ? ` (issue #${r.issue} closed)` : "";
      const name = r.orphan ? `orphan folder ${r.orphan}` : `${r.branch ?? `#${r.issue} session`}${done}`;
      if (r.leftover) return `leftover: ${r.leftover.folder} (issue #${r.issue} has PR #${r.leftover.pr} on ${r.leftover.branch}); its commits are not in any PR`;
      if (r.status === "skipped") return r.orphan && r.files > 0 ? `${name} ${r.skip}` : `skipped ${name}: ${r.skip}`;
      if (r.status === "planned") return `would remove ${name}: ${r.ran.join("; ")}`;
      if (r.status === "failed") return `failed ${name} at ${r.failedStep}: ${r.error}`;
      const said = r.already?.length ? `${r.already.slice(0, -1).join(", ")}${r.already.length > 1 ? " and " : ""}${r.already.at(-1)} already removed` : "";
      return `removed ${name}: ${[...r.ran, ...(said ? [said] : [])].join("; ") || "nothing left to remove"}`;
    })
    .join("\n");
}

// A large maxBuffer: `claude logs` of a long session can pass the 1 MB default. windowsHide comes last so no caller
// can bring back the console window Windows opens for each child process.
export const shOptions = (opts = {}) => ({ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000, maxBuffer: 64 * 1024 * 1024, ...opts, windowsHide: true });
const sh = (cmd, args, opts) => execFileSync(cmd, args, shOptions(opts));

// Lanes run in worktrees of the main checkout, so the root is the common git dir's parent, not --show-toplevel.
const repoRoot = (run = sh) => dirname(run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim());

function porcelain(path, sh) {
  try {
    return sh("git", ["-C", path, "status", "--porcelain"]).trim() !== "";
  } catch {
    return null;
  }
}

// How many of a branch's commits are on no remote, or null when git cannot say.
function unpushedCount(branch, sh) {
  try {
    return Number(sh("git", ["rev-list", "--count", `refs/heads/${branch}`, "--not", "--remotes"]).trim());
  } catch {
    return null;
  }
}

// #717: `{ [merged head]: { files } | { error } }` for each merged PR on `branch` whose head is not the branch tip:
// `files` is how many files differ between that head and the tip (0 for the same tree), `error` the first line of
// what git said when it could not compare. A head not in the local repository is fetched once (`pull/<N>/head`).
function treeDiffsFor(branch, tip, prs, sh) {
  const own = prs.filter((p) => p.headRefName === branch);
  if (own.some((p) => p.state === "OPEN")) return undefined;
  const diffs = {};
  for (const p of own.filter((q) => q.state === "MERGED" && q.headRefOid !== tip)) {
    const compare = () => {
      try {
        sh("git", ["diff", "--quiet", p.headRefOid, tip]);
        return { files: 0 };
      } catch (err) {
        if (err.status !== 1) throw err;
        return { files: sh("git", ["diff", "--name-only", p.headRefOid, tip]).split(/\r?\n/).filter(Boolean).length };
      }
    };
    try {
      try {
        diffs[p.headRefOid] = compare();
      } catch (err) {
        if (err.status === 1) throw err;
        sh("git", ["fetch", "origin", `pull/${p.number}/head`]);
        diffs[p.headRefOid] = compare();
      }
    } catch (err) {
      diffs[p.headRefOid] = { error: errorText(err, { args: [] }) };
    }
  }
  return Object.keys(diffs).length > 0 ? diffs : undefined;
}

// #382: why a lane's worktree still holds work only its owner may drop, or null when it is clean and fully pushed.
// Uses the dirty and unpushed reads loadCleanupInputs uses; a read that fails counts as work left. `run` as in `sh`.
export function laneWorkLeft(path, branch, run = sh) {
  const dirty = porcelain(path, run);
  if (dirty === null) return "cannot read worktree status";
  if (dirty) return "uncommitted changes";
  const unpushed = unpushedCount(branch, run);
  if (!Number.isInteger(unpushed)) return "cannot read unpushed commits";
  return unpushed > 0 ? `${plural(unpushed, "commit")} not on any remote` : null;
}

// #382: removes a stopped lane's session, worktree and branch, without any force flag: git refuses a dirty worktree
// and `branch -D` is only safe once laneWorkLeft said null. Throws on the first failing step.
export function removeLaneWorktree({ id, path, branch }, run = sh) {
  run("claude", ["rm", id]);
  run("git", ["worktree", "remove", path]);
  run("git", ["branch", "-D", branch]);
}

// The inputs to planCleanup, read from git, gh, `claude agents --json` and the .claude/worktrees folder. Throws when
// any of them cannot be read: cleaning without knowing the sessions could remove a worktree from under one.
// `run(cmd, args)` returns stdout or throws, and defaults to `sh`; every read goes through it.
export function loadCleanupInputs(rootArg, run = sh) {
  const sh = run;
  const root = rootArg ?? repoRoot(run);
  const trees = parseWorktrees(sh("git", ["worktree", "list", "--porcelain"]));
  const onBranch = new Set(trees.map((t) => t.branch));
  const worktrees = trees.map((t) => {
    const lane = LANE_BRANCH.test(t.branch ?? "") && !t.main;
    // A lane folder that no longer exists cannot be dirty (#399); git's `prunable` mark or a failed read of a missing folder says so.
    const read = lane && !t.gone ? porcelain(t.path, sh) : false;
    const vanished = lane && (t.gone || (read === null && !existsSync(t.path)));
    const tree = { ...t, ...(vanished ? { gone: true } : {}), dirty: vanished ? false : lane ? read : false, ...(lane ? { unpushed: unpushedCount(t.branch, sh) } : {}) };
    const pid = lockPid(t.locked);
    return pid ? { ...tree, lockRunning: pidRunning(pid) } : tree;
  });
  for (const line of sh("git", ["for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads/"]).split(/\r?\n/)) {
    const [branch, head] = line.split(" ");
    if (LANE_BRANCH.test(branch ?? "") && !onBranch.has(branch)) worktrees.push({ path: null, branch, head, dirty: false, main: false, unpushed: unpushedCount(branch, sh) });
  }
  const prs = JSON.parse(sh("gh", ["pr", "list", "--state", "all", "--limit", String(PR_LIMIT), "--json", "number,state,headRefName,headRefOid"]));
  for (const w of worktrees) {
    if (!LANE_BRANCH.test(w.branch ?? "") || w.main) continue;
    const treeDiffs = treeDiffsFor(w.branch, w.head, prs, sh);
    if (treeDiffs) w.treeDiffs = treeDiffs;
  }
  const issues = JSON.parse(sh("gh", ["issue", "list", "--state", "all", "--limit", String(PR_LIMIT), "--json", "number,state,labels"]));
  const sessions = sessionsFrom(JSON.parse(sh("claude", ["agents", "--json"])), root).map((s) => (s.pid ? { ...s, alive: pidRunning(s.pid) } : s));
  return { root, worktrees, sessions, prs, issues, orphans: findOrphans(root, trees.map((t) => t.path)) };
}

// Whether `<dir>/.git` is a plain file naming a `gitdir:` that no longer exists: what git leaves behind in a worktree
// folder it pruned. A relative gitdir resolves against `dir`. Anything else (a folder, a link, no gitdir line) is not.
function hasStalePointer(dir) {
  const file = join(dir, ".git");
  try {
    if (!lstatSync(file).isFile()) return false;
    const target = /^gitdir:[ \t]*(.+?)[ \t]*$/.exec(readFileSync(file, "utf8").split(/\r?\n/, 1)[0])?.[1];
    return Boolean(target) && !existsSync(resolve(dir, target));
  } catch {
    return false;
  }
}

// Files (anything but a folder, links included) anywhere under `dir`, or null when it cannot be read. A stale `.git`
// pointer directly in `dir` does not count: it is debris, removed with the folder.
function countFiles(dir) {
  try {
    const stale = hasStalePointer(dir) ? join(dir, ".git") : null;
    return readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => !e.isDirectory() && join(e.parentPath, e.name) !== stale).length;
  } catch {
    return null;
  }
}

/**
 * The folders directly under `<root>/.claude/worktrees` that hold none of the `tracked` worktree paths, each with how
 * many files it holds (null when unreadable). No such folder: [].
 * @param {string} root
 * @param {string[]} tracked
 * @returns {{ path: string, files: number | null }[]}
 */
export function findOrphans(root, tracked) {
  const base = join(root, ".claude", "worktrees");
  let entries;
  try {
    entries = readdirSync(base, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const known = tracked.filter(Boolean).map(normalPath);
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => join(base, e.name))
    .filter((path) => !known.some((t) => inside(normalPath(path), t)))
    .map((path) => ({ path, files: countFiles(path) }));
}

/**
 * Deletes `path` if it holds no files (empty folders inside go with it); throws otherwise. Folders are removed deepest
 * first with a plain rmdir, which refuses a non-empty one, so a file written after the count is never deleted. The one
 * file unlinked outright is a stale `.git` pointer directly in `path` (see hasStalePointer), which is not counted.
 */
export function removeEmptyDir(path) {
  const files = countFiles(path);
  if (files === null) throw new Error(`cannot count the files in ${path}`);
  if (files > 0) throw new Error(`${path} has ${plural(files, "file")}; left in place`);
  const inner = readdirSync(path, { recursive: true, withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(e.parentPath, e.name))
    .sort((a, b) => b.length - a.length);
  if (hasStalePointer(path)) unlinkSync(join(path, ".git"));
  for (const dir of [...inner, path]) rmdirSync(dir);
}

export const LOG_LINES = 200;
export const LOG_KEEP = 50;

// ECMA-48 escape sequences: DCS/SOS/PM/APC strings, OSC strings (BEL or ST ended), CSI, charset picks, then any other
// two-byte escape. Not util.stripVTControlCharacters: it reads `ESC[1Gend BEL` as one sequence and drops the text.
const ESCAPES = /\x1b[PX^_][\s\S]*?\x1b\\|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|(?:\x1b\[|\u009b)[0-?]*[ -/]*[@-~]|\x1b[()*+][ -~]|\x1b[ -~]/g;

// Terminal escape codes out, line endings as \n (a lone \r, a redrawn line, becomes a line break), other control
// characters out.
const stripEscapes = (text) => text.replace(ESCAPES, "").replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");

/**
 * Saves the last LOG_LINES lines of `claude logs <id>`, escape codes stripped, to `<root>/.lanes/logs/issue-<N>-<id>.txt`
 * (one line saying why when `claude logs` fails or prints nothing), then deletes all but the LOG_KEEP newest files
 * there. Returns the file as `.lanes/logs/<name>`. Throws only when the file cannot be written.
 * @param {string} id
 * @param {number | null} issue
 * @param {{ run: Function, root: string, keep?: number }} deps
 * @returns {string}
 */
export function saveSessionLog(id, issue, { run, root, keep = LOG_KEEP }) {
  const name = `issue-${issue ?? "none"}-${String(id).replace(/[^A-Za-z0-9_-]/g, "_")}.txt`;
  let body;
  try {
    const lines = stripEscapes(String(run("claude", ["logs", id]) ?? "")).split("\n");
    while (lines.length > 0 && lines.at(-1).trim() === "") lines.pop();
    body = lines.length > 0 ? `${lines.slice(-LOG_LINES).join("\n")}\n` : `claude logs ${id} printed nothing\n`;
  } catch (err) {
    const reason = stripEscapes(String(err.stderr ?? "")).trim() || String(err.message);
    body = `claude logs ${id} failed: ${reason.split("\n")[0]}\n`;
  }
  const dir = join(root, ".lanes", "logs");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), body);
  const older = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name !== name)
    .map((e) => ({ name: e.name, time: statSync(join(dir, e.name)).mtimeMs }))
    .sort((a, b) => b.time - a.time || b.name.localeCompare(a.name));
  for (const old of older.slice(Math.max(keep - 1, 0))) rmSync(join(dir, old.name), { force: true });
  return `.lanes/logs/${name}`;
}

// The background sessions under `root` from `claude agents --json`, as planCleanup's `sessions`. A session whose id is
// not a plain name is kept without its id and marked `unreadableId: true`: no command can name it, but planCleanup
// still sees it sitting in a worktree and leaves that worktree alone.
export function sessionsFrom(agents, root) {
  const top = `${normalPath(root)}/`;
  const sessions = [];
  for (const a of agents) {
    if (a?.kind !== "background" || typeof a.cwd !== "string") continue;
    const cwd = normalPath(a.cwd);
    // The root itself counts: a lane that has not entered its worktree yet sits there, with no issue.
    if (cwd !== normalPath(root) && !cwd.startsWith(top)) continue;
    // The `lane-<N>` name wins over the cwd (#341); the cwd is read relative to the root, as its parents are not lanes.
    const startNamed = typeof a.name === "string" ? Number(/^start-lane-([1-9]\d*)$/.exec(a.name)?.[1]) : NaN;
    const issue = Number.isSafeInteger(startNamed) ? startNamed : laneIssueOf({ ...a, cwd: cwd.slice(top.length) });
    const readable = typeof a.id === "string" && SESSION_ID.test(a.id);
    const session = { ...(readable ? { id: a.id } : { unreadableId: true }), cwd: a.cwd, issue, status: a.status, state: a.state };
    if (issue && (a.name === `lane-${issue}` || a.name === `start-lane-${issue}`)) session.name = a.name;
    // The transcript's name and the launch time, kept for lane-cost.mjs.
    if (typeof a.sessionId === "string") session.sessionId = a.sessionId;
    if (Number.isFinite(a.startedAt)) session.startedAt = a.startedAt;
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

export const STOP_CHECKS = 10;
export const STOP_CHECK_MS = 1000;

// A blocking pause; the whole script is synchronous.
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * After `claude stop <id>`, waits until `claude agents --json` no longer lists session `id` as busy or running,
 * checking every STOP_CHECK_MS for at most STOP_CHECKS seconds. Only `status` counts: `state` can keep saying
 * "working" after a session stopped (#83). Returns whether it stopped; a list that cannot be read ends the wait at
 * once with false, and the caller's `claude rm` retry covers the rest.
 * @param {string} id
 * @param {{ run: Function, sleep: (ms: number) => void }} deps
 */
export function waitForStop(id, { run, sleep }) {
  for (let check = 0; ; check++) {
    let agents;
    try {
      agents = JSON.parse(String(run("claude", ["agents", "--json"])));
    } catch {
      return false;
    }
    if (!Array.isArray(agents)) return false;
    const status = agents.find((a) => a?.id === id)?.status;
    if (status !== "busy" && status !== "running") return true;
    if (check >= STOP_CHECKS) return false;
    sleep(STOP_CHECK_MS);
  }
}

// Appends the lane cost line (lane-cost.mjs) for background session `id` of `issue`: its transcript comes from the
// Claude Code projects folder for the repository root, and the tier from the issue's `tier:*` label when it has one.
// `costDeps` (home, read, now) are lane-cost's, for tests.
export function recordSessionCost(id, issue, inputs, costDeps = {}) {
  const session = inputs.sessions?.find((s) => s.id === id);
  const label = inputs.issues?.find((i) => i.number === issue)?.labels?.map((l) => /^tier:(.+)$/.exec(l?.name ?? "")?.[1]).find(Boolean);
  return recordLaneCost({ issue, tier: label ?? null, sessionId: session?.sessionId, startedAt: session?.startedAt, cwd: session?.cwd }, { root: inputs.root, ...costDeps });
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
  run: (cmd, args) => sh(cmd, args),
  stillThere: (onlyIf) => (onlyIf.path ? existsSync(onlyIf.path) : branchExists(onlyIf.branch)),
  removeDir: removeEmptyDir,
  sleep: sleepMs,
};

/**
 * Removes every done lane and empty orphan folder (or, with `dryRun`, only plans it) and returns render's lines, one
 * per entry or `["no lanes to clean up"]`; a failed step's line starts with `failed `. Throws when the inputs cannot
 * be read. `deps` holds fakes in tests: `load()` returns planCleanup's inputs, and `run`, `stillThere`,
 * `sessionEnded`, `saveLog`, `removeDir`, `waitStopped` and `sleep` are runCleanup's (`sessionEnded` defaults to the
 * exported one over the loaded sessions and `run`; `saveLog` to saveSessionLog under the loaded `root`, and to none when
 * inputs have no root; `waitStopped` to waitForStop over `run` and `sleep`; `sleep` to a blocking pause).
 * @param {{ dryRun?: boolean, deps?: { load?: Function, run?: Function, stillThere?: Function, sessionEnded?: Function, saveLog?: Function, removeDir?: Function, waitStopped?: Function, sleep?: Function } }} [options]
 * @returns {string[]}
 */
export function cleanupMerged({ dryRun = false, deps = {} } = {}) {
  const { load, run, stillThere, sessionEnded: ended, saveLog, recordCost: costed, removeDir, waitStopped: waited, sleep, unmark: unmarked } = { ...DEFAULT_DEPS, ...deps };
  const inputs = load ? load() : loadCleanupInputs(undefined, run);
  const isEnded = ended ?? ((id) => sessionEnded(id, { sessions: inputs.sessions, run }));
  const save = saveLog ?? (inputs.root ? (id, issue) => saveSessionLog(id, issue, { run, root: inputs.root }) : undefined);
  const record = costed ?? (inputs.root ? (id, issue) => recordSessionCost(id, issue, inputs) : undefined);
  const waitStopped = waited ?? ((id) => waitForStop(id, { run, sleep }));
  const unmark = unmarked ?? ((n) => run("gh", ["issue", "edit", String(n), "--remove-label", "lane:running"]));
  return render(runCleanup(planCleanup(inputs), { dryRun, run, stillThere, sessionEnded: isEnded, saveLog: save, recordCost: record, removeDir, waitStopped, sleep, unmark })).split("\n");
}

export const USAGE = "usage: node scripts/lanes/cleanup.mjs [--dry-run]";

// What the CLI does before any git, gh or claude command: `--help`/`-h` prints the usage and stops (exit 0); any argument
// but `--dry-run` is refused (exit 2) with its name and the usage; otherwise null and the cleanup runs.
export function argsOutcome(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return { code: 0, stdout: USAGE };
  const unknown = argv.find((a) => a !== "--dry-run");
  if (unknown !== undefined) return { code: 2, stderr: `unknown argument: ${unknown}\n${USAGE}` };
  return null;
}

function main(argv = process.argv.slice(2)) {
  const early = argsOutcome(argv);
  if (early) {
    if (early.stdout) console.log(early.stdout);
    if (early.stderr) console.error(early.stderr);
    process.exitCode = early.code;
    return;
  }
  const lines = cleanupMerged({ dryRun: argv.includes("--dry-run") });
  console.log(lines.join("\n"));
  if (lines.some((line) => line.startsWith("failed "))) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
