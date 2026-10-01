// Pure logic for the lanes workflow: config, file classes, required reviewers, the task and PR contracts, and the gate
// decision. No I/O except loadConfig and the injected `api` in authorCanWrite; everything else is a plain function so
// it can be unit-tested.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { reviewersFor } from "./modules.mjs";

export const REVIEWERS = ["test-hunter", "ui-reviewer", "security-reviewer", "architecture-advisor"];
export const TIERS = ["skip", "quick", "full"];
export const GATE_CONTEXT = "lanes/gate";
export const reviewContext = (name) => `review/${name}`;

const LANE_NAME = /^lane-([1-9]\d*)$/;
const LANE_FOLDER = /^issue-(\d+)(?:-.*)?$/;

/**
 * The issue a background session works, or null. `start.mjs` names each lane `lane-<N>`, which stays true whatever
 * cwd `claude agents --json` reports (a lane that entered its worktree by path can still report the repository
 * root), so the name wins. Otherwise the issue comes from the `issue-<N>` or `issue-<N>-<slug>` worktree folder in
 * the cwd: the one directly under the last `.claude/worktrees`, whatever lane-shaped folders sit above it or below
 * it; a cwd with no `.claude/worktrees` falls back to its first lane-shaped folder. A session with any other non-empty
 * name is never a lane (#494); only an unnamed session uses the cwd fallback.
 * @param {{ kind?: string, name?: string, cwd?: string } | null} session a `claude agents --json` entry, or
 *   cleanup.mjs's `sessionsFrom` output (which has no `kind`)
 * @returns {number | null}
 */
export function laneIssueOf(session) {
  if (!session || typeof session !== "object" || (session.kind !== undefined && session.kind !== "background")) return null;
  const named = typeof session.name === "string" ? Number(LANE_NAME.exec(session.name)?.[1]) : NaN;
  if (Number.isSafeInteger(named)) return named;
  // #494: a session with any other name (the owner session, a coordinator) is never a lane, whatever its cwd.
  if (typeof session.name === "string" && session.name !== "") return null;
  if (typeof session.cwd !== "string") return null;
  const segs = session.cwd.split(/[\\/]+/);
  const at = segs.findLastIndex((seg, i) => seg === "worktrees" && segs[i - 1] === ".claude");
  const lane = (seg) => {
    const n = Number(LANE_FOLDER.exec(seg ?? "")?.[1]);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  };
  return at >= 0 ? lane(segs[at + 1]) : (segs.map(lane).find(Boolean) ?? null);
}

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
  // ADR 0018: the optional module map, kept as written; modules.mjs validates it.
  const config = raw.modules === undefined ? { requiredChecks, paths } : { requiredChecks, paths, modules: raw.modules };
  // ADR 0020 part 1: the validated identity, so the gate can read the configured lane bot; absent when the key is.
  const identity = parseIdentity(raw.identity);
  return identity === undefined ? config : { ...config, identity };
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

const normPath = (f) => posix.normalize(String(f).replace(/\\/g, "/"));
// #241: the ADRs themselves and the module map (the `modules` key of lanes.config.json) are architecture changes.
const isArchitectureFile = (f) => f.startsWith("docs/adr/") || f === "lanes.config.json";

/**
 * The repo-relative paths a task issue's Interface contract names (#241): backticked or bare tokens with a `/` or a
 * file extension, a trailing `/` marking a directory. A contract that starts with `none` names none; an absolute or
 * `..` path is dropped, since no diff path can match it.
 */
export function interfacePaths(text) {
  const s = String(text ?? "").trim();
  if (/^none\b/i.test(s)) return [];
  const out = new Set();
  for (const token of s.match(/[\w./\\-]+/g) ?? []) {
    const t = token.replace(/\.+$/, "");
    if (!t.includes("/") && !t.includes("\\") && !/\.[A-Za-z][\w-]+$/.test(t)) continue;
    if (/^([/\\]|[A-Za-z]:)/.test(t)) continue;
    const p = normPath(t) + (/[/\\]$/.test(t) ? "/" : "");
    if (p === "./" || p === "." || p.startsWith("../") || p === "..") continue;
    out.add(p.replace(/\/\/$/, "/"));
  }
  return [...out];
}

/** A task issue body's Interface contract text (#241), or `""` for a body that is missing or not a string. */
export function interfaceContractOf(body) {
  return typeof body === "string" ? parseIssueForm(body).fields.contract : "";
}

