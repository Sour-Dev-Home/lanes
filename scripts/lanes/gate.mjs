// Posts the `lanes/gate` commit status. Run by .github/workflows/lanes-gate.yml, always from the default branch.
// Inputs (environment): REPO, EVENT_NAME, PR_NUMBER, STATUS_SHA, STATUS_CONTEXT, STATUS_STATE, HEAD_REF, GROUP_SHA, ISSUE_NUMBER, GH_TOKEN.
// On workflow_run (the review ping, ADR 0021): RUN_PR_NUMBER (workflow_run.pull_requests[0].number, may be empty) and RUN_HEAD_SHA (workflow_run.head_sha).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  authorCanWrite,
  readBotIssueRelease,
  diffFingerprint,
  GATE_CONTEXT,
  gateDecision,
  interfaceContractOf,
  isLaneBot,
  issuePaths,
  parseIssueForm,
  pathsOverlap,
  latestByContext,
  loadAdrs,
  loadConfig,
  moduleMapProblem,
  nativeCodeOwnerApproval,
  parseCodeOwnerUsers,
  parseIdentity,
  parsePending,
  parsePrBody,
  parseVerdictComment,
  pendingFileHash,
  pendingReuseBlockedBy,
  REVIEWERS,
  reviewerNames,
  reusableReviewers,
  reuseBlockedBy,
  reviewContext,
  trustedStatuses,
} from "./lib.mjs";
import { parseBlockedBy, readBlockerReport } from "./blockers.mjs";

const SHA = /^[0-9a-f]{40}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const QUEUE_REF = /^(?:refs\/heads\/)?gh-readonly-queue\/[^/]+\/pr-([1-9][0-9]{0,8})-[0-9a-f]{40}$/;

// #281: a transient GitHub error (HTTP 500, 502, 503, 504 or no HTTP answer at all) is retried after 2, 4 and 8 seconds.
// One budget covers the whole run, so a GitHub outage adds at most RETRY_BUDGET_MS of waiting, never 14 seconds per call.
const RETRY_DELAYS_MS = [2000, 4000, 8000];
const RETRY_BUDGET_MS = 45000;
const TRANSIENT = new Set([500, 502, 503, 504]);

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const runGh = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** The call as "GET path" or "POST path", without the query string, so it is safe to show in a status description. */
const describeCall = (args) => `${args.includes("-f") ? "POST" : "GET"} ${String(args[0]).split("?")[0]}`;

export function makeGhApi({ run = runGh, sleep = sleepSync, budgetMs = RETRY_BUDGET_MS } = {}) {
  let left = budgetMs;
  return (args) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return run("gh", ["api", ...args]);
      } catch (e) {
        const httpStatus = Number(/HTTP (\d{3})/.exec(String(e?.stderr ?? ""))?.[1]) || undefined;
        const transient = httpStatus === undefined ? e?.code !== "ENOENT" : TRANSIENT.has(httpStatus);
        const delay = RETRY_DELAYS_MS[attempt];
        if (transient && delay !== undefined && delay <= left) {
          left -= delay;
          sleep(delay);
          continue;
        }
        throw Object.assign(e, { ghCall: describeCall(args), httpStatus });
      }
    }
  };
}

export const ghApi = makeGhApi();

function post(api, repo, sha, { state, description }) {
  api([`repos/${repo}/statuses/${sha}`, "-f", `state=${state}`, "-f", `context=${GATE_CONTEXT}`, "-f", `description=${description.slice(0, 140)}`]);
}

const statusesOf = (api, repo, sha) => JSON.parse(api([`repos/${repo}/commits/${sha}/statuses?per_page=100`]));

/**
 * The PR's verdict comments, oldest first, parsed with `parseVerdictComment` and kept only when their author passes
 * `authorCanWrite` (one lookup per login). Fails closed: comments that cannot be read mean no verdicts, so a full-tier
 * PR waits on the owner.
 */
export function trustedVerdicts(api, repo, number, names = REVIEWERS, identity = undefined) {
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
    const parsed = parseVerdictComment(comment?.body, names);
    if (!parsed) continue;
    const login = comment.login;
    // ADR 0020 part 3: the configured lane bot's comment counts without a permission lookup (it is no collaborator).
    if (isLaneBot(identity, { login })) {
      out.push(parsed);
      continue;
    }
    if (!canWrite.has(login)) canWrite.set(login, authorCanWrite(api, repo, login));
    if (canWrite.get(login)) out.push(parsed);
  }
  return out;
}

