// Pure logic for the lanes workflow: config, file classes, required reviewers, the task and PR contracts, and the gate
// decision. No I/O except loadConfig and the injected `api` in authorCanWrite; everything else is a plain function so
// it can be unit-tested.
import { readFileSync } from "node:fs";

export const REVIEWERS = ["test-hunter", "ui-reviewer", "security-reviewer", "architecture-advisor"];
export const TIERS = ["skip", "quick", "full"];
export const GATE_CONTEXT = "lanes/gate";
export const reviewContext = (name) => `review/${name}`;

const PATH_KEYS = ["skip", "contract", "sensitive", "ui"];

export function compileConfig(raw) {
  const paths = {};
  for (const key of PATH_KEYS) {
    const list = raw?.paths?.[key];
    if (!Array.isArray(list)) throw new Error(`lanes.config.json: paths.${key} must be an array of regex strings`);
    paths[key] = list.map((source) => new RegExp(source));
  }
  const requiredChecks = raw?.requiredChecks;
  if (!Array.isArray(requiredChecks) || requiredChecks.length === 0) {
    throw new Error("lanes.config.json: requiredChecks must be a non-empty array");
  }
  return { requiredChecks, paths };
}

export function loadConfig(file = "lanes.config.json") {
  return compileConfig(JSON.parse(readFileSync(file, "utf8")));
}

const matchesAny = (patterns, file) => patterns.some((re) => re.test(file));

/** Which kinds of files a diff touches. Pass both the new and the old name of a renamed file. */
export function classifyFiles(files, config) {
  const { paths } = config;
  return {
    skipOnly: files.length > 0 && files.every((f) => matchesAny(paths.skip, f) && !matchesAny(paths.sensitive, f)),
    contract: files.some((f) => matchesAny(paths.contract, f)),
    sensitive: files.some((f) => matchesAny(paths.sensitive, f)),
    ui: files.some((f) => matchesAny(paths.ui, f)),
  };
}

/** The fresh-eyes reviewers a PR must pass, from its issue's tier and its diff. */
export function requiredReviewers(tier, cls) {
  if (tier === "skip") return [];
  const out = ["test-hunter"];
  if (cls.ui) out.push("ui-reviewer");
  if (cls.sensitive) out.push("security-reviewer");
  if (cls.contract) out.push("architecture-advisor");
  return out;
}

// ---- Contracts: the task issue form and the PR template ----

/**
 * CommonMark fence scanner: returns array of { line, inFence } for each line.
 * Fence opener: 0-3 spaces + 3+ backticks/tildes. Closer: same char, ≥ length, only whitespace after.
 */
