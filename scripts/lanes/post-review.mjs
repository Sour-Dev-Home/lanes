// scripts/lanes/post-review.mjs
// Posts a review result as the commit status review/<reviewer> on a PR's current head.
// A reviewer's success or failure is a JSON verdict (the reviewer contract), validated first:
//   node scripts/lanes/post-review.mjs --file .lanes/verdicts/test-hunter.json [--pr N]
// Free text only for a reviewer the tier does not need:
//   node scripts/lanes/post-review.mjs ui-reviewer skipped "no visible change"
// The owner's approval is a native code-owner review in GitHub (ADR 0021, 0025); there is no owner status to post.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, parseIssueForm, parsePending, parsePrBody, REVIEWERS, reviewContext, reviewerNames } from "./lib.mjs";

export const TEAM_REASON = "under the team profile, approve the PR in GitHub (ADR 0021)";
const OWNER_REASON = TEAM_REASON;

/** The main checkout's root, found from `from` (a directory of any checkout or worktree) through `git rev-parse --git-common-dir`; the checkout holding `from` without git (#447). */
export function mainCheckoutFrom(from) {
  try {
    // An inherited GIT_DIR, GIT_COMMON_DIR or GIT_WORK_TREE would redirect the answer, so git reads only `from`.
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.toUpperCase().startsWith("GIT_")));
    const common = execFileSync("git", ["-C", from, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env, windowsHide: true }).trim();
    if (common !== "" && basename(common) === ".git") return dirname(common);
  } catch {
    // git missing or not a repository: the checkout holding this script is the best answer.
  }
  return resolve(from, "../..");
}

/**
 * The reviewer names a session may post (#463, ADR 0018): reviewerNames of the main checkout's lanes.config.json, never a
 * worktree's copy. A config that is missing, unreadable or invalid leaves the built-in four, and `owner` is never one.
 */
export function configuredReviewersFrom(from) {
  try {
    const names = reviewerNames(loadConfig(join(mainCheckoutFrom(from), "lanes.config.json"))).filter((n) => n !== "owner");
    // loadConfig does not check the modules block: a name that is not the agent-name shape (`Owner`, `owner `,
    // `review/owner`) could alias the owner's status, so one bad name leaves the built-in four.
    if (!names.every((n) => /^[a-z][a-z0-9-]*$/.test(n))) return [...REVIEWERS];
    return names;
  } catch {
    return [...REVIEWERS];
  }
}

/** configuredReviewersFrom for the checkout holding this script. */
export function configuredReviewers() {
  return configuredReviewersFrom(fileURLToPath(new URL(".", import.meta.url)));
}

const RESULTS = ["pass", "fail", "not-applicable"];
const SEVERITIES = ["critical", "important", "minor"];
/** Reviewers that judge the acceptance criteria themselves, so they must assess every one. */
const MUST_COVER = ["test-hunter", "ui-reviewer"];

/** `names` is the set a session may post (configuredReviewers of the main checkout's config, #463); `owner` is never in it. */
export function buildStatus(reviewer, verdict, summary, names = REVIEWERS) {
  if (reviewer === "owner") throw new Error(`there is no owner status: ${OWNER_REASON}`);
  const allowed = names.filter((n) => n !== "owner");
  if (!allowed.includes(reviewer)) throw new Error(`reviewer must be one of ${allowed.join(", ")}`);
  if (verdict !== "skipped") throw new Error("a reviewer posts success or failure as a JSON verdict: --file <verdict.json>");
  const text = String(summary ?? "").trim();
  if (!text) throw new Error("summary is required");
  return {
    context: reviewContext(reviewer),
    state: "success",
    description: (verdict === "skipped" ? `skipped: ${text}` : text).slice(0, 140),
  };
}

const METRIC_TIERS = ["skip", "quick", "full"];
const METRIC_KEYS = ["tier", "minutes", "tokens", "rounds"];

