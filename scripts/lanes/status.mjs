// /status and the nightly digest: what waits on the owner, what is in flight, what is ready, what merged.
// Usage: node scripts/lanes/status.mjs [--since 24h] [--json]
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { GATE_CONTEXT, parseIssueForm, parsePrBody } from "./lib.mjs";

const ISSUE_LIMIT = 1000;
const FAILED = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"]);

// A PR that enters the merge queue loses its `autoMergeRequest`, so queue membership is checked first.
// `gh pr list` leaves StatusContext descriptions out of `statusCheckRollup`, so the gate's comes from `gateDescription`.
function prStage(pr, queuePosition, gateDescription) {
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
  return { stage: "review", note: description };
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

const cleanPath = (token) =>
  token
    .replace(/^[("'[]+|[)"'\].,;:]+$/g, "")
    .replace(/^\.\//, "")
    .replace(/\*+$/, "");
const looksLikePath = (p) => p && !/\s/.test(p) && !/^(-|https?:)/.test(p) && (p.includes("/") || /\.[a-z][a-z0-9]{0,5}$/i.test(p));

// The file paths an issue names: backticked or bare tokens with a `/` or a file extension, read from its Interface
// contract and the "In:" part of its Scope (anything after "Out:" is ignored). A trailing `*` glob reads as its directory.
export function issuePaths({ contract = "", scope = "" }) {
  const inPart = scope.split(/(?<![\w-])Out:/i)[0].replace(/^[\s\S]*?(?<![\w-])In:/i, "");
  const paths = [];
  for (const text of [contract, inPart]) {
    for (const [, quoted, bare] of text.matchAll(/`([^`]+)`|(\S+)/g)) {
      const p = cleanPath(quoted ?? bare);
      if (looksLikePath(p) && !paths.includes(p)) paths.push(p);
    }
  }
  return paths;
}

// Two path lists overlap when they share a path, or one names a directory (`dir/`) holding a path the other names.
export function pathsOverlap(a, b) {
  const within = (dir, p) => dir.endsWith("/") && p.startsWith(dir);
  return a.some((x) => b.some((y) => x === y || within(x, y) || within(y, x)));
}

// Marks each startable item `parallel` unless its paths overlap another startable item's, or its Scope names none.
// An issue whose Scope names no paths is excluded from *other* issues' comparisons too (only itself is flagged),
// since a scopeless issue's Interface contract alone would otherwise produce a one-sided overlap.
function markParallel(ready, formOf) {
  const paths = new Map(ready.map((i) => [i.number, issuePaths(formOf.get(i.number) ?? {})]));
  const isScoped = new Map(ready.map((i) => [i.number, issuePaths({ scope: formOf.get(i.number)?.scope }).length > 0]));
  for (const item of ready) {
    const scoped = isScoped.get(item.number);
    item.overlapsWith = scoped
      ? ready.filter((o) => o !== item && isScoped.get(o.number) && pathsOverlap(paths.get(item.number), paths.get(o.number))).map((o) => o.number)
      : [];
    item.parallel = scoped && item.overlapsWith.length === 0;
    item.note = !scoped ? "one at a time (scope names no paths)" : item.parallel ? "parallel" : `one at a time with ${item.overlapsWith.map((n) => `#${n}`).join(", ")}`;
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
// named `issue-<N>-…`. Two sessions on one issue: the most recently started wins.
export function laneSessions(agents, repoRoot) {
  const root = `${normalPath(repoRoot)}/`;
  const found = new Map();
  for (const a of agents) {
    if (a?.kind !== "background" || typeof a.id !== "string" || typeof a.cwd !== "string") continue;
    const cwd = normalPath(a.cwd);
    if (!cwd.startsWith(root)) continue;
    const number = cwd.slice(root.length).split("/").map((s) => /^issue-(\d+)-./.exec(s)?.[1]).find(Boolean);
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

const withSession = (item, session) => {
  if (!session) return item;
  const note = session.waiting ? `waiting on a prompt: claude attach ${session.id}` : [item.note, `session ${session.id}`].filter(Boolean).join(" — ");
  return { ...item, note, session: { id: session.id, state: session.state } };
};

// `issues` is every open issue (with body); only those labelled `ready` are listed, the rest only block.
// `mergeQueue` is the output of mergeQueueEntries (null or missing: no merge queue); `gateDescriptions` that of
// gateDescriptions (missing: the rollup's own descriptions only). `sessions` and `sessionsUnavailable` come from
// loadSessions (missing: no sessions).
export function summarize({ prs, issues, merged, mergeQueue, gateDescriptions = new Map(), sessions = new Map(), sessionsUnavailable }) {
  const out = { waitingOnOwner: [], inFlight: [], ready: [], blocked: [], merged: [] };
  const taken = new Set();
  const queuePosition = new Map((mergeQueue ?? []).map((e) => [e.number, e.position]));
  for (const pr of prs) {
    const refs = (pr.closingIssuesReferences ?? []).map((ref) => ref.number);
    for (const n of refs) taken.add(n);
    const session = refs.map((n) => sessions.get(n)).find(Boolean);
    const { stage, note } = prStage(pr, queuePosition.get(pr.number), gateDescriptions.get(pr.number));
    const needs = (parsePrBody(pr.body).sections["needs the owner"] ?? "").trim();
    const item = withSession({ number: pr.number, title: pr.title, stage, note }, session);
    if (stage === "owner" || session?.waiting) out.waitingOnOwner.push(item);
    else if (needs && !/^nothing\b/i.test(needs)) out.waitingOnOwner.push({ ...item, note: `needs: ${needs.split("\n")[0]}` });
    else out.inFlight.push(item);
  }
  const formOf = new Map(issues.map((i) => [i.number, parseIssueForm(i.body ?? "").fields]));
  const blockedByOf = new Map([...formOf].map(([n, f]) => [n, f.blockedBy]));
  for (const issue of issues) {
    const labels = (issue.labels ?? []).map((l) => l.name);
    const session = taken.has(issue.number) ? undefined : sessions.get(issue.number);
    if (session) {
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
  markParallel(out.ready, formOf);
  for (const pr of merged) out.merged.push({ number: pr.number, title: pr.title, stage: "merged", note: "" });
  if (sessionsUnavailable) out.sessionsUnavailable = sessionsUnavailable;
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

function main(argv = process.argv.slice(2)) {
  const sinceIdx = argv.indexOf("--since");
  const sinceLabel = sinceIdx >= 0 ? argv[sinceIdx + 1] : "24h";
  const hours = Number(/^(\d+)h$/.exec(sinceLabel)?.[1]);
  if (!hours) throw new Error("--since takes hours, for example 12h");
  const since = new Date(Date.now() - hours * 3600_000).toISOString().slice(0, 19);
  const reply = gh(["api", "graphql", "-F", "owner={owner}", "-F", "name={repo}", "-f", `query=${STATUS_QUERY}`]);
  const data = {
    prs: gh(["pr", "list", "--state", "open", "--limit", "100", "--json", "number,title,body,statusCheckRollup,autoMergeRequest,closingIssuesReferences"]),
    issues: gh(["issue", "list", "--state", "open", "--limit", String(ISSUE_LIMIT), "--json", "number,title,labels,body"]),
    merged: gh(["pr", "list", "--state", "merged", "--search", `merged:>=${since}`, "--limit", "100", "--json", "number,title"]),
    mergeQueue: mergeQueueEntries(reply),
    gateDescriptions: gateDescriptions(reply),
    // Lanes run in worktrees of the main checkout, so the root is the common git dir's parent, not --show-toplevel.
    ...loadSessions(dirname(execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim())),
  };
  // A blocker missing from a truncated list would read as closed, so refuse rather than list a blocked issue as ready.
  if (data.issues.length >= ISSUE_LIMIT) throw new Error(`${ISSUE_LIMIT}+ open issues: too many to tell open blockers from closed ones`);
  const summary = summarize(data);
  console.log(argv.includes("--json") ? JSON.stringify({ version: 0, generatedAt: new Date().toISOString(), since: sinceLabel, ...summary }, null, 2) : render(summary, sinceLabel));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