const REUSE_WALK = 20;
// A branch name safe to put before `...` in a compare URL: no `..` and nothing outside a plain ref's characters.
const BASE_REF = /^(?!.*\.\.)[A-Za-z0-9_./-]+$/;

// The compare API lists at most this many files; a list that long may be cut short, so it fails closed.
const COMPARE_FILES_CAP = 300;

/**
 * The trusted review successes to reuse on PR `number`'s head (#25, #154), as a list of `{ sha, status }`, one at most
 * per name in `reviewers`. For each reviewer, walks the PR's newest `REUSE_WALK` commits from newest to oldest to the
 * most recent one with a trusted review/<reviewer> status, and reuses it only if it is a success, that commit's own diff
 * (three-dot compare against the base branch, so merged-in main changes drop out) has the head's `diffFingerprint`,
 * and nothing changed between it and the head that the reviewer checks against (`reuseBlockedBy`, given the PR's
 * `files` and the gate's `adrs`). Fails closed per reviewer: any API error, an empty diff, or a changed-file list that
 * may be cut short means no reuse for it; a commit list that does not end at the head means no reuse at all.
 *
 * ADR 0023 part 3: when the reviewer's trusted verdict comment on that commit carries `pending` (workflow files the
 * owner commits in the web editor), the head's own diff may differ by those files alone. Each pending file is read at
 * the head and hashed with `pendingFileHash`, and `pendingReuseBlockedBy` decides. A refusal for that reason is
 * recorded in `blocked` (a Map from reviewer to reason) when given, for the gate to name. A `pending` that is
 * malformed, or a file that cannot be read, means no reuse.
 */
export function reusableReviews(api, repo, number, pr, reviewers, { files = [], adrs = [], config = undefined, blocked = undefined } = {}) {
  if (!Array.isArray(reviewers) || reviewers.length === 0) return [];
  const w = reviewWalk(api, repo, number, pr, config);
  if (w === null) return [];
  const { head, ownDiff, rawDiff, changedSince, statusesAt, walk } = w;
  let verdicts;
  const verdictsOnce = () => (verdicts ??= trustedVerdicts(api, repo, number, reviewerNames(config ?? {}), config?.identity));
  const out = [];
  for (const reviewer of reviewers) {
    const context = reviewContext(reviewer);
    try {
      const sha = walk.find((s) => statusesAt(s).has(context));
      if (sha === undefined) continue;
      const status = statusesAt(sha).get(context);
      if (status.state !== "success") continue;
      const earlier = verdictsOnce().findLast((v) => v.reviewer === reviewer && v.sha === sha);
      if (earlier?.verdict && Object.hasOwn(earlier.verdict, "pending")) {
        const pending = parsePending(earlier.verdict);
        if (pending === null) continue;
        const paths = pending.map((p) => p.path);
        const since = changedSince(sha);
        if (reuseBlockedBy(reviewer, since.filter((f) => !paths.includes(f)), files, adrs) !== null) continue;
        const headHashes = new Map(pending.map(({ path }) => [path, pendingBlobHash(api, repo, path, head)]));
        const reason = pendingReuseBlockedBy({ pending: earlier.verdict.pending, changedSince: since, headHashes, earlierDiff: rawDiff(sha), headDiff: rawDiff(head) });
        if (reason !== null) {
          blocked?.set(reviewer, reason);
          continue;
        }
        out.push({ sha, status });
        continue;
      }
      if (ownDiff(sha) !== ownDiff(head)) continue;
      if (reuseBlockedBy(reviewer, changedSince(sha), files, adrs) !== null) continue;
      out.push({ sha, status });
    } catch {
      continue;
    }
  }
  return out;
}

/**
 * `pendingFileHash` of `path`'s blob at `ref`, or null when the file is not committed there (HTTP 404). Any other
 * failure throws, so the caller fails closed. An unhashable blob (empty, invalid UTF-8) is null too: it never matches.
 */
