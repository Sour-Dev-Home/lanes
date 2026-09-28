// Posts the `lanes/gate` commit status. Run by .github/workflows/lanes-gate.yml, always from the default branch.
// Inputs (environment): REPO, EVENT_NAME, PR_NUMBER, STATUS_SHA, STATUS_CONTEXT, HEAD_REF, GROUP_SHA, ISSUE_NUMBER, GH_TOKEN.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  authorCanWrite,
  diffFingerprint,
  GATE_CONTEXT,
  gateDecision,
  latestByContext,
  loadAdrs,
  loadConfig,
  parsePrBody,
  parseVerdictComment,
  REUSABLE_REVIEWER,
  reviewContext,
  testHunterReusable,
  trustedStatuses,
} from "./lib.mjs";
import { parseBlockedBy, readBlockerReport } from "./blockers.mjs";

const SHA = /^[0-9a-f]{40}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const QUEUE_REF = /^(?:refs\/heads\/)?gh-readonly-queue\/[^/]+\/pr-([1-9][0-9]{0,8})-[0-9a-f]{40}$/;

export function ghApi(args) {
  return execFileSync("gh", ["api", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function post(api, repo, sha, { state, description }) {
  api([`repos/${repo}/statuses/${sha}`, "-f", `state=${state}`, "-f", `context=${GATE_CONTEXT}`, "-f", `description=${description.slice(0, 140)}`]);
}

const statusesOf = (api, repo, sha) => JSON.parse(api([`repos/${repo}/commits/${sha}/statuses?per_page=100`]));

/**
 * The PR's verdict comments, oldest first, parsed with `parseVerdictComment` and kept only when their author passes
 * `authorCanWrite` (one lookup per login). Fails closed: comments that cannot be read mean no verdicts, so a full-tier
 * PR waits on the owner.
 */
export function trustedVerdicts(api, repo, number) {
  let lines;
  try {
    // @json emits one line per comment, whatever newlines its body holds.
    lines = api([`repos/${repo}/issues/${number}/comments`, "--paginate", "--jq", ".[] | {login: .user.login, body} | @json"]).split("\n").filter(Boolean);
  } catch {
    return [];
  }
  const canWrite = new Map();
  const out = [];
  for (const line of lines) {
    let comment;
    try {
      comment = JSON.parse(line);
    } catch {
      continue;
    }
    const parsed = parseVerdictComment(comment?.body);
    if (!parsed) continue;
    const login = comment.login;
    if (!canWrite.has(login)) canWrite.set(login, authorCanWrite(api, repo, login));
    if (canWrite.get(login)) out.push(parsed);
  }
  return out;
}

const REUSE_WALK = 20;
// A branch name safe to put before `...` in a compare URL: no `..` and nothing outside a plain ref's characters.
const BASE_REF = /^(?!.*\.\.)[A-Za-z0-9_./-]+$/;

/**
 * A trusted review/test-hunter success to reuse on PR `number`'s head (#25), as `{ sha, status }`, or null. Walks the
 * PR's newest `REUSE_WALK` commits from newest to oldest to the most recent one with a trusted review/test-hunter
 * status, and reuses it only if it is a success and that commit's own diff (three-dot compare against the base branch,
 * so merged-in main changes drop out) has the head's `diffFingerprint`. Fails closed: any API error, an empty diff,
 * or a commit list that does not end at the head means no reuse.
 */
export function reusableTestHunter(api, repo, number, pr) {
  const head = pr?.head?.sha;
  const base = pr?.base?.ref;
  if (!SHA.test(head ?? "") || !BASE_REF.test(base ?? "")) return null;
  const ownDiff = (sha) => {
    const diff = api([`repos/${repo}/compare/${base}...${sha}`, "-H", "Accept: application/vnd.github.diff"]);
    if (typeof diff !== "string" || diff === "") throw new Error(`no diff for ${sha}`);
    return diffFingerprint(diff);
  };
  try {
    const shas = api([`repos/${repo}/pulls/${number}/commits`, "--paginate", "--jq", ".[].sha"]).split("\n").filter(Boolean);
    // A push landed between reading the PR and its commits: decide on the next event instead.
    if (shas.at(-1) !== head) return null;
    for (const sha of shas.slice(-REUSE_WALK).reverse()) {
      if (sha === head || !SHA.test(sha)) continue;
      const status = latestByContext(trustedStatuses(statusesOf(api, repo, sha))).get(reviewContext(REUSABLE_REVIEWER));
      if (!status) continue;
      if (status.state !== "success") return null;
      return ownDiff(sha) === ownDiff(head) ? { sha, status } : null;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Gathers every input `gateDecision` needs for PR `number` from the API and returns its verdict, without posting
 * anything. Returns `null` for a closed PR. Shared by `evaluatePr` (posts on the PR head) and `carry` (posts on the
 * merge-group commit): the merge queue must re-decide from these same live inputs, never trust a `lanes/gate` status
 * already sitting on the head, since a lane-pushed workflow running in the queue with GITHUB_TOKEN could forge one (R3).
 */
export function decideForPr(api, repo, number, config, adrs = []) {
  const pr = JSON.parse(api([`repos/${repo}/pulls/${number}`]));
  if (pr.state !== "open") return null;
  // Both names of a renamed file: moving code into docs/ must not make a diff look docs-only.
  const files = api([`repos/${repo}/pulls/${number}/files`, "--paginate", "--jq", ".[] | .filename, (.previous_filename // empty)"])
    .split("\n")
    .filter(Boolean);
  const closes = parsePrBody(pr.body).closes;
  let issueLabels = [];
  let issueState = null;
  let issueAuthorCanWrite = false;
  let issueIsPr = false;
  // Fails closed until the issue's "Blocked by" has been read.
  let blockers = { ok: false, open: [], unreadable: [], error: "issue unreadable" };
  if (closes !== null) {
    try {
      const issue = JSON.parse(api([`repos/${repo}/issues/${closes}`]));
      issueLabels = issue.labels.map((l) => l.name);
      issueState = issue.state;
      // E2: the issues API also returns pull requests; only a `pull_request` key set means it is actually a PR.
      issueIsPr = issue.pull_request !== undefined && issue.pull_request !== null;
      issueAuthorCanWrite = authorCanWrite(api, repo, issue.user?.login);
      blockers = readBlockers(api, repo, issue.body);
    } catch {
      issueLabels = []; // unknown issue: the decision then fails on the missing tier label
    }
  }
  const statuses = statusesOf(api, repo, pr.head.sha);
  const reused = testHunterReusable({ issueLabels, files, statuses, config, adrs }) ? reusableTestHunter(api, repo, number, pr) : null;
  const decision = gateDecision({
    prBody: pr.body,
    issueLabels,
    issueState,
    issueAuthorCanWrite,
    issueIsPr,
    headRef: pr.head.ref,
    headSha: pr.head.sha,
    files,
    statuses,
    verdicts: trustedVerdicts(api, repo, number),
    config,
    adrs,
    reused,
    blockers,
  });
  return { pr, decision };
}

/**
 * #36: `blockerReport` for a task issue's body through blockers.mjs's shared reader, one API call per blocker. The
 * issues API also answers for a PR, so a PR used as a blocker counts by its own state.
 */
export function readBlockers(api, repo, issueBody) {
  return readBlockerReport(issueBody, (b) => JSON.parse(api([`repos/${repo}/issues/${b}`])).state);
}

/**
 * #36: after issue #`closed` closes, re-evaluates each open PR whose linked issue ("Closes #N") lists it in "Blocked
 * by", and no other. A PR whose issue cannot be read is skipped: its own next gate run fails closed on it anyway.
 */
export function reevaluateBlocked(api, repo, closed, config, adrs = []) {
  const prs = api([`repos/${repo}/pulls?state=open&per_page=100`, "--paginate", "--jq", ".[] | {number, body} | @json"]).split("\n").filter(Boolean);
  const lists = new Map();
  const listsClosed = (n) => {
    if (!lists.has(n)) {
      try {
        lists.set(n, parseBlockedBy(JSON.parse(api([`repos/${repo}/issues/${n}`])).body).blockedBy?.includes(closed) === true);
      } catch {
        lists.set(n, false);
      }
    }
    return lists.get(n);
  };
  const out = [];
  for (const line of prs) {
    let pr;
    try {
      pr = JSON.parse(line);
    } catch {
      continue;
    }
    const closes = parsePrBody(pr?.body).closes;
    if (closes === null || !Number.isInteger(pr.number) || !listsClosed(closes)) continue;
    out.push(evaluatePr(api, repo, pr.number, config, adrs));
  }
  return out;
}

export function evaluatePr(api, repo, number, config, adrs = []) {
  const result = decideForPr(api, repo, number, config, adrs);
  if (result === null) return null;
  post(api, repo, result.pr.head.sha, result.decision);
  return result.decision;
}

export function carry(api, repo, headRef, groupSha, config, adrs = []) {
  const match = QUEUE_REF.exec(headRef ?? "");
  let decision = { state: "failure", description: "cannot tell which PR this queue entry is for" };
  if (match) {
    const result = decideForPr(api, repo, Number(match[1]), config, adrs);
    if (result === null) decision = { state: "failure", description: "the PR for this queue entry is not open" };
    // A non-success decision (pending or failure) always carries as failure: the merge queue needs a definite
    // answer now, and "pending" must never be treated as good enough to merge.
    else decision = result.decision.state === "success" ? result.decision : { state: "failure", description: result.decision.description };
  }
  post(api, repo, groupSha, decision);
  return decision;
}

export function main(env = process.env, api = ghApi) {
  const repo = env.REPO ?? "";
  if (!REPO.test(repo)) throw new Error("REPO is missing or malformed");
  const config = loadConfig();
  // #45: the ADRs in this checkout (the default branch), so a PR's own ADR edits never change its required reviewers.
  const adrs = loadAdrs();
  switch (env.EVENT_NAME) {
    // pull_request_target (I3): the workflow trigger changed from pull_request so a PR cannot rewrite its own gate;
    // GitHub sets this exact event name on the resulting run, so both must be accepted here.
    case "pull_request":
    case "pull_request_target":
    case "workflow_dispatch":
      return console.log(JSON.stringify(evaluatePr(api, repo, Number(env.PR_NUMBER), config, adrs)));
    case "status": {
      // Intentionally duplicates the workflow's job-level if (defence in depth for manual runs).
      if (env.STATUS_CONTEXT === GATE_CONTEXT || !SHA.test(env.STATUS_SHA ?? "")) return;
      for (const pr of JSON.parse(api([`repos/${repo}/commits/${env.STATUS_SHA}/pulls`]))) {
        if (pr.state === "open" && pr.head?.sha === env.STATUS_SHA) console.log(JSON.stringify(evaluatePr(api, repo, pr.number, config, adrs)));
      }
      return;
    }
    case "issues": {
      if (!/^[1-9][0-9]{0,8}$/.test(env.ISSUE_NUMBER ?? "")) throw new Error("ISSUE_NUMBER is missing or malformed");
      for (const d of reevaluateBlocked(api, repo, Number(env.ISSUE_NUMBER), config, adrs)) console.log(JSON.stringify(d));
      return;
    }
    case "merge_group":
      if (!SHA.test(env.GROUP_SHA ?? "")) throw new Error("GROUP_SHA is missing or malformed");
      return console.log(JSON.stringify(carry(api, repo, env.HEAD_REF, env.GROUP_SHA, config, adrs)));
    default:
      throw new Error(`unsupported event: ${env.EVENT_NAME}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
