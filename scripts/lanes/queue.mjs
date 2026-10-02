// scripts/lanes/queue.mjs
// The owner-run lane queue (ADR 0005 as amended by ADR 0006). `planTick` decides one tick from a snapshot: which
// ready issues launch now, which lane PRs wait on the owner, and whether the queue is idle. Pure: `main` reads
// GitHub and the sessions, cleans up merged lanes and launches, every 3 minutes (every 15 once idle) until Ctrl+C.
// Usage: node scripts/lanes/queue.mjs, in the owner's own terminal (ADR 0026: it sustains itself).
// Exit 0: Ctrl+C (SIGINT or SIGTERM). 2: an argument, a bad lanes.config.json, or run inside Claude (CLAUDECODE).
// 3: the lanes scripts changed since the queue started (#535) but a restart precondition does not hold (not on main,
// a dirty checkout, HEAD is not origin/main after the pull). 4: `git pull --ff-only` could not fast-forward.
// 10: only between the child and the supervisor, meaning "scripts changed, pulled, start the next child".
// Exit 1 is retired: a failed GitHub read backs off and retries.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseBlockedBy } from "./blockers.mjs";
import { cleanupMerged, laneWorkLeft, SESSION_ID, parseWorktrees, removeLaneWorktree, waitForStop } from "./cleanup.mjs";
import { GATE_CONTEXT, TEAM_REQUIRED_MESSAGE, laneIssueOf, parseIssueForm } from "./lib.mjs";
import { issuePaths } from "./paths.mjs";
import { claimedPaths, pickStartable } from "./pick.mjs";
import { loadBudget } from "./lane-cost.mjs";
import { appendStarts, budgetConfig, inFlightIssues, isEntryScript, startDecisions, deadLaneSession, launchLane, localLaunchEnv, launchRefusal, reaperLog, START_DEFAULTS, startConfig, teamSteps } from "./start.mjs";
import { QUEUE_EVENTS, formatAge, gateDescriptions, gateSince, liveLanes, mergeGroupFailures, prStage, queueFailedNote, queueRemovals, stalledLanes } from "./status.mjs";

// The status.mjs stages a lane PR waits on the owner in: a failing check or review, a failing lanes/gate, or a gate
// waiting on owner.
const WAITING_STAGES = new Set(["failing", "contract", "owner", "conflict"]);
// #444: the stages in which a lane owes the PR something, so a dead lane is worth resuming: a failing check, no
// lanes/gate yet, or a gate waiting for a reviewer's status.
const RESUMABLE_STAGES = new Set(["failing", "starting", "gate"]);
const labelsOf = (issue) => (issue.labels ?? []).map((l) => (typeof l === "string" ? l : l?.name));
const isOpen = (issue) => (issue.state ?? "OPEN") === "OPEN";
const branchIssue = (pr) => Number(String(pr.headRefName ?? "").match(/^issue-(\d+)-/)?.[1] ?? NaN);

// Why a lane PR waits on the owner, or null, from status.mjs's stage. The gate's description falls back to
// `gateDescription`, which `gh pr list` leaves out of the rollup.
function waitReason(pr) {
  const { stage, note } = prStage(pr, undefined, pr.gateDescription);
  if (!WAITING_STAGES.has(stage)) return null;
  return note || `${GATE_CONTEXT} failed`;
}

