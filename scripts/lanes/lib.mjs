// Pure logic for the lanes workflow: config, file classes, required reviewers, the task and PR contracts, and the gate
// decision. No I/O except loadConfig and the injected `api` in authorCanWrite; everything else is a plain function so
// it can be unit-tested.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
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

// A refusal the gate reports as `error` with the message (ADR 0031 part 2): the owner paths cannot be read.
function ownerPatternError(message) {
  const err = new Error(message);
  err.ownerPatterns = true;
  return err;
}

/** Why a CODEOWNERS pattern is outside the strict subset ADR 0031 part 2 allows, or null when it is allowed. */
function ownerPatternProblem(pattern) {
  if (typeof pattern !== "string" || pattern === "") return "empty pattern";
  for (const [bad, name] of [["**", "`**`"], ["?", "`?`"], ["[", "`[`"], ["]", "`]`"], ["!", "`!`"], ["\\", "a backslash"]]) {
    if (pattern.includes(bad)) return `${name} is not supported`;
  }
  const core = pattern.replace(/^\/|\/$/g, "");
  if (core === "") return "empty pattern";
  if (core.includes("/") && core.includes("*")) return "`*` is not supported in a pattern with an inner `/`";
  return null;
}

/**
 * A CODEOWNERS pattern as a regex, for the strict subset of gitignore-style forms ADR 0031 part 2 allows: a leading
 * `/` anchors it to the root, a trailing `/` matches a directory's contents, `*` stays within one path segment and
 * is allowed only in a pattern with no inner `/`. A pattern that names a directory also covers everything under it,
 * and an inner slash anchors it. Anything else throws, so the matcher fails closed.
 */
export function codeownersRegex(pattern) {
  const problem = ownerPatternProblem(pattern);
  if (problem) throw ownerPatternError(`CODEOWNERS pattern ${JSON.stringify(pattern)}: ${problem}`);
  const dir = pattern.endsWith("/");
  const core = pattern.replace(/^\/|\/$/g, "");
  const anchored = pattern.startsWith("/") || core.includes("/");
  const body = core.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*/g, "[^/]*");
  return new RegExp(`${anchored ? "^" : "(^|/)"}${body}${dir ? "/" : "(/|$)"}`);
}

/**
 * The patterns of a CODEOWNERS text, each with its 1-based line and compiled regex. Blank and comment lines are
 * skipped. A line outside the allowed subset, or with a pattern and no owner (which un-owns the path in GitHub),
 * throws an error naming the line.
 */
export function parseOwnerPatterns(text) {
  const out = [];
  String(text ?? "").split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    const [pattern, ...rest] = line.split(/\s+/);
    const fail = (why) => ownerPatternError(`CODEOWNERS line ${i + 1}: ${why}: ${line}`);
    if (rest.length === 0 || rest[0].startsWith("#")) throw fail("no owner");
    const problem = ownerPatternProblem(pattern);
    if (problem) throw fail(problem);
    out.push({ pattern, line: i + 1, regex: codeownersRegex(pattern) });
  });
  return out;
}

