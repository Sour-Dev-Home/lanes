// /status and the nightly digest: what waits on the owner, what is in flight, what is ready, what merged.
// Usage: node scripts/lanes/status.mjs [--since 24h] [--json]
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { GATE_CONTEXT, parseIssueForm, parsePrBody, reviewContext } from "./lib.mjs";
import { issuePaths, pathsOverlap } from "./paths.mjs";
import { claimedPaths } from "./pick.mjs";

const ISSUE_LIMIT = 1000;
const FAILED = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"]);

// A PR that enters the merge queue loses its `autoMergeRequest`, so queue membership is checked first.
// `gh pr list` leaves StatusContext descriptions out of `statusCheckRollup`, so the gate's comes from `gateDescription`.
// queue.mjs derives its owner waits from this too, so the queue and /status never disagree (#122).
export function prStage(pr, queuePosition, gateDescription) {
  if (queuePosition !== undefined) return { stage: "queued", note: `in merge queue, position ${queuePosition}` };
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
  const root = `${normalPath(repoRoot)}/`;
  const found = new Map();
  for (const a of agents) {
    if (a?.kind !== "background" || typeof a.id !== "string" || typeof a.cwd !== "string") continue;
    const cwd = normalPath(a.cwd);
    if (!cwd.startsWith(root)) continue;
    const number = cwd.slice(root.length).split("/").map((s) => /^issue-(\d+)(?:-.*)?$/.exec(s)?.[1]).find(Boolean);
    if (!number) continue;
    const previous = found.get(Number(number));
    if (previous && previous.startedAt > (a.startedAt ?? 0)) continue;
    found.set(Number(number), { startedAt: a.startedAt ?? 0, id: a.id, state: a.state, waiting: a.state === PROMPT_STATE && a.waitingFor === PROMPT_WAITING_FOR });
  }
  return new Map([...found].map(([n, { startedAt, ...s }]) => [n, s]));
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
  const note = session.waiting ? `waiting on a prompt: claude attach ${session.id}` : [item.note, `session ${session.id}`].filter(Boolean).join(" — ");
  return { ...item, note, session: { id: session.id, state: session.state } };
};

// `issues` is every open issue (with body); only those labelled `ready` are listed, the rest only block.
// `mergeQueue` is the output of mergeQueueEntries (null or missing: no merge queue); `gateDescriptions` that of
// gateDescriptions (missing: the rollup's own descriptions only). `sessions` and `sessionsUnavailable` come from
// loadSessions (missing: no sessions). `laneBranches` is the output of laneBranches (missing: no branches known).
export function summarize({ prs, issues, merged, mergeQueue, gateDescriptions = new Map(), sessions = new Map(), sessionsUnavailable, laneBranches = new Map(), branchesUnavailable }) {
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
    if (session?.waiting) out.waitingOnOwner.push(withSession(item, session));
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

const gh = (args) => JSON.parse(execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));

// `gh pr --json` has no merge queue field and drops status descriptions, so one GraphQL call fetches both.
// `mergeQueue` without `branch` is the default branch's queue; null when it has none. `pullRequests` matches the
// `gh pr list` limit below. `{owner}` and `{repo}` are filled in by gh.
const STATUS_QUERY =
  "query($owner:String!,$name:String!){ repository(owner:$owner,name:$name){ " +
  "mergeQueue { entries(first:100){ nodes { state position pullRequest { number } } } } " +
  `pullRequests(states:OPEN,first:100){ nodes { number commits(last:1){ nodes { commit { status { context(name:"${GATE_CONTEXT}"){ description } } } } } } } } }`;

async function main(argv = process.argv.slice(2)) {
  const sinceIdx = argv.indexOf("--since");
  const sinceLabel = sinceIdx >= 0 ? argv[sinceIdx + 1] : "24h";
  const hours = Number(/^(\d+)h$/.exec(sinceLabel)?.[1]);
  if (!hours) throw new Error("--since takes hours, for example 12h");
  const since = new Date(Date.now() - hours * 3600_000).toISOString().slice(0, 19);
  const reply = gh(["api", "graphql", "-F", "owner={owner}", "-F", "name={repo}", "-f", `query=${STATUS_QUERY}`]);
  const data = {
    prs: gh(["pr", "list", "--state", "open", "--limit", "100", "--json", "number,title,body,statusCheckRollup,autoMergeRequest,closingIssuesReferences,headRefName,files"]),
    issues: gh(["issue", "list", "--state", "open", "--limit", String(ISSUE_LIMIT), "--json", "number,title,labels,body"]),
    merged: gh(["pr", "list", "--state", "merged", "--search", `merged:>=${since}`, "--limit", "100", "--json", "number,title"]),
    mergeQueue: mergeQueueEntries(reply),
    gateDescriptions: gateDescriptions(reply),
    // Lanes run in worktrees of the main checkout, so the root is the common git dir's parent, not --show-toplevel.
    ...loadSessions(dirname(execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim())),
    ...loadLaneBranches(),
  };
  // A blocker missing from a truncated list would read as closed, so refuse rather than list a blocked issue as ready.
  if (data.issues.length >= ISSUE_LIMIT) throw new Error(`${ISSUE_LIMIT}+ open issues: too many to tell open blockers from closed ones`);
  const summary = summarize(data);
  // Only a hint: when cleanup.mjs is not installed or its inputs cannot be read, /status stays silent rather than failing.
  try {
    const { cleanableCount, loadCleanupInputs, planCleanup } = await import("./cleanup.mjs");
    summary.toCleanUp = cleanableCount(planCleanup(loadCleanupInputs()));
  } catch {}
  console.log(argv.includes("--json") ? JSON.stringify({ version: 0, generatedAt: new Date().toISOString(), since: sinceLabel, ...summary }, null, 2) : render(summary, sinceLabel));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
