// /status and the nightly digest: what waits on the owner, what is in flight, what is ready, what merged.
// Usage: node scripts/lanes/status.mjs [--since 24h] [--json] [--waiting] [--starts <days>]
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GATE_CONTEXT, identityRefusal, laneIssueOf, loadConfig, nativeCodeOwnerApproval, parseCodeOwnerUsers, parseIssueForm, parsePrBody, reviewContext, reviewerNames, trustedStatuses } from "./lib.mjs";
import { issuePaths, pathsOverlap } from "./paths.mjs";
import { BUDGET_DEFAULTS, budgetConfig, loadBudget, projectFolder } from "./lane-cost.mjs";
import { claimedPaths } from "./pick.mjs";

const ISSUE_LIMIT = 1000;
const FAILED = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"]);
export const CONFLICT_NOTE = "conflict: rebase needed";
// The `lanes/gate` description's start while a team PR waits on a code owner's native review (ADR 0021).
export const TEAM_OWNER_WAIT = "waiting for a code-owner review in GitHub";

// A PR that enters the merge queue loses its `autoMergeRequest`, so queue membership is checked first.
// `gh pr list` leaves StatusContext descriptions out of `statusCheckRollup`, so the gate's comes from `gateDescription`.
// queue.mjs derives its owner waits from this too, so the queue and /status never disagree (#122).
export function prStage(pr, queuePosition, gateDescription) {
  if (queuePosition !== undefined) return { stage: "queued", note: `in merge queue, position ${queuePosition}` };
  // A merge conflict blocks the merge whatever the checks say; `UNKNOWN` (GitHub still computing) says nothing.
  if (pr.mergeable === "CONFLICTING") return { stage: "conflict", note: CONFLICT_NOTE };
  const rollup = pr.statusCheckRollup ?? [];
  const failing = rollup
    .filter((c) => c.context !== GATE_CONTEXT && (FAILED.has(c.conclusion) || FAILED.has(c.state)))
    .map((c) => c.name ?? c.context);
  if (failing.length) return { stage: "failing", note: `failing: ${failing.join(", ")}` };
  const gate = rollup.find((c) => c.context === GATE_CONTEXT);
  if (!gate) return { stage: "starting", note: "no lanes/gate yet" };
  if (gate.state === "SUCCESS") return pr.autoMergeRequest ? { stage: "queued", note: "auto-merge on" } : { stage: "ready", note: "auto-merge is off" };
  const description = gate.description ?? gateDescription ?? "";
  if (gate.state === "FAILURE" || gate.state === "ERROR") return { stage: "contract", note: description };
  // A code-owner review in GitHub (ADR 0021).
  if (description.startsWith(TEAM_OWNER_WAIT)) return { stage: "owner", note: description };
  // The gate waits for a reviewer's status: the lane owes it, not the owner, whatever the body asks for.
  if (/^waiting for review\/\S/.test(description)) return { stage: "gate", note: description };
  return { stage: "review", note: description };
}

// `gh pr list`'s rollup carries no status creator, so each PR's `review/*` entries are checked against the creators in
// STATUS_QUERY's reply: lib's `trustedStatuses` drops a bot's (except the configured lane bot's for a non-owner
// reviewer under team), and an entry with no readable creator, or a PR missing from the reply, is untrusted. Every
// other entry is kept. A `lanes/gate` status is trusted as posted (it comes from the gate workflow's own bot, so
// its author cannot be filtered): the risk ADR 0004 part 3 accepts.
export function trustedRollups(prs, reply, config) {
  const byPr = new Map();
  for (const node of reply?.data?.repository?.pullRequests?.nodes ?? []) {
    const contexts = node?.commits?.nodes?.[0]?.commit?.status?.contexts;
    const statuses = (Array.isArray(contexts) ? contexts : []).map((c) => ({
      context: c?.context,
      state: c?.state,
      creator: c?.creator ? { login: c.creator.login, type: c.creator.__typename } : undefined,
    }));
    byPr.set(node.number, trustedStatuses(statuses, config?.identity, reviewerNames(config)));
  }
  return prs.map((pr) => {
    const trusted = byPr.get(pr.number) ?? [];
    const keep = (c) => !String(c?.context ?? "").startsWith("review/") || trusted.some((t) => t.context === c.context && t.state === c.state);
    return { ...pr, statusCheckRollup: (pr.statusCheckRollup ?? []).filter(keep) };
  });
}

// `team` is `{ owners, identity }`: the PR's native review on its head, as the gate reads it (`gh pr list`'s
// `latestReviews`, `author` and `headRefOid`); an unreadable one, or a missing `team`, is no approval.
function ownerApproved(pr, team) {
  if (!team) return false;
  const reviews = (pr.latestReviews ?? []).map((r) => ({ user: { login: r?.author?.login }, state: r?.state, commit_id: r?.commit?.oid }));
  return nativeCodeOwnerApproval(reviews, pr.author?.login, pr.headRefOid, team.owners, team.identity).approved;
}