// Why a ready issue cannot be a candidate, or null. Blockers count as open only when open in the snapshot.
function refusal(issue, openNumbers) {
  // #522: the owner claims an issue it will do itself by assigning it.
  // An entry with no readable login still counts as a claim, and a non-list value is one too: fail closed.
  const raw = issue.assignees ?? [];
  const assignees = (Array.isArray(raw) ? raw : [null]).map((a) => (typeof a === "string" ? a : a?.login) || "unknown");
  if (assignees.length) return `assigned to ${assignees.join(", ")}`;
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
 * @returns {{ launch: number[], waiting: { number: number, reason: string }[], idle: boolean, lines: string[], skipped: { number: number, reason: string }[] }}
 *   `launch` in priority order; `waiting` by PR number, for lane PRs only
 */
export function planTick({ issues = [], prs = [], sessions = [], maxLanes = START_DEFAULTS.maxLanes, softPaths = START_DEFAULTS.softPaths, budgetOver = false }) {
  const openIssues = issues.filter(isOpen);
  const openNumbers = new Set(openIssues.map((i) => i.number));
  const lanePrs = prs.filter((pr) => Number.isInteger(branchIssue(pr)));
  // A session is a leftover once its issue has closed and it has no open PR; cleanup removes it.
  const withPr = new Set(lanePrs.map(branchIssue));
  const finished = sessions.map(laneIssueOf).filter((n) => Number.isInteger(n) && !openNumbers.has(n) && !withPr.has(n));
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
  const { start: picked, skipped: notPicked } = pickStartable({ candidates, claimed, openIssues, maxLanes, inFlightCount: busy.size, softPaths });
  // #390: over the token budget nothing launches, yet the picks still count as work left, so the queue waits instead of going idle.
  const launch = budgetOver ? [] : picked;

  const waiting = lanePrs
    .map((pr) => ({ number: pr.number, reason: waitReason(pr) }))
    .filter((w) => w.reason !== null)
    .sort((a, b) => a.number - b.number);
  const idle = busy.size === 0 && picked.length === 0;

  const lines = [
    ...launch.map((n) => `#${n}: launch`),
    ...[...skipped, ...notPicked].sort((a, b) => a.number - b.number).map((s) => `#${s.number}: skipped: ${s.reason}`),
    ...waiting.map((w) => `PR #${w.number}: needs the owner: ${w.reason}`),
    idle ? "idle: nothing in flight, nothing to launch" : `${busy.size} in flight, ${launch.length} to launch, ${waiting.length} waiting on the owner`,
  ];
  return { launch, waiting, idle, lines, skipped: [...skipped, ...notPicked] };
}

/**
 * #383: the owner's digest of the lane PRs waiting on them. Pure. One block: a header, a line per PR (oldest first) with
 * its number, title, age since it began waiting and what the owner must decide, with the PR's files URL when it waits
 * for the owner's review. Empty when nothing waits. A PR's age runs from its gate
 * status's time (`gateSince`), else from `seen` (PR number → ms it was first seen waiting), else from `now`.
 * @param {{ number: number, title?: string, gateSince?: number }[]} prs the snapshot's open PRs
 * @param {{ number: number, reason: string }[]} waiting planTick's `waiting`
 * @returns {string[]} lines, without a time stamp
 */
export function waitingDigest(prs, waiting, now, seen = new Map()) {
  const byNumber = new Map(prs.map((pr) => [pr.number, pr]));
  const rows = waiting.map((w) => {
    const pr = byNumber.get(w.number) ?? {};
    return { ...w, pr, since: pr.gateSince ?? seen.get(w.number) ?? now };
  });
  if (!rows.length) return [];
  rows.sort((a, b) => a.since - b.since || a.number - b.number);
  // PR text is untrusted: control characters (ANSI escapes) are dropped before it reaches the owner's terminal.
  const plain = (text) => String(text ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
  const title = (pr) => plain(pr.title);
  const ownerWait = (r) => prStage(r.pr, undefined, r.pr.gateDescription).stage === "owner";
  // ADR 0021: a PR waiting on the owner's review gets its GitHub files URL.
  const reviewUrl = (r) => (ownerWait(r) && typeof r.pr.url === "string" && r.pr.url.startsWith("https://") ? ` — ${plain(r.pr.url)}/files` : "");
  return [
    `waiting on you (${rows.length}):`,
    ...rows.map((r) => `  #${r.number} ${title(r.pr)} — waiting ${formatAge(r.since, now)} — ${plain(r.reason)}${reviewUrl(r)}`),
  ];
}

/**
 * #382: which lanes to recover this tick. Pure. A lane is a ready, open issue with no open PR whose newest background
 * session is stalled (`stalled`: issue → minutes silent, from status.mjs's stalledLanes) or idle with no prompt
 * pending (ended without a PR). An issue with a marker is `again` (reported, never retried), unless the marker names
 * this very session, which was already handled (its work was left for the owner). #444: a ready issue whose open PR
 * still owes a check or review (stage failing, starting or gate) and whose newest session is gone or idle also
 * comes back, with `resume: true` and the PR's `branch`, to be relaunched in its own worktree rather than removed.
 * @param {{ issues: object[], prs: object[], sessions: object[], stalled?: Map<number, number>, marker?: (n: number) => { session?: string } | null }} input
 * @returns {{ number: number, id: string, reason: string, again: boolean }[]} by issue number
 */
export function planRecovery({ issues = [], prs = [], sessions = [], stalled = new Map(), marker = () => null }) {
  const withPr = new Set(prs.map(branchIssue));
  const ready = new Set(issues.filter((i) => isOpen(i) && labelsOf(i).includes("ready")).map((i) => i.number));
  const newest = new Map();
  for (const s of sessions) {
    const n = laneIssueOf(s);
    // An id that is not a plain token could be read as an option by `claude stop` or `claude rm`.
    if (!n || typeof s.id !== "string" || !SESSION_ID.test(s.id) || (newest.get(n)?.startedAt ?? -1) > (s.startedAt ?? 0)) continue;
    newest.set(n, s);
  }
  const out = [];
  for (const [n, s] of newest) {
    if (!ready.has(n) || withPr.has(n)) continue;
    let reason = null;
    if (stalled.has(n)) reason = `stalled for ${stalled.get(n)} minutes`;
    else if (s.status === "idle" && s.state !== "blocked") reason = "session ended with no open PR";
    if (!reason) continue;
    const marked = marker(n);
    if (marked?.session === s.id) continue;
    out.push({ number: n, id: s.id, cwd: s.cwd, reason, again: Boolean(marked) });
  }
  // #444: a ready issue whose lane session is dead but whose open PR still owes a check or review is resumed in place.
  const resumed = new Set();
  for (const pr of prs) {
    const n = branchIssue(pr);
    // A fork's PR may reuse a lane's branch name; only the repo's own PR names a lane's worktree.
    if (!ready.has(n) || resumed.has(n) || pr.isCrossRepository === true) continue;
    const { dead, session } = deadLaneSession(sessions, n);
    if (!dead) continue;
    const { stage, note } = prStage(pr, undefined, pr.gateDescription);
    if (!RESUMABLE_STAGES.has(stage)) continue;
    resumed.add(n);
    const marked = marker(n);
    if (session && marked?.session === session.id) continue;
    out.push({ number: n, id: session?.id ?? null, cwd: session?.cwd, branch: pr.headRefName, reason: `dead lane with open PR #${pr.number} (${note})`, again: Boolean(marked), resume: true });
  }
  return out.sort((a, b) => a.number - b.number);
}

export const TICK_MS = 3 * 60 * 1000;
// ADR 0026 part 4: after IDLE_TICKS idle ticks the tick lengthens to IDLE_TICK_MS; picked work returns it to TICK_MS.
export const IDLE_TICK_MS = 15 * 60 * 1000;
const IDLE_TICKS = 3;
// ADR 0026 part 5: a failed read backs off 1, 2, 4, 8 ... minutes, capped at 15.
export const BACKOFF_CAP_MS = 15 * 60 * 1000;
export const backoffMs = (failures) => Math.min(60_000 * 2 ** (Math.max(failures, 1) - 1), BACKOFF_CAP_MS);
// ADR 0026 part 3: the exit code a child uses to ask its supervisor for the next child.
export const RESTART_CODE = 10;
const STOP = "QUEUE_STOP";
const PR_LIMIT = 1000;
const ISSUE_LIMIT = 1000;
const USAGE = "usage: node scripts/lanes/queue.mjs (no arguments; run it in your own terminal, Ctrl-C stops it)";
const WAIT_LINE = /^PR #(\d+): needs the owner: /;
// `gh pr list` leaves the gate's description out of `statusCheckRollup`; this reads it from each open PR's head.
const GATE_QUERY =
  "query($owner:String!,$name:String!){ repository(owner:$owner,name:$name){ " +
  `pullRequests(states:OPEN,first:100){ nodes { number ${QUEUE_EVENTS} commits(last:1){ nodes { commit { status { context(name:"${GATE_CONTEXT}"){ description createdAt } } } } } } } } }`;

const reason = (err) => String(err?.stderr || err?.message || err).trim().split("\n")[0];
const stamp = (ms) => new Date(ms).toTimeString().slice(0, 8);

// #535: the paths a running queue has loaded. A directory pathspec ends in a slash so `scripts/lanes-other` never matches.
export const LOADED_PATHS = ["scripts/lanes/", "lanes.config.json"];

// Fetches origin/main and returns `{ old, now }` when the loaded paths differ between the queue's start commit and it,
// else null. Throws when the fetch, the ref or the diff cannot be read.
function scriptsChanged(git, startedAt) {
  git(["fetch", "--quiet", "origin", "main"]);
  const now = git(["rev-parse", "origin/main"]).trim();
  if (now === startedAt) return null;
  return git(["diff", "--name-only", startedAt, now, "--", ...LOADED_PATHS]).trim() ? { old: startedAt, now } : null;
}

// ADR 0026 part 2: once the lanes scripts are stale, pull and restart only when the branch is main, the checkout is
// clean, the pull fast-forwards and HEAD then equals origin/main. Returns { code, line } for a stop (3, or 4 for a pull
// that cannot fast-forward) or { restart: { old, now } }.
function pullForRestart(git, stale) {
  const stop = (code, why) => ({ code, line: `lanes scripts changed (${stale.old.slice(0, 7)}..${stale.now.slice(0, 7)}) but cannot restart: ${why}; fix it, then start the queue again` });
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  if (branch !== "main") return stop(3, `the checkout is on ${branch || "no branch"}, not main`);
  if (git(["status", "--porcelain"]).trim()) return stop(3, "the checkout has uncommitted changes");
  try {
    git(["pull", "--ff-only"]);
  } catch (err) {
    return stop(4, `git pull --ff-only failed (${reason(err)})`);
  }
  const head = git(["rev-parse", "HEAD"]).trim();
  if (head !== git(["rev-parse", "origin/main"]).trim()) return stop(3, "HEAD is not origin/main after the pull");
  return { restart: { old: stale.old, now: head } };
}

// One tick's snapshot for planTick. Throws when any part cannot be read, or a list may be truncated.
function readSnapshot(deps, root) {
  const issues = JSON.parse(deps.gh(["issue", "list", "--state", "open", "--limit", String(ISSUE_LIMIT), "--json", "number,labels,body,assignees"]));
  // A blocker missing from a truncated list would read as closed, and a lane's claim would be lost.
  if (issues.length >= ISSUE_LIMIT) throw new Error(`${ISSUE_LIMIT}+ open issues: too many to plan from`);
  const prs = JSON.parse(deps.gh(["pr", "list", "--state", "open", "--limit", String(PR_LIMIT), "--json", "number,title,url,headRefName,files,mergeable,statusCheckRollup,isCrossRepository"]));
  if (prs.length >= PR_LIMIT) throw new Error(`${PR_LIMIT}+ open PRs: too many to count lanes in flight`);
  const gate = JSON.parse(deps.gh(["api", "graphql", "-F", "owner={owner}", "-F", "name={repo}", "-f", `query=${GATE_QUERY}`]));
  const descriptions = gateDescriptions(gate);
  const since = gateSince(gate);
  for (const pr of prs) {
    if (descriptions.has(pr.number)) pr.gateDescription = descriptions.get(pr.number);
    if (since.has(pr.number)) pr.gateSince = since.get(pr.number);
  }
  const sessions = JSON.parse(deps.claude(["agents", "--json", "--cwd", root], { cwd: root }));
  if (!Array.isArray(sessions)) throw new Error("claude agents --json printed no list");
  return { issues, prs, sessions, removals: queueRemovals(gate) };
}

// #621: a PR the merge queue removed (and that is open and not back in the queue), one line per removal. The failed
// check is read from the merge group's runs only when a removal is new; a run list that cannot be read leaves it out.
function removalLines(snapshot, deps, told) {
  const lines = [];
  const fresh = [...snapshot.removals].filter(([n, r]) => told.get(n) !== r.at);
  if (!fresh.length) return lines;
  let failures = new Map();
  try {
    failures = mergeGroupFailures(JSON.parse(deps.gh(["run", "list", "--event", "merge_group", "--status", "failure", "--limit", "50", "--json", "databaseId,headBranch,workflowName,url,createdAt"])));
  } catch {}
  for (const [n, r] of fresh) {
    told.set(n, r.at);
    const title = String(snapshot.prs.find((p) => p.number === n)?.title ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
    lines.push(`#${n} [queue failed] ${title} — ${queueFailedNote(r, failures.get(n))}`);
  }
  return lines;
}

// #382: stops each lane planRecovery names and, when its worktree is clean and fully pushed, removes it so the tick's
// normal launch path relaunches the issue (the removed session leaves `snapshot.sessions`). Unpushed or uncommitted
// work is left and said. Each issue gets one attempt per run (`attempted`) and a stalled-again line once (`told`);
// a marker is written before anything is removed, so a crash cannot allow a second relaunch.
// #444: a dead lane with an open PR is not removed: it is returned as `{ number, cwd, id, reason }` to be relaunched in
// its own worktree, unless that worktree holds work that is not pushed, which is left and said.
function recoverLanes(snapshot, { deps, dir, say, attempted, told }) {
  const { recovery, claude } = deps;
  const resumes = [];
  let stalled;
  try {
    stalled = recovery.stalled(snapshot.sessions, dir);
  } catch (err) {
    say(`stall check failed: ${reason(err)}`);
    return resumes;
  }
  for (const { number: n, id, cwd, branch, reason: why, again, resume } of planRecovery({ ...snapshot, stalled, marker: recovery.marker.read })) {
    if (again) {
      if (!told.has(n)) say(`#${n}: stalled again after recovery: ${why}`);
      told.add(n);
      continue;
    }
    if (attempted.has(n)) continue;
    if (resume) {
      try {
        const tree = recovery.worktree(n, cwd, branch);
        const left = tree ? recovery.workLeft(tree) : "worktree not found";
        if (left) {
          attempted.add(n);
          say(tree ? `#${n}: not recovered: unsaved work in ${tree.path}` : `#${n}: dead lane with open PR, worktree not found, left for the owner`);
        } else resumes.push({ number: n, cwd: tree.path, id, reason: why });
      } catch (err) {
        attempted.add(n);
        say(`#${n}: recovery failed: ${reason(err)}`);
      }
      continue;
    }
    attempted.add(n);
    try {
      claude(["stop", id], { cwd: dir });
      if (!recovery.waitStopped(id)) {
        say(`#${n}: could not stop session ${id}, left for the owner`);
        continue;
      }
      // Fail closed: a worktree that cannot be found or read is never removed from under a session.
      const tree = recovery.worktree(n, cwd);
      const left = tree ? recovery.workLeft(tree) : "worktree not found";
      recovery.marker.write(n, { issue: n, session: id, reason: why, time: new Date(deps.now()).toISOString(), outcome: left ? "left" : "relaunch" });
      if (left) {
        say(left === "worktree not found" ? `#${n}: stalled, worktree not found, left for the owner` : `#${n}: stalled with unpushed work, left for the owner`);
        continue;
      }
      recovery.remove(id, tree);
      snapshot.sessions = snapshot.sessions.filter((s) => s.id !== id);
      say(`#${n}: ${why}; stopped and removed, relaunching once`);
    } catch (err) {
      say(`#${n}: recovery failed: ${reason(err)}`);
    }
  }
  return resumes;
}

/**
 * The queue CLI. Every TICK_MS: cleanupMerged, then reads issues, PRs and sessions, runs planTick, launches its picks
 * (one attempt each; a failed issue is not tried again this run) and prints its lines, each time-stamped. An owner
 * wait prints once per change. Resolves to the exit code (ADR 0026): 0 when a `sleep` rejects with `code: "QUEUE_STOP"`
 * (Ctrl+C), 2 for an argument, a bad config, or a run inside Claude or from a lane worktree (start.mjs's launchRefusal
 * on `env` and `deps.file`, the script's own URL; with no `file` only `env` is checked), 3 or 4 for scripts that are stale with no restart,
 * 10 for a restart (child only). With `deps.runChild(argv, env)` and no LANES_QUEUE_CHILD in `env` it is the supervisor:
 * it spawns children until one exits with other than 10. `deps` holds fakes in tests: `env`,
 * `gh(args)` and `claude(args, { cwd })` return stdout, `root()` the main checkout, `config()` the parsed
 * lanes.config.json (undefined when missing), `cleanup()` cleanupMerged's lines, `spawn` and `reaperLog(root, n)` for
 * each launched lane's reaper (as in start.mjs), `team` the team profile's steps (start.mjs's launchLane, #556), `now()`
 * ms, `sleep(ms)` a promise, `print(line)`.
 */
export async function main(argv, deps = DEFAULT_DEPS) {
  const { env, gh, claude, root, config, cleanup, now, sleep, print } = deps;
  // ADR 0030 parts 1 and 3: a lane, any other Claude session, or a copy under .claude/worktrees must not run the queue.
  const refused = launchRefusal(env, deps.file);
  if (refused) {
    print(refused);
    return 2;
  }
  if (argv.length) {
    print(USAGE);
    return 2;
  }
  // ADR 0026 part 3: the first process only supervises; each child runs the loop below and exits RESTART_CODE to be replaced.
  if (deps.runChild && !env.LANES_QUEUE_CHILD) {
    for (let restarts = 0; ; restarts += 1) {
      let code;
      try {
        code = await deps.runChild(argv, { ...env, LANES_QUEUE_CHILD: "1", LANES_QUEUE_RESTARTS: String(restarts) });
      } catch (err) {
        print(`cannot start the queue: ${reason(err)}`);
        return 2;
      }
      if (code !== RESTART_CODE) return code;
    }
  }
  const restartNumber = Number(env.LANES_QUEUE_RESTARTS) + 1 || 1;
  let settings;
  try {
    settings = startConfig(config());
  } catch (err) {
    // ADR 0025: the team-profile refusal is one message, printed as is.
    print(String(err?.message).startsWith(TEAM_REQUIRED_MESSAGE) ? err.message : `cannot read lanes.config.json: ${reason(err)}`);
    return 2;
  }
  let caps;
  try {
    caps = budgetConfig(config());
  } catch (err) {
    print(`cannot read lanes.config.json: ${reason(err)}`);
    return 2;
  }
  const { maxLanes, softPaths, models, identity } = settings;
  // #535: Node loads the lanes scripts once, so the commit they came from is recorded now and compared every tick.
  let startedAt = null;
  if (deps.git) {
    try {
      startedAt = deps.git(["rev-parse", "HEAD"]).trim();
    } catch (err) {
      print(`cannot read the lanes scripts commit: ${reason(err)}`);
      return 2;
    }
  }
  let budgetOver = false;
  let budgetFailed = false;
  let overLane = new Set();
  const failedLaunches = new Set();
  const waits = new Map();
  const skipSeen = new Map();
  const firstWaiting = new Map();
  const attempted = new Set();
  const told = new Set();
  const removalTold = new Map();
  let idleTicks = 0;
  let readFailures = 0;
  for (;;) {
    const at = stamp(now());
    // #444: check names and gate text in a line are external, so control characters (ANSI escapes) never reach the terminal.
    const say = (line) => print(`${at} ${String(line).replace(/[\u0000-\u001f\u007f-\u009f]/g, "")}`);
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
      const delay = backoffMs(readFailures);
      say(`cannot read GitHub or the sessions: ${reason(err)}, retrying in ${delay / 60_000} min`);
      if (await stopped(sleep, delay)) return 0;
      continue;
    }
    // #535: nothing launches, recovers or resumes with lanes scripts older than origin/main's; a fetch that fails launches nothing.
    if (deps.git) {
      let stale;
      try {
        stale = scriptsChanged(deps.git, startedAt);
      } catch (err) {
        say(`cannot fetch origin/main: ${reason(err)}, launching nothing this tick`);
        if (await stopped(sleep, TICK_MS)) return 0;
        continue;
      }
      if (stale) {
        let outcome;
        try {
          outcome = pullForRestart(deps.git, stale);
        } catch (err) {
          outcome = { code: 3, line: `lanes scripts changed (${stale.old.slice(0, 7)}..${stale.now.slice(0, 7)}) but cannot restart: ${reason(err)}; fix it, then start the queue again` };
        }
        if (outcome.restart) {
          say(`queue: lanes scripts changed (${outcome.restart.old.slice(0, 7)} -> ${outcome.restart.now.slice(0, 7)}), pulled, restarting (#${restartNumber})`);
          return RESTART_CODE;
        }
        say(outcome.line);
        return outcome.code;
      }
    }
    const resumes = deps.recovery ? recoverLanes(snapshot, { deps, dir, say, attempted, told }) : [];
    // An issue whose launch failed stays open (its blockers and ranking still count) but is no longer a candidate.
    const issues = snapshot.issues.map((i) => (failedLaunches.has(i.number) ? { ...i, labels: labelsOf(i).filter((l) => l !== "ready") } : i));
    // #390: a budget that cannot be read never stops the queue; it says so once and launches as before.
    let budget = null;
    if (deps.budget) {
      try {
        budget = deps.budget(snapshot.sessions, dir, caps);
      } catch (err) {
        if (!budgetFailed) say(`budget: cannot be read (${reason(err)}), not enforced`);
        budgetFailed = true;
      }
      if (budget) budgetFailed = false;
    }
    if (budget) {
      if (budget.over !== budgetOver) say(budget.over ? `budget: ${budget.spent24h} of ${budget.perNightTokens} tokens in 24 h, not launching` : `budget: ${budget.spent24h} of ${budget.perNightTokens} tokens in 24 h, launching again`);
      budgetOver = budget.over;
      // A lane over its own cap is said once and left running.
      for (const n of budget.lanesOver) if (!overLane.has(n)) say(`#${n}: over its ${caps.perLaneTokens} token budget, left running`);
      overLane = new Set(budget.lanesOver);
    }
    const plan = planTick({ ...snapshot, issues, maxLanes, softPaths, budgetOver });
    // #383: the waiting PRs print as one block, only in a tick where a PR started or stopped waiting or its reason changed.
    const current = new Map(plan.waiting.map((w) => [w.number, w.reason]));
    for (const line of plan.lines) if (!WAIT_LINE.test(line)) say(line);
    const changed = current.size !== waits.size || [...current].some(([n, r]) => waits.get(n) !== r);
    for (const line of removalLines(snapshot, deps, removalTold)) say(line);
    if (changed) for (const line of waitingDigest(snapshot.prs, plan.waiting, now(), firstWaiting)) say(line);
    for (const n of [...firstWaiting.keys()]) if (!current.has(n)) firstWaiting.delete(n);
    for (const n of current.keys()) if (!firstWaiting.has(n)) firstWaiting.set(n, now());
    waits.clear();
    for (const [n, r] of current) waits.set(n, r);
    // #483: a started issue and each skip is logged; a skip is logged again only when its reason changes, not every tick.
    const decided = startDecisions({ started: plan.launch, skipped: plan.skipped.filter((s) => skipSeen.get(s.number) !== s.reason), at: new Date(now()).toISOString() });
    skipSeen.clear();
    for (const s of plan.skipped) skipSeen.set(s.number, s.reason);
    try {
      deps.recordStarts?.(dir, decided);
    } catch {
      // The log is evidence for phase 2, not a gate.
    }
    const tierOf = new Map(issues.map((i) => [i.number, labelsOf(i).find((l) => l?.startsWith("tier:"))?.slice("tier:".length)]));
    // #344: as the retired /start did (#337), Windows lanes launch with Git's POSIX tools first on PATH; a note says when not.
    // #444: over the token budget a dead lane waits too. Its marker is written before it launches, so a crash cannot
    // allow a second relaunch, and the launch runs in the lane's own worktree, where /lane continues its PR.
    const resuming = budgetOver ? [] : resumes;
    const labelsByIssue = new Map(issues.map((i) => [i.number, labelsOf(i).filter(Boolean)]));
    const scopeByIssue = new Map(issues.map((i) => [i.number, issuePaths(parseIssueForm(i.body ?? "").fields)]));
    const launches = [...resuming.map((r) => ({ n: r.number, cwd: r.cwd })), ...plan.launch.map((n) => ({ n, cwd: dir }))];
    const { env: launchEnvironment, note: envNote } = launches.length && deps.launchEnv ? deps.launchEnv() : { env: undefined, note: null };
    for (const { n, cwd } of launches) {
      const resume = resuming.find((r) => r.number === n);
      if (resume) {
        attempted.add(n);
        try {
          deps.recovery.marker.write(n, { issue: n, session: resume.id, reason: resume.reason, time: new Date(now()).toISOString(), outcome: "resume" });
        } catch (err) {
          say(`#${n}: recovery failed: ${reason(err)}`);
          continue;
        }
        say(`#${n}: ${resume.reason}; resuming once`);
      }
      // #556: start.mjs's one-lane launcher: one attempt, then the reaper (ADR 0010) and the running label (ADR 0014); under
      // team (ADR 0019) the App-only environment, --settings, strict MCP and the token refresher, or no launch at all.
      // #577: the issue's labels, so `model:opus` launches on Opus (resumed lanes too).
      const launched = launchLane(n, deps, { tier: tierOf.get(n), models, labels: labelsByIssue.get(n) ?? [], identity, root: dir, cwd, env: launchEnvironment, envNote, scope: scopeByIssue.get(n) ?? [] });
      for (const line of launched.lines) say(line);
      if (launched.failed) failedLaunches.add(n);
    }
    idleTicks = plan.idle ? idleTicks + 1 : 0;
    // ADR 0026 part 4: idle lengthens the tick, it never stops the queue, and prints nothing.
    if (await stopped(sleep, idleTicks >= IDLE_TICKS ? IDLE_TICK_MS : TICK_MS)) return 0;
  }
}

// Sleeps `ms`; true when the sleep was ended by a stop request (a rejection with code QUEUE_STOP), which exits 0.
async function stopped(sleep, ms) {
  try {
    await sleep(ms);
    return false;
  } catch (err) {
    if (err?.code === STOP) return true;
    throw err;
  }
}

// The main checkout, even when run from a worktree: the parent of the shared .git directory.
const repoRoot = () => dirname(execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim());
const run = (cmd) => (args, { cwd, env } = {}) => execFileSync(cmd, args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000, windowsHide: true });

// #382: the stall, worktree and marker effects of recovery on this machine. Markers live in the main checkout's
// .lanes/queue-recover/<N>.json, and are removed by hand to allow another recovery.
const markerFile = (n) => join(repoRoot(), ".lanes", "queue-recover", `${n}.json`);
const DEFAULT_RECOVERY = {
  stalled: (agents, root) => stalledLanes(agents, root),
  // The lane's own worktree: the one at the session's cwd, on an issue-N-* branch. Anything else is not found.
  // #444: a dead lane's session may be gone, so its PR's branch names the worktree too.
  worktree: (n, cwd, branch) => {
    const same = (a, b) => String(a).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() === String(b).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    const tree = parseWorktrees(run("git")(["worktree", "list", "--porcelain"])).find((t) => !t.main && ((cwd && same(t.path, cwd)) || (branch && t.branch === branch)) && Number(/^issue-(\d+)-./.exec(t.branch ?? "")?.[1]) === n);
    return tree ? { path: tree.path, branch: tree.branch } : null;
  },
  workLeft: (tree) => laneWorkLeft(tree.path, tree.branch),
  // `claude agents --json` is asked from the repo root, as readSnapshot asks it.
  waitStopped: (id) => waitForStop(id, { run: (cmd, args) => run(cmd)(cmd === "claude" && args[0] === "agents" ? [...args, "--cwd", repoRoot()] : args), sleep: (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }),
  remove: (id, tree) => removeLaneWorktree({ id, ...tree }, (cmd, args) => run(cmd)(args)),
  marker: {
    read: (n) => {
      let text;
      try {
        text = readFileSync(markerFile(n), "utf8");
      } catch (err) {
        if (err.code === "ENOENT") return null;
        return {};
      }
      // A marker that exists but cannot be read still counts as marked: it never allows a second recovery.
      try {
        return JSON.parse(text) ?? {};
      } catch {
        return {};
      }
    },
    write: (n, record) => {
      mkdirSync(dirname(markerFile(n)), { recursive: true });
      writeFileSync(markerFile(n), `${JSON.stringify(record, null, 2)}\n`);
    },
  },
};

const DEFAULT_DEPS = {
  env: process.env,
  file: import.meta.url,
  launchEnv: localLaunchEnv,
  recovery: DEFAULT_RECOVERY,
  gh: run("gh"),
  git: (args) => run("git")(args, { cwd: repoRoot() }),
  claude: run("claude"),
  budget: (agents, root, caps) => loadBudget({ root, lanes: liveLanes(agents, root), ...caps }),
  root: repoRoot,
  spawn,
  reaperLog,
  // #556: the team profile's owner-side steps; the key comes from this shell's LANES_APP_KEY_FILE.
  team: teamSteps,
  recordStarts: appendStarts,
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
  // ADR 0026 part 3: one child at a time, sharing this console; a signal-ended child counts as Ctrl+C.
  runChild: (argv, env) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...argv], { stdio: "inherit", env });
      child.on("error", reject);
      child.on("exit", (code) => resolve(code ?? 0));
    }),
};

if (isEntryScript(process.argv[1], import.meta.url)) {
  // Ctrl+C reaches the supervisor and its child through the shared console; each ends the run with exit 0.
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => process.exit(0));
  process.exitCode = await main(process.argv.slice(2));
}