/**
 * Which kinds of files a diff touches. Pass both the new and the old name of a renamed file. `adr` lists the accepted
 * ADRs (from `adrs`, default none) that govern any changed file. `architecture` (#241) is a change to an ADR, to
 * lanes.config.json, or to a path the issue's `interfaceContract` text names.
 */
export function classifyFiles(files, config, adrs = [], interfaceContract = "") {
  const { paths } = config;
  const named = interfacePaths(interfaceContract);
  const inContract = (f) => named.some((p) => (p.endsWith("/") ? f.startsWith(p) : f === p));
  return {
    skipOnly: files.length > 0 && files.every((f) => matchesAny(paths.skip, f) && !matchesAny(paths.sensitive, f)),
    contract: files.some((f) => matchesAny(paths.contract, f)),
    sensitive: files.some((f) => matchesAny(paths.sensitive, f)),
    ui: files.some((f) => matchesAny(paths.ui, f)),
    owner: files.some((f) => matchesAny(paths.owner, f)),
    adr: [...new Set(files.flatMap((f) => adrGoverns(adrs, f)))].sort((a, b) => a - b),
    architecture: files.map(normPath).some((f) => isArchitectureFile(f) || inContract(f)),
  };
}

/**
 * The fresh-eyes reviewers a PR must pass, from its issue's tier and its diff. The architecture-advisor runs for a
 * contract or architecture change (#241), not for every diff an accepted ADR governs.
 */
export function requiredReviewers(tier, cls, files = [], modules = undefined) {
  if (tier === "skip") return [];
  const out = ["test-hunter"];
  if (cls.ui) out.push("ui-reviewer");
  if (cls.sensitive) out.push("security-reviewer");
  if (cls.contract || cls.architecture) out.push("architecture-advisor");
  // ADR 0018: a module's configured reviewers are added to the built-in ones, never a replacement.
  for (const name of reviewersFor(files, modules)) if (!out.includes(name)) out.push(name);
  return out;
}

/** The names a verdict may carry: the built-in reviewers plus every configured one; `owner` is never a reviewer. */
export function reviewerNames(config) {
  const names = [...REVIEWERS];
  // Tolerant of a malformed map: readers must not crash on it, and moduleMapProblem reports it.
  const entries = Array.isArray(config?.modules?.entries) ? config.modules.entries : [];
  for (const e of entries) {
    const list = Array.isArray(e?.reviewers) ? e.reviewers : [];
    for (const r of list) if (typeof r === "string" && r !== "owner" && !names.includes(r)) names.push(r);
  }
  return names;
}

/** Why the config's module map cannot be used (malformed, or a configured reviewer with no agent file), or null. */
export function moduleMapProblem(config) {
  try {
    reviewersFor([], config?.modules);
    return null;
  } catch (e) {
    return String(e?.message ?? e);
  }
}

/** What `reviewers.mjs` prints: a skip warning if due, the reviewers (or `none`), then `ADRs: NNNN, ...` if any govern. */
export function reviewersReport(tier, files, config, adrs = [], interfaceContract = "") {
  const cls = classifyFiles(files, config, adrs, interfaceContract);
  const lines = [];
  if (tier === "skip" && !cls.skipOnly) lines.push("NOT SKIP: the diff changes files outside the skip paths; use quick or full");
  const list = requiredReviewers(tier, cls, files, config.modules);
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

export class ValidationParseError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationParseError";
  }
}

const VALIDATE_FORM = "validate: <command> — <regex> <op> <threshold> (attempts: N)";
// The line is split in three passes (attempts suffix, operator and threshold, command separator) so no
// single pattern has overlapping groups: each pass is linear, whatever the line holds.
const VALIDATE_ATTEMPTS = /\(attempts:\s*(\d+)\)$/;
const VALIDATE_OP_THRESHOLD = /\s(<=|>=|<|>)\s+(-?\d+(?:\.\d+)?)\s+$/;
const VALIDATE_SEPARATOR = /\s+—\s+/g;
export const VALIDATE_MAX_LENGTH = 500;

function splitValidateLine(body) {
  const att = VALIDATE_ATTEMPTS.exec(body);
  if (!att) return null;
  const head = body.slice(0, att.index);
  const ot = VALIDATE_OP_THRESHOLD.exec(head);
  if (!ot) return null;
  const rest = head.slice(0, ot.index);
  for (const sep of rest.matchAll(VALIDATE_SEPARATOR)) {
    const end = sep.index + sep[0].length;
    // the old `.` groups never matched a line terminator, so a multi-line command or regex stays malformed
    if (end < rest.length && !/[\n\r\p{Zl}\p{Zp}]/u.test(rest.slice(0, sep.index) + rest.slice(end))) return [rest.slice(0, sep.index), rest.slice(end), ot[1], ot[2], att[1]];
  }
  return null;
}

