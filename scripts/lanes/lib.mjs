// Pure logic for the lanes workflow: config, file classes, required reviewers, the task and PR contracts, and the gate
// decision. No I/O except loadConfig and the injected `api` in authorCanWrite; everything else is a plain function so
// it can be unit-tested.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";

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
  // ADR 0002: owner-only paths force /approve at every tier. Optional so older installed configs still load.
  // A present but null owner list is a typo, not an absent key, so it is rejected rather than read as [].
  const owner = raw?.paths?.owner === undefined ? [] : raw.paths.owner;
  if (!Array.isArray(owner)) throw new Error("lanes.config.json: paths.owner must be an array of regex strings");
  paths.owner = owner.map((source) => new RegExp(source));
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

/**
 * Parses every `*.md` in `dir` with `parseAdr`, in file-name order. A malformed ADR stays in the list as `{ error }`
 * (which governs nothing); a missing directory is `[]`. Callers read the working tree they run in, so the gate, which
 * runs from the default branch, never sees a PR's own ADR edits.
 */
export function loadAdrs(dir = "docs/adr") {
  let names;
  try {
    names = readdirSync(dir);
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
  return names
    .filter((n) => n.endsWith(".md"))
    .sort()
    .map((n) => parseAdr(readFileSync(join(dir, n), "utf8")));
}

/**
 * Which kinds of files a diff touches. Pass both the new and the old name of a renamed file. `adr` lists the accepted
 * ADRs (from `adrs`, default none) that govern any changed file.
 */
export function classifyFiles(files, config, adrs = []) {
  const { paths } = config;
  return {
    skipOnly: files.length > 0 && files.every((f) => matchesAny(paths.skip, f) && !matchesAny(paths.sensitive, f)),
    contract: files.some((f) => matchesAny(paths.contract, f)),
    sensitive: files.some((f) => matchesAny(paths.sensitive, f)),
    ui: files.some((f) => matchesAny(paths.ui, f)),
    owner: files.some((f) => matchesAny(paths.owner, f)),
    adr: [...new Set(files.flatMap((f) => adrGoverns(adrs, f)))].sort((a, b) => a - b),
  };
}

/** The fresh-eyes reviewers a PR must pass, from its issue's tier and its diff. */
export function requiredReviewers(tier, cls) {
  if (tier === "skip") return [];
  const out = ["test-hunter"];
  if (cls.ui) out.push("ui-reviewer");
  if (cls.sensitive) out.push("security-reviewer");
  if (cls.contract || cls.adr?.length > 0) out.push("architecture-advisor");
  return out;
}

/** What `reviewers.mjs` prints: a skip warning if due, the reviewers (or `none`), then `ADRs: NNNN, ...` if any govern. */
export function reviewersReport(tier, files, config, adrs = []) {
  const cls = classifyFiles(files, config, adrs);
  const lines = [];
  if (tier === "skip" && !cls.skipOnly) lines.push("NOT SKIP: the diff changes files outside the skip paths; use quick or full");
  const list = requiredReviewers(tier, cls);
  lines.push(...(list.length ? list : ["none"]));
  if (cls.adr.length) lines.push(`ADRs: ${cls.adr.map((n) => String(n).padStart(4, "0")).join(", ")}`);
  return lines.join("\n");
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

// ---- Architecture decision records (contracts/adr-template.md) ----

const ADR_TITLE_RE = /^#\s+(\d{4})\s*:\s*(.*)$/;
const ADR_STATUS_RE = /^(proposed|accepted|superseded by (\d{4}))$/;

/** Why a `Governs` entry is not a plain repo-relative path, or null when it is. */
function governsPathError(p) {
  if (/^([/\\]|[A-Za-z]:)/.test(p)) return `Governs entry is absolute: ${p}`;
  if (p.includes("`")) return `Governs entry has an unbalanced backtick: ${p}`;
  if (p.includes("\\")) return `Governs entry must use forward slashes: ${p}`;
  if (/[*?[\]{}!]/.test(p)) return `Governs entry is a glob, list the path or its directory: ${p}`;
  const segments = p.replace(/\/$/, "").split("/");
  if (segments.includes("..")) return `Governs entry contains ..: ${p}`;
  if (segments.some((s) => s === "" || s === ".")) return `Governs entry is not a normalized path: ${p}`;
  return null;
}

/**
 * Parses an ADR in the contracts/adr-template.md format.
 * @returns {{ number: number, title: string, status: "proposed" | "accepted" | "superseded", supersededBy?: number, governs: string[] } | { error: string }}
 */
export function parseAdr(text) {
  // Strip HTML comments until none remain, so a nested `<!-<!-- -->-` can't reassemble one after a single pass.
  let body = String(text ?? "").replace(/\r\n/g, "\n");
  for (let prev = null; prev !== body; ) {
    prev = body;
    body = body.replace(/<!--[\s\S]*?-->/g, "");
  }
  const lines = scanFences(body).filter((l) => !l.inFence).map((l) => l.line);
  const titleLine = lines.find((l) => l.startsWith("# "));
  if (!titleLine) return { error: "missing title line `# NNNN: <title>`" };
  const t = titleLine.match(ADR_TITLE_RE);
  if (!t) return { error: `title has no NNNN number: ${titleLine}` };
  const title = t[2].trim();
  if (!title) return { error: "missing title after the number" };
  const statusLine = lines.find((l) => /^Status:/.test(l));
  if (!statusLine) return { error: "missing status line `Status: proposed | accepted | superseded by NNNN`" };
  const rawStatus = statusLine.slice("Status:".length).trim();
  const s = rawStatus.match(ADR_STATUS_RE);
  if (!s) return { error: `unknown status: ${rawStatus} (expected proposed, accepted or superseded by NNNN)` };
  const dup = duplicateHeadings(body, "##");
  if (dup.length) return { error: `duplicate section: ${dup.join(", ")}` };
  const governs = [];
  for (const line of (parseSections(body, "##").governs ?? "").split("\n")) {
    if (!line.trim()) continue;
    const item = line.match(/^-\s+(.+)$/);
    if (!item) return { error: `Governs line is not a list item: ${line.trim()}` };
    const p = item[1].trim().replace(/^`(.*)`$/, "$1");
    const err = governsPathError(p);
    if (err) return { error: err };
    governs.push(p);
  }
  if (governs.length === 0) return { error: "empty Governs: list at least one repo-relative path" };
  const adr = { number: Number(t[1]), title, status: s[2] ? "superseded" : s[1], governs };
  if (s[2]) adr.supersededBy = Number(s[2]);
  return adr;
}

/** Numbers of the accepted ADRs whose Governs lists `file` exactly or a directory (trailing `/`) containing it. */
export function adrGoverns(adrs, file) {
  const f = posix.normalize(String(file ?? "").replace(/\\/g, "/"));
  if (f.startsWith("../") || f.startsWith("/")) return [];
  const hits = (adrs ?? [])
    .filter((a) => a && !a.error && a.status === "accepted")
    .filter((a) => a.governs.some((g) => (g.endsWith("/") ? f.startsWith(g) : f === g)))
    .map((a) => a.number);
  return [...new Set(hits)].sort((a, b) => a - b);
}

// ---- The gate decision ----

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@.*$/;

/**
 * SHA-256 (hex) of a unified diff that survives a merge from main when the PR's own change did not change (#25): it
 * drops `index` lines, reduces each hunk header to `@@` (line numbers and the function heading both move with code
 * above the hunk) and sorts the per-file blocks. Every other byte counts, whitespace and CR included, unlike
 * `git patch-id`: whitespace can change behaviour, so a whitespace-only change must invalidate a review.
 */
export function diffFingerprint(diffText) {
  const blocks = [];
  const lines = String(diffText ?? "").split("\n");
  // The diff's final newline belongs to whichever file comes last; dropping it keeps blocks order-independent.
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines) {
    if (line.startsWith("diff --git ") || blocks.length === 0) blocks.push([]);
    if (line.startsWith("index ")) continue;
    blocks.at(-1).push(HUNK_HEADER.test(line) ? "@@" : line);
  }
  const normalized = blocks.map((b) => b.join("\n")).sort();
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

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

/**
 * Why a full-tier PR still needs the owner, or null when it may merge unattended. `verdicts` are the parsed verdict
 * comments (`parseVerdictComment`) whose author already passed `authorCanWrite`, oldest first; only those bound to
 * `headSha` count, and the newest per reviewer is its verdict for this head.
 */
function fullTierBlocker({ pr, required, verdicts, headSha, reusedSha }) {
  if (pr.contractChange === "breaking") return "breaking contract change";
  const head = typeof headSha === "string" ? headSha.toLowerCase() : null;
  // #25: a reused test-hunter status brings along the test-hunter's verdict comment for the same commit, and only that.
  const bound = (v) => (head !== null && v.sha === head) || (reusedSha !== null && v.reviewer === REUSABLE_REVIEWER && v.sha === reusedSha);
  const forHead = (Array.isArray(verdicts) ? verdicts : []).filter((v) => v?.verdict && bound(v));
  for (const v of forHead) {
    const findings = Array.isArray(v.verdict.findings) ? v.verdict.findings : [];
    // Fails closed: any severity but minor (in any case, or unknown) blocks while unfixed.
    const unfixed = findings.find((f) => String(f?.severity ?? "").toLowerCase() !== "minor" && f?.fixed !== true);
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

/** The issue's one valid tier, or null when it has none or several. */
function tierOf(issueLabels) {
  const tiers = (Array.isArray(issueLabels) ? issueLabels : []).filter((l) => l.startsWith("tier:")).map((l) => l.slice(5)).filter((t) => TIERS.includes(t));
  return tiers.length === 1 ? tiers[0] : null;
}

/** The only reviewer whose status may be reused from an earlier commit (#25). */
export const REUSABLE_REVIEWER = "test-hunter";

/**
 * Whether the gate should look for a test-hunter success on an earlier commit (#25): only when the tier requires the
 * test-hunter and the head has no trusted review/test-hunter status. Any status on the head, a failure included, wins.
 */
export function testHunterReusable({ issueLabels, files, statuses, config, adrs = [] }) {
  const tier = tierOf(issueLabels);
  if (tier === null || !requiredReviewers(tier, classifyFiles(files, config, adrs)).includes(REUSABLE_REVIEWER)) return false;
  return !latestByContext(trustedStatuses(statuses)).has(reviewContext(REUSABLE_REVIEWER));
}

/**
 * What `lanes/gate` should say for a PR head. Pure: every input is passed in. `reused` (#25) is `{ sha, status }`: a
 * trusted review/test-hunter success from an earlier commit of the PR whose own diff matches the head's. It counts only
 * when the head has no trusted test-hunter status of its own, and brings along the test-hunter verdict for that `sha`.
 */
export function gateDecision({ prBody, issueLabels, issueState, issueAuthorCanWrite, issueIsPr, headRef, headSha, files, statuses, verdicts, config, adrs = [], reused = null }) {
  const fail = (description, stage = "contract") => ({ state: "failure", description, stage });
  const labels = Array.isArray(issueLabels) ? issueLabels : [];
  const pr = parsePrBody(prBody);
  if (pr.closes === null) return fail("PR body must say 'Closes #N' for its task issue");
  if (pr.duplicates.length > 0) return fail(`PR template sections repeated: ${pr.duplicates.join(", ")}`);
  const tier = tierOf(labels);
  if (tier === null) return fail(`issue #${pr.closes} needs exactly one tier:skip|quick|full label`);
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
  // #45: `adrs` come from the gate's own checkout of the default branch, never from the PR.
  const cls = classifyFiles(files, config, adrs);
  if (tier === "skip" && !cls.skipOnly) return fail("tier:skip but the diff changes files outside the skip paths");
  if (pr.contractChange === "none" && cls.contract) return fail("contract files changed but 'Contract changes' says none");
  if (pr.contractChange === "breaking" && !labels.includes("contract:breaking")) {
    return fail("a breaking contract change needs the issue label contract:breaking");
  }
  const latest = latestByContext(trustedStatuses(statuses));
  const hunter = reviewContext(REUSABLE_REVIEWER);
  // Defence in depth: the reused status must itself be a trusted test-hunter success on a real commit SHA.
  const reuse =
    !latest.has(hunter) && COMMIT_SHA_RE.test(reused?.sha ?? "") && reused.status?.context === hunter && reused.status.state === "success" && trustedStatuses([reused.status]).length === 1
      ? { sha: reused.sha.toLowerCase(), status: reused.status }
      : null;
  if (reuse) latest.set(hunter, reuse.status);
  const note = reuse ? `, test-hunter reused from ${reuse.sha.slice(0, 7)}` : "";
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
    return { state: "success", description: `approved by owner${note}`, stage: "ready" };
  }
  const waitOwner = (reason) => ({ state: "pending", description: `waiting on owner (/approve) (${reason})${note}`, stage: "owner" });
  // ADR 0002: the files that decide what gets checked and who approves always need the owner, at every tier. A
  // sensitive path only adds the security-reviewer (requiredReviewers); it no longer sends a PR to the owner.
  if (cls.owner) return waitOwner("owner-only path");
  if (!NEEDS_NOTHING.test(pr.sections["needs the owner"] ?? "")) return waitOwner("needs the owner");
  let blocker = null;
  if (tier === "full") blocker = fullTierBlocker({ pr, required, verdicts, headSha, reusedSha: reuse?.sha ?? null });
  else if (tier === "quick" && cls.contract) blocker = "contract change";
  if (blocker) return waitOwner(blocker);
  return { state: "success", description: `unattended-eligible (tier:${tier}), reviews in${note}`, stage: "ready" };
}