/**
 * The optional `metrics` object, by the rules of contracts/review-metrics.schema.json (checked in code, not read from
 * the file, so an installed copy of this script needs no contracts/ folder; contracts.test.mjs keeps them in step).
 */
function metricsErrors(m) {
  if (m === null || typeof m !== "object" || Array.isArray(m)) return ["metrics must be an object"];
  const errors = [];
  for (const key of Object.keys(m)) if (!METRIC_KEYS.includes(key)) errors.push(`metrics.${key} is not a known field`);
  if (!METRIC_TIERS.includes(m.tier)) errors.push(`metrics.tier must be ${METRIC_TIERS.join(", ")}`);
  if (typeof m.minutes !== "number" || !Number.isFinite(m.minutes) || m.minutes < 0) errors.push("metrics.minutes must be a number >= 0");
  if (!Number.isInteger(m.tokens) || m.tokens < 0) errors.push("metrics.tokens must be an integer >= 0");
  if (m.rounds !== undefined && (!Number.isInteger(m.rounds) || m.rounds < 1)) errors.push("metrics.rounds must be an integer >= 1");
  return errors;
}

/**
 * A one-line warning when a verdict carries no `metrics` (lane.md step 6 records them from the Agent tool's result),
 * or null. A warning, not a refusal: an Agent tool that reported no figures leaves `metrics` out rather than guess.
 */
export function metricsWarning(v) {
  if (v?.metrics !== undefined) return null;
  const who = String(v?.reviewer ?? "the reviewer").replace(/\s+/g, " ");
  return `warning: ${who}'s verdict has no metrics (tier, minutes, tokens); posting it anyway`;
}

/**
 * #447: a `security-reviewer` success over a failure already on the same SHA must carry `metrics`, the record of a reviewer
 * run, so a hand-edited verdict cannot turn the failure into a success. `latestState()` is read only in that case. Returns
 * the refusal or null. It stops accidental self-grading, not forged metrics (the single-account model).
 */
export function flipRefusal(verdict, latestState) {
  if (verdict?.reviewer !== "security-reviewer" || verdict.verdict !== "success" || verdict.metrics !== undefined) return null;
  if (latestState() !== "failure") return null;
  return "refusing: review/security-reviewer is failure on this commit and this success verdict has no metrics, the record of a reviewer run; re-run the security reviewer and post the verdict it returns";
}

/** The latest state of the status `context` on `sha` (the combined status keeps the newest per context), or null. */
function latestStatusState(run, repo, sha, context) {
  const combined = JSON.parse(run(["api", `repos/${repo}/commits/${sha}/status?per_page=100`]));
  const found = combined.statuses?.find((s) => s.context === context)?.state;
  // A truncated list may hide the failure: fail closed.
  if (found === undefined && combined.total_count > (combined.statuses?.length ?? 0)) return "failure";
  return found ?? null;
}

