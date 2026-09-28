// The aggregates-only snapshot the dashboard publishes (ADR 0012, contracts/snapshot.schema.json): every task
// issue's stage and blockers, from the same functions /status uses. It keeps numbers, titles, stages, check and
// reviewer names and times; no logins, emails, bodies or comments reach the output.
// Usage: node scripts/lanes/snapshot.mjs [--out <file>] [--from <input.json>]   (--from builds offline, without gh)
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { GATE_CONTEXT, parseIssueForm, parseVerdictComment } from "./lib.mjs";
import { gateDescriptions, mergeQueueEntries, prStage } from "./status.mjs";

const ISSUE_LIMIT = 1000;
const TITLE_MAX = 200;
// Only comments by people with write access count: a verdict comment from anyone else is not a review.
const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const FAILED = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"]);
const PASSED = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const CRITERION_RESULTS = ["pass", "fail", "not-applicable"];

// GitHub-sourced text: control characters (ANSI escapes) dropped, length capped.
const clean = (text, max = TITLE_MAX) => (typeof text === "string" ? text.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, max) : "");

function checkResult(c) {
  const value = c.context ? c.state : c.conclusion;
  if (FAILED.has(value)) return "fail";
  return PASSED.has(value) ? "pass" : "pending";
}

const checksOf = (pr) => (pr.statusCheckRollup ?? []).map((c) => ({ name: clean(c.name ?? c.context), result: checkResult(c) }));

/**
 * The parsed verdict comments on a PR that count: trusted authors, bound to `headSha`, the newest per reviewer.
 * Nothing but the parsed verdict leaves this function.
 */
function currentVerdicts(comments, headSha) {
  const newest = new Map();
  for (const c of comments ?? []) {
    if (!TRUSTED_ASSOCIATIONS.has(c?.authorAssociation)) continue;
    const parsed = parseVerdictComment(c.body);
    if (parsed && parsed.sha === String(headSha).toLowerCase()) newest.set(parsed.reviewer, parsed);
  }
  return [...newest.values()];
}

/**
 * Per criterion index across `verdicts` (as parseVerdictComment returns them): fail if any reviewer failed it, else
 * pass if any passed it, else not-applicable. Entries without a positive integer index or a known result are skipped.
 */
export function verdictCriteria(verdicts, headSha) {
  const rank = { fail: 2, pass: 1, "not-applicable": 0 };
  const merged = new Map();
  for (const v of verdicts) {
    if (v.sha !== headSha || !Array.isArray(v.verdict?.criteria)) continue;
    for (const c of v.verdict.criteria) {
      if (!Number.isInteger(c?.index) || c.index < 1 || !CRITERION_RESULTS.includes(c.result)) continue;
      if (!merged.has(c.index) || rank[c.result] > rank[merged.get(c.index)]) merged.set(c.index, c.result);
    }
  }
  return [...merged].sort(([a], [b]) => a - b).map(([index, result]) => ({ index, result }));
}

function prBlockers(stage, note) {
  const reason = clean(note, 500);
  switch (stage) {
    case "queued":
      return note.startsWith("in merge queue") ? [{ kind: "queue", ref: "merge queue", reason }] : [];
    case "failing":
      return note.replace(/^failing: /, "").split(", ").map((name) => ({ kind: "check", ref: clean(name), reason }));
    case "owner":
      return [{ kind: "owner", ref: "review/owner", reason }];
    case "gate":
      return [{ kind: "review", ref: clean(/^waiting for review\/(\S+)/.exec(note)?.[1]), reason }];
    case "ready":
      return [];
    default:
      return [{ kind: "check", ref: GATE_CONTEXT, reason: reason || "pending" }];
  }
}

/**
 * `prs` is `gh pr list --json number,statusCheckRollup,autoMergeRequest,closingIssuesReferences,headRefOid,comments`,
 * `issues` every open issue with body and labels; `mergeQueue` and `gateDescriptions` are the outputs of status.mjs's
 * mergeQueueEntries and gateDescriptions.
 */
