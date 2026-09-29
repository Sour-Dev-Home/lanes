// scripts/lanes/queue.mjs
// The owner-run lane queue (ADR 0005 as amended by ADR 0006). `planTick` decides one tick from a snapshot: which
// ready issues launch now, which lane PRs wait on the owner, and whether the queue is idle. Pure: `main` reads
// GitHub and the sessions, cleans up merged lanes and launches, every 3 minutes until it is idle.
// Usage: node scripts/lanes/queue.mjs, in the owner's own terminal. Exit 0: idle for three ticks in a row.
// 1: three GitHub reads failed in a row. 2: an argument, a bad lanes.config.json, or run inside Claude (CLAUDECODE).
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseBlockedBy } from "./blockers.mjs";
import { cleanupMerged } from "./cleanup.mjs";
import { GATE_CONTEXT } from "./lib.mjs";
import { claimedPaths, pickStartable } from "./pick.mjs";
import { inFlightIssues, launchArgs, launchEnv, markRunning, parseSessionId, reaperLog, START_DEFAULTS, startConfig, startReaper } from "./start.mjs";
import { gateDescriptions, prStage } from "./status.mjs";

// The status.mjs stages a lane PR waits on the owner in: a failing check or review, a failing lanes/gate, or a gate
// waiting on owner.
const WAITING_STAGES = new Set(["failing", "contract", "owner"]);
const labelsOf = (issue) => (issue.labels ?? []).map((l) => (typeof l === "string" ? l : l?.name));
const isOpen = (issue) => (issue.state ?? "OPEN") === "OPEN";
const branchIssue = (pr) => Number(String(pr.headRefName ?? "").match(/^issue-(\d+)-/)?.[1] ?? NaN);
const sessionIssue = (s) => Number(String(s.cwd ?? "").match(/(?:^|[\\/])issue-(\d+)-[^\\/]*(?:[\\/]|$)/)?.[1] ?? NaN);

// Why a lane PR waits on the owner, or null, from status.mjs's stage. The gate's description falls back to
// `gateDescription`, which `gh pr list` leaves out of the rollup.
function waitReason(pr) {
  const { stage, note } = prStage(pr, undefined, pr.gateDescription);
  if (!WAITING_STAGES.has(stage)) return null;
  return note || `${GATE_CONTEXT} failed`;
}

// Why a ready issue cannot be a candidate, or null. Blockers count as open only when open in the snapshot.
function refusal(issue, openNumbers) {
  if (labelsOf(issue).filter((l) => l?.startsWith("tier:")).length !== 1) return "no single tier:* label";
  const { blockedBy, error } = parseBlockedBy(issue.body ?? "");
  if (error) return error;
  const open = blockedBy.filter((b) => openNumbers.has(b));
  return open.length ? `blocked by ${open.map((b) => `#${b}`).join(", ")}` : null;
}

/**
 * One queue tick. Pure: no I/O.
 * @param {{
 *   issues: { number: number, state?: string, labels?: (string | { name: string })[], body?: string }[],
 *   prs: { number: number, headRefName?: string, files?: (string | { path: string })[], statusCheckRollup?: object[],
 *     gateDescription?: string }[],
 *   sessions: { kind: string, cwd: string }[],
 *   maxLanes?: number,
 *   softPaths?: (string | RegExp)[],
 * }} input every open issue (`state` defaults to OPEN; closed entries are ignored), every open PR, and the background
 *   sessions from `claude agents --json`; `maxLanes` and `softPaths` default to start.mjs's
 * @returns {{ launch: number[], waiting: { number: number, reason: string }[], idle: boolean, lines: string[] }}
 *   `launch` in priority order; `waiting` by PR number, for lane PRs only
 */