function pendingBlobHash(api, repo, path, ref) {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  try {
    return pendingFileHash(api([`repos/${repo}/contents/${encoded}?ref=${ref}`, "-H", "Accept: application/vnd.github.raw"]));
  } catch (e) {
    if (e?.httpStatus === 404) return null;
    throw e;
  }
}

/**
 * #684: the head's `pendingFileHash` for every path a verdict bound to the head (or to a reused commit) lists as
 * `pending`, whether or not any verdict is reused, for `gateDecision`'s hand-over check. A path maps to the hash, null
 * (not committed), or the Error of a failed read, which the check treats as pending.
 */
export function pendingHeadHashes(api, repo, verdicts, head, reused) {
  const reuseShas = new Set((Array.isArray(reused) ? reused : []).map((r) => r?.sha));
  const headSha = typeof head === "string" ? head.toLowerCase() : null;
  const hashes = new Map();
  for (const v of Array.isArray(verdicts) ? verdicts : []) {
    if (!v?.verdict || !(v.sha === headSha || reuseShas.has(v.sha))) continue;
    for (const { path } of parsePending(v.verdict) ?? []) {
      if (hashes.has(path)) continue;
      try {
        hashes.set(path, pendingBlobHash(api, repo, path, head));
      } catch (e) {
        hashes.set(path, e instanceof Error ? e : new Error(String(e)));
      }
    }
  }
  return hashes;
}

/**
 * The lookups `reusableReviews` uses, or null when they cannot run: the head, each
 * commit's own diff fingerprint (three-dot compare against the base branch), the files changed since a commit, a
 * commit's trusted statuses, and the PR's newest `REUSE_WALK` commits before the head, newest first.
 */
function reviewWalk(api, repo, number, pr, config = undefined) {
  const head = pr?.head?.sha;
  const base = pr?.base?.ref;
  if (!SHA.test(head ?? "") || !BASE_REF.test(base ?? "")) return null;
  // Each lookup at most once per gate run, whichever reviewers share a commit.
  const once = (fn) => {
    const seen = new Map();
    return (sha) => {
      if (!seen.has(sha)) seen.set(sha, fn(sha));
      return seen.get(sha);
    };
  };
  const rawDiff = once((sha) => {
    const diff = api([`repos/${repo}/compare/${base}...${sha}`, "-H", "Accept: application/vnd.github.diff"]);
    if (typeof diff !== "string" || diff === "") throw new Error(`no diff for ${sha}`);
    return diff;
  });
  const ownDiff = once((sha) => diffFingerprint(rawDiff(sha)));
  const changedSince = once((sha) => {
    const [count, ...names] = api([`repos/${repo}/compare/${sha}...${head}`, "--jq", "(.files | length), (.files[] | .filename, (.previous_filename // empty))"])
      .split("\n")
      .filter(Boolean);
    if (!/^\d+$/.test(count ?? "") || Number(count) >= COMPARE_FILES_CAP) throw new Error(`cannot list the files changed since ${sha}`);
    return names;
  });
  const statusesAt = once((sha) => latestByContext(trustedStatuses(statusesOf(api, repo, sha), config?.identity, reviewerNames(config ?? {}))));
  let walk;
  try {
    const shas = api([`repos/${repo}/pulls/${number}/commits`, "--paginate", "--jq", ".[].sha"]).split("\n").filter(Boolean);
    // A push landed between reading the PR and its commits: decide on the next event instead.
    if (shas.at(-1) !== head) return null;
    walk = shas.slice(-REUSE_WALK).reverse().filter((sha) => sha !== head && SHA.test(sha));
  } catch {
    return null;
  }
  return { head, ownDiff, rawDiff, changedSince, statusesAt, walk };
}

/**
 * ADR 0021 part 1: `nativeCodeOwnerApproval`'s `{ approved, by }` for PR `pr`, from its native reviews (every page) and
 * the user owners of `.github/CODEOWNERS` in this checkout, which is the default branch's, never the PR's copy. Fails
 * closed: a failed read of either, or a CODEOWNERS file with no user owner, is `{ approved: false, by: null }`.
 */