export function buildSnapshot({ prs, issues, mergeQueue = [], gateDescriptions: gates = new Map(), generatedAt }) {
  const queuePosition = new Map(mergeQueue.map((e) => [e.number, e.position]));
  const prOf = new Map();
  for (const pr of [...prs].sort((a, b) => a.number - b.number)) for (const ref of pr.closingIssuesReferences ?? []) prOf.set(ref.number, pr);
  const blockedByOf = new Map(issues.map((i) => [i.number, [...new Set(parseIssueForm(i.body ?? "").fields.blockedBy ?? [])]]));
  const listed = issues
    .filter((i) => i.labels?.some((l) => l.name.startsWith("tier:")) || prOf.has(i.number))
    .sort((a, b) => a.number - b.number);
  const listedNumbers = new Set(listed.map((i) => i.number));

  const out = { version: 0, generatedAt, issues: [], edges: [] };
  for (const issue of listed) {
    const labels = issue.labels.map((l) => l.name);
    const tierLabel = labels.find((n) => n.startsWith("tier:"))?.slice(5);
    const item = { number: issue.number, title: clean(issue.title), tier: ["skip", "quick", "full"].includes(tierLabel) ? tierLabel : "unknown" };
    const openBlockers = blockedByOf.get(issue.number).filter((b) => blockedByOf.has(b));
    const pr = prOf.get(issue.number);
    if (pr) {
      const { stage, note } = prStage(pr, queuePosition.get(pr.number), gates.get(pr.number));
      item.stage = stage;
      item.blockedBy = prBlockers(stage, note);
      item.pr = { number: pr.number, headSha: String(pr.headRefOid ?? "").toLowerCase(), checks: checksOf(pr) };
      const criteria = verdictCriteria(currentVerdicts(pr.comments, item.pr.headSha), item.pr.headSha);
      if (criteria.length) item.criteria = criteria;
    } else {
      item.stage = labels.includes("needs-owner") ? "already met" : labels.includes("ready") ? (openBlockers.length ? "blocked" : "ready") : "not-ready";
      item.blockedBy = openBlockers.map((b) => ({ kind: "issue", ref: `#${b}`, reason: `blocked by #${b}` }));
    }
    out.issues.push(item);
    for (const b of blockedByOf.get(issue.number)) if (listedNumbers.has(b)) out.edges.push({ from: b, to: issue.number });
  }
  out.edges.sort((a, b) => a.from - b.from || a.to - b.to);
  return out;
}

function fileArg(argv, flag) {
  const at = argv.indexOf(flag);
  if (at < 0) return undefined;
  const file = argv[at + 1];
  if (!file || file.startsWith("--")) throw new Error(`${flag} takes a file`);
  return file;
}

export const parseOutArg = (argv) => fileArg(argv, "--out");
export const parseFromArg = (argv) => fileArg(argv, "--from");

/**
 * The inputs of buildSnapshot from `--from` JSON: `{ prs, issues, mergeQueue?, gateDescriptions?, generatedAt? }`, where
 * gateDescriptions maps a PR number to its lanes/gate description. This lets a snapshot be built offline, and lets
 * contracts.test.mjs check a really built one through the command line rather than an import across modules.
 */
export function parseInput(text) {
  let input;
  try {
    input = JSON.parse(text);
  } catch {
    throw new Error("--from file is not valid JSON");
  }
  if (input === null || typeof input !== "object" || !Array.isArray(input.prs) || !Array.isArray(input.issues)) throw new Error("--from file needs prs and issues arrays");
  const gates = input.gateDescriptions ?? {};
  if (gates === null || typeof gates !== "object" || Array.isArray(gates) || Object.values(gates).some((d) => typeof d !== "string")) throw new Error("gateDescriptions must map a PR number to a text");
  if (input.mergeQueue !== undefined && !Array.isArray(input.mergeQueue)) throw new Error("mergeQueue must be an array");
  return {
    prs: input.prs,
    issues: input.issues,
    mergeQueue: input.mergeQueue ?? [],
    gateDescriptions: new Map(Object.entries(gates).map(([n, d]) => [Number(n), d])),
    generatedAt: typeof input.generatedAt === "string" ? input.generatedAt : new Date().toISOString(),
  };
}

export function writeSnapshot(snapshot, file) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(snapshot, null, 2)}\n`);
}

const gh = (args) => JSON.parse(execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 }));

// Same query as status.mjs: the merge queue and each open PR's gate description in one call.
const SNAPSHOT_QUERY =
  "query($owner:String!,$name:String!){ repository(owner:$owner,name:$name){ " +
  "mergeQueue { entries(first:100){ nodes { state position pullRequest { number } } } } " +
  `pullRequests(states:OPEN,first:100){ nodes { number commits(last:1){ nodes { commit { status { context(name:"${GATE_CONTEXT}"){ description } } } } } } } } }`;

function main(argv = process.argv.slice(2)) {
  const out = parseOutArg(argv);
  const from = parseFromArg(argv);
  if (from) {
    const snapshot = buildSnapshot(parseInput(readFileSync(from, "utf8")));
    if (out) writeSnapshot(snapshot, out);
    else console.log(JSON.stringify(snapshot, null, 2));
    return;
  }
  const reply = gh(["api", "graphql", "-F", "owner={owner}", "-F", "name={repo}", "-f", `query=${SNAPSHOT_QUERY}`]);
  const issues = gh(["issue", "list", "--state", "open", "--limit", String(ISSUE_LIMIT), "--json", "number,title,labels,body"]);
  // A blocker missing from a truncated list would read as closed, so refuse rather than publish a wrong "ready".
  if (issues.length >= ISSUE_LIMIT) throw new Error(`${ISSUE_LIMIT}+ open issues: too many to tell open blockers from closed ones`);
  const prs = gh(["pr", "list", "--state", "open", "--limit", "100", "--json", "number,statusCheckRollup,autoMergeRequest,closingIssuesReferences,headRefOid,comments"]);
  const snapshot = buildSnapshot({ prs, issues, mergeQueue: mergeQueueEntries(reply), gateDescriptions: gateDescriptions(reply), generatedAt: new Date().toISOString() });
  if (out) writeSnapshot(snapshot, out);
  else console.log(JSON.stringify(snapshot, null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