export function compileConfig(raw, codeownersText = undefined) {
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
  // ADR 0031 part 1: the CODEOWNERS patterns, a union with paths.owner. A parse error throws, naming the line.
  paths.codeowners = parseOwnerPatterns(codeownersText).map((p) => p.regex);
  const requiredChecks = raw?.requiredChecks;
  if (!Array.isArray(requiredChecks) || requiredChecks.length === 0) {
    throw new Error("lanes.config.json: requiredChecks must be a non-empty array");
  }
  // ADR 0018: the optional module map, kept as written; modules.mjs validates it.
  const config = raw.modules === undefined ? { requiredChecks, paths } : { requiredChecks, paths, modules: raw.modules };
  // ADR 0020 part 1: the validated identity, so the gate can read the configured lane bot. A config with no identity
  // key, or one that is not team, still compiles; start, queue and the gate refuse it with parseIdentity (ADR 0025).
  // A refused identity is kept as its bare profile name only, so that refusal can name it. A team identity with a bad
  // shape throws.
  let identity;
  try {
    identity = raw.identity === undefined ? undefined : parseIdentity(raw.identity);
  } catch (err) {
    if (!err.teamRequired) throw err;
    if (typeof raw.identity?.profile === "string") identity = { profile: raw.identity.profile };
  }
  // ADR 0032 part 1: the opt-in switch for the Dependabot action-bump path. Absent is false; any non-boolean is a typo.
  const actionBumps = raw.dependabot?.actionBumps === undefined ? false : raw.dependabot.actionBumps;
  if (typeof actionBumps !== "boolean") throw new Error("lanes.config.json: dependabot.actionBumps must be a boolean");
  const withDependabot = { ...config, dependabot: { actionBumps } };
  return identity === undefined ? withDependabot : { ...withDependabot, identity };
}

