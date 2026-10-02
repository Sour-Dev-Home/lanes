// The aggregates-only snapshot the dashboard publishes (ADR 0012, contracts/snapshot.schema.json): every task
// issue's stage and blockers, from the same functions /status uses. It keeps numbers, titles, stages, check and
// reviewer names and times; no logins, emails, bodies or comments reach the output.
// Usage: node scripts/lanes/snapshot.mjs [--out <file>] [--from <input.json>]   (--from builds offline, without gh)
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { GATE_CONTEXT, identityRefusal, loadConfig, nativeCodeOwnerApproval, parseCodeOwnerUsers, parseIdentity, parseIssueForm, parseVerdictComment, REVIEWERS, reviewerNames } from "./lib.mjs";
import { issuePaths, pathsOverlap } from "./paths.mjs";
import { STATUS_QUERY, gateDescriptions, mergeQueueEntries, prStage } from "./status.mjs";

// start.mjs is not part of the installed file set, so these two are copies of its RUNNING_LABEL and
// START_DEFAULTS.softPaths; snapshot.test.mjs fails if they drift.
export const RUNNING_LABEL = "lane:running";
export const DEFAULT_SOFT_PATHS = Object.freeze(["^docs/USING\\.md$", "^README\\.md$", "^lanes\\.config\\.json$"]);
const ISSUE_LIMIT = 1000;
const PR_LIMIT = 100; // also the GraphQL page size of STATUS_QUERY
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