export function planTick({ issues = [], prs = [], sessions = [], maxLanes = START_DEFAULTS.maxLanes, softPaths = START_DEFAULTS.softPaths }) {
  const openIssues = issues.filter(isOpen);
  const openNumbers = new Set(openIssues.map((i) => i.number));
  const lanePrs = prs.filter((pr) => Number.isInteger(branchIssue(pr)));
  // A session is a leftover once its issue has closed and it has no open PR; cleanup removes it.
  const withPr = new Set(lanePrs.map(branchIssue));
  const finished = sessions.map(sessionIssue).filter((n) => Number.isInteger(n) && !openNumbers.has(n) && !withPr.has(n));
  const inFlight = inFlightIssues({ prs, sessions, finished });
  const busy = new Set(inFlight);

  const skipped = [];
  const candidates = [];
  for (const issue of openIssues) {
    if (!labelsOf(issue).includes("ready") || busy.has(issue.number)) continue;
    // #136: a lane found nothing to build; the owner closes or rewrites the issue before it can run again.
    const why = labelsOf(issue).includes("needs-owner") ? "needs-owner" : refusal(issue, openNumbers);
    if (why) skipped.push({ number: issue.number, reason: why });
    else candidates.push(issue);
  }

  const claimed = claimedPaths({ openPrs: prs, runningIssues: openIssues.filter((i) => busy.has(i.number)) });
  const { start: launch, skipped: notPicked } = pickStartable({ candidates, claimed, openIssues, maxLanes, inFlightCount: busy.size, softPaths });

  const waiting = lanePrs
    .map((pr) => ({ number: pr.number, reason: waitReason(pr) }))
    .filter((w) => w.reason !== null)
    .sort((a, b) => a.number - b.number);
  const idle = busy.size === 0 && launch.length === 0;

  const lines = [
    ...launch.map((n) => `#${n}: launch`),
    ...[...skipped, ...notPicked].sort((a, b) => a.number - b.number).map((s) => `#${s.number}: skipped: ${s.reason}`),
    ...waiting.map((w) => `PR #${w.number}: needs the owner: ${w.reason}`),
    idle ? "idle: nothing in flight, nothing to launch" : `${busy.size} in flight, ${launch.length} to launch, ${waiting.length} waiting on the owner`,
  ];
  return { launch, waiting, idle, lines };
}

export const TICK_MS = 3 * 60 * 1000;
const IDLE_TICKS = 3;
const READ_FAILURES = 3;
const PR_LIMIT = 1000;
const ISSUE_LIMIT = 1000;
const USAGE = "usage: node scripts/lanes/queue.mjs (no arguments; run it in your own terminal, Ctrl-C stops it)";
const WAIT_LINE = /^PR #(\d+): needs the owner: /;
// `gh pr list` leaves the gate's description out of `statusCheckRollup`; this reads it from each open PR's head.
const GATE_QUERY =
  "query($owner:String!,$name:String!){ repository(owner:$owner,name:$name){ " +
  `pullRequests(states:OPEN,first:100){ nodes { number commits(last:1){ nodes { commit { status { context(name:"${GATE_CONTEXT}"){ description } } } } } } } } }`;

const reason = (err) => String(err?.stderr || err?.message || err).trim().split("\n")[0];
const stamp = (ms) => new Date(ms).toTimeString().slice(0, 8);

// One tick's snapshot for planTick. Throws when any part cannot be read, or a list may be truncated.
function readSnapshot(deps, root) {
  const issues = JSON.parse(deps.gh(["issue", "list", "--state", "open", "--limit", String(ISSUE_LIMIT), "--json", "number,labels,body"]));
  // A blocker missing from a truncated list would read as closed, and a lane's claim would be lost.
  if (issues.length >= ISSUE_LIMIT) throw new Error(`${ISSUE_LIMIT}+ open issues: too many to plan from`);
  const prs = JSON.parse(deps.gh(["pr", "list", "--state", "open", "--limit", String(PR_LIMIT), "--json", "number,headRefName,files,statusCheckRollup"]));
  if (prs.length >= PR_LIMIT) throw new Error(`${PR_LIMIT}+ open PRs: too many to count lanes in flight`);
  const descriptions = gateDescriptions(JSON.parse(deps.gh(["api", "graphql", "-F", "owner={owner}", "-F", "name={repo}", "-f", `query=${GATE_QUERY}`])));
  for (const pr of prs) if (descriptions.has(pr.number)) pr.gateDescription = descriptions.get(pr.number);
  const sessions = JSON.parse(deps.claude(["agents", "--json", "--cwd", root], { cwd: root }));
  if (!Array.isArray(sessions)) throw new Error("claude agents --json printed no list");
  return { issues, prs, sessions };
}

/**
 * The queue CLI. Every TICK_MS: cleanupMerged, then reads issues, PRs and sessions, runs planTick, launches its picks
 * (one attempt each; a failed issue is not tried again this run) and prints its lines, each time-stamped. An owner
 * wait prints once per change. Resolves to the exit code: 0 after three idle ticks in a row, 1 after three failed
 * reads in a row, 2 for an argument, a bad config, or a run inside Claude. `deps` holds fakes in tests: `env`,
 * `gh(args)` and `claude(args, { cwd })` return stdout, `root()` the main checkout, `config()` the parsed
 * lanes.config.json (undefined when missing), `cleanup()` cleanupMerged's lines, `spawn` and `reaperLog(root, n)` for
 * each launched lane's reaper (as in start.mjs), `now()` ms, `sleep(ms)` a promise,
 * `print(line)`.
 */
