// scripts/lanes/post-review.mjs
// Posts a review result as the commit status review/<reviewer> on a PR's current head.
// A reviewer's success or failure is a JSON verdict (the reviewer contract), validated first:
//   node scripts/lanes/post-review.mjs --file .lanes/verdicts/test-hunter.json [--pr N]
// Free text only for the owner's approval and for a reviewer the tier does not need:
//   node scripts/lanes/post-review.mjs owner success "approved by owner" --pr N
//     (the approve guard allows this only from /approve <N>, and this script itself refuses it without a fresh,
//     unused /approve <N> grant, which it consumes once the status is posted)
//   node scripts/lanes/post-review.mjs ui-reviewer skipped "no visible change"
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { findFreshGrant, grantDir } from "./approve-guard.mjs";
import { parseIssueForm, parsePrBody, REVIEWERS, reviewContext } from "./lib.mjs";

const RESULTS = ["pass", "fail", "not-applicable"];
const SEVERITIES = ["critical", "important", "minor"];
/** Reviewers that judge the acceptance criteria themselves, so they must assess every one. */
const MUST_COVER = ["test-hunter", "ui-reviewer"];

export function buildStatus(reviewer, verdict, summary) {
  if (![...REVIEWERS, "owner"].includes(reviewer)) throw new Error(`reviewer must be one of ${[...REVIEWERS, "owner"].join(", ")}`);
  if (reviewer === "owner" && verdict !== "success") throw new Error("the owner verdict is only 'success' (approve); to reject, comment on the PR");
  if (reviewer !== "owner" && verdict !== "skipped") throw new Error("a reviewer posts success or failure as a JSON verdict: --file <verdict.json>");
  const text = String(summary ?? "").trim();
  if (!text) throw new Error("summary is required");
  return {
    context: reviewContext(reviewer),
    state: "success",
    description: (verdict === "skipped" ? `skipped: ${text}` : text).slice(0, 140),
  };
}

const METRIC_TIERS = ["skip", "quick", "full"];
const METRIC_KEYS = ["tier", "minutes", "tokens"];

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

export function validateVerdict(v, { criteriaCount }) {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return { ok: false, errors: ["verdict must be a JSON object"], status: null };
  const errors = [];
  if (!REVIEWERS.includes(v.reviewer)) errors.push(`reviewer must be one of ${REVIEWERS.join(", ")}`);
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
  if (v.verdict === "success") {
    if (criteria.some((c) => c?.result === "fail")) errors.push("success is refused: a criterion fails");
    if (findings.some((f) => (f?.severity === "critical" || f?.severity === "important") && f?.fixed !== true)) {
      errors.push("success is refused: an unfixed critical or important finding");
    }
  }
  if (errors.length) return { ok: false, errors, status: null };

  const fixed = findings.filter((f) => f.fixed).length;
  const pass = criteria.filter((c) => c.result === "pass").length;
  const counts = criteria.length ? `${pass}/${criteriaCount} criteria pass, ${fixed} fixed` : `${fixed} fixed`;
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
export function buildVerdictComment(verdict, sha) {
  if (!REVIEWERS.includes(verdict?.reviewer)) throw new Error(`reviewer must be one of ${REVIEWERS.join(", ")}`);
  if (typeof sha !== "string" || !SHA_RE.test(sha)) throw new Error("the head SHA must be a 40-character hex commit SHA");
  return `<!-- lanes:verdict ${verdict.reviewer} ${sha} -->\n\`\`\`json\n${JSON.stringify(verdict, null, 2)}\n\`\`\``;
}

const gh = (args) => execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

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

/** M5: refuses a stale `--sha` (a push landed between /approve reading the head and posting the status). */
export function checkSha(sha, headRefOid) {
  if (sha === undefined) return null;
  if (sha.toLowerCase() !== String(headRefOid ?? "").toLowerCase()) {
    return `refusing: --sha ${sha} does not match the PR's current head ${headRefOid} (a new commit landed; re-run /approve)`;
  }
  return null;
}

/**
 * #81: the owner's approval needs an unused, unexpired `/approve N` grant for exactly that PR, however the command was
 * built. Returns the grant file to consume once the status is posted; throws when there is none.
 */
export function requireOwnerGrant(prArg, dir, now) {
  if (prArg === undefined || !/^[1-9][0-9]{0,8}$/.test(prArg)) throw new Error("the owner's approval needs --pr N (the PR the /approve grant names)");
  const file = findFreshGrant(dir, Number(prArg), now);
  if (file === null) throw new Error(`no fresh /approve ${prArg} grant: run /approve ${prArg} in the owner's session`);
  return file;
}

/**
 * Runs the CLI. `run` stands in for `gh` in tests. With `--file` the verdict comment is posted before the status: the
 * status event re-runs lanes/gate, which must find the comment then (#42). A failed comment throws before any status.
 */
export function main(argv = process.argv.slice(2), { run = gh, log = console.log, warn = console.warn, grantDir: dir = grantDir(), now = Date.now() } = {}) {
  const parsed = parseArgs(argv);
  const grantFile = !parsed.file && parsed.positional[0] === "owner" ? requireOwnerGrant(parsed.pr, dir, now) : null;
  const pr = JSON.parse(run(["pr", "view", ...(parsed.pr ? [parsed.pr] : []), "--json", "number,headRefOid,body"]));
  if (grantFile && String(pr.number) !== parsed.pr) throw new Error(`refusing: gh resolved --pr ${parsed.pr} to #${pr.number}`);
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
    const result = validateVerdict(verdict, { criteriaCount: parseIssueForm(issue.body).fields.criteria.length });
    if (!result.ok) throw new Error(`verdict refused:\n- ${result.errors.join("\n- ")}`);
    const warning = metricsWarning(verdict);
    if (warning) warn(warning);
    status = result.status;
    comment = buildVerdictComment(verdict, pr.headRefOid);
  } else {
    status = buildStatus(...parsed.positional);
  }
  if (comment) run(["pr", "comment", String(pr.number), "--body", comment]);
  run(["api", `repos/${repo}/statuses/${pr.headRefOid}`, "-f", `state=${status.state}`, "-f", `context=${status.context}`, "-f", `description=${status.description}`]);
  // Consumed only after the post succeeds: a failed post throws above and keeps the grant for a retry.
  if (grantFile) rmSync(grantFile, { force: true });
  log(`${status.context}=${status.state} on #${pr.number} at ${pr.headRefOid.slice(0, 7)}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