export function validateVerdict(v, { criteriaCount, names = REVIEWERS }) {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return { ok: false, errors: ["verdict must be a JSON object"], status: null };
  const errors = [];
  const allowed = names.filter((n) => n !== "owner");
  if (!allowed.includes(v.reviewer)) errors.push(`reviewer must be one of ${allowed.join(", ")}`);
  if (!["success", "failure"].includes(v.verdict)) errors.push("verdict must be success or failure");
  if (typeof v.summary !== "string" || !v.summary.trim()) errors.push("summary is required");
  let criteria = [];
  if (Array.isArray(v.criteria)) criteria = v.criteria;
  else errors.push("criteria must be an array");
  let findings = [];
  if (Array.isArray(v.findings)) findings = v.findings;
  else errors.push("findings must be an array");

  const seen = new Set();
  for (const c of criteria) {
    const index = c?.index;
    if (!Number.isInteger(index) || index < 1 || index > criteriaCount) errors.push(`criterion index ${index} is not 1..${criteriaCount}`);
    else if (seen.has(index)) errors.push(`criterion ${index} appears twice`);
    else seen.add(index);
    if (!RESULTS.includes(c?.result)) errors.push(`criterion ${index}: result must be ${RESULTS.join(", ")}`);
    if (typeof c?.evidence !== "string" || !c.evidence.trim()) errors.push(`criterion ${index}: evidence is required`);
  }
  if (MUST_COVER.includes(v.reviewer) && seen.size !== criteriaCount) {
    errors.push(`${v.reviewer} must assess all ${criteriaCount} criteria (got ${seen.size})`);
  }
  findings.forEach((f, i) => {
    if (!SEVERITIES.includes(f?.severity)) errors.push(`finding ${i + 1}: severity must be ${SEVERITIES.join(", ")}`);
    if (typeof f?.summary !== "string" || !f.summary.trim()) errors.push(`finding ${i + 1}: summary is required`);
    if (typeof f?.fixed !== "boolean") errors.push(`finding ${i + 1}: fixed must be true or false`);
  });
  if (v.metrics !== undefined) errors.push(...metricsErrors(v.metrics));
  // ADR 0023 part 3: workflow files the owner will commit; the gate reuses this review when they match these hashes.
  if (v.pending !== undefined && parsePending(v) === null) {
    errors.push("pending must be a non-empty list of { path: .github/workflows/<file>, sha256: 64 lowercase hex } with no repeated or .. path");
  }
  if (v.verdict === "success") {
    if (criteria.some((c) => c?.result === "fail")) errors.push("success is refused: a criterion fails");
    if (findings.some((f) => (f?.severity === "critical" || f?.severity === "important") && f?.fixed !== true)) {
      errors.push("success is refused: an unfixed critical or important finding");
    }
  }
  if (errors.length) return { ok: false, errors, status: null };

  const fixed = findings.filter((f) => f.fixed).length;
  const pass = criteria.filter((c) => c.result === "pass").length;
  // A count only reads right when the reviewer assessed something: "0/4 criteria pass" on an all-not-applicable review looks like a failure.
  const assessed = criteria.some((c) => c.result === "pass" || c.result === "fail");
  const counts = assessed ? `${pass}/${criteriaCount} criteria pass, ${fixed} fixed` : `${fixed} fixed`;
  return {
    ok: true,
    errors: [],
    status: { context: reviewContext(v.reviewer), state: v.verdict, description: `${counts}: ${v.summary.trim()}`.slice(0, 140) },
  };
}

/**
 * The verdict comment (the contract parseVerdictComment in lib.mjs reads back): a marker naming the reviewer and the
 * commit the status was posted on, then the verdict as a JSON fence. Pure, so the round-trip test needs no `gh`.
 */
export function buildVerdictComment(verdict, sha, names = REVIEWERS) {
  const allowed = names.filter((n) => n !== "owner");
  if (!allowed.includes(verdict?.reviewer)) throw new Error(`reviewer must be one of ${allowed.join(", ")}`);
  if (typeof sha !== "string" || !SHA_RE.test(sha)) throw new Error("the head SHA must be a 40-character hex commit SHA");
  return `<!-- lanes:verdict ${verdict.reviewer} ${sha} -->\n\`\`\`json\n${JSON.stringify(verdict, null, 2)}\n\`\`\``;
}

const gh = (args) => execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true });

const VALUED_FLAGS = new Set(["--file", "--pr", "--sha"]);
const SHA_RE = /^[0-9a-f]{40}$/i;

/**
 * Strict CLI parsing (M1 + T7): `--file` takes a value and then no positional arguments; the positional form (a
 * reviewer, a verdict and a summary) needs exactly 3 positionals; any other `--flag` is an error; a literal `--`
 * ends flag parsing, so a summary may start with `--` only after it.
 * @returns {{ file?: string, pr?: string, sha?: string, positional: string[] }}
 */