// The team context for `summarize` from the config and the CODEOWNERS text: undefined when the config has no team identity.
export function teamContext(config, codeOwnersText) {
  if (config?.identity?.profile !== "team") return undefined;
  return { owners: parseCodeOwnerUsers(codeOwnersText ?? ""), identity: config.identity };
}

// The open issues that block `number`, direct ones first, then theirs. Only open issues count, and only open
// issues are followed; `number` itself appears last when it sits on a cycle.
function openBlockers(number, blockedByOf) {
  const found = [];
  const seen = new Set();
  const queue = [number];
  while (queue.length) {
    for (const b of blockedByOf.get(queue.shift()) ?? []) {
      if (seen.has(b) || !blockedByOf.has(b)) continue;
      seen.add(b);
      found.push(b);
      queue.push(b);
    }
  }
  return found.includes(number) ? [...found.filter((b) => b !== number), number] : found;
}

// Marks each startable item `parallel` unless its paths overlap another startable item's or claimed work's (the
// `{ path, by }` list from claimedPaths), or its Scope names none. An issue whose Scope names no paths is excluded
// from *other* issues' comparisons too (only itself is flagged), since a scopeless issue's Interface contract alone
// would otherwise produce a one-sided overlap.
function markParallel(ready, formOf, claimed = []) {
  const paths = new Map(ready.map((i) => [i.number, issuePaths(formOf.get(i.number) ?? {})]));
  const isScoped = new Map(ready.map((i) => [i.number, issuePaths({ scope: formOf.get(i.number)?.scope }).length > 0]));
  const list = (numbers) => numbers.map((n) => `#${n}`).join(", ");
  for (const item of ready) {
    const scoped = isScoped.get(item.number);
    const mine = paths.get(item.number);
    item.overlapsWith = scoped ? ready.filter((o) => o !== item && isScoped.get(o.number) && pathsOverlap(mine, paths.get(o.number))).map((o) => o.number) : [];
    item.overlapsRunning = scoped ? [...new Set(claimed.filter((c) => c.by !== item.number && pathsOverlap(mine, [c.path])).map((c) => c.by))] : [];
    item.parallel = scoped && item.overlapsWith.length === 0 && item.overlapsRunning.length === 0;
    const notes = [
      ...(item.overlapsRunning.length ? [`one at a time with running ${list(item.overlapsRunning)}`] : []),
      ...(item.overlapsWith.length ? [`one at a time with ${list(item.overlapsWith)}`] : []),
    ];
    item.note = !scoped ? "one at a time (scope names no paths)" : item.parallel ? "parallel" : notes.join("; ");
  }
}

// The `{ number, position }` of each PR in the merge queue, from the reply to STATUS_QUERY; [] when the branch
// has no merge queue.
export function mergeQueueEntries(reply) {
  return (reply?.data?.repository?.mergeQueue?.entries?.nodes ?? []).map((e) => ({ number: e.pullRequest.number, position: e.position }));
}

// #621: the merge queue removes a PR whose merge group fails and nothing else says so. The PR's timeline holds each
// queue event; the `timelineItems` fragment below is shared by every query that reads them.
export const QUEUE_EVENTS = "timelineItems(last:10,itemTypes:[ADDED_TO_MERGE_QUEUE_EVENT,REMOVED_FROM_MERGE_QUEUE_EVENT]){ nodes { __typename ... on AddedToMergeQueueEvent { createdAt } ... on RemovedFromMergeQueueEvent { createdAt } } }";

// PR number → `{ at }` (ms) for each open PR whose latest queue event is a removal, from a reply holding QUEUE_EVENTS.
// A PR re-added after a removal, or in the queue now, is left out (`inQueue`: the numbers in the queue).
export function queueRemovals(reply, inQueue = []) {
  const out = new Map();
  for (const node of reply?.data?.repository?.pullRequests?.nodes ?? []) {
    const events = (node.timelineItems?.nodes ?? []).filter((e) => e?.createdAt && !Number.isNaN(Date.parse(e.createdAt)));
    events.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    const last = events.at(-1);
    if (last?.__typename === "RemovedFromMergeQueueEvent" && !inQueue.includes(node.number)) out.set(node.number, { at: Date.parse(last.createdAt) });
  }
  return out;
}

// PR number → `{ name, url }` of the newest failed merge-group run, from `gh run list --event merge_group --json
// databaseId,headBranch,workflowName,url,createdAt` (the merge group's branch is gh-readonly-queue/<base>/pr-<N>-<sha>).
// Only an https URL is kept.
export function mergeGroupFailures(runs) {
  const out = new Map();
  const newest = new Map();
  for (const run of Array.isArray(runs) ? runs : []) {
    const n = Number(/^gh-readonly-queue\/.+\/pr-(\d+)-/.exec(run?.headBranch ?? "")?.[1]);
    const at = Date.parse(run?.createdAt ?? "") || 0;
    if (!n || at < (newest.get(n) ?? -1)) continue;
    newest.set(n, at);
    out.set(n, { name: String(run.workflowName ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, ""), ...(typeof run.url === "string" && run.url.startsWith("https://") && { url: run.url }) });
  }
  return out;
}