export function readNativeApproval(api, repo, pr, config, codeOwnersPath = ".github/CODEOWNERS") {
  const none = { approved: false, by: null };
  try {
    const owners = parseCodeOwnerUsers(readFileSync(codeOwnersPath, "utf8"));
    const reviews = api([`repos/${repo}/pulls/${pr.number}/reviews`, "--paginate", "--jq", ".[] | {user: {login: .user.login, type: .user.type}, state, commit_id} | @json"])
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    return nativeCodeOwnerApproval(reviews, pr.user?.login, pr.head.sha, owners, config.identity);
  } catch {
    return none;
  }
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
  // An unusable module map would throw in reusableReviewers below; report it as a gate failure instead.
  const mapProblem = moduleMapProblem(config);
  if (mapProblem !== null) return { pr, decision: { state: "failure", description: `module map unusable: ${mapProblem}`, stage: "contract" } };
  // Both names of a renamed file: moving code into docs/ must not make a diff look docs-only.
  const files = api([`repos/${repo}/pulls/${number}/files`, "--paginate", "--jq", ".[] | .filename, (.previous_filename // empty)"])
    .split("\n")
    .filter(Boolean);
  const closes = parsePrBody(pr.body).closes;
  let issueLabels = [];
  let issueState = null;
  let issueAuthorCanWrite = false;
  let issueIsPr = false;
  // #241: the paths the issue's Interface contract names need the architecture-advisor; unread, it names none.
  let interfaceContract = "";
  // #635: the issue's claimed paths; an issue that claims none leaves every file uncovered, so it notes nothing.
  let scopePaths = [];
  // Fails closed until the issue's "Blocked by" has been read.
  let blockers = { ok: false, open: [], unreadable: [], error: "issue unreadable" };
  if (closes !== null) {
    try {
      const issue = JSON.parse(api([`repos/${repo}/issues/${closes}`]));
      issueLabels = issue.labels.map((l) => l.name);
      issueState = issue.state;
      // E2: the issues API also returns pull requests; only a `pull_request` key set means it is actually a PR.
      issueIsPr = issue.pull_request !== undefined && issue.pull_request !== null;
      interfaceContract = interfaceContractOf(issue.body);
      scopePaths = issuePaths(parseIssueForm(issue.body ?? "").fields);
      // ADR 0022 part 2: under team, a lane-filed bot issue a write-access actor released counts as a trusted author.
      issueAuthorCanWrite = authorCanWrite(api, repo, issue.user?.login) || readBotIssueRelease(api, config.identity, repo, Number(closes));
      // Only a trusted task issue's blockers are read: each costs an API call, and a stranger's PR runs this gate.
      // An untrusted issue fails in gateDecision before the blocker check, so the fail-closed default never shows.
      if (issueAuthorCanWrite === true && !issueIsPr && issueState === "open" && issueLabels.includes("ready")) {
        blockers = readBlockers(api, repo, issue.body);
      }
    } catch {
      issueLabels = []; // unknown issue: the decision then fails on the missing tier label
    }
  }
  const statuses = statusesOf(api, repo, pr.head.sha);
  const candidates = reusableReviewers({ issueLabels, files, statuses, config, adrs, interfaceContract });
  const pendingBlocked = new Map();
  const reused = candidates.length > 0 ? reusableReviews(api, repo, number, pr, candidates, { files, adrs, config, blocked: pendingBlocked }) : [];
  // ADR 0021, 0025: the owner stage is a native code-owner review, read live here so a merge_group run re-reads it
  // against the queued head.
  const verdicts = trustedVerdicts(api, repo, number, reviewerNames(config), config.identity);
  const inputs = {
    pendingHeadHashes: pendingHeadHashes(api, repo, verdicts, pr.head.sha, reused),
    nativeApproval: readNativeApproval(api, repo, { number, user: pr.user, head: pr.head }, config),
    prBody: pr.body,
    issueLabels,
    issueState,
    issueAuthorCanWrite,
    issueIsPr,
    headRef: pr.head.ref,
    headSha: pr.head.sha,
    files,
    statuses,
    verdicts,
    config,
    adrs,
    interfaceContract,
    reused,
    blockers,
    outsideScope: scopePaths.length > 0 ? files.filter((f) => !pathsOverlap([f], scopePaths)) : [],
  };
  let decision = gateDecision(inputs);
  // ADR 0023 part 3: a review refused for a pending workflow file names that file's reason instead of the bare wait.
  // #635: the outside-Scope note ends the description, so match the wait without it and put it back last.
  const noted = /^(.*?)(; \d+ files outside Scope, see PR body)?$/s.exec(decision.description);
  const waiting = decision.state === "pending" && decision.stage === "review" ? /^waiting for review\/(\S+)$/.exec(noted[1]) : null;
  if (waiting && pendingBlocked.has(waiting[1])) decision = { ...decision, description: `${noted[1]}: ${pendingBlocked.get(waiting[1])}${noted[2] ?? ""}` };
  return { pr, decision };
}