export async function main(argv, deps = DEFAULT_DEPS) {
  const { env, gh, claude, root, config, cleanup, now, sleep, print } = deps;
  if (argv.length) {
    print(USAGE);
    return 2;
  }
  // ADR 0007 part 3: a lane or any other Claude session must not run the queue.
  if (env.CLAUDECODE) {
    print("queue.mjs refuses to run inside Claude (CLAUDECODE is set): run it in your own terminal");
    return 2;
  }
  let settings;
  try {
    settings = startConfig(config());
  } catch (err) {
    print(`cannot read lanes.config.json: ${reason(err)}`);
    return 2;
  }
  const { maxLanes, softPaths, models } = settings;
  const failedLaunches = new Set();
  const waits = new Map();
  let idleTicks = 0;
  let readFailures = 0;
  for (;;) {
    const at = stamp(now());
    const say = (line) => print(`${at} ${line}`);
    try {
      for (const line of cleanup()) if (line.trim()) say(line);
    } catch (err) {
      say(`cleanup failed: ${reason(err)}`);
    }
    let snapshot;
    let dir;
    try {
      dir = root();
      snapshot = readSnapshot({ gh, claude }, dir);
      readFailures = 0;
    } catch (err) {
      readFailures += 1;
      if (readFailures >= READ_FAILURES) {
        say(`cannot read GitHub or the sessions: ${reason(err)}; three reads failed in a row, stopping`);
        return 1;
      }
      say(`cannot read GitHub or the sessions: ${reason(err)}, retrying next tick`);
      await sleep(TICK_MS);
      continue;
    }
    // An issue whose launch failed stays open (its blockers and ranking still count) but is no longer a candidate.
    const issues = snapshot.issues.map((i) => (failedLaunches.has(i.number) ? { ...i, labels: labelsOf(i).filter((l) => l !== "ready") } : i));
    const plan = planTick({ ...snapshot, issues, maxLanes, softPaths });
    const current = new Map(plan.waiting.map((w) => [w.number, w.reason]));
    for (const line of plan.lines) {
      const number = Number(WAIT_LINE.exec(line)?.[1]);
      if (Number.isInteger(number) && waits.get(number) === current.get(number)) continue;
      say(line);
    }
    waits.clear();
    for (const [n, r] of current) waits.set(n, r);
    const tierOf = new Map(issues.map((i) => [i.number, labelsOf(i).find((l) => l?.startsWith("tier:"))?.slice("tier:".length)]));
    // #344: as /start does (#337), Windows lanes launch with Git's POSIX tools first on PATH; a note says when not.
    const { env: launchEnvironment, note: envNote } = plan.launch.length && deps.launchEnv ? deps.launchEnv() : { env: undefined, note: null };
    for (const n of plan.launch) {
      if (envNote) say(`#${n}: ${envNote}`);
      // One attempt only: a launch that printed no id may still have started, and a retry could start it twice.
      let id = null;
      let why = "no session id in output";
      try {
        id = parseSessionId(claude(launchArgs(n, { tier: tierOf.get(n), models }), launchEnvironment ? { cwd: dir, env: launchEnvironment } : { cwd: dir }));
      } catch (err) {
        why = reason(err);
      }
      if (id) {
        say(`#${n} → ${id}`);
        // ADR 0010: the reaper cleans the lane up after it merges, even once the queue has exited.
        const reaperFailed = startReaper(n, id, deps, dir);
        if (reaperFailed) say(reaperFailed);
        // ADR 0014: the owner-side label marks the running lane; a failure is said and changes nothing else.
        const marked = markRunning(n, deps);
        if (marked.includes(": label not set: ")) say(marked);
      } else {
        failedLaunches.add(n);
        say(`#${n}: launch failed: ${why}, not retried`);
      }
    }
    idleTicks = plan.idle ? idleTicks + 1 : 0;
    if (idleTicks >= IDLE_TICKS) {
      say(`idle for ${IDLE_TICKS} ticks in a row: stopping`);
      return 0;
    }
    await sleep(TICK_MS);
  }
}

// The main checkout, even when run from a worktree: the parent of the shared .git directory.
const repoRoot = () => dirname(execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim());
const run = (cmd) => (args, { cwd, env } = {}) => execFileSync(cmd, args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000, windowsHide: true });

// The launch environment for this machine: asks git where it lives; a git that cannot run counts as not found.
function localLaunchEnv() {
  let out = "";
  try {
    out = execFileSync("git", ["--exec-path"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch {}
  return launchEnv(process.env, process.platform, out);
}

const DEFAULT_DEPS = {
  env: process.env,
  launchEnv: localLaunchEnv,
  gh: run("gh"),
  claude: run("claude"),
  root: repoRoot,
  spawn,
  reaperLog,
  config: () => {
    let text;
    try {
      text = readFileSync(join(repoRoot(), "lanes.config.json"), "utf8");
    } catch (err) {
      if (err.code === "ENOENT") return undefined;
      throw err;
    }
    return JSON.parse(text);
  },
  cleanup: () => cleanupMerged(),
  now: Date.now,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  print: (line) => console.log(line),
};

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