// The text after `[queue failed]`: when the merge queue removed the PR and, if known, which merge-group check failed.
export function queueFailedNote(removal, failure) {
  const at = new Date(removal.at).toISOString().slice(0, 16).replace("T", " ");
  return `removed from the merge queue at ${at} UTC${failure?.name ? `: ${failure.name} failed in the merge group` : ""}${failure?.url ? ` (${failure.url})` : ""}`;
}

// PR number → the `lanes/gate` description on its head commit, from the reply to STATUS_QUERY. PRs without a gate
// status are left out.
export function gateDescriptions(reply) {
  const out = new Map();
  for (const node of reply?.data?.repository?.pullRequests?.nodes ?? []) {
    const description = node.commits?.nodes?.[0]?.commit?.status?.context?.description;
    if (typeof description === "string") out.set(node.number, description);
  }
  return out;
}

// PR number → ms since epoch at which the gate's current status was set, from the same reply as gateDescriptions
// (the status context's `createdAt`). A PR without a readable time is left out.
export function gateSince(reply) {
  const out = new Map();
  for (const node of reply?.data?.repository?.pullRequests?.nodes ?? []) {
    const ms = Date.parse(node.commits?.nodes?.[0]?.commit?.status?.context?.createdAt);
    if (Number.isFinite(ms)) out.set(node.number, ms);
  }
  return out;
}