// Bounds the API calls one gate run spends on blockers; a longer list fails closed.
const MAX_BLOCKERS = 20;

/**
 * #36: `blockerReport` for a task issue's body through blockers.mjs's shared reader, one API call per blocker (at most
 * `MAX_BLOCKERS`). The issues API also answers for a PR, so a PR used as a blocker counts by its own state.
 */
export function readBlockers(api, repo, issueBody) {
  const { blockedBy } = parseBlockedBy(issueBody);
  if (blockedBy && blockedBy.length > MAX_BLOCKERS) return { ok: false, open: [], unreadable: [], error: `more than ${MAX_BLOCKERS} blockers` };
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

/** Runs the gate; when it cannot finish it posts `lanes/gate` = error on the commit it was deciding, then rethrows (non-zero exit). */
export function main(env = process.env, api = ghApi) {
  try {
    return decide(env, api);
  } catch (e) {
    // Only a failed GitHub call: other failures (a malformed input) keep their own outcome. A failed notice call also lands here,
    // which overwrites an already-posted status with error: the safe direction.
    if (e?.ghCall) postError(env, api, e);
    // ADR 0025: a config that is not team fails closed, with the one refusal message as the reason.
    else if (e?.teamRequired) postError(env, api, e, { state: "failure", description: e.message });
    throw e;
  }
}

function postError(env, api, e, decision = { state: "error", description: `gate error: ${e.ghCall} failed (${e.httpStatus ? `HTTP ${e.httpStatus}` : "no response"})` }) {
  try {
    let sha;
    if (env.EVENT_NAME === "merge_group") sha = env.GROUP_SHA;
    else if (env.EVENT_NAME === "status") sha = env.STATUS_SHA;
    else if (/^[1-9][0-9]{0,8}$/.test(env.PR_NUMBER ?? "")) {
      try {
        sha = JSON.parse(api([`repos/${env.REPO}/pulls/${env.PR_NUMBER}`])).head?.sha;
      } catch {}
    }
    if (!SHA.test(sha ?? "")) return;
    post(api, env.REPO, sha, decision);
  } catch {}
}

function decide(env, api) {
  // ADR 0025: the identity is checked before anything else; a config that is not team fails closed.
  const config = loadConfig();
  parseIdentity(config.identity);
  const repo = env.REPO ?? "";
  if (!REPO.test(repo)) throw new Error("REPO is missing or malformed");
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
        if (pr.state !== "open" || pr.head?.sha !== env.STATUS_SHA) continue;
        console.log(JSON.stringify(evaluatePr(api, repo, pr.number, config, adrs)));
      }
      return;
    }
    // ADR 0021: the review ping workflow completed. Default-branch code, like every trigger here. The PR comes from the
    // run's own list, else from the open PR whose head is the run's head SHA; with neither the gate posts nothing.
    case "workflow_run": {
      const numbers = [];
      if (/^[1-9][0-9]{0,8}$/.test(env.RUN_PR_NUMBER ?? "")) numbers.push(Number(env.RUN_PR_NUMBER));
      else if (SHA.test(env.RUN_HEAD_SHA ?? "")) {
        // The SHA was just checked to be 40 hex digits, so it is safe inside the jq filter.
        const found = api([`repos/${repo}/pulls?state=open&per_page=100`, "--paginate", "--jq", `.[] | select(.head.sha == "${env.RUN_HEAD_SHA}") | .number`]);
        for (const n of found.split("\n").filter(Boolean)) if (/^[1-9][0-9]{0,8}$/.test(n)) numbers.push(Number(n));
      }
      for (const n of numbers) console.log(JSON.stringify(evaluatePr(api, repo, n, config, adrs)));
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