function scanFences(text) {
  const lines = String(text ?? "").split("\n");
  const result = [];
  let fenceChar = null;
  let fenceLen = 0;

  for (const line of lines) {
    const indent = line.match(/^ {0,3}/)[0].length;
    const rest = line.slice(indent);
    const match = rest.match(/^(`{3,}|~{3,})/);

    if (match && fenceChar === null) {
      // This is a fence opener
      fenceChar = match[1][0];
      fenceLen = match[1].length;
      result.push({ line, inFence: true }); // Opener is part of the fence block
    } else if (match && fenceChar === match[1][0] && match[1].length >= fenceLen && /^\s*$/.test(rest.slice(match[1].length))) {
      // This is a fence closer
      result.push({ line, inFence: true }); // Closer is part of the fence block
      fenceChar = null;
      fenceLen = 0;
    } else {
      // Regular line
      result.push({ line, inFence: fenceChar !== null });
    }
  }
  return result;
}

/** Returns the lower-cased heading keys that appear more than once (fence-aware, comments stripped). */
export function duplicateHeadings(body, marker) {
  const text = String(body ?? "").replace(/\r\n/g, "\n").replace(/<!--[\s\S]*?-->/g, "");
  const scanned = scanFences(text);
  const headings = [];
  for (const { line, inFence } of scanned) {
    if (!inFence && line.startsWith(`${marker} `)) {
      const key = line.slice(marker.length + 1).trim().toLowerCase();
      headings.push(key);
    }
  }
  const counts = {};
  for (const h of headings) counts[h] = (counts[h] ?? 0) + 1;
  return Object.keys(counts).filter((k) => counts[k] > 1).sort();
}

/** Splits a markdown body into sections by headings of exactly `marker` ("##" or "###"). Keeps first occurrence of each heading. */
export function parseSections(body, marker) {
  const text = String(body ?? "").replace(/\r\n/g, "\n").replace(/<!--[\s\S]*?-->/g, "");
  const scanned = scanFences(text);
  const raw = {};
  let current = null;

  for (const { line, inFence } of scanned) {
    if (!inFence && line.startsWith(`${marker} `)) {
      const key = line.slice(marker.length + 1).trim().toLowerCase();
      if (!(key in raw)) {
        current = key;
        raw[current] = [];
      } else {
        current = null;
      }
      continue;
    }
    if (inFence) {
      current = null;
      continue;
    }
    if (current !== null) raw[current].push(line);
  }
  const out = {};
  for (const [key, lines] of Object.entries(raw)) {
    const value = lines.join("\n").trim();
    out[key] = value === "_No response_" ? "" : value;
  }
  return out;
}

const ISSUE_FIELDS = ["goal", "acceptance criteria", "interface contract", "scope", "blocked by", "tier"];

export function parseIssueForm(body) {
  const s = parseSections(body, "###");
  const errors = ISSUE_FIELDS.filter((f) => !s[f]).map((f) => `missing: ${f}`);
  const dups = duplicateHeadings(body, "###");
  for (const dup of dups) errors.push(`duplicate heading: ${dup}`);
  const criteria = (s["acceptance criteria"] ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^- \[[ xX]\]\s+\S/.test(l))
    .map((l) => l.replace(/^- \[[ xX]\]\s+/, ""));
  if (s["acceptance criteria"] && criteria.length === 0) errors.push("acceptance criteria: write each as a '- [ ] ...' line");
  const tier = (s.tier ?? "").trim().toLowerCase();
  if (s.tier && !TIERS.includes(tier)) errors.push(`tier must be one of ${TIERS.join(", ")}`);
  const blockedRaw = (s["blocked by"] ?? "").trim();
  let blockedBy = [];
  if (blockedRaw && blockedRaw.toLowerCase() !== "none") {
    blockedBy = [...blockedRaw.matchAll(/#(\d+)/g)].map((m) => Number(m[1]));
    if (blockedBy.length === 0) errors.push("blocked by: list issues as #N, or write none");
  }
  return {
    ok: errors.length === 0,
    errors,
    fields: { goal: s.goal ?? "", criteria, contract: s["interface contract"] ?? "", scope: s.scope ?? "", blockedBy, tier },
  };
}

export const PR_SECTIONS = ["what changed", "contract changes", "tests added", "reviewer results", "needs the owner", "not done"];
const CONTRACT_CHANGES = ["none", "additive", "breaking"];

export function parsePrBody(body) {
  const text = String(body ?? "").replace(/<!--[\s\S]*?-->/g, "");
  const scanned = scanFences(text);
  const textWithoutFences = scanned.filter(({ inFence }) => !inFence).map(({ line }) => line).join("\n");
  const closes = textWithoutFences.match(/\b(?:closes|fixes|resolves)\s+#(\d+)\b/i);
  const sections = parseSections(text, "##");
  const missing = PR_SECTIONS.filter((k) => !sections[k]);
  const duplicates = duplicateHeadings(text, "##");
  const first = (sections["contract changes"] ?? "").split(/\s/)[0].toLowerCase().replace(/[^a-z]/g, "");
  return {
    closes: closes ? Number(closes[1]) : null,
    missing,
    contractChange: CONTRACT_CHANGES.includes(first) ? first : null,
    duplicates,
    sections,
  };
}

// ---- Verdict comments ----

/**
 * The verdict comment post-review.mjs posts: `<!-- lanes:verdict <reviewer> <40-hex sha> -->`, a newline, then a
 * ```json fence holding the verdict, and nothing else. The marker must open the body, so a quoted marker further down
 * never counts. An old-format marker without a SHA parses with `sha: null` (unbound to any commit).
 */
const VERDICT_COMMENT_RE = /^<!-- lanes:verdict (\S+)(?: (\S+))? -->\r?\n```json\r?\n([\s\S]*)\r?\n```\s*$/;
const COMMIT_SHA_RE = /^[0-9a-f]{40}$/i;

/** @returns {{ reviewer: string, sha: string | null, verdict: object } | null} null for anything not well-formed */
export function parseVerdictComment(body) {
  const m = String(body ?? "").match(VERDICT_COMMENT_RE);
  if (!m) return null;
  const [, reviewer, sha, json] = m;
  if (!REVIEWERS.includes(reviewer)) return null;
  if (sha !== undefined && !COMMIT_SHA_RE.test(sha)) return null;
  let verdict;
  try {
    verdict = JSON.parse(json);
  } catch {
    return null;
  }
  if (verdict === null || typeof verdict !== "object" || Array.isArray(verdict) || verdict.reviewer !== reviewer) return null;
  return { reviewer, sha: sha === undefined ? null : sha.toLowerCase(), verdict };
}

// ---- The gate decision ----

/** Newest status per context (GitHub keeps every status ever posted on a commit). */
export function latestByContext(statuses) {
  const out = new Map();
  const sorted = [...(Array.isArray(statuses) ? statuses : [])]
    .filter((s) => s && typeof s.context === "string")
    .sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")));
  for (const s of sorted) if (!out.has(s.context)) out.set(s.context, s);
  return out;
}

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

/**
 * Whether `login` may hand a lane unattended-mergeable work (C1): write, maintain or admin permission on `repo`.
 * Read from the collaborator permission endpoint, whose legacy `permission` maps maintain to write and triage to read.
 * Not author_association, which reports a private org member as CONTRIBUTOR or NONE. `api` takes `gh api` arguments.
 * Fails closed: a bad login, an API error or an unexpected reply all mean no.
 */
export function authorCanWrite(api, repo, login) {
  if (typeof login !== "string" || !LOGIN.test(login)) return false;
  try {
    const permission = JSON.parse(api([`repos/${repo}/collaborators/${login}/permission`]))?.permission;
    return permission === "admin" || permission === "write";
  } catch {
    return false;
  }
}

/**
 * A status posted by a bot (GitHub Actions' own token, or any other App), not a human running `gh` with their own
 * account. Fails closed (E1): a status with no creator info at all cannot be vouched for as human-posted, so it is
 * treated as untrusted rather than assumed safe.
 */
export function isBotStatus(status) {
  const creator = status?.creator;
  if (!creator) return true;
  if (creator.type === "Bot") return true;
  return typeof creator.login === "string" && creator.login.endsWith("[bot]");
}

/**
 * Drops review/* statuses posted by a bot (I3): a PR that adds or edits a workflow can post one with GITHUB_TOKEN in
 * the merge queue, but a real reviewer or the owner always posts review/* by running `gh` as themselves.
 */
export function trustedStatuses(statuses) {
  return (Array.isArray(statuses) ? statuses : []).filter((s) => !(String(s?.context ?? "").startsWith("review/") && isBotStatus(s)));
}

const NEEDS_NOTHING = /^nothing\.?$/i;
const BLOCKING = ["critical", "important"];

/**
 * Why a full-tier PR still needs the owner, or null when it may merge unattended. `verdicts` are the parsed verdict
 * comments (`parseVerdictComment`) whose author already passed `authorCanWrite`, oldest first; only those bound to
 * `headSha` count, and the newest per reviewer is its verdict for this head.
 */
function fullTierBlocker({ pr, cls, required, verdicts, headSha }) {
  if (pr.contractChange === "breaking") return "breaking contract change";
  if (cls.sensitive) return "sensitive path";
  const head = typeof headSha === "string" ? headSha.toLowerCase() : null;
  const forHead = (Array.isArray(verdicts) ? verdicts : []).filter((v) => head !== null && v?.sha === head && v.verdict);
  for (const v of forHead) {
    const findings = Array.isArray(v.verdict.findings) ? v.verdict.findings : [];
    const unfixed = findings.find((f) => BLOCKING.includes(f?.severity) && f?.fixed !== true);
    if (unfixed) return `unfixed ${unfixed.severity} finding from ${v.reviewer}`;
  }
  const newest = new Map(forHead.map((v) => [v.reviewer, v]));
  for (const name of required) {
    const v = newest.get(name);
    if (!v) return `no verdict for head from ${name}`;
    if (v.verdict.verdict !== "success") return `verdict from ${name} is not success`;
  }
  return null;
}

/** What `lanes/gate` should say for a PR head. Pure: every input is passed in. */
export function gateDecision({ prBody, issueLabels, issueState, issueAuthorCanWrite, issueIsPr, headRef, headSha, files, statuses, verdicts, config }) {
  const fail = (description, stage = "contract") => ({ state: "failure", description, stage });
  const labels = Array.isArray(issueLabels) ? issueLabels : [];
  const pr = parsePrBody(prBody);
  if (pr.closes === null) return fail("PR body must say 'Closes #N' for its task issue");
  if (pr.duplicates.length > 0) return fail(`PR template sections repeated: ${pr.duplicates.join(", ")}`);
  const tiers = labels.filter((l) => l.startsWith("tier:")).map((l) => l.slice(5)).filter((t) => TIERS.includes(t));
  if (tiers.length !== 1) return fail(`issue #${pr.closes} needs exactly one tier:skip|quick|full label`);
  const tier = tiers[0];
  // E2: the GitHub issues API also returns pull requests; "Closes #N" must name a real task issue, not a PR.
  if (issueIsPr) return fail(`issue #${pr.closes} is a pull request, not a task issue`);
  // C1: a stranger's issue must never reach the unattended merge path, whatever labels a lane later applies to the PR.
  if (!labels.includes("ready")) return fail(`issue #${pr.closes} is not labelled ready; a maintainer must approve it first`);
  if (issueState !== "open") return fail(`issue #${pr.closes} is not open`);
  // Fails closed: anything but a literal true (an unread or unknown permission included) is untrusted.
  if (issueAuthorCanWrite !== true) {
    return fail(`issue #${pr.closes} was not opened by someone with write access to the repository`);
  }
  // I4: a lane cannot choose its own tier by branching off any name it likes.
  if (!new RegExp(`^issue-${pr.closes}-`).test(headRef ?? "")) {
    return fail(`the PR head branch must match issue-${pr.closes}-*`);
  }
  if (pr.missing.length > 0) return fail(`PR template sections missing: ${pr.missing.join(", ")}`);
  if (pr.contractChange === null) return fail("'Contract changes' must start with none, additive or breaking");
  const cls = classifyFiles(files, config);
  if (tier === "skip" && !cls.skipOnly) return fail("tier:skip but the diff changes files outside the skip paths");
  if (pr.contractChange === "none" && cls.contract) return fail("contract files changed but 'Contract changes' says none");
  if (pr.contractChange === "breaking" && !labels.includes("contract:breaking")) {
    return fail("a breaking contract change needs the issue label contract:breaking");
  }
  const latest = latestByContext(trustedStatuses(statuses));
  const required = requiredReviewers(tier, cls);
  for (const name of required) {
    const s = latest.get(reviewContext(name));
    if (!s) return { state: "pending", description: `waiting for review/${name}`, stage: "review" };
    if (s.state !== "success") return fail(`review/${name} is ${s.state}`, "review");
    if (String(s.description ?? "").startsWith("skipped")) {
      return fail(`review/${name} is required for this diff and cannot be skipped`, "review");
    }
  }
  if (latest.get(reviewContext("owner"))?.state === "success") {
    return { state: "success", description: "approved by owner", stage: "ready" };
  }
  const waitOwner = (reason) => ({ state: "pending", description: `waiting on owner (/approve) (${reason})`, stage: "owner" });
  if (!NEEDS_NOTHING.test(pr.sections["needs the owner"] ?? "")) return waitOwner("needs the owner");
  let blocker = null;
  if (tier === "full") blocker = fullTierBlocker({ pr, cls, required, verdicts, headSha });
  else if (tier === "quick" && cls.contract) blocker = "contract change";
  else if (tier === "quick" && cls.sensitive) blocker = "sensitive path";
  if (blocker) return waitOwner(blocker);
  return { state: "success", description: `unattended-eligible (tier:${tier}), reviews in`, stage: "ready" };
}