/**
 * Parses a validation-loop criterion (ADR 0012): `validate: <command> — <regex> <op> <threshold> (attempts: N)`.
 * @returns {{ command: string, regex: string, op: "<"|"<="|">"|">=", threshold: number, attempts: number } | null}
 *   null for a criterion that does not start with `validate:`
 * @throws {ValidationParseError} for a `validate:` line that is malformed
 */
export function parseValidation(line) {
  const text = String(line ?? "").trim();
  if (!text.startsWith("validate:")) return null;
  if (text.length > VALIDATE_MAX_LENGTH) throw new ValidationParseError(`validate: line is over ${VALIDATE_MAX_LENGTH} characters`);
  const parts = splitValidateLine(text.slice("validate:".length));
  if (!parts) throw new ValidationParseError(`malformed validate: line, expected "${VALIDATE_FORM}"`);
  const [command, regex, op, threshold, attempts] = parts;
  if (!command.trim()) throw new ValidationParseError("validate: line has an empty command");
  const n = Number(attempts);
  if (!Number.isInteger(n) || n < 1 || n > 10) throw new ValidationParseError(`validate: attempts must be 1 to 10, got ${attempts}`);
  let compiled;
  try {
    compiled = new RegExp(regex);
  } catch (err) {
    throw new ValidationParseError(`validate: regex does not compile (${err.message})`);
  }
  if (new RegExp(`${compiled.source}|`).exec("")?.length < 2) throw new ValidationParseError("validate: regex needs a capture group for the metric");
  return { command: command.trim(), regex, op, threshold: Number(threshold), attempts: n };
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
export function parseVerdictComment(body, names = REVIEWERS) {
  const m = String(body ?? "").match(VERDICT_COMMENT_RE);
  if (!m) return null;
  const [, reviewer, sha, json] = m;
  if (!names.includes(reviewer)) return null;
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
export function trustedStatuses(statuses, identity = undefined, names = []) {
  const reviewers = Array.isArray(names) ? names : [];
  // ADR 0020 part 2: the one exception is the configured lane bot's status for a configured non-owner reviewer. A status
  // needs creator type Bot as well (isLaneBot matches a comment author, which has no type, on login alone).
  const laneBot = (s) => {
    const name = String(s?.context ?? "").slice("review/".length);
    return s?.creator?.type === "Bot" && isLaneBot(identity, s.creator) && name !== "owner" && reviewers.includes(name);
  };
  return (Array.isArray(statuses) ? statuses : []).filter((s) => !(String(s?.context ?? "").startsWith("review/") && isBotStatus(s)) || laneBot(s));
}

const BOT_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\[bot\]$/;

/**
 * ADR 0020 part 2: whether `actor` (a status creator or a comment author, `{ login, type? }`) is the lane App bot the
 * config names. Only under the team profile with `app.botLogin` set, on an exact, case-sensitive login. An actor that
 * carries a type must have type Bot; a comment author carries none, and the reserved `[bot]` suffix covers that.
 */
export function isLaneBot(identity, actor) {
  const login = identity?.app?.botLogin;
  if (identity?.profile !== "team" || typeof login !== "string" || login === "") return false;
  if (actor === null || typeof actor !== "object" || actor.login !== login) return false;
  return actor.type === undefined || actor.type === "Bot";
}

const LANE_FILED = "lane-filed";

/**
 * ADR 0022 part 1: whether a bot-authored issue was released by a write-access actor. `issue` is `{ user, labels }` (labels
 * as names or `{ name }`), `events` the issue's events, `edit` `{ lastEditedAt, editor }` or null for a never-edited body,
 * and `canWrite(login)` is injected (authorCanWrite bound to an api and repo). True only when every clause holds; a
 * missing field or an unexpected shape is false. An edit in the same second as the release also needs a write-access
 * editor, since timestamps have no finer grain to tell the order.
 */
export function botIssueReleased(identity, issue, events, edit, canWrite) {
  try {
    if (typeof canWrite !== "function" || issue === null || typeof issue !== "object") return false;
    if (!isLaneBot(identity, issue.user) || issue.user.type !== "Bot") return false;
    if (!Array.isArray(issue.labels) || !Array.isArray(events)) return false;
    const names = issue.labels.map((l) => (typeof l === "string" ? l : l?.name));
    if (names.some((n) => typeof n !== "string") || names.includes(LANE_FILED)) return false;
    const marks = [];
    for (const e of events) {
      if (e === null || typeof e !== "object") return false;
      if ((e.event !== "labeled" && e.event !== "unlabeled") || e.label?.name !== LANE_FILED) continue;
      if (!Number.isFinite(e.id) || Number.isNaN(Date.parse(e.created_at))) return false;
      marks.push(e);
    }
    if (marks.length === 0) return false;
    const last = marks.reduce((a, b) => (b.id > a.id ? b : a));
    const actor = last.actor?.login;
    if (last.event !== "unlabeled" || typeof actor !== "string" || isLaneBot(identity, last.actor)) return false;
    if (canWrite(actor) !== true) return false;
    if (edit === null) return true;
    if (typeof edit !== "object" || edit === undefined) return false;
    const editedAt = Date.parse(edit.lastEditedAt);
    if (Number.isNaN(editedAt)) return false;
    if (editedAt < Date.parse(last.created_at)) return true;
    return typeof edit.editor?.login === "string" && !isLaneBot(identity, edit.editor) && canWrite(edit.editor.login) === true;
  } catch {
    return false;
  }
}

const RELEASE_EVENTS = ".[] | {id, event, created_at, label: {name: .label.name}, actor: {login: .actor.login}} | @json";
const RELEASE_EDIT = "query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { issue(number: $number) { lastEditedAt editor { login } } } }";

/**
 * ADR 0022 part 1: reads what botIssueReleased needs for issue `number` in `repo` (`api` takes `gh api` arguments).
 * False with no API call unless the identity is team with a bot login; false on any read or parse error, an unexpected
 * shape or a page that does not parse (a truncated read).
 */
export function readBotIssueRelease(api, identity, repo, number) {
  if (identity?.profile !== "team" || typeof identity?.app?.botLogin !== "string" || identity.app.botLogin === "") return false;
  try {
    const [owner, name] = String(repo).split("/");
    if (!owner || !name || !Number.isInteger(number)) return false;
    const issue = JSON.parse(api([`repos/${repo}/issues/${number}`]));
    if (typeof issue?.user?.login !== "string" || !Array.isArray(issue.labels)) return false;
    if (!isLaneBot(identity, issue.user) || issue.user.type !== "Bot") return false;
    const events = api([`repos/${repo}/issues/${number}/events`, "--paginate", "--jq", RELEASE_EVENTS]).split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const reply = JSON.parse(api(["graphql", "-f", `query=${RELEASE_EDIT}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${number}`]));
    const node = reply?.data?.repository?.issue;
    if (node === null || typeof node !== "object" || !("lastEditedAt" in node) || !("editor" in node)) return false;
    const edit = node.lastEditedAt === null ? null : { lastEditedAt: node.lastEditedAt, editor: node.editor };
    return botIssueReleased(identity, { user: issue.user, labels: issue.labels }, events, edit, (login) => authorCanWrite(api, repo, login));
  } catch {
    return false;
  }
}

/**
 * ADR 0021 part 1: the user owners (`@login`) of a CODEOWNERS file, in order, without the `@`. The first token of a
 * line is its pattern; team entries (`@org/team`), emails and comments are ignored.
 */
export function parseCodeOwnerUsers(text) {
  const users = [];
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const tokens = raw.replace(/(^|\s)#.*$/, "").trim().split(/\s+/).slice(1);
    for (const t of tokens) {
      const m = /^@([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)$/.exec(t);
      if (m && !users.includes(m[1])) users.push(m[1]);
    }
  }
  return users;
}

/**
 * ADR 0021 part 1: whether a code owner approved the PR's current head. `reviews` is `pulls/{n}/reviews` oldest first;
 * the latest review per login (COMMENTED and PENDING ignored) decides, so a later CHANGES_REQUESTED or DISMISSED
 * supersedes an approval. It counts only
 * when APPROVED on `headSha`, by a login in `owners` (exact, case-sensitive) who is neither `prAuthor` nor the lane bot.
 */
export function nativeCodeOwnerApproval(reviews, prAuthor, headSha, owners, identity = undefined) {
  const none = { approved: false, by: null };
  if (!Array.isArray(reviews) || !Array.isArray(owners) || owners.length === 0) return none;
  if (typeof headSha !== "string" || headSha === "") return none;
  const latest = new Map();
  for (const r of reviews) {
    const login = r?.user?.login;
    // A COMMENTED or PENDING review changes no approval state on GitHub, so it never supersedes one.
    if (r?.state === "COMMENTED" || r?.state === "PENDING") continue;
    if (typeof login === "string" && login !== "") latest.set(login, r);
  }
  for (const [login, r] of latest) {
    if (r.state !== "APPROVED" || r.commit_id !== headSha) continue;
    if (!owners.includes(login) || login === prAuthor || isLaneBot(identity, r.user)) continue;
    return { approved: true, by: login };
  }
  return none;
}

/**
 * The `identity` key (ADR 0019 part 1, ADR 0020 part 1), validated and copied; undefined when the key is missing.
 * `{ profile: "solo" }` or `{ profile: "team", app: { id, installationId, botLogin } }`; `botLogin` is required under
 * team and accepted (and never used) under solo. Throws on any other shape.
 */
export function parseIdentity(identity) {
  if (identity === undefined) return undefined;
  const bad = (what) => new Error(`lanes.config.json: identity ${what}`);
  if (identity === null || typeof identity !== "object" || Array.isArray(identity)) throw bad("must be an object");
  const extra = Object.keys(identity).find((k) => k !== "profile" && k !== "app");
  if (extra !== undefined) throw bad(`has an unknown key ${JSON.stringify(extra)}`);
  if (identity.profile !== "solo" && identity.profile !== "team") throw bad(`.profile must be "solo" or "team", got ${JSON.stringify(identity.profile)}`);
  const { app } = identity;
  if (app === undefined) {
    if (identity.profile === "team") throw bad(".app { id, installationId, botLogin } is required for the team profile");
    return { profile: "solo" };
  }
  if (app === null || typeof app !== "object" || Array.isArray(app)) throw bad(".app must be an object { id, installationId, botLogin }");
  if (Object.keys(app).some((k) => k !== "id" && k !== "installationId" && k !== "botLogin")) throw bad(".app may only have id, installationId and botLogin");
  for (const key of ["id", "installationId"]) {
    if (!Number.isSafeInteger(app[key]) || app[key] < 1) throw bad(`.app.${key} must be a positive whole number, got ${JSON.stringify(app[key])}`);
  }
  const copy = { id: app.id, installationId: app.installationId };
  if (app.botLogin === undefined) {
    if (identity.profile === "team") throw bad(".app.botLogin is required for the team profile (the lane App's login, like name[bot])");
  } else {
    if (typeof app.botLogin !== "string" || !BOT_LOGIN.test(app.botLogin)) throw bad(`.app.botLogin must be one App login like name[bot], got ${JSON.stringify(app.botLogin)}`);
    copy.botLogin = app.botLogin;
  }
  return { profile: identity.profile, app: copy };
}

const NEEDS_NOTHING = /^nothing\.?$/i;

/**
 * Why a full-tier PR still needs the owner, or null when it may merge unattended. `verdicts` are the parsed verdict
 * comments (`parseVerdictComment`) whose author already passed `authorCanWrite`, oldest first; only those bound to
 * `headSha` count, and the newest per reviewer is its verdict for this head.
 */
function fullTierBlocker({ pr, required, verdicts, headSha, reuse }) {
  if (pr.contractChange === "breaking") return "breaking contract change";
  const head = typeof headSha === "string" ? headSha.toLowerCase() : null;
  // #25, #154: a reused status brings along its own reviewer's verdict comment for the same commit, and only that.
  const bound = (v) => (head !== null && v.sha === head) || (reuse.has(v.reviewer) && v.sha === reuse.get(v.reviewer).sha);
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

/**
 * The reviewers whose status may be reused from an earlier commit (#25, #154). Never the ui-reviewer (it judges what
 * the page looks like, which a merge from main can change without touching the PR's own diff) and never review/owner.
 */
export const REUSABLE_REVIEWERS = Object.freeze(["test-hunter", "security-reviewer", "architecture-advisor"]);

/**
 * The required reviewers the gate should look for a success on an earlier commit for (#25, #154): each reusable
 * reviewer the tier and diff require that has no trusted status on the head. Any status on the head, a failure
 * included, wins.
 */
export function reusableReviewers({ issueLabels, files, statuses, config, adrs = [], interfaceContract = "" }) {
  const tier = tierOf(issueLabels);
  if (tier === null) return [];
  const latest = latestByContext(trustedStatuses(statuses, config.identity, reviewerNames(config)));
  return requiredReviewers(tier, classifyFiles(files, config, adrs, interfaceContract), files, config.modules).filter((r) => REUSABLE_REVIEWERS.includes(r) && !latest.has(reviewContext(r)));
}

/** Whether the gate should look for a test-hunter success on an earlier commit (#25). */
export const testHunterReusable = (inputs) => reusableReviewers(inputs).includes("test-hunter");

// What each reusable reviewer checks against besides the diff (#154): a file listed here, or under a listed directory
// (trailing `/`), changing since the review means the review no longer stands.
const REVIEW_INPUTS = {
  "test-hunter": ["vendor/agent-skills/references/definition-of-done.md", "vendor/agent-skills/references/testing-patterns.md"],
  "security-reviewer": ["vendor/agent-skills/references/security-checklist.md", "vendor/owasp-cheatsheets/"],
  "architecture-advisor": [],
};
const ADR_FILE = /^docs\/adr\/(?:(\d{4})-)?[^/]*\.md$/;

/**
 * #154: the first of `changedFiles` (the files changed between the reviewed commit and the head, both names of a
 * rename) that invalidates a reused `reviewer` review, or null when none does. That is the reviewer's brief
 * (`.claude/agents/<reviewer>.md`), its checklists, and for the architecture-advisor any ADR (`docs/adr/NNNN-*.md`,
 * whatever its status now) whose Governs covers one of `prFiles`. Fails closed: a reviewer that is not reusable,
 * a changed list that is not an array of strings, or an ADR file with no NNNN number all block reuse.
 */
export function reuseBlockedBy(reviewer, changedFiles, prFiles, adrs = []) {
  if (!REUSABLE_REVIEWERS.includes(reviewer)) return `${reviewer} is never reused`;
  if (!Array.isArray(changedFiles) || !changedFiles.every((f) => typeof f === "string")) return "changed files unreadable";
  const inputs = [`.claude/agents/${reviewer}.md`, ...REVIEW_INPUTS[reviewer]];
  const norm = (f) => posix.normalize(f.replace(/\\/g, "/"));
  const pr = (Array.isArray(prFiles) ? prFiles : []).filter((f) => typeof f === "string").map(norm);
  const governing = new Set(
    (Array.isArray(adrs) ? adrs : [])
      .filter((a) => a && !a.error && Array.isArray(a.governs) && pr.some((f) => a.governs.some((g) => (g.endsWith("/") ? f.startsWith(g) : f === g))))
      .map((a) => a.number),
  );
  for (const file of changedFiles) {
    const f = norm(file);
    if (inputs.some((p) => (p.endsWith("/") ? f.startsWith(p) : f === p))) return file;
    if (reviewer !== "architecture-advisor") continue;
    const adr = ADR_FILE.exec(f);
    if (adr && (adr[1] === undefined || governing.has(Number(adr[1])))) return file;
  }
  return null;
}

/**
 * The `reused` entries `gateDecision` trusts, as a Map from reviewer to `{ sha, status }`. `reused` is one
 * `{ sha, status }` or a list of them. Defence in depth: each must be a trusted success of a reusable reviewer on a real
 * commit SHA, for a reviewer with no trusted status on the head (`latest`); a reviewer named twice is dropped entirely.
 */
function acceptReused(reused, latest, identity, names) {
  const out = new Map();
  const twice = new Set();
  for (const r of Array.isArray(reused) ? reused : reused ? [reused] : []) {
    const name = String(r?.status?.context ?? "").slice("review/".length);
    const ok =
      REUSABLE_REVIEWERS.includes(name) &&
      r.status.context === reviewContext(name) &&
      !latest.has(r.status.context) &&
      COMMIT_SHA_RE.test(r.sha ?? "") &&
      r.status.state === "success" &&
      trustedStatuses([r.status], identity, names).length === 1;
    if (!ok) continue;
    if (out.has(name)) twice.add(name);
    out.set(name, { sha: r.sha.toLowerCase(), status: r.status });
  }
  for (const name of twice) out.delete(name);
  return out;
}

/**
 * #493: the `ownerCarry` `gateDecision` trusts, as `{ sha, status, same }`, or null. Defence in depth: a trusted
 * review/owner success on a real commit SHA, `same` exactly true or false, and only when the head has no trusted
 * review/owner status of its own (`latest`), whatever its state.
 */
function acceptOwnerCarry(carry, latest, identity, names) {
  const ok =
    carry !== null &&
    typeof carry === "object" &&
    typeof carry.same === "boolean" &&
    !latest.has(reviewContext("owner")) &&
    COMMIT_SHA_RE.test(carry.sha ?? "") &&
    carry.status?.context === reviewContext("owner") &&
    carry.status.state === "success" &&
    trustedStatuses([carry.status], identity, names).length === 1;
  return ok ? { sha: carry.sha.toLowerCase(), same: carry.same } : null;
}

/** `, reused <reviewer>[+<reviewer>...] from <sha7>` per reviewed commit, in the order first reused. */
function reuseNote(reuse) {
  const bySha = new Map();
  for (const [name, { sha }] of reuse) bySha.set(sha, [...(bySha.get(sha) ?? []), name]);
  return [...bySha].map(([sha, names]) => `, reused ${names.join("+")} from ${sha.slice(0, 7)}`).join("");
}

// ADR 0015: the only files a proven-additive diff may change and still skip the owner-only-path wait.
const OWNER_DIFF_FILES = Object.freeze(["lanes.config.json", "scripts/lanes/workflow.test.mjs"]);

/**
 * #380, ADR 0015: whether a PR's owner-only paths need no /approve because owner-diff.mjs proved the diff additive.
 * Fails closed: `ownerDiff` must be exactly "additive", every changed file one of `OWNER_DIFF_FILES` (compared as
 * given, never normalised), and the tier must require at least one reviewer; `gateDecision` has already checked that
 * each required reviewer passed on the head before it asks.
 */
function ownerPathExempt(ownerDiff, files, required) {
  if (ownerDiff !== "additive") return false;
  if (!Array.isArray(files) || files.length === 0) return false;
  return required.length > 0 && files.every((f) => OWNER_DIFF_FILES.includes(f));
}

const NO_BLOCKERS = Object.freeze({ ok: true, open: [], unreadable: [] });
const isIssueList = (xs) => Array.isArray(xs) && xs.every((x) => Number.isInteger(x) && x > 0);

/**
 * #36: the gate's answer for the linked issue #`closes`'s blockers (`blockerReport`'s `{ ok, open, unreadable }`, plus
 * an optional `error` when the "Blocked by" field itself cannot be read), or null when none is open. Fails closed: an
 * unreadable blocker, an error, or a report that is not exactly ok-with-nothing-open is never treated as clear.
 */
function blockerStatus(blockers, closes) {
  const cannot = (why) => ({ state: "failure", description: `cannot check blockers of #${closes}: ${why}`, stage: "blocked" });
  if (blockers === null || typeof blockers !== "object" || !isIssueList(blockers.open) || !isIssueList(blockers.unreadable)) return cannot("no blocker report");
  if (typeof blockers.error === "string" && blockers.error) return cannot(blockers.error);
  if (blockers.unreadable.length > 0) return cannot(`${blockers.unreadable.map((b) => `#${b}`).join(", ")} unreadable`);
  if (blockers.open.length > 0) return { state: "pending", description: `waiting for blocker ${blockers.open.map((b, i) => (i === 0 ? `#${b} (open)` : `#${b}`)).join(", ")}`, stage: "blocked" };
  if (blockers.ok !== true) return cannot("blocker report is not ok");
  return null;
}

/**
 * What `lanes/gate` should say for a PR head. Pure: every input is passed in. `blockers` (#36) is the linked issue's
 * `blockerReport` (from blockers.mjs); omitted, the issue has none. `reused` (#25, #154) is one `{ sha, status }` or a
 * list: each a trusted review/<reviewer> success, for a reviewer in `REUSABLE_REVIEWERS`, from an earlier commit of
 * the PR whose own diff matches the head's. Each counts only when the head has no trusted status of its own for that
 * reviewer, and brings along that reviewer's verdict for its `sha`. `interfaceContract` (#241) is the issue's Interface
 * contract text; a path it names that the diff changes requires the architecture-advisor. `ownerDiff` (#380, ADR 0015)
 * is owner-diff.mjs's verdict on the diff: only the string "additive" can clear the owner-only-path wait, and only
 * under `ownerPathExempt`'s conditions; the other reasons to wait on the owner still apply. `ownerCarry` (#493, ADR
 * 0002) is the owner's approval on an earlier commit, `{ sha, status, same }`, where `same` says that commit's own diff
 * has the head's `diffFingerprint`: only `same === true` counts as the owner's approval, and only once every required
 * reviewer has passed on the head; otherwise it only changes what the gate says while it waits on the owner, and
 * `prNumber` names the PR in the `/approve` line. `nativeApproval` (ADR 0021) is `nativeCodeOwnerApproval`'s
 * `{ approved, by }`; under the team profile an object replaces review/owner, the carry and the ADR 0015 exemption at
 * every point the gate would wait on the owner, and only `approved === true` passes. TRANSITIONAL: null (the default,
 * "not read") keeps today's owner stage under team too, so the gate cannot lock before gate.mjs reads reviews (#559,
 * which never passes null under team; #575 removes this fallback). Solo ignores `nativeApproval` entirely.
 */
export function gateDecision({ prBody, issueLabels, issueState, issueAuthorCanWrite, issueIsPr, headRef, headSha, files, statuses, verdicts, config, adrs = [], interfaceContract = "", reused = null, blockers = NO_BLOCKERS, ownerDiff = null, ownerCarry = null, prNumber = null, nativeApproval = null }) {
  const fail = (description, stage = "contract") => ({ state: "failure", description, stage });
  const labels = Array.isArray(issueLabels) ? issueLabels : [];
  const pr = parsePrBody(prBody);
  if (pr.closes === null) return fail("PR body must say 'Closes #N' for its task issue");
  if (pr.duplicates.length > 0) return fail(`PR template sections repeated: ${pr.duplicates.join(", ")}`);
  const mapProblem = moduleMapProblem(config);
  if (mapProblem !== null) return fail(`module map unusable: ${mapProblem}`);
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
  const cls = classifyFiles(files, config, adrs, interfaceContract);
  if (tier === "skip" && !cls.skipOnly) return fail("tier:skip but the diff changes files outside the skip paths");
  if (pr.contractChange === "none" && cls.contract) return fail("contract files changed but 'Contract changes' says none");
  if (pr.contractChange === "breaking" && !labels.includes("contract:breaking")) {
    return fail("a breaking contract change needs the issue label contract:breaking");
  }
  const blocked = blockerStatus(blockers, pr.closes);
  if (blocked) return blocked;
  const latest = latestByContext(trustedStatuses(statuses, config.identity, reviewerNames(config)));
  const reuse = acceptReused(reused, latest, config.identity, reviewerNames(config));
  for (const [name, r] of reuse) latest.set(reviewContext(name), r.status);
  const note = reuseNote(reuse);
  const required = requiredReviewers(tier, cls, files, config.modules);
  for (const name of required) {
    const s = latest.get(reviewContext(name));
    if (!s) return { state: "pending", description: `waiting for review/${name}`, stage: "review" };
    if (s.state !== "success") return fail(`review/${name} is ${s.state}`, "review");
    if (String(s.description ?? "").startsWith("skipped")) {
      return fail(`review/${name} is required for this diff and cannot be skipped`, "review");
    }
  }
  // ADR 0021: under team, once the gate passes a native approval object, the owner stage is a native code-owner review
  // and review/owner and the carry are ignored. Null (unread) keeps the solo stage for now (see the JSDoc; #575).
  const team = config.identity?.profile === "team" && nativeApproval !== null && typeof nativeApproval === "object";
  let carried = null;
  if (!team) {
    if (latest.get(reviewContext("owner"))?.state === "success") {
      return { state: "success", description: `approved by owner${note}`, stage: "ready" };
    }
    carried = acceptOwnerCarry(ownerCarry, latest, config.identity, reviewerNames(config));
    if (carried?.same === true) {
      return { state: "success", description: `approved by owner (carried from ${carried.sha.slice(0, 7)})${note}`, stage: "ready" };
    }
  }
  const approved = team && nativeApproval?.approved === true;
  const waitOwner = (reason) => {
    // Fails closed: only a literal `approved: true` clears the wait; null (unread) and anything else is pending.
    if (approved) return { state: "success", description: `approved by code owner${typeof nativeApproval.by === "string" ? ` @${nativeApproval.by}` : ""}${note}`, stage: "ready" };
    if (team) return { state: "pending", description: `waiting for a code-owner review in GitHub (${reason})${note}`, stage: "owner" };
    return {
      state: "pending",
      description: carried
        ? `owner approval was for ${carried.sha.slice(0, 7)}; the PR's own diff changed since: /approve ${prNumber ?? ""}`.trimEnd()
        : `waiting on owner (/approve) (${reason})${note}`,
      stage: "owner",
    };
  };
  // ADR 0002: the files that decide what gets checked and who approves always need the owner, at every tier. A
  // sensitive path only adds the security-reviewer (requiredReviewers); it no longer sends a PR to the owner.
  if (cls.owner && (team || !ownerPathExempt(ownerDiff, files, required))) return waitOwner("owner-only path");
  if (!NEEDS_NOTHING.test(pr.sections["needs the owner"] ?? "")) return waitOwner("needs the owner");
  let blocker = null;
  if (tier === "full") blocker = fullTierBlocker({ pr, required, verdicts, headSha, reuse });
  else if (tier === "quick" && cls.contract) blocker = "contract change";
  if (blocker) return waitOwner(blocker);
  return { state: "success", description: `unattended-eligible (tier:${tier}), reviews in${note}`, stage: "ready" };
}
