// Posts the `lanes/gate` commit status. Run by .github/workflows/lanes-gate.yml, always from the default branch.
// Inputs (environment): REPO, EVENT_NAME, PR_NUMBER, STATUS_SHA, STATUS_CONTEXT, HEAD_REF, GROUP_SHA, GH_TOKEN.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { authorCanWrite, GATE_CONTEXT, gateDecision, loadConfig, parsePrBody, parseVerdictComment } from "./lib.mjs";

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

/**
 * Gathers every input `gateDecision` needs for PR `number` from the API and returns its verdict, without posting
 * anything. Returns `null` for a closed PR. Shared by `evaluatePr` (posts on the PR head) and `carry` (posts on the
 * merge-group commit): the merge queue must re-decide from these same live inputs, never trust a `lanes/gate` status
 * already sitting on the head, since a lane-pushed workflow running in the queue with GITHUB_TOKEN could forge one (R3).
 */
export function decideForPr(api, repo, number, config) {
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
  if (closes !== null) {
    try {
      const issue = JSON.parse(api([`repos/${repo}/issues/${closes}`]));
      issueLabels = issue.labels.map((l) => l.name);
      issueState = issue.state;
      // E2: the issues API also returns pull requests; only a `pull_request` key set means it is actually a PR.
      issueIsPr = issue.pull_request !== undefined && issue.pull_request !== null;
      issueAuthorCanWrite = authorCanWrite(api, repo, issue.user?.login);
    } catch {
      issueLabels = []; // unknown issue: the decision then fails on the missing tier label
    }
  }
  const decision = gateDecision({
    prBody: pr.body,
    issueLabels,
    issueState,
    issueAuthorCanWrite,
    issueIsPr,
    headRef: pr.head.ref,
    headSha: pr.head.sha,
    files,
    statuses: statusesOf(api, repo, pr.head.sha),
    verdicts: trustedVerdicts(api, repo, number),
    config,
  });
  return { pr, decision };
}

export function evaluatePr(api, repo, number, config) {
  const result = decideForPr(api, repo, number, config);
  if (result === null) return null;
  post(api, repo, result.pr.head.sha, result.decision);
  return result.decision;
}

export function carry(api, repo, headRef, groupSha, config) {
  const match = QUEUE_REF.exec(headRef ?? "");
  let decision = { state: "failure", description: "cannot tell which PR this queue entry is for" };
  if (match) {
    const result = decideForPr(api, repo, Number(match[1]), config);
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
  switch (env.EVENT_NAME) {
    // pull_request_target (I3): the workflow trigger changed from pull_request so a PR cannot rewrite its own gate;
    // GitHub sets this exact event name on the resulting run, so both must be accepted here.
    case "pull_request":
    case "pull_request_target":
    case "workflow_dispatch":
      return console.log(JSON.stringify(evaluatePr(api, repo, Number(env.PR_NUMBER), config)));
    case "status": {
      // Intentionally duplicates the workflow's job-level if (defence in depth for manual runs).
      if (env.STATUS_CONTEXT === GATE_CONTEXT || !SHA.test(env.STATUS_SHA ?? "")) return;
      for (const pr of JSON.parse(api([`repos/${repo}/commits/${env.STATUS_SHA}/pulls`]))) {
        if (pr.state === "open" && pr.head?.sha === env.STATUS_SHA) console.log(JSON.stringify(evaluatePr(api, repo, pr.number, config)));
      }
      return;
    }
    case "merge_group":
      if (!SHA.test(env.GROUP_SHA ?? "")) throw new Error("GROUP_SHA is missing or malformed");
      return console.log(JSON.stringify(carry(api, repo, env.HEAD_REF, env.GROUP_SHA, config)));
    default:
      throw new Error(`unsupported event: ${env.EVENT_NAME}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
