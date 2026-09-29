// /status and the nightly digest: what waits on the owner, what is in flight, what is ready, what merged.
// Usage: node scripts/lanes/status.mjs [--since 24h] [--json] [--waiting]
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GATE_CONTEXT, laneIssueOf, parseIssueForm, parsePrBody, reviewContext } from "./lib.mjs";
import { issuePaths, pathsOverlap } from "./paths.mjs";
import { projectFolder } from "./lane-cost.mjs";
import { claimedPaths } from "./pick.mjs";

const ISSUE_LIMIT = 1000;
const FAILED = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"]);
export const CONFLICT_NOTE = "conflict: rebase needed";

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
  if (description.startsWith("waiting on owner")) return { stage: "owner", note: description };
  // The gate waits for a reviewer's status: the lane owes it, not the owner, whatever the body asks for.
  if (/^waiting for review\/\S/.test(description)) return { stage: "gate", note: description };
  return { stage: "review", note: description };
}

const ownerApproved = (pr) => (pr.statusCheckRollup ?? []).some((c) => c.context === reviewContext("owner") && c.state === "SUCCESS");

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

// Issue N → `{ id, state, waiting }` for each background session whose cwd is inside a worktree of `repoRoot`
// named `issue-<N>-…`, or bare `issue-<N>` (#134). Two sessions on one issue: the most recently started wins.
export function laneSessions(agents, repoRoot) {
  return new Map([...latestLaneAgents(agents, repoRoot)].map(([n, { agent: a }]) => [n, { id: a.id, state: a.state, waiting: a.state === PROMPT_STATE && a.waitingFor === PROMPT_WAITING_FOR }]));
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
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

// Issue N → whole minutes since the transcript of its busy lane session was last written, for those at or past
// STALLED_MINUTES. The transcript is found the way lane-cost.mjs finds it (the root's project folder, then the
// session's own cwd's); only its modification time is read. A missing or unreadable transcript, or a session that is
// idle or waiting on a prompt, leaves the lane out. Never throws.
export function stalledLanes(agents, repoRoot, { home = homedir(), now = Date.now(), mtime = (f) => statSync(f).mtimeMs } = {}) {
  const out = new Map();
  for (const [n, { agent: a }] of latestLaneAgents(agents, repoRoot)) {
    if (a.status !== "busy" && a.state !== "working") continue;
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
export function loadSessions(repoRoot, run = runClaudeAgents) {
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
  return { sessions: laneSessions(agents, repoRoot) };
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
  const note = session.waiting ? `waiting on a prompt: claude attach ${session.id}` : [item.note, stalled && `stalled ${session.stalledMin} min`, `session ${session.id}`].filter(Boolean).join(" — ");
  return { ...item, note, session: { id: session.id, state: session.state, ...(stalled && { stalledMin: session.stalledMin }) } };
};

// `issues` is every open issue (with body); only those labelled `ready` are listed, the rest only block.
// `mergeQueue` is the output of mergeQueueEntries (null or missing: no merge queue); `gateDescriptions` that of
// gateDescriptions (missing: the rollup's own descriptions only). `sessions` and `sessionsUnavailable` come from
// loadSessions (missing: no sessions). `laneBranches` is the output of laneBranches (missing: no branches known).
export function summarize({ prs, issues, merged, mergeQueue, gateDescriptions = new Map(), sessions: loaded = new Map(), stalled = new Map(), sessionsUnavailable, laneBranches = new Map(), branchesUnavailable }) {
  // `stalled` is the output of stalledLanes (issue N → minutes silent).
  const sessions = new Map([...loaded].map(([n, s]) => [n, stalled.has(n) ? { ...s, stalledMin: stalled.get(n) } : s]));
  const out = { waitingOnOwner: [], inFlight: [], ready: [], blocked: [], merged: [] };
  const taken = new Set();
  const queuePosition = new Map((mergeQueue ?? []).map((e) => [e.number, e.position]));
  for (const pr of prs) {
    const refs = (pr.closingIssuesReferences ?? []).map((ref) => ref.number);
    for (const n of refs) taken.add(n);
    const session = refs.map((n) => sessions.get(n)).find(Boolean);
    const { stage, note } = prStage(pr, queuePosition.get(pr.number), gateDescriptions.get(pr.number));
    const needs = (parsePrBody(pr.body).sections["needs the owner"] ?? "").trim();
    const item = { number: pr.number, title: pr.title, stage, note };
    // A prompt still needs the owner; a gate waiting on a reviewer does not, whatever the body asks for. An
    // approval already given only clears a /approve ask (the gate's own "waiting on owner" stage, or a "needs the
    // owner" note that asks for /approve) — an unrelated need (e.g. "pick a name for the package") still surfaces.
    const asksForApprove = /\/approve\b/i.test(needs);
    if (session?.waiting || stage === "conflict") out.waitingOnOwner.push(withSession(item, session));
    else if (stage === "gate") out.inFlight.push(withSession(item, session));
    else if (stage === "owner") (ownerApproved(pr) ? out.inFlight : out.waitingOnOwner).push(withSession(item, session));
    else if (needs && !/^nothing\b/i.test(needs)) {
      if (ownerApproved(pr) && asksForApprove) out.inFlight.push(withSession(item, session));
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
    const idle = !session || (session.state === PROMPT_STATE && !session.waiting);
    // A lane found every criterion already met on main and took the issue out of the ready pool (#136). An open PR
    // or a busy session on the issue still shows as such.
    if (labels.includes("needs-owner") && !taken.has(issue.number) && idle) {
      out.waitingOnOwner.push({ number: issue.number, title: issue.title, stage: "already met", note: "close it or rewrite it" });
      continue;
    }
    if (!taken.has(issue.number) && labels.includes("ready") && branches.length && idle) {
      const item = { number: issue.number, title: issue.title, stage: "stopped", note: `no PR yet: restart with /start ${issue.number}` };
      out.waitingOnOwner.push(session ? { ...item, session: { id: session.id, state: session.state } } : item);
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
  return summary.inFlight.filter((i) => i.session?.stalledMin !== undefined);
}

export function renderWaiting(waiting, stalled = []) {
  if (!waiting.length && !stalled.length) return "none";
  const approvals = waiting.map((w) => `#${w.number} ${w.title}${w.age ? ` — waiting ${w.age}` : ""}\n  Needs the owner: ${w.needs}\n  Contract changes: ${w.contract}\n  Files changed: ${w.files}`);
  const lines = stalled.map((s) => `#${s.number} ${plain(s.title ?? "")} — stalled ${s.session.stalledMin} min: claude attach ${plain(String(s.session.id))}`);
  return [...approvals, ...(lines.length ? [lines.join("\n")] : [])].join("\n\n");
}

// The `/approve N M K` line for the owner to paste: at most 10 numbers, empty when there are none.
export function approveLine(numbers) {
  return numbers.length ? `/approve ${numbers.slice(0, 10).join(" ")}` : "";
}

const gh = (args) => JSON.parse(execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));

// `gh pr --json` has no merge queue field and drops status descriptions, so one GraphQL call fetches both.
// `mergeQueue` without `branch` is the default branch's queue; null when it has none. `pullRequests` matches the
// `gh pr list` limit below. `{owner}` and `{repo}` are filled in by gh.
export const STATUS_QUERY =
  "query($owner:String!,$name:String!){ repository(owner:$owner,name:$name){ " +
  "mergeQueue { entries(first:100){ nodes { state position pullRequest { number } } } } " +
  `pullRequests(states:OPEN,first:100){ nodes { number commits(last:1){ nodes { commit { status { context(name:"${GATE_CONTEXT}"){ description createdAt } } } } } } } } }`;

async function main(argv = process.argv.slice(2)) {
  const sinceIdx = argv.indexOf("--since");
  const sinceLabel = sinceIdx >= 0 ? argv[sinceIdx + 1] : "24h";
  const hours = Number(/^(\d+)h$/.exec(sinceLabel)?.[1]);
  if (!hours) throw new Error("--since takes hours, for example 12h");
  const since = new Date(Date.now() - hours * 3600_000).toISOString().slice(0, 19);
  const repoRoot = dirname(execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim());
  let rawAgents;
  const reply = gh(["api", "graphql", "-F", "owner={owner}", "-F", "name={repo}", "-f", `query=${STATUS_QUERY}`]);
  const data = {
    prs: gh(["pr", "list", "--state", "open", "--limit", "100", "--json", "number,title,body,mergeable,statusCheckRollup,autoMergeRequest,closingIssuesReferences,headRefName,files"]),
    issues: gh(["issue", "list", "--state", "open", "--limit", String(ISSUE_LIMIT), "--json", "number,title,labels,body"]),
    merged: gh(["pr", "list", "--state", "merged", "--search", `merged:>=${since}`, "--limit", "100", "--json", "number,title"]),
    mergeQueue: mergeQueueEntries(reply),
    gateDescriptions: gateDescriptions(reply),
    // Lanes run in worktrees of the main checkout, so the root is the common git dir's parent, not --show-toplevel.
    ...loadSessions(repoRoot, () => (rawAgents = runClaudeAgents())),
    ...loadLaneBranches(),
  };
  try {
    data.stalled = stalledLanes(JSON.parse(rawAgents), repoRoot);
  } catch {}
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
  console.log(argv.includes("--json") ? JSON.stringify({ version: 0, generatedAt: new Date().toISOString(), since: sinceLabel, ...summary }, null, 2) : render(summary, sinceLabel));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
