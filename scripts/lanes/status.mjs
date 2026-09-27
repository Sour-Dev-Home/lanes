// /status and the nightly digest: what waits on the owner, what is in flight, what is ready, what merged.
// Usage: node scripts/lanes/status.mjs [--since 24h] [--json]
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { GATE_CONTEXT, parseIssueForm, parsePrBody } from "./lib.mjs";

const ISSUE_LIMIT = 1000;
const FAILED = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"]);

function prStage(pr) {
  const rollup = pr.statusCheckRollup ?? [];
  const failing = rollup
    .filter((c) => c.context !== GATE_CONTEXT && (FAILED.has(c.conclusion) || FAILED.has(c.state)))
    .map((c) => c.name ?? c.context);
  if (failing.length) return { stage: "failing", note: `failing: ${failing.join(", ")}` };
  const gate = rollup.find((c) => c.context === GATE_CONTEXT);
  if (!gate) return { stage: "starting", note: "no lanes/gate yet" };
  if (gate.state === "SUCCESS") return pr.autoMergeRequest ? { stage: "queued", note: "auto-merge on" } : { stage: "ready", note: "auto-merge is off" };
  if (gate.state === "FAILURE" || gate.state === "ERROR") return { stage: "contract", note: gate.description ?? "" };
  if (String(gate.description).startsWith("waiting on owner")) return { stage: "owner", note: gate.description };
  return { stage: "review", note: gate.description ?? "" };
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
  const inPart = scope.split(/\bOut:/i)[0].replace(/^[\s\S]*?\bIn:/i, "");
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
function markParallel(ready, formOf) {
  const paths = new Map(ready.map((i) => [i.number, issuePaths(formOf.get(i.number) ?? {})]));
  for (const item of ready) {
    const scoped = issuePaths({ scope: formOf.get(item.number)?.scope }).length > 0;
    item.overlapsWith = scoped ? ready.filter((o) => o !== item && pathsOverlap(paths.get(item.number), paths.get(o.number))).map((o) => o.number) : [];
    item.parallel = scoped && item.overlapsWith.length === 0;
    item.note = !scoped ? "one at a time (scope names no paths)" : item.parallel ? "parallel" : `one at a time with ${item.overlapsWith.map((n) => `#${n}`).join(", ")}`;
  }
}

// `issues` is every open issue (with body); only those labelled `ready` are listed, the rest only block.
export function summarize({ prs, issues, merged }) {
  const out = { waitingOnOwner: [], inFlight: [], ready: [], blocked: [], merged: [] };
  const taken = new Set();
  for (const pr of prs) {
    for (const ref of pr.closingIssuesReferences ?? []) taken.add(ref.number);
    const { stage, note } = prStage(pr);
    const needs = (parsePrBody(pr.body).sections["needs the owner"] ?? "").trim();
    const item = { number: pr.number, title: pr.title, stage, note };
    if (stage === "owner") out.waitingOnOwner.push(item);
    else if (needs && !/^nothing\b/i.test(needs)) out.waitingOnOwner.push({ ...item, note: `needs: ${needs.split("\n")[0]}` });
    else out.inFlight.push(item);
  }
  const formOf = new Map(issues.map((i) => [i.number, parseIssueForm(i.body ?? "").fields]));
  const blockedByOf = new Map([...formOf].map(([n, f]) => [n, f.blockedBy]));
  for (const issue of issues) {
    const labels = (issue.labels ?? []).map((l) => l.name);
    if (taken.has(issue.number) || !labels.includes("ready")) continue;
    const tier = labels.find((n) => n.startsWith("tier:"))?.slice(5) ?? "?";
    const item = { number: issue.number, title: issue.title, stage: tier, note: "" };
    const blockedBy = openBlockers(issue.number, blockedByOf);
    if (blockedBy.length === 0) out.ready.push(item);
    else out.blocked.push({ ...item, note: `blocked by ${blockedBy.map((n) => `#${n}`).join(", ")}`, blockedBy });
  }
  markParallel(out.ready, formOf);
  for (const pr of merged) out.merged.push({ number: pr.number, title: pr.title, stage: "merged", note: "" });
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
  ].join("\n\n");
}

const gh = (args) => JSON.parse(execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));

function main(argv = process.argv.slice(2)) {
  const sinceIdx = argv.indexOf("--since");
  const sinceLabel = sinceIdx >= 0 ? argv[sinceIdx + 1] : "24h";
  const hours = Number(/^(\d+)h$/.exec(sinceLabel)?.[1]);
  if (!hours) throw new Error("--since takes hours, for example 12h");
  const since = new Date(Date.now() - hours * 3600_000).toISOString().slice(0, 19);
  const data = {
    prs: gh(["pr", "list", "--state", "open", "--limit", "100", "--json", "number,title,body,statusCheckRollup,autoMergeRequest,closingIssuesReferences"]),
    issues: gh(["issue", "list", "--state", "open", "--limit", String(ISSUE_LIMIT), "--json", "number,title,labels,body"]),
    merged: gh(["pr", "list", "--state", "merged", "--search", `merged:>=${since}`, "--limit", "100", "--json", "number,title"]),
  };
  // A blocker missing from a truncated list would read as closed, so refuse rather than list a blocked issue as ready.
  if (data.issues.length >= ISSUE_LIMIT) throw new Error(`${ISSUE_LIMIT}+ open issues: too many to tell open blockers from closed ones`);
  const summary = summarize(data);
  console.log(argv.includes("--json") ? JSON.stringify({ version: 0, generatedAt: new Date().toISOString(), since: sinceLabel, ...summary }, null, 2) : render(summary, sinceLabel));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