// ADR 0024: the snapshot's own repository, as owner/name; anything else is not published.
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const URL_MAX = 500;
// A "." or ".." part would let a prefix check pass for a URL that resolves elsewhere; so would a dot segment in the URL.
const DOT_SEGMENT = /(^|\/)(\.|%2e){1,2}(\/|\?|#|$)/i;
const validRepo = (repo) => (typeof repo === "string" && REPO_PATTERN.test(repo) && !repo.split("/").some((part) => part === "." || part === "..") ? repo : undefined);

/**
 * ADR 0024: a check's link, kept only when it points into this repository on github.com. Whoever posts a status chooses
 * its targetUrl, so anything else (another repo, http, javascript:, whitespace, control characters) is dropped.
 */
function checkUrl(c, repo) {
  const url = c.detailsUrl ?? c.targetUrl;
  if (repo === undefined || typeof url !== "string" || url.length > URL_MAX) return undefined;
  if (!url.startsWith(`https://github.com/${repo}/`) || /[\s\u0000-\u001f\u007f-\u009f\\]|%5c|%2f/i.test(url) || DOT_SEGMENT.test(url.slice(8))) return undefined;
  return url;
}

const checksOf = (pr, repo) =>
  (pr.statusCheckRollup ?? []).map((c) => {
    const check = { name: clean(c.name ?? c.context), result: checkResult(c) };
    const url = checkUrl(c, repo);
    if (url !== undefined) check.url = url;
    return check;
  });

/**
 * The parsed verdict comments on a PR that count: trusted authors, bound to `headSha`, the newest per reviewer.
 * Nothing but the parsed verdict leaves this function.
 */
function currentVerdicts(comments, headSha, names) {
  const newest = new Map();
  for (const c of comments ?? []) {
    if (!TRUSTED_ASSOCIATIONS.has(c?.authorAssociation)) continue;
    const parsed = parseVerdictComment(c.body, names);
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
    case "conflict":
      return [{ kind: "owner", ref: "merge conflict", reason }];
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
export function buildSnapshot({ prs, issues, mergeQueue = [], gateDescriptions: gates = new Map(), softPaths = DEFAULT_SOFT_PATHS, reviewers = REVIEWERS, generatedAt, profile, repo: repoName, ownerApprovals = new Map() }) {
  const repo = validRepo(repoName);
  const queuePosition = new Map(mergeQueue.map((e) => [e.number, e.position]));
  const prOf = new Map();
  // A fork's PR is stranger-controlled (its check names are whatever its workflow calls them, and "Fixes #N" is free),
  // and those names would be published and compared with the PII secret. Only a PR proven same-repo counts; a missing
  // isCrossRepository counts as a stranger's.
  const sameRepo = prs.filter((pr) => pr.isCrossRepository === false);
  for (const pr of [...sameRepo].sort((a, b) => a.number - b.number)) for (const ref of pr.closingIssuesReferences ?? []) prOf.set(ref.number, pr);
  const blockedByOf = new Map(issues.map((i) => [i.number, [...new Set(parseIssueForm(i.body ?? "").fields.blockedBy ?? [])]]));
  const listed = issues
    .filter((i) => i.labels?.some((l) => l.name.startsWith("tier:")) || prOf.has(i.number))
    .sort((a, b) => a.number - b.number);
  const listedNumbers = new Set(listed.map((i) => i.number));

  const out = { version: 0, generatedAt, issues: [], edges: [] };
  if (profile === "solo" || profile === "team") out.profile = profile;
  if (repo !== undefined) out.repo = repo;
  for (const issue of listed) {
    const labels = issue.labels.map((l) => l.name);
    const tierLabel = labels.find((n) => n.startsWith("tier:"))?.slice(5);
    const item = { number: issue.number, title: clean(issue.title), tier: ["skip", "quick", "full"].includes(tierLabel) ? tierLabel : "unknown" };
    const openBlockers = blockedByOf.get(issue.number).filter((b) => blockedByOf.has(b));
    const pr = prOf.get(issue.number);
    if (pr) {
      const { stage, note } = prStage(pr, queuePosition.get(pr.number), gates.get(pr.number));
      // The dashboard knows no "conflict" stage: a conflicted PR waits on the owner there.
      item.stage = stage === "conflict" ? "owner" : stage;
      item.blockedBy = prBlockers(stage, note);
      item.pr = { number: pr.number, headSha: String(pr.headRefOid ?? "").toLowerCase(), checks: checksOf(pr, repo) };
      // ADR 0024: a boolean under team only; an unread or missing answer counts as not approved.
      if (profile === "team") item.pr.ownerApproved = ownerApprovals.get(pr.number) === true;
      const criteria = verdictCriteria(currentVerdicts(pr.comments, item.pr.headSha, reviewers), item.pr.headSha);
      if (criteria.length) item.criteria = criteria;
    } else {
      item.stage = labels.includes("needs-owner")
        ? "already met"
        : labels.includes(RUNNING_LABEL)
          ? "running"
          : labels.includes("ready")
            ? openBlockers.length
              ? "blocked"
              : "ready"
            : "not-ready";
      item.blockedBy = openBlockers.map((b) => ({ kind: "issue", ref: `#${b}`, reason: `blocked by #${b}` }));
    }
    out.issues.push(item);
    for (const b of blockedByOf.get(issue.number)) if (listedNumbers.has(b)) out.edges.push({ from: b, to: issue.number });
  }
  out.edges.sort((a, b) => a.from - b.from || a.to - b.to);
  out.overlaps = overlapPairs(issues, prOf, softPaths);
  return out;
}

/**
 * Every pair (a < b) of open ready or running issues without a PR whose Scope paths overlap, soft paths left out, the
 * check pick.mjs runs. Only the issue numbers leave here, never a path.
 */
function overlapPairs(issues, prOf, softPaths) {
  const soft = softPaths.map((s) => (s instanceof RegExp ? s : new RegExp(s)));
  const claims = issues
    .filter((i) => !prOf.has(i.number) && i.labels?.some((l) => l.name === "ready" || l.name === RUNNING_LABEL))
    .map((i) => ({ number: i.number, paths: issuePaths(parseIssueForm(i.body ?? "").fields).filter((p) => !soft.some((re) => re.test(p))) }))
    .filter((c) => c.paths.length)
    .sort((a, b) => a.number - b.number);
  const pairs = [];
  for (let i = 0; i < claims.length; i++) for (let j = i + 1; j < claims.length; j++) if (pathsOverlap(claims[i].paths, claims[j].paths)) pairs.push({ a: claims[i].number, b: claims[j].number });
  return pairs;
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
  const parsed = {
    prs: input.prs,
    issues: input.issues,
    mergeQueue: input.mergeQueue ?? [],
    gateDescriptions: new Map(Object.entries(gates).map(([n, d]) => [Number(n), d])),
    generatedAt: typeof input.generatedAt === "string" ? input.generatedAt : new Date().toISOString(),
  };
  // ADR 0024: the repo and, per PR number, whether a code owner's review covers the head (read by the caller under team).
  if (typeof input.repo === "string") parsed.repo = input.repo;
  const approved = input.ownerApproved;
  if (approved !== null && typeof approved === "object" && !Array.isArray(approved)) parsed.ownerApprovals = new Map(Object.entries(approved).map(([n, ok]) => [Number(n), ok === true]));
  return parsed;
}

/**
 * ADR 0024: PR number -> whether a code owner's native review covers the PR's head, for the team profile. `run` takes
 * `gh` arguments and returns stdout. Only the boolean is kept (never the reviewer's login), and any failed read of the
 * default branch's CODEOWNERS or of a PR's reviews leaves that answer false, the safe direction.
 */
export function readOwnerApprovals({ prs, repo, run, identity }) {
  const approvals = new Map();
  let owners = [];
  try {
    owners = parseCodeOwnerUsers(run(["api", `repos/${repo}/contents/.github/CODEOWNERS`, "-H", "Accept: application/vnd.github.raw"]));
  } catch {
    // no readable CODEOWNERS: nobody's review counts
  }
  for (const pr of prs) {
    let approved = false;
    try {
      if (owners.length && typeof pr.headRefOid === "string" && pr.headRefOid !== "") {
        const reviews = run(["api", `repos/${repo}/pulls/${pr.number}/reviews`, "--paginate", "--jq", ".[] | {user: {login: .user.login, type: .user.type}, state, commit_id} | @json"])
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));
        approved = nativeCodeOwnerApproval(reviews, pr.author?.login, pr.headRefOid, owners, identity).approved === true;
      }
    } catch {
      approved = false;
    }
    approvals.set(pr.number, approved);
  }
  return approvals;
}

export function writeSnapshot(snapshot, file) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(snapshot, null, 2)}\n`);
}

const gh = (args) => JSON.parse(execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 }));

// start.softPaths of the lanes.config.json in the working directory; the defaults when there is none or the key is absent.
function configuredSoftPaths() {
  let raw;
  try {
    raw = JSON.parse(readFileSync("lanes.config.json", "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return DEFAULT_SOFT_PATHS;
    throw err;
  }
  const soft = raw?.start?.softPaths;
  if (soft === undefined) return DEFAULT_SOFT_PATHS;
  if (!Array.isArray(soft) || soft.some((s) => typeof s !== "string")) throw new Error("lanes.config.json: start.softPaths must be an array of regex strings");
  return soft;
}

// The validated `identity` key of the lanes.config.json in the working directory; undefined when there is none.
function configuredIdentity() {
  try {
    return parseIdentity(JSON.parse(readFileSync("lanes.config.json", "utf8"))?.identity);
  } catch (err) {
    if (err.code === "ENOENT") return undefined;
    throw err;
  }
}

const ghText = (args) => execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });

function main(argv = process.argv.slice(2)) {
  const out = parseOutArg(argv);
  const from = parseFromArg(argv);
  // ADR 0025: a config that is not team shows the refusal line in place of data, and writes no snapshot file.
  const refusal = identityRefusal(() => readFileSync("lanes.config.json", "utf8"));
  if (refusal) return console.log(refusal);
  const identity = configuredIdentity();
  const profile = identity?.profile;
  if (from) {
    const snapshot = buildSnapshot({ ...parseInput(readFileSync(from, "utf8")), softPaths: configuredSoftPaths(), profile });
    if (out) writeSnapshot(snapshot, out);
    else console.log(JSON.stringify(snapshot, null, 2));
    return;
  }
  const reply = gh(["api", "graphql", "-F", "owner={owner}", "-F", "name={repo}", "-f", `query=${STATUS_QUERY}`]);
  const issues = gh(["issue", "list", "--state", "open", "--limit", String(ISSUE_LIMIT), "--json", "number,title,labels,body"]);
  // A blocker missing from a truncated list would read as closed, so refuse rather than publish a wrong "ready".
  if (issues.length >= ISSUE_LIMIT) throw new Error(`${ISSUE_LIMIT}+ open issues: too many to tell open blockers from closed ones`);
  const prs = gh(["pr", "list", "--state", "open", "--limit", String(PR_LIMIT), "--json", "number,isCrossRepository,mergeable,statusCheckRollup,autoMergeRequest,closingIssuesReferences,headRefOid,comments,author"]);
  // Same reason as issues: a PR cut off the list would leave its issue showing a wrong stage.
  if (prs.length >= PR_LIMIT) throw new Error(`${PR_LIMIT}+ open PRs: too many to list every issue's real stage`);
  let repo;
  try {
    repo = validRepo(gh(["repo", "view", "--json", "nameWithOwner"]).nameWithOwner);
  } catch {
    repo = undefined; // links are optional: the snapshot is still useful without them
  }
  // Team only, and only for same-repo PRs (the ones the snapshot lists).
  const ownerApprovals = profile === "team" && repo !== undefined ? readOwnerApprovals({ prs: prs.filter((p) => p.isCrossRepository === false), repo, run: ghText, identity }) : undefined;
  const snapshot = buildSnapshot({ prs, issues, mergeQueue: mergeQueueEntries(reply), gateDescriptions: gateDescriptions(reply), softPaths: configuredSoftPaths(), reviewers: reviewerNames(loadConfig()), generatedAt: new Date().toISOString(), profile, repo, ownerApprovals });
  if (out) writeSnapshot(snapshot, out);
  else console.log(JSON.stringify(snapshot, null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