// "5m", "2h 10m", "3d 4h": how long ago `since` was at `now` (both ms). Never negative.
export function formatAge(since, now) {
  const minutes = Math.max(0, Math.floor((now - since) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

// A background session on a permission prompt reads, in `claude agents --json`:
// { status: "waiting", waitingFor: "permission prompt", state: "blocked" }. A lane that ended its turn is also
// `blocked`, without `waitingFor`, so both fields are checked.
const PROMPT_STATE = "blocked";
const PROMPT_WAITING_FOR = "permission prompt";

const normalPath = (p) => {
  const slashed = p.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[a-z]:\//i.test(slashed) ? slashed.toLowerCase() : slashed;
};

// #571: the one test for "this lane session has stopped": idle (any `state`, `blocked` included) and not on a permission
// prompt. /status and the queue both decide through it, so they cannot disagree about the same session.
export function idleLaneSession(agent) {
  return agent?.status === "idle" && agent.waitingFor !== PROMPT_WAITING_FOR;
}

// #571, #675: the recovery /status gives for an idle lane session with no PR: message it, or stop it so the queue
// (ADR 0030, the only launcher) relaunches the issue.
export function idleLaneRecovery(id, _n, unsaved = false) {
  return `message it to continue, or stop it (claude stop ${id}) so the queue relaunches it${unsaved ? "; worktree has unsaved changes" : ""}`;
}

// The `issue-<N>[-slug]` worktree folder a session's cwd is in (cwd may be a subfolder), or null: a lane that entered its
// worktree by path reports the repository root, and then there is no folder to read.
export function laneWorktree(cwd, n) {
  return new RegExp(`^(.*/\\.claude/worktrees/issue-${Number(n)}(?:-[^/]*)?)(?:/|$)`).exec(normalPath(String(cwd ?? "")))?.[1] ?? null;
}

// #571: whether the worktree has uncommitted changes, read with `git -C <dir> status --porcelain` only. A read failure
// (or no worktree) is false: it adds nothing and never changes a refusal.
export function worktreeUnsaved(dir, run = (args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 })) {
  if (!dir) return false;
  try {
    return String(run(["-C", dir, "status", "--porcelain"])).trim() !== "";
  } catch {
    return false;
  }
}

// Issue N → `{ id, state, waiting, stopped }` for each background session whose cwd is inside a worktree of `repoRoot`
// named `issue-<N>-…`, or bare `issue-<N>` (#134). Two sessions on one issue: the most recently started wins.
export function laneSessions(agents, repoRoot) {
  return new Map([...latestLaneAgents(agents, repoRoot)].map(([n, { agent: a }]) => [n, { id: a.id, state: a.state, waiting: a.state === PROMPT_STATE && a.waitingFor === PROMPT_WAITING_FOR, stopped: idleLaneSession(a) }]));
}

// #390: the running lane sessions as `{ issue, sessionId, cwd }`, for lane-cost.mjs's loadBudget.
export function liveLanes(agents, repoRoot) {
  return [...latestLaneAgents(agents, repoRoot)].map(([issue, { agent: a }]) => ({ issue, sessionId: a.sessionId, cwd: a.cwd }));
}

// Issue N → `{ startedAt, agent }`, the raw `claude agents --json` entry of the lane session on that issue.
function latestLaneAgents(agents, repoRoot) {
  const root = `${normalPath(repoRoot)}/`;
  const found = new Map();
  for (const a of agents) {
    if (a?.kind !== "background" || typeof a.id !== "string" || typeof a.cwd !== "string") continue;
    // The root itself counts: a lane that entered its worktree by path still reports it, and its name says which issue.
    const cwd = normalPath(a.cwd);
    if (!cwd.startsWith(root) && `${cwd}/` !== root) continue;
    const number = laneIssueOf({ ...a, cwd: cwd.startsWith(root) ? cwd.slice(root.length) : "" });
    if (!number) continue;
    const previous = found.get(number);
    if (previous && previous.startedAt > (a.startedAt ?? 0)) continue;
    found.set(number, { startedAt: a.startedAt ?? 0, agent: a });
  }
  return found;
}

export const STALLED_MINUTES = 30;
// PR stages where the lane still owes something: a failing check to fix, or a reviewer's verdict to post.
const OWED_STAGES = new Set(["starting", "failing", "gate", "review"]);
export const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

// Issue N → whole minutes since the transcript of its busy lane session was last written, for those at or past
// STALLED_MINUTES. The transcript is found the way lane-cost.mjs finds it (the root's project folder, then the
// session's own cwd's); only its modification time is read. A missing or unreadable transcript, or a session that is
// idle or waiting on a prompt, leaves the lane out. Never throws.
export function stalledLanes(agents, repoRoot, opts = {}) {
  return silentLanes(agents, repoRoot, (a) => a.status === "busy" || a.state === "working", opts);
}

// Issue N → whole minutes of silence for the lane sessions that are idle (not busy, not waiting on a prompt) and
// silent for STALLED_MINUTES or more. `summarize` reports one only while its open PR still owes a review or check
// (#465): an idle lane whose PR owes nothing has simply finished.
export function idleLanes(agents, repoRoot, opts = {}) {
  return silentLanes(agents, repoRoot, (a) => a.status === "idle" && a.waitingFor !== PROMPT_WAITING_FOR, opts);
}

function silentLanes(agents, repoRoot, wanted, { home = homedir(), now = Date.now(), mtime = (f) => statSync(f).mtimeMs } = {}) {
  const out = new Map();
  for (const [n, { agent: a }] of latestLaneAgents(agents, repoRoot)) {
    if (!wanted(a)) continue;
    if (typeof a.sessionId !== "string" || !SAFE_SESSION_ID.test(a.sessionId)) continue;
    for (const folder of new Set([repoRoot, a.cwd].map(projectFolder))) {
      let modified;
      try {
        modified = mtime(join(home, ".claude", "projects", folder, `${a.sessionId}.jsonl`));
      } catch {
        continue;
      }
      const minutes = Math.floor((now - modified) / 60_000);
      if (Number.isFinite(minutes) && minutes >= STALLED_MINUTES) out.set(n, minutes);
      break;
    }
  }
  return out;
}

const runClaudeAgents = () => execFileSync("claude", ["agents", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });

// `{ sessions }` from `claude agents --json`, or `{ sessions: empty, sessionsUnavailable: reason }` when it cannot be read.
export function loadSessions(repoRoot, run = runClaudeAgents, runGit) {
  let stdout;
  try {
    stdout = run();
  } catch (err) {
    const reason = err.code === "ENOENT" ? "claude not found" : typeof err.status === "number" ? `claude agents --json exited ${err.status}` : `claude agents --json failed: ${err.code ?? err.message}`;
    return { sessions: new Map(), sessionsUnavailable: reason };
  }
  let agents;
  try {
    agents = JSON.parse(stdout);
  } catch {}
  if (!Array.isArray(agents)) return { sessions: new Map(), sessionsUnavailable: "claude agents --json printed invalid JSON" };
  const sessions = laneSessions(agents, repoRoot);
  // #571: a stopped session's worktree is read once, so the note can say its work is unsaved.
  for (const [n, { agent: a }] of latestLaneAgents(agents, repoRoot)) {
    if (sessions.get(n)?.stopped && worktreeUnsaved(laneWorktree(a.cwd, n), runGit)) sessions.get(n).unsaved = true;
  }
  return { sessions };
}

const LANE_BRANCH = /^issue-(\d+)(?:-.*)?$/;

// Issue N → the `issue-<N>-…` (or bare `issue-<N>`) branches a lane left: pushed ones from `git ls-remote --heads
// origin` output, local ones from `git worktree list --porcelain` output, where a detached worktree counts by its folder.
export function laneBranches({ remote = "", worktrees = "" }) {
  const found = new Map();
  const add = (branch) => {
    const number = Number(LANE_BRANCH.exec(branch ?? "")?.[1]);
    if (!number) return;
    const list = found.get(number) ?? [];
    if (!list.includes(branch)) list.push(branch);
    found.set(number, list);
  };
  for (const line of remote.split(/\r?\n/)) add(/\trefs\/heads\/(.+)$/.exec(line)?.[1]);
  for (const entry of worktrees.split(/\r?\n\r?\n/)) {
    const lines = entry.split(/\r?\n/);
    const path = lines.find((l) => l.startsWith("worktree "))?.slice(9);
    const branch = lines.find((l) => l.startsWith("branch refs/heads/"))?.slice(18);
    add(branch ?? path?.replace(/\\/g, "/").split("/").pop());
  }
  return new Map([...found].sort(([a], [b]) => a - b));
}

const git = (args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });

// `{ laneBranches }`, or local worktrees only plus `branchesUnavailable` when origin cannot be read.
export function loadLaneBranches(run = git) {
  let worktrees = "";
  let remote = "";
  const failed = [];
  try {
    worktrees = run(["worktree", "list", "--porcelain"]);
  } catch {
    failed.push("git worktree list failed");
  }
  try {
    remote = run(["ls-remote", "--heads", "origin"]);
  } catch {
    failed.push("git ls-remote origin failed");
  }
  const loaded = { laneBranches: laneBranches({ remote, worktrees }) };
  return failed.length ? { ...loaded, branchesUnavailable: failed.join("; ") } : loaded;
}

const withSession = (item, session) => {
  if (!session) return item;
  const stalled = session.stalledMin !== undefined && !session.waiting;
  if (stalled && session.idle) return { ...item, note: `${item.note} — idle ${session.stalledMin} min: claude attach ${session.id}`, session: { id: session.id, state: session.state, stalledMin: session.stalledMin } };
  const note = session.waiting ? `waiting on a prompt: claude attach ${session.id}` : [item.note, stalled && `stalled ${session.stalledMin} min`, `session ${session.id}`].filter(Boolean).join(" — ");
  return { ...item, note, session: { id: session.id, state: session.state, ...(stalled && { stalledMin: session.stalledMin }) } };
};

// `issues` is every open issue (with body); only those labelled `ready` are listed, the rest only block.
// `mergeQueue` is the output of mergeQueueEntries (null or missing: no merge queue); `gateDescriptions` that of
// gateDescriptions (missing: the rollup's own descriptions only). `sessions` and `sessionsUnavailable` come from
// loadSessions (missing: no sessions). `laneBranches` is the output of laneBranches (missing: no branches known).
export function summarize({ prs, issues, merged, mergeQueue, gateDescriptions = new Map(), sessions: loaded = new Map(), stalled = new Map(), idle: idleLanesFound = new Map(), sessionsUnavailable, laneBranches = new Map(), branchesUnavailable, team, removals = new Map(), queueFailures = new Map() }) {
  // `team` is teamContext's output (missing: no owner approval is read). `stalled` is the output of stalledLanes (issue N → minutes silent).
  const sessions = new Map([...loaded].map(([n, s]) => [n, stalled.has(n) ? { ...s, stalledMin: stalled.get(n) } : s]));
  const out = { waitingOnOwner: [], inFlight: [], ready: [], blocked: [], merged: [] };
  const taken = new Set();
  const queuePosition = new Map((mergeQueue ?? []).map((e) => [e.number, e.position]));
  for (const pr of prs) {
    const refs = (pr.closingIssuesReferences ?? []).map((ref) => ref.number);
    for (const n of refs) taken.add(n);
    let session = refs.map((n) => sessions.get(n)).find(Boolean);
    const { stage, note } = prStage(pr, queuePosition.get(pr.number), gateDescriptions.get(pr.number));
    // An idle lane whose PR still owes a review or check has hung (#465): it waits on the owner like a stalled one.
    const idleMin = refs.map((n) => idleLanesFound.get(n)).find((m) => m !== undefined);
    const hung = session && !session.waiting && idleMin !== undefined && OWED_STAGES.has(stage);
    if (hung) session = { ...session, stalledMin: idleMin, idle: true };
    const needs = (parsePrBody(pr.body).sections["needs the owner"] ?? "").trim();
    const item = { number: pr.number, title: pr.title, stage, note };
    // A prompt still needs the owner; a gate waiting on a reviewer does not, whatever the body asks for. An
    // approval already given only clears a /approve ask (the gate's own "waiting on owner" stage, or a "needs the
    // owner" note that asks for /approve) — an unrelated need (e.g. "pick a name for the package") still surfaces.
    const asksForApprove = /\/approve\b/i.test(needs);
    // #621: the merge queue removed it and it is open still, so it is not ready whatever the gate says.
    const removal = removals.get(pr.number);
    if (removal && queuePosition.get(pr.number) === undefined) out.waitingOnOwner.push(withSession({ ...item, stage: "queue failed", note: queueFailedNote(removal, queueFailures.get(pr.number)) }, session));
    else if (session?.waiting || hung || stage === "conflict") out.waitingOnOwner.push(withSession(item, session));
    else if (stage === "gate") out.inFlight.push(withSession(item, session));
    else if (stage === "owner") (ownerApproved(pr, team) ? out.inFlight : out.waitingOnOwner).push(withSession(item, session));
    else if (needs && !/^nothing\b/i.test(needs)) {
      if (ownerApproved(pr, team) && asksForApprove) out.inFlight.push(withSession(item, session));
      else out.waitingOnOwner.push(withSession({ ...item, note: `needs: ${needs.split("\n")[0]}` }, session));
    } else out.inFlight.push(withSession(item, session));
  }
  const formOf = new Map(issues.map((i) => [i.number, parseIssueForm(i.body ?? "").fields]));
  const blockedByOf = new Map([...formOf].map(([n, f]) => [n, f.blockedBy]));
  const runningIssues = [];
  const prBranches = new Set(prs.map((pr) => pr.headRefName).filter(Boolean));
  for (const issue of issues) {
    const labels = (issue.labels ?? []).map((l) => l.name);
    const branches = laneBranches.get(issue.number) ?? [];
    if (!taken.has(issue.number) && branches.some((b) => prBranches.has(b))) taken.add(issue.number);
    const session = taken.has(issue.number) ? undefined : sessions.get(issue.number);
    // A lane that pushed or kept a branch and then stopped (e.g. at a usage limit) opens no PR: the owner restarts it.
    const idle = !session || session.stopped;
    // A lane found every criterion already met on main and took the issue out of the ready pool (#136). An open PR
    // or a busy session on the issue still shows as such.
    if (labels.includes("needs-owner") && !taken.has(issue.number) && idle) {
      out.waitingOnOwner.push({ number: issue.number, title: issue.title, stage: "already met", note: "close it or rewrite it" });
      continue;
    }
    if (!taken.has(issue.number) && labels.includes("ready") && branches.length && idle) {
      const item = { number: issue.number, title: issue.title, stage: "stopped", note: "no PR yet: the queue relaunches it" };
      // #571: the queue skips an issue with a live session, so the note names the session and the recovery above.
      // An id that is not a plain token is never printed inside a command the owner would paste.
      const note = SAFE_SESSION_ID.test(session?.id ?? "") ? `no PR yet: session ${session.id} is idle; ${idleLaneRecovery(session.id, issue.number, session.unsaved)}` : session && "no PR yet: a lane session is idle; message it, or stop it so the queue relaunches it";
      out.waitingOnOwner.push(session ? { ...item, note, session: { id: session.id, state: session.state } } : item);
      // Its branch still holds work on the issue's paths, so other issues on those paths wait for it.
      runningIssues.push(issue);
      continue;
    }
    if (session) {
      runningIssues.push(issue);
      const item = withSession({ number: issue.number, title: issue.title, stage: "running", note: "" }, session);
      (session.waiting ? out.waitingOnOwner : out.inFlight).push(item);
      continue;
    }
    if (taken.has(issue.number) || !labels.includes("ready")) continue;
    const tier = labels.find((n) => n.startsWith("tier:"))?.slice(5) ?? "?";
    const item = { number: issue.number, title: issue.title, stage: tier, note: "" };
    const blockedBy = openBlockers(issue.number, blockedByOf);
    if (blockedBy.length === 0) out.ready.push(item);
    else out.blocked.push({ ...item, note: `blocked by ${blockedBy.map((n) => `#${n}`).join(", ")}`, blockedBy });
  }
  markParallel(out.ready, formOf, claimedPaths({ openPrs: prs, runningIssues }));
  for (const pr of merged) out.merged.push({ number: pr.number, title: pr.title, stage: "merged", note: "" });
  if (sessionsUnavailable) out.sessionsUnavailable = sessionsUnavailable;
  if (branchesUnavailable) out.branchesUnavailable = branchesUnavailable;
  return out;
}

export function render(summary, sinceLabel) {
  const block = (title, items, withStage = true, hint = "") =>
    [`${title} (${items.length})`, ...(hint && items.length ? [`  ${hint}`] : []), ...items.map((i) => `  #${i.number}${withStage ? ` [${i.stage}]` : ""} ${i.title}${i.note ? ` — ${i.note}` : ""}`)].join("\n");
  return [
    block("WAITING ON YOU", summary.waitingOnOwner),
    block("IN FLIGHT", summary.inFlight),
    block("READY TO START", summary.ready, true, "(parallel is a heuristic read from each issue's Scope and Interface contract, not a guarantee)"),
    block("BLOCKED", summary.blocked ?? []),
    block(`MERGED, last ${sinceLabel}`, summary.merged, false),
    ...(summary.sessionsUnavailable ? [`(background sessions unavailable: ${summary.sessionsUnavailable})`] : []),
    ...(summary.branchesUnavailable ? [`(stopped lanes may be missing: ${summary.branchesUnavailable})`] : []),
    // Merged lanes, closed-issue lanes and empty orphan folders all count, so the line names none of them alone.
    ...(summary.toCleanUp > 0 ? [`${summary.toCleanUp} ${summary.toCleanUp === 1 ? "lane or folder" : "lanes or folders"} to clean up: node scripts/lanes/cleanup.mjs`] : []),
  ].join("\n\n");
}

const NONE_STATED = "(none stated)";
// PR text is untrusted: control characters (ANSI escapes) are dropped before it reaches the owner's terminal.
const plain = (text) => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
const firstLine = (text) => plain((text ?? "").trim().split("\n")[0]).trim() || NONE_STATED;

// The open PRs in `summary.waitingOnOwner` that wait on the owner's /approve: the gate's own owner wait, or a body
// asking for /approve. Prompts, stopped lanes and issues also wait on the owner but are not approvals.
// `since` (gateSince's output) and `now` add each PR's `age` since it began waiting; the list is oldest first, PRs of
// unknown age last, in the order given.
export function waitingApprovals(prs, summary, since = new Map(), now = Date.now()) {
  const waiting = new Map(summary.waitingOnOwner.map((i) => [i.number, i]));
  const out = [];
  for (const pr of prs) {
    const item = waiting.get(pr.number);
    if (!item || item.session?.state === PROMPT_STATE && item.note.startsWith("waiting on a prompt")) continue;
    const sections = parsePrBody(pr.body).sections;
    const needs = (sections["needs the owner"] ?? "").trim();
    if (item.stage !== "owner" && !/\/approve\b/i.test(needs)) continue;
    out.push({ number: pr.number, title: plain(pr.title ?? ""), needs: firstLine(needs), contract: firstLine(sections["contract changes"]), files: (pr.files ?? []).length, ...(since.has(pr.number) && { age: formatAge(since.get(pr.number), now), since: since.get(pr.number) }) });
  }
  return out.map((w, i) => [w, i]).sort(([a, i], [b, j]) => (a.since ?? Infinity) - (b.since ?? Infinity) || i - j).map(([w]) => w);
}

// The lanes in flight whose session is busy but has written nothing for STALLED_MINUTES or more; they need the owner too.
export function stalledItems(summary) {
  return [...summary.inFlight, ...summary.waitingOnOwner].filter((i) => i.session?.stalledMin !== undefined);
}

export function renderWaiting(waiting, stalled = []) {
  if (!waiting.length && !stalled.length) return "none";
  const approvals = waiting.map((w) => `#${w.number} ${w.title}${w.age ? ` — waiting ${w.age}` : ""}\n  Needs the owner: ${w.needs}\n  Contract changes: ${w.contract}\n  Files changed: ${w.files}`);
  const lines = stalled.map((s) => `#${s.number} ${plain(s.title ?? "")} — stalled ${s.session.stalledMin} min: claude attach ${plain(String(s.session.id))}`);
  return [...approvals, ...(lines.length ? [lines.join("\n")] : [])].join("\n\n");
}

/**
 * #483: the start decisions of the last `days` days, from `.lanes/starts.jsonl` text (start.mjs writes it), as lines.
 * A line that is not a JSON object with a readable `at`, an `outcome` and a `reason` is ignored. Pure apart from `now`.
 */
export function startsReport(text, days, now = Date.now()) {
  const from = now - days * 86_400_000;
  let started = 0;
  const skipped = { overlap: 0, cap: 0, other: 0 };
  const pairs = new Map();
  for (const raw of String(text ?? "").split("\n")) {
    let l;
    try {
      l = JSON.parse(raw);
    } catch {
      continue;
    }
    const at = Date.parse(l?.at);
    if (!(at >= from) || at > now) continue;
    if (l.outcome === "started") started++;
    else if (l.outcome === "skipped") {
      skipped[l.reason === "overlap" || l.reason === "cap" ? l.reason : "other"]++;
      if (l.reason === "overlap" && Number.isInteger(l.issue) && Number.isInteger(l.with)) {
        const pair = `#${Math.min(l.issue, l.with)} and #${Math.max(l.issue, l.with)}`;
        pairs.set(pair, (pairs.get(pair) ?? 0) + 1);
      }
    }
  }
  if (!started && !skipped.overlap && !skipped.cap && !skipped.other) return ["no start decisions recorded"];
  return [
    `start decisions, last ${days} days: ${started} started, ${skipped.overlap} skipped for overlap, ${skipped.cap} for the cap, ${skipped.other} for other reasons`,
    ...[...pairs].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([pair, n]) => `  overlap ${pair}: ${n}`),
  ];
}

const gh = (args) => JSON.parse(execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));

// `gh pr --json` has no merge queue field and drops status descriptions, so one GraphQL call fetches both.
// `mergeQueue` without `branch` is the default branch's queue; null when it has none. `pullRequests` matches the
// `gh pr list` limit below. `{owner}` and `{repo}` are filled in by gh.
export const STATUS_QUERY =
  "query($owner:String!,$name:String!){ repository(owner:$owner,name:$name){ " +
  "mergeQueue { entries(first:100){ nodes { state position pullRequest { number } } } } " +
  `pullRequests(states:OPEN,first:100){ nodes { number ${QUEUE_EVENTS} commits(last:1){ nodes { commit { status { context(name:"${GATE_CONTEXT}"){ description createdAt } contexts { context state creator { login __typename } } } } } } } } } }`;

// #390: the token budget for `--json`. A bad or unreadable lanes.config.json gives the defaults and says so in `note`;
// unreadable agents or costs count as 0 (loadBudget notes the latter). Never throws.
export function readBudget(repoRoot, rawAgents, { readConfig = () => readFileSync(join(repoRoot, "lanes.config.json"), "utf8"), load = loadBudget } = {}) {
  const notes = [];
  let caps = { ...BUDGET_DEFAULTS };
  let text;
  try {
    text = readConfig();
  } catch (err) {
    // A file system error's message carries the file's absolute path, so only a fixed string is reported.
    if (err.code !== "ENOENT") notes.push("lanes.config.json unreadable, budget defaults used");
  }
  if (text !== undefined) {
    try {
      caps = budgetConfig(JSON.parse(text));
    } catch (err) {
      notes.push(`lanes.config.json budget not read (${String(err.message).split("\n")[0]}), defaults used`);
    }
  }
  let lanes = [];
  try {
    lanes = liveLanes(JSON.parse(rawAgents), repoRoot);
  } catch {
    notes.push("running lanes unreadable, counted as 0");
  }
  const report = load({ root: repoRoot, lanes, ...caps });
  const note = [...notes, report.note].filter(Boolean).join("; ");
  const { note: _, ...rest } = report;
  return note ? { ...rest, note } : rest;
}

async function main(argv = process.argv.slice(2)) {
  // ADR 0025: a config that is not team shows the refusal line in place of data.
  const refusal = identityRefusal(() => readFileSync("lanes.config.json", "utf8"));
  if (refusal) return console.log(refusal);
  const startsIdx = argv.indexOf("--starts");
  if (startsIdx >= 0) {
    const days = Number(/^[1-9]\d*$/.test(argv[startsIdx + 1] ?? "") ? argv[startsIdx + 1] : NaN);
    if (!days) throw new Error("--starts takes a number of days, for example 7");
    const root = dirname(execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim());
    let text = "";
    try {
      text = readFileSync(join(root, ".lanes", "starts.jsonl"), "utf8");
    } catch {
      // Absent or unreadable: reported as no decisions.
    }
    for (const line of startsReport(text, days)) console.log(line);
    return;
  }
  const sinceIdx = argv.indexOf("--since");
  const sinceLabel = sinceIdx >= 0 ? argv[sinceIdx + 1] : "24h";
  const hours = Number(/^(\d+)h$/.exec(sinceLabel)?.[1]);
  if (!hours) throw new Error("--since takes hours, for example 12h");
  const since = new Date(Date.now() - hours * 3600_000).toISOString().slice(0, 19);
  const repoRoot = dirname(execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim());
  let rawAgents;
  const reply = gh(["api", "graphql", "-F", "owner={owner}", "-F", "name={repo}", "-f", `query=${STATUS_QUERY}`]);
  const config = loadConfig();
  // CODEOWNERS is the checkout's (the default branch's), as the gate reads it; unreadable means no owner, so no approval.
  let codeOwners = "";
  try { codeOwners = readFileSync(join(repoRoot, ".github", "CODEOWNERS"), "utf8"); } catch {}
  const data = {
    team: teamContext(config, codeOwners),
    prs: trustedRollups(gh(["pr", "list", "--state", "open", "--limit", "100", "--json", "number,title,body,mergeable,statusCheckRollup,autoMergeRequest,closingIssuesReferences,headRefName,files,author,headRefOid,latestReviews"]), reply, config),
    issues: gh(["issue", "list", "--state", "open", "--limit", String(ISSUE_LIMIT), "--json", "number,title,labels,body"]),
    merged: gh(["pr", "list", "--state", "merged", "--search", `merged:>=${since}`, "--limit", "100", "--json", "number,title"]),
    mergeQueue: mergeQueueEntries(reply),
    gateDescriptions: gateDescriptions(reply),
    removals: queueRemovals(reply, mergeQueueEntries(reply).map((e) => e.number)),
    // Lanes run in worktrees of the main checkout, so the root is the common git dir's parent, not --show-toplevel.
    ...loadSessions(repoRoot, () => (rawAgents = runClaudeAgents())),
    ...loadLaneBranches(),
  };
  try {
    const agents = JSON.parse(rawAgents);
    data.stalled = stalledLanes(agents, repoRoot);
    data.idle = idleLanes(agents, repoRoot);
  } catch {}
  // The failed check is a nicety: a run list that cannot be read leaves the removal line without it.
  if (data.removals.size) {
    try {
      data.queueFailures = mergeGroupFailures(gh(["run", "list", "--event", "merge_group", "--status", "failure", "--limit", "50", "--json", "databaseId,headBranch,workflowName,url,createdAt"]));
    } catch {}
  }
  const budget = readBudget(repoRoot, rawAgents);
  // A blocker missing from a truncated list would read as closed, so refuse rather than list a blocked issue as ready.
  if (data.issues.length >= ISSUE_LIMIT) throw new Error(`${ISSUE_LIMIT}+ open issues: too many to tell open blockers from closed ones`);
  const summary = summarize(data);
  if (argv.includes("--waiting")) {
    console.log(renderWaiting(waitingApprovals(data.prs, summary, gateSince(reply)), stalledItems(summary)));
    return;
  }
  // Only a hint: when cleanup.mjs is not installed or its inputs cannot be read, /status stays silent rather than failing.
  try {
    const { cleanableCount, loadCleanupInputs, planCleanup } = await import("./cleanup.mjs");
    summary.toCleanUp = cleanableCount(planCleanup(loadCleanupInputs()));
  } catch {}
  console.log(argv.includes("--json") ? JSON.stringify({ version: 0, generatedAt: new Date().toISOString(), since: sinceLabel, ...summary, budget }, null, 2) : render(summary, sinceLabel));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
