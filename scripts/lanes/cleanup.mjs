// Removes each merged lane's background session, worktree and local branch. Unmerged or dirty work is never touched.
// Usage: node scripts/lanes/cleanup.mjs [--dry-run]
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const LANE_BRANCH = /^issue-(\d+)-./;
const PR_LIMIT = 1000;

const normalPath = (p) => {
  const slashed = p.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[a-z]:\//i.test(slashed) ? slashed.toLowerCase() : slashed;
};
const inside = (dir, p) => p === dir || p.startsWith(`${dir}/`);

export const formatStep = (step) => `${step.cmd} ${step.args.join(" ")}`;

// `git worktree list --porcelain` → `[{ path, branch, head, main }]`; the first entry is the main worktree, and a
// detached one has branch null.
export function parseWorktrees(text) {
  return text
    .split(/\r?\n\r?\n/)
    .map((block) => block.split(/\r?\n/))
    .filter((lines) => lines[0]?.startsWith("worktree "))
    .map((lines, i) => {
      const value = (key) => lines.find((l) => l.startsWith(`${key} `))?.slice(key.length + 1);
      return { path: value("worktree"), branch: value("branch")?.replace(/^refs\/heads\//, "") ?? null, head: value("HEAD"), main: i === 0 };
    });
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

// One entry per `issue-<N>-…` local branch, plus one per session whose worktree and branch are already gone:
// `{ branch, issue, pr, steps }` to clean, or `{ branch, issue, skip }` with the reason not to.
//   worktrees: local branches, each `{ path, branch, head, dirty, main }`; path null for a branch with no worktree,
//              dirty null when its status could not be read. Non-lane worktrees are passed too, to place sessions.
//   sessions:  background sessions in this repo, `{ id, cwd, issue, state }` (issue from an `issue-<N>-…` folder).
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
    const merge = mergedPr(prs.filter((p) => p.headRefName === w.branch), w.head);
    if (merge.skip) plan.push({ ...entry, skip: merge.skip });
    else if (w.main) plan.push({ ...entry, skip: "checked out in the main worktree" });
    else if (w.dirty === null) plan.push({ ...entry, skip: "cannot read worktree status" });
    else if (w.dirty) plan.push({ ...entry, skip: "dirty worktree" });
    else if (sessionsHere.some((s) => s.state === "working")) plan.push({ ...entry, skip: "session still working" });
    else {
      const steps = [];
      for (const s of sessionsHere) steps.push({ cmd: "claude", args: ["rm", s.id] });
      // `claude rm` may already have removed the worktree, so these two run only if their target is still there.
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
    else if (s.state === "working") plan.push({ ...entry, skip: "session still working" });
    else plan.push({ ...entry, pr: merge.pr, steps: [{ cmd: "claude", args: ["rm", s.id] }] });
  }
  return plan;
}

export const cleanableCount = (plan) => plan.filter((e) => e.steps).length;

// Runs each lane's steps in order; a failed step skips that lane's later steps, and other lanes continue.
// `run(cmd, args)` throws on failure; `stillThere(onlyIf)` says whether a step's target still exists.
export function runCleanup(plan, { run, stillThere, dryRun = false }) {
  return plan.map((entry) => {
    const base = { branch: entry.branch, issue: entry.issue, pr: entry.pr };
    if (entry.skip) return { ...base, status: "skipped", skip: entry.skip };
    if (dryRun) return { ...base, status: "planned", ran: entry.steps.map(formatStep) };
    const ran = [];
    for (const step of entry.steps) {
      if (step.onlyIf && !stillThere(step.onlyIf)) continue;
      try {
        run(step.cmd, step.args);
      } catch (err) {
        return { ...base, status: "failed", ran, failedStep: formatStep(step), error: errorText(err) };
      }
      ran.push(formatStep(step));
    }
    return { ...base, status: "removed", ran };
  });
}

const errorText = (err) => (String(err.stderr ?? "").trim() || err.message).split(/\r?\n/)[0];

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
  const worktrees = trees.map((t) => ({ ...t, dirty: LANE_BRANCH.test(t.branch ?? "") && !t.main ? porcelain(t.path) : false }));
  for (const line of sh("git", ["for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads/"]).split(/\r?\n/)) {
    const [branch, head] = line.split(" ");
    if (LANE_BRANCH.test(branch ?? "") && !onBranch.has(branch)) worktrees.push({ path: null, branch, head, dirty: false, main: false });
  }
  const prs = JSON.parse(sh("gh", ["pr", "list", "--state", "all", "--limit", String(PR_LIMIT), "--json", "number,state,headRefName,headRefOid"]));
  const top = `${normalPath(root)}/`;
  const sessions = [];
  for (const a of JSON.parse(sh("claude", ["agents", "--json"]))) {
    if (a?.kind !== "background" || typeof a.id !== "string" || typeof a.cwd !== "string") continue;
    const cwd = normalPath(a.cwd);
    if (!cwd.startsWith(top)) continue;
    const issue = Number(cwd.slice(top.length).split("/").map((s) => LANE_BRANCH.exec(s)?.[1]).find(Boolean)) || null;
    sessions.push({ id: a.id, cwd: a.cwd, issue, state: a.state });
  }
  return { worktrees, sessions, prs };
}

const branchExists = (branch) => {
  try {
    sh("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
};

function main(argv = process.argv.slice(2)) {
  const dryRun = argv.includes("--dry-run");
  const plan = planCleanup(loadCleanupInputs());
  const results = runCleanup(plan, {
    dryRun,
    run: (cmd, args) => sh(cmd, args),
    stillThere: (onlyIf) => (onlyIf.path ? existsSync(onlyIf.path) : branchExists(onlyIf.branch)),
  });
  console.log(render(results));
  if (results.some((r) => r.status === "failed")) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