export function parseArgs(argv) {
  const out = { file: undefined, pr: undefined, sha: undefined, positional: [] };
  let doubleDash = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!doubleDash && a === "--") {
      doubleDash = true;
      continue;
    }
    if (!doubleDash && VALUED_FLAGS.has(a)) {
      const key = a.slice(2);
      if (out[key] !== undefined) throw new Error(`${a} may be given only once`);
      const value = argv[i + 1];
      if (value === undefined || value === "" || (VALUED_FLAGS.has(value) && value !== "--")) {
        throw new Error(`${a} requires a value`);
      }
      out[key] = value;
      i += 1;
      continue;
    }
    if (!doubleDash && a.startsWith("--")) throw new Error(`unknown flag: ${a}`);
    out.positional.push(a);
  }
  if (out.file !== undefined) {
    if (out.positional.length > 0) throw new Error("--file takes no positional arguments");
  } else if (out.positional.length !== 3) {
    throw new Error("usage: post-review.mjs <reviewer> <skipped|success> <summary>, or --file <verdict.json>");
  }
  if (out.sha !== undefined && !SHA_RE.test(out.sha)) throw new Error("--sha must be a 40-character hex commit SHA");
  return out;
}

/** M5: refuses a stale `--sha` (a push landed between reading the head and posting the status). */
export function checkSha(sha, headRefOid) {
  if (sha === undefined) return null;
  if (sha.toLowerCase() !== String(headRefOid ?? "").toLowerCase()) {
    return `refusing: --sha ${sha} does not match the PR's current head ${headRefOid} (a new commit landed; re-run the reviewer)`;
  }
  return null;
}

/**
 * Runs the CLI. `run` stands in for `gh` in tests. With `--file` the verdict comment is posted before the status: the
 * status event re-runs lanes/gate, which must find the comment then (#42). A failed comment throws before any status.
 */
export function main(argv = process.argv.slice(2), { run = gh, log = console.log, warn = console.warn, reviewers = configuredReviewers() } = {}) {
  const parsed = parseArgs(argv);
  // Refused before any gh call: nothing is read or posted.
  if (!parsed.file && parsed.positional[0] === "owner") throw new Error(`there is no owner status: ${OWNER_REASON}`);
  const { pr, status } = post(parsed, { run, warn, reviewers });
  log(`${status.context}=${status.state} on #${pr.number} at ${pr.headRefOid.slice(0, 7)}`);
}

/** Everything up to and including the status post. Throws, with nothing posted as the status, on any failure. */
function post(parsed, { run, warn, reviewers }) {
  const pr = JSON.parse(run(["pr", "view", ...(parsed.pr ? [parsed.pr] : []), "--json", "number,headRefOid,body"]));
  const staleSha = checkSha(parsed.sha, pr.headRefOid);
  if (staleSha) throw new Error(staleSha);
  const repo = run(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]).trim();
  let status;
  let comment = null;
  if (parsed.file) {
    const closes = parsePrBody(pr.body).closes;
    if (closes === null) throw new Error("the PR body has no 'Closes #N' outside code fences; fix the PR body first");
    const issue = JSON.parse(run(["issue", "view", String(closes), "--json", "body"]));
    const verdict = JSON.parse(readFileSync(parsed.file, "utf8"));
    const result = validateVerdict(verdict, { criteriaCount: parseIssueForm(issue.body).fields.criteria.length, names: reviewers });
    if (!result.ok) throw new Error(`verdict refused:\n- ${result.errors.join("\n- ")}`);
    const flip = flipRefusal(verdict, () => latestStatusState(run, repo, pr.headRefOid, result.status.context));
    if (flip) throw new Error(flip);
    const warning = metricsWarning(verdict);
    if (warning) warn(warning);
    status = result.status;
    comment = buildVerdictComment(verdict, pr.headRefOid, reviewers);
  } else {
    status = buildStatus(...parsed.positional.slice(0, 3), reviewers);
  }
  if (comment) run(["pr", "comment", String(pr.number), "--body", comment]);
  run(["api", `repos/${repo}/statuses/${pr.headRefOid}`, "-f", `state=${status.state}`, "-f", `context=${status.context}`, "-f", `description=${status.description}`]);
  return { pr, status };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