const BUMP_FILE = /^(?:\.github\/workflows\/[^/]+\.ya?ml|\.github\/actions\/.+\/action\.ya?ml)$/;
const BUMP_HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const BUMP_USES =
  /^([ \t]*(?:-[ \t]+)?uses:[ \t]+)([A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*(?:\/[\w.-]+)*)@([0-9a-f]{40})([ \t]+#[ \t]*[\w.+ /-]{1,64})?$/;
// The API caps a PR's file list at 3000, so a list that long may be cut.
const FILES_API_CAP = 3000;

/** The `-` and `+` lines of each change block in a unified-diff patch, or null when the patch is not well formed. */
function patchBlocks(patch) {
  if (typeof patch !== "string" || patch === "") return null;
  const lines = (patch.endsWith("\n") ? patch.slice(0, -1) : patch).split("\n");
  const blocks = [];
  let at = 0;
  while (at < lines.length) {
    const head = BUMP_HUNK.exec(lines[at]);
    if (!head) return null;
    let oldLeft = head[2] === undefined ? 1 : Number(head[2]);
    let newLeft = head[4] === undefined ? 1 : Number(head[4]);
    at++;
    let block = null;
    while (oldLeft > 0 || newLeft > 0) {
      const line = lines[at++];
      if (line === undefined) return null;
      const mark = line[0];
      if (mark === " ") {
        oldLeft--;
        newLeft--;
        block = null;
      } else if (mark === "-" || mark === "+") {
        if (mark === "-") oldLeft--;
        else newLeft--;
        if (!block) blocks.push((block = { removed: [], added: [] }));
        block[mark === "-" ? "removed" : "added"].push(line.slice(1));
      } else return null; // "\ No newline", an empty line or anything else
      if (oldLeft < 0 || newLeft < 0) return null;
    }
    if (lines[at] !== undefined && lines[at][0] === "\\") return null;
  }
  return blocks;
}

/**
 * ADR 0032 part 2: does this PR do nothing but re-pin SHA-pinned actions? Pure and fail-closed: any condition not met,
 * and any input of an unexpected shape, is `bump: false`. Never throws.
 * @param {{ author?: { login?: string, type?: string }, files?: Array<{ filename?: string, status?: string,
 *   previous_filename?: string | null, patch?: string }> }} input
 * @returns {{ bump: true } | { bump: false, reason: string }}
 */
export function dependabotActionBump(input) {
  const no = (reason) => ({ bump: false, reason });
  try {
    const { author, files } = input ?? {};
    if (author?.login !== "dependabot[bot]" || author?.type !== "Bot") return no("author is not dependabot[bot]");
    if (!Array.isArray(files) || files.length === 0) return no("no file list");
    if (files.length >= FILES_API_CAP) return no("file list may be cut at the API cap");
    for (const file of files) {
      if (!file || typeof file !== "object") return no("unreadable file entry");
      const { filename, status, previous_filename: previous, patch } = file;
      if (typeof filename !== "string" || !BUMP_FILE.test(filename) || filename.split("/").includes("..")) {
        return no(`${String(filename)} is not a workflow or action file`);
      }
      if (status !== "modified") return no(`${filename} is not modified`);
      if (previous !== undefined && previous !== null) return no(`${filename} was renamed`);
      const blocks = patchBlocks(patch);
      if (!blocks) return no(`${filename} has a missing, truncated or malformed patch`);
      if (blocks.length === 0) return no(`${filename} has no changed line`);
      for (const { removed, added } of blocks) {
        if (removed.length !== added.length) return no(`${filename} adds or removes a line`);
        for (let i = 0; i < removed.length; i++) {
          const before = BUMP_USES.exec(removed[i]);
          const after = BUMP_USES.exec(added[i]);
          if (!before || !after || [before, after].some((m) => m[2].split("/").some((s) => s === "." || s === ".."))) return no(`${filename} changes a line that is not a SHA-pinned uses:`);
          if (before[1] !== after[1] || before[2] !== after[2]) return no(`${filename} changes more than the SHA or comment`);
        }
      }
    }
    return { bump: true };
  } catch {
    return no("unexpected input");
  }
}

export function loadConfig(file = "lanes.config.json") {
  const raw = JSON.parse(readFileSync(file, "utf8"));
  // ADR 0031 part 1: CODEOWNERS from the same checkout as the config, so a PR's own copy is never read by the gate.
  let codeowners;
  try {
    codeowners = readFileSync(join(dirname(file), ".github", "CODEOWNERS"), "utf8");
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
  }
  const config = compileConfig(raw, codeowners);
  // ADR 0031 part 2: under team, no owner paths at all is a misconfiguration, never "nothing is owner-only".
  if (config.identity?.profile === "team" && config.paths.owner.length === 0 && config.paths.codeowners.length === 0) {
    throw ownerPatternError(codeowners === undefined ? "no .github/CODEOWNERS and paths.owner is empty: no owner-only paths" : "CODEOWNERS has no patterns and paths.owner is empty: no owner-only paths");
  }
  return config;
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
    owner: files.some((f) => matchesAny(paths.owner, f) || matchesAny(paths.codeowners ?? [], f)),
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

const cleanPath = (token) =>
  token
    .replace(/^[("'[]+|[)"'\].,;:]+$/g, "")
    .replace(/^\.\//, "")
    .replace(/\*+$/, "");
// Only repo-relative paths are claimed: an email, a backslash path, a URI scheme or drive letter (`file:///C:/x`, `C:`),
// a leading `/`, `~`, `%` or `$` (an absolute or home path) or a `..` segment never is.
const notRepoRelative = (p) => /[@\\]/.test(p) || /^([a-z][a-z0-9+.-]*:|[/~%$])/i.test(p) || p.split("/").includes("..");
const looksLikePath = (p) => p && !/\s/.test(p) && !/^(-|https?:)/.test(p) && !notRepoRelative(p) && (p.includes("/") || /\.[a-z][a-z0-9]{0,5}$/i.test(p));

// The file paths an issue names: backticked or bare tokens with a `/` or a file extension, read from its Interface
// contract and the "In:" part of its Scope (anything after "Out:" is ignored). A trailing `*` glob reads as its directory.
export function issuePaths({ contract = "", scope = "" }) {
  const inPart = scope.split(/(?<![\w-])Out:/i)[0].replace(/^[\s\S]*?(?<![\w-])In:/i, "");
  // A contract of `none (reads `x` from #N)` only reads x, so the note right after `none` names no path to claim.
  const owned = contract.replace(/^\s*none\s*\((?:[^()]|\([^()]*\))*\)/i, "none");
  const paths = [];
  for (const text of [owned, inPart]) {
    for (const [, quoted, bare] of text.matchAll(/`([^`]+)`|(\S+)/g)) {
      const p = cleanPath(quoted ?? bare);
      if (looksLikePath(p) && !paths.includes(p)) paths.push(p);
    }
  }
  return paths;
}

// Two path lists overlap when they share a path, or one names a directory (`dir/`) holding a path the other names.
export function pathsOverlap(a, b) {
  const within = (dir, p) => dir.endsWith("/") && p.startsWith(dir);
  return a.some((x) => b.some((y) => x === y || within(x, y) || within(y, x)));
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
 *
 * `omit` (ADR 0023 part 3) lists paths whose blocks are dropped before sorting. When it is non-empty and a block's
 * file name cannot be parsed (no `diff --git a/<p> b/<p>` header, a quoted or renamed path), it returns null: the
 * caller cannot know which block to drop, so it fails closed.
 */
export function diffFingerprint(diffText, { omit = [] } = {}) {
  const blocks = [];
  const lines = String(diffText ?? "").split("\n");
  // The diff's final newline belongs to whichever file comes last; dropping it keeps blocks order-independent.
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines) {
    if (line.startsWith("diff --git ") || blocks.length === 0) blocks.push([]);
    if (line.startsWith("index ")) continue;
    blocks.at(-1).push(HUNK_HEADER.test(line) ? "@@" : line);
  }
  let kept = blocks;
  if (Array.isArray(omit) && omit.length > 0) {
    kept = [];
    for (const block of blocks) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(block[0]);
      if (!m || m[1] !== m[2]) return null;
      if (!omit.includes(m[1])) kept.push(block);
    }
  }
  const normalized = kept.map((b) => b.join("\n")).sort();
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

const PENDING_DIR = ".github/workflows/";

/**
 * Hex SHA-256 of a workflow file's normalised content (ADR 0023 part 3): every `\r\n` becomes `\n`, trailing newlines
 * are removed and one `\n` is appended. Null for empty (or newline-only) text, invalid UTF-8, or input that is neither
 * a string nor bytes.
 */
export function pendingFileHash(text) {
  let s;
  if (typeof text === "string") {
    if (!text.isWellFormed()) return null;
    s = text;
  } else if (text instanceof Uint8Array) {
    try {
      s = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(text);
    } catch {
      return null;
    }
  } else {
    return null;
  }
  const body = s.replaceAll("\r\n", "\n").replace(/\n+$/, "");
  if (body === "") return null;
  return createHash("sha256").update(`${body}\n`).digest("hex");
}

/** A verdict's `pending` as `[{ path, sha256 }]` when it is valid (ADR 0023 part 3), otherwise null. */
export function parsePending(verdict) {
  const list = verdict?.pending;
  if (!Array.isArray(list) || list.length === 0) return null;
  const seen = new Set();
  const out = [];
  for (const e of list) {
    if (!e || typeof e !== "object" || Array.isArray(e)) return null;
    const { path, sha256 } = e;
    if (typeof path !== "string" || typeof sha256 !== "string") return null;
    if (!path.startsWith(PENDING_DIR) || path.length === PENDING_DIR.length) return null;
    if (path.split("/").includes("..") || seen.has(path)) return null;
    if (!/^[0-9a-f]{64}$/.test(sha256)) return null;
    seen.add(path);
    out.push({ path, sha256 });
  }
  return out;
}

/**
 * Pure check of ADR 0023 part 3 conditions 2 to 4 for reusing a verdict that lists `pending` files. Returns null when
 * they hold, otherwise the reason. `changedSince` is the files the head changed since the reviewed commit,
 * `headHashes` maps each pending path to `pendingFileHash` of its blob at the head (absent or null: not committed),
 * and the diffs are the reviewed commit's own diff and the head's own diff. Anything malformed blocks.
 */
export function pendingReuseBlockedBy({ pending, changedSince, headHashes, earlierDiff, headDiff } = {}) {
  const entries = parsePending({ pending });
  if (!entries) return "the reviewed verdict's pending list is missing or invalid";
  if (!Array.isArray(changedSince) || changedSince.some((f) => typeof f !== "string")) return "the files changed since the reviewed commit are unknown";
  const hashOf = headHashes instanceof Map ? (p) => headHashes.get(p) : headHashes && typeof headHashes === "object" ? (p) => (Object.hasOwn(headHashes, p) ? headHashes[p] : undefined) : null;
  if (!hashOf) return "the pending files at the head could not be read";
  const paths = entries.map((e) => e.path);
  const other = changedSince.find((f) => !paths.includes(f));
  if (other !== undefined) return `${other} changed since the reviewed commit and is not a pending workflow file`;
  for (const { path, sha256 } of entries) {
    const got = hashOf(path);
    if (typeof got !== "string") return `workflow file ${path} is not committed yet`;
    if (got !== sha256) return `workflow file ${path} differs from the reviewed copy`;
  }
  if (typeof earlierDiff !== "string" || typeof headDiff !== "string") return "the diffs to compare are unavailable";
  const before = diffFingerprint(earlierDiff);
  const after = diffFingerprint(headDiff, { omit: paths });
  if (after === null || before !== after) return "the PR's own diff changed since the reviewed commit, beyond the pending workflow files";
  return null;
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
    // GraphQL names a bot without its `[bot]` suffix, so the bare App slug counts as the bot too.
    const isBot = (a) => isLaneBot(identity, a) || a?.login === identity.app.botLogin.replace(/\[bot\]$/, "");
    if (last.event !== "unlabeled" || typeof actor !== "string" || isBot(last.actor)) return false;
    if (canWrite(actor) !== true) return false;
    if (edit === null) return true;
    if (typeof edit !== "object" || edit === undefined) return false;
    const editedAt = Date.parse(edit.lastEditedAt);
    if (Number.isNaN(editedAt)) return false;
    if (editedAt < Date.parse(last.created_at)) return true;
    return typeof edit.editor?.login === "string" && !isBot(edit.editor) && canWrite(edit.editor.login) === true;
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

/** ADR 0025 part 2: the one refusal for a config whose identity is not team. */
export const TEAM_REQUIRED_MESSAGE = "lanes needs the team identity profile (a GitHub App). Run: node scripts/lanes/app-setup.mjs";

/**
 * The `identity` key (ADR 0019 part 1, ADR 0020 part 1, ADR 0025 part 1), validated and copied:
 * `{ profile: "team", app: { id, installationId, botLogin } }`. Throws TEAM_REQUIRED_MESSAGE, naming `configPath` and
 * the profile found if any, for a missing identity, a missing profile or any profile but "team"; throws on any other
 * bad shape.
 */
export function parseIdentity(identity, configPath = "lanes.config.json") {
  const bad = (what) => new Error(`${configPath}: identity ${what}`);
  const isObject = identity !== null && typeof identity === "object" && !Array.isArray(identity);
  if (identity === undefined || (isObject && identity.profile !== "team")) {
    const found = isObject && identity.profile !== undefined ? `profile ${JSON.stringify(identity.profile)}` : "no identity profile";
    throw Object.assign(new Error(`${TEAM_REQUIRED_MESSAGE} (${configPath}: ${found})`), { teamRequired: true });
  }
  if (!isObject) throw bad("must be an object");
  const extra = Object.keys(identity).find((k) => k !== "profile" && k !== "app");
  if (extra !== undefined) throw bad(`has an unknown key ${JSON.stringify(extra)}`);
  if (identity.app === undefined) throw bad(".app { id, installationId, botLogin } is required for the team profile");
  return { profile: "team", app: validApp(identity.app, bad, true) };
}

// The `app` of an identity, validated and copied; botLogin is required when `needLogin`.
function validApp(app, bad, needLogin) {
  if (app === null || typeof app !== "object" || Array.isArray(app)) throw bad(".app must be an object { id, installationId, botLogin }");
  if (Object.keys(app).some((k) => k !== "id" && k !== "installationId" && k !== "botLogin")) throw bad(".app may only have id, installationId and botLogin");
  for (const key of ["id", "installationId"]) {
    if (!Number.isSafeInteger(app[key]) || app[key] < 1) throw bad(`.app.${key} must be a positive whole number, got ${JSON.stringify(app[key])}`);
  }
  const copy = { id: app.id, installationId: app.installationId };
  if (app.botLogin === undefined) {
    if (needLogin) throw bad(".app.botLogin is required for the team profile (the lane App's login, like name[bot])");
  } else {
    if (typeof app.botLogin !== "string" || !BOT_LOGIN.test(app.botLogin)) throw bad(`.app.botLogin must be one App login like name[bot], got ${JSON.stringify(app.botLogin)}`);
    copy.botLogin = app.botLogin;
  }
  return copy;
}

/**
 * ADR 0025 part 2, for the readers that show a line instead of refusing (`/status`, the snapshot): the refusal line for
 * the lanes.config.json `read()` returns, or null when its identity is team. A missing file counts as no identity;
 * a file that is not JSON is left to the reader's own config loading.
 */
export function identityRefusal(read, configPath = "lanes.config.json") {
  let raw;
  try {
    raw = JSON.parse(read());
  } catch (err) {
    if (err?.code !== "ENOENT") return null;
  }
  try {
    parseIdentity(raw?.identity, configPath);
    return null;
  } catch (err) {
    return err.teamRequired ? err.message : null;
  }
}

const NEEDS_NOTHING = /^nothing\.?$/i;

/**
 * The trusted verdicts that count for this head: bound to `headSha`, or (a reused status) to its reviewer's reused
 * commit; the newest per reviewer, oldest first otherwise. `verdicts` are `parseVerdictComment` results.
 */
export function currentVerdicts(verdicts, headSha, reuse = new Map()) {
  const head = typeof headSha === "string" ? headSha.toLowerCase() : null;
  const bound = (v) => (head !== null && v.sha === head) || (reuse.has(v.reviewer) && v.sha === reuse.get(v.reviewer).sha);
  const newest = new Map();
  for (const v of Array.isArray(verdicts) ? verdicts : []) if (v?.verdict && bound(v)) newest.set(v.reviewer, v);
  return [...newest.values()];
}

/**
 * ADR 0023 part 3: why the gate still waits for a workflow hand-over, or null when none is outstanding. Every current
 * verdict that lists `pending` files needs each at the head with its listed sha256. `headHashes` maps a path to
 * `pendingFileHash` of its blob at the head: a string, null (not committed), or anything else (an Error, or a missing
 * key) for a read that failed. Fails closed: a malformed `pending` list also waits.
 */
export function pendingHandoverBlockedBy({ verdicts, headSha, reuse, headHashes } = {}) {
  const hashOf = headHashes instanceof Map ? (p) => headHashes.get(p) : () => undefined;
  const problems = new Map();
  for (const v of currentVerdicts(verdicts, headSha, reuse)) {
    const list = v.verdict.pending;
    if (list === undefined || list === null || (Array.isArray(list) && list.length === 0)) continue;
    const entries = parsePending(v.verdict);
    if (entries === null) {
      problems.set(`invalid pending list from ${v.reviewer}`, true);
      continue;
    }
    for (const { path, sha256 } of entries) {
      const got = hashOf(path);
      if (got === sha256) continue;
      problems.set(typeof got === "string" || got === null ? path : `could not read ${path}`, true);
    }
  }
  if (problems.size === 0) return null;
  const [first] = problems.keys();
  const more = problems.size - 1;
  return `waiting for the workflow hand-over: ${first}${more > 0 ? ` and ${more} more` : ""}`;
}

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

/** `, reused <reviewer>[+<reviewer>...] from <sha7>` per reviewed commit, in the order first reused. */
function reuseNote(reuse) {
  const bySha = new Map();
  for (const [name, { sha }] of reuse) bySha.set(sha, [...(bySha.get(sha) ?? []), name]);
  return [...bySha].map(([sha, names]) => `, reused ${names.join("+")} from ${sha.slice(0, 7)}`).join("");
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
 * contract text; a path it names that the diff changes requires the architecture-advisor. `nativeApproval` (ADR 0021,
 * 0025) is `nativeCodeOwnerApproval`'s `{ approved, by }`; it is the only owner stage, at every point the gate would
 * wait on the owner, and only `approved === true` passes: null (the default, "not read") or a missing value is
 * pending, never a pass.
 */
export function gateDecision(inputs) {
  const decision = decideGate(inputs);
  const outside = Array.isArray(inputs.outsideScope) ? inputs.outsideScope.length : 0;
  if (outside === 0) return decision;
  // #635: a note only, never a state change. The status description is cut at 140 characters when posted, so the
  // base text gives way to keep the note.
  const note = `; ${outside} files outside Scope, see PR body`;
  const room = 140 - note.length;
  const base = decision.description.length > room ? `${decision.description.slice(0, room - 1)}…` : decision.description;
  return { ...decision, description: `${base}${note}` };
}

// `outsideScope` (#635) is the PR's changed files its issue's Scope "In" and Interface contract do not cover.
function decideGate({ prBody, issueLabels, issueState, issueAuthorCanWrite, issueIsPr, headRef, headSha, files, statuses, verdicts, config, adrs = [], interfaceContract = "", reused = null, blockers = NO_BLOCKERS, nativeApproval = null, pendingHeadHashes = undefined, dependabotFiles = null }) {
  const fail = (description, stage = "contract") => ({ state: "failure", description, stage });
  // ADR 0032 part 3: a Dependabot action re-pin skips the issue, template and reviewer checks but never the owner.
  // After the module-map check and before "Closes #N"; the map check is repeated here so every other order is today's.
  if (config.dependabot?.actionBumps === true && dependabotFiles && moduleMapProblem(config) === null && dependabotActionBump(dependabotFiles).bump === true) {
    if (nativeApproval?.approved === true) {
      return { state: "success", description: `approved by code owner${typeof nativeApproval.by === "string" ? ` @${nativeApproval.by}` : ""} (dependabot action bump)`, stage: "ready" };
    }
    return { state: "pending", description: "waiting for a code-owner review in GitHub (dependabot action bump)", stage: "owner" };
  }
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
  // ADR 0023 part 3 (#684): a workflow file a current verdict lists as pending must be at the head as reviewed, at
  // every tier and even after the owner's approval; merging without it loses the handed-over change.
  const handover = pendingHandoverBlockedBy({ verdicts, headSha, reuse, headHashes: pendingHeadHashes });
  if (handover !== null) return { state: "pending", description: handover, stage: "handover" };
  // ADR 0021, 0025: the owner stage is a native code-owner review; review/owner is never read. A null or missing
  // approval (unread) is pending.
  const approved = nativeApproval?.approved === true;
  const waitOwner = (reason) => {
    // Fails closed: only a literal `approved: true` clears the wait; null (unread) and anything else is pending.
    if (approved) return { state: "success", description: `approved by code owner${typeof nativeApproval.by === "string" ? ` @${nativeApproval.by}` : ""}${note}`, stage: "ready" };
    return { state: "pending", description: `waiting for a code-owner review in GitHub (${reason})${note}`, stage: "owner" };
  };
  // ADR 0002: the files that decide what gets checked and who approves always need the owner, at every tier. A
  // sensitive path only adds the security-reviewer (requiredReviewers); it no longer sends a PR to the owner.
  if (cls.owner) return waitOwner("owner-only path");
  if (!NEEDS_NOTHING.test(pr.sections["needs the owner"] ?? "")) return waitOwner("needs the owner");
  let blocker = null;
  if (tier === "full") blocker = fullTierBlocker({ pr, required, verdicts, headSha, reuse });
  else if (tier === "quick" && cls.contract) blocker = "contract change";
  if (blocker) return waitOwner(blocker);
  return { state: "success", description: `unattended-eligible (tier:${tier}), reviews in${note}`, stage: "ready" };
}
