// Pre-push preflight: run `npm run preflight` before every push. It catches, locally and in about a second, the
// things that otherwise cost a CI round or a review round:
//   1. the PR for this branch is still OPEN and not CONFLICTING unless origin/main is already merged into HEAD (a merged PR must not be pushed to; branch fresh from main);
//   2. the diff against origin/main (committed and uncommitted) and the commit messages hold no local absolute path
//      (a Windows, Linux or macOS user-profile path: see PATH_PATTERNS) and none of the identifiers listed in PREFLIGHT_PATTERNS_FILE (an optional,
//      git-ignored file, one fixed string per line; the real list lives in CI's PII_PATTERNS secret, not here).
// Before origin/main exists locally (a brand-new repo's first push), there is no PR and no merge-base to diff against:
// the PR checks are skipped with a one-line notice, and the diff is taken against git's empty tree instead, so every
// tracked file's lines are still scanned rather than none. Any other unexpected git failure is reported as a plain
// `preflight:` problem line, never an uncaught stack trace.
// It never prints the matched text of a private pattern, only the file and line.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The path shapes CI's PII scan rejects, built from parts so this file does not contain them literally. */
export const PATH_PATTERNS = [
  ["C:", "\\Users"].join(""),
  ["C:", "/Users"].join(""),
  ["/", "home", "/"].join(""),
  ["/", "Users", "/"].join(""),
  ["C:", "\\\\Users"].join(""), // the same path escaped inside JSON or a string literal
];

/**
 * Exactly the files CI's security job skips (security.yml): workflows, CLAUDE.md docs, the license. No wider.
 * PATH_SCAN_EXEMPT is skipped by the PATH_PATTERNS only, never by the private patterns, again exactly as security.yml does:
 * the vendored OWASP sheets are byte-identical upstream text (ADR 0009) whose URL fragments (a users/profile route, a
 * report-uri.com home/hash link) look like local paths. They are safe to skip because scripts/lanes/vendor.test.mjs proves
 * their integrity by git blob id, so an edit that adds a real local path fails that test instead. The rest of vendor/
 * (INDEX.md, VENDORED.md, LICENSE) is written or chosen here and is still scanned. Keep both lists in step with
 * security.yml; scripts/security-workflow.test.mjs checks that they are.
 */
export const SCAN_EXEMPT = [/^\.github\//, /CLAUDE\.md$/, /^LICENSE$/];
export const PATH_SCAN_EXEMPT = [/^vendor\/owasp-cheatsheets\/sheets\//];

/** Git's fixed hash for the empty tree object (`git hash-object -t tree --stdin < /dev/null`); exists in every repo. */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/**
 * @param {boolean} hasOriginMain whether `origin/main` resolves locally
 * @returns {string} what to diff HEAD against: `origin/main` normally, or the empty tree before it exists
 *   (a brand-new repo's first push), so every tracked file's lines count as added rather than none.
 */
export function diffBase(hasOriginMain) {
  return hasOriginMain ? "origin/main" : EMPTY_TREE;
}

/**
 * @param {string} diff unified diff (`git diff -U0`)
 * @returns {{ file: string; line: number; text: string }[]} the added lines, with the new file's line number
 */
export function addedLines(diff) {
  const out = [];
  let file = "";
  let line = 0;
  let inHeader = false; // "+++ " is a file header only between `diff --git` and the first hunk; inside a hunk it is content
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff ")) {
      inHeader = true;
      file = "";
    } else if (inHeader && raw.startsWith("+++ ")) {
      file = headerPath(raw.slice(4));
    } else if (raw.startsWith("@@")) {
      inHeader = false;
      const match = /\+(\d+)/.exec(raw);
      line = match ? Number(match[1]) : 0;
    } else if (!inHeader && raw.startsWith("+")) {
      // Never drop an added line just because its file name could not be read: report it under a placeholder.
      out.push({ file: file === "" ? "(unknown file)" : file, line, text: raw.slice(1) });
      line += 1;
    } else if (!inHeader && raw.startsWith(" ")) {
      line += 1; // a context line (absent with -U0, but harmless to count)
    }
  }
  return out;
}

/** The path of a `+++ ` header: drops git's trailing tab (names with spaces), unquotes C-style quoting, strips the `b/` prefix. */
function headerPath(value) {
  let name = value.replace(/\r$/, "").replace(/\t.*$/, "");
  if (name.startsWith('"') && name.endsWith('"') && name.length >= 2) {
    const bytes = [];
    const body = name.slice(1, -1);
    for (let i = 0; i < body.length; i += 1) {
      const octal = /^[0-7]{3}/.exec(body.slice(i + 1, i + 4));
      if (body[i] === "\\" && octal) {
        bytes.push(parseInt(octal[0], 8));
        i += 3;
      } else if (body[i] === "\\" && i + 1 < body.length) {
        const escapes = { n: 10, t: 9, '"': 34, "\\": 92 };
        bytes.push(escapes[body[i + 1]] ?? body.charCodeAt(i + 1));
        i += 1;
      } else {
        bytes.push(...Buffer.from(body[i], "utf8"));
      }
    }
    name = Buffer.from(bytes).toString("utf8");
  }
  if (name === "/dev/null") return "";
  return name.startsWith("b/") ? name.slice(2) : name;
}

/**
 * @param {{ file: string; line: number; text: string }[]} lines
 * @param {string[]} patterns fixed strings, matched case-insensitively; those equal to a PATH_PATTERNS entry are the
 *   path patterns, which PATH_SCAN_EXEMPT files skip
 * @returns {{ file: string; line: number; pattern: number }[]} pattern is an index, never the text
 */
export function scanLines(lines, patterns) {
  const lowered = patterns.map((pattern) => pattern.toLowerCase());
  const pathShapes = new Set(PATH_PATTERNS.map((pattern) => pattern.toLowerCase()));
  const hits = [];
  for (const { file, line, text } of lines) {
    if (SCAN_EXEMPT.some((exempt) => exempt.test(file))) continue;
    const pathExempt = PATH_SCAN_EXEMPT.some((exempt) => exempt.test(file));
    const haystack = text.toLowerCase();
    lowered.forEach((pattern, index) => {
      if (pathExempt && pathShapes.has(pattern)) return;
      if (pattern !== "" && haystack.includes(pattern)) hits.push({ file, line, pattern: index });
    });
  }
  return hits;
}

/**
 * Keeps only the first hit per file:line (M6): a line matching several patterns must be reported once, not once
 * per pattern.
 * @param {{ file: string; line: number; pattern: number }[]} hits
 */
export function dedupeHits(hits) {
  const seen = new Set();
  const out = [];
  for (const hit of hits) {
    const key = `${hit.file}:${hit.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(hit);
  }
  return out;
}

/** @param {string} message the commit messages joined */
export function scanMessages(message, patterns) {
  return scanLines(
    message.split("\n").map((text, index) => ({ file: "(commit message)", line: index + 1, text })),
    patterns,
  );
}

/**
 * @param {{ state: string; mergeable: string } | undefined} pr `gh pr view --json state,mergeable`, undefined when the branch has no PR
 * @param {boolean} [mainMerged] whether `origin/main` is already an ancestor of HEAD: GitHub keeps reporting CONFLICTING until the resolving merge is pushed, so a locally resolved conflict must not block that push
 * @returns {string[]} problems
 */
export function checkPr(pr, mainMerged = false) {
  if (pr === undefined) return [];
  const problems = [];
  if (pr.state !== "OPEN") {
    problems.push(`The PR for this branch is ${pr.state}, not OPEN: do not push to it. Branch fresh from origin/main.`);
  } else if (pr.mergeable === "CONFLICTING" && !mainMerged) {
    problems.push("The PR is CONFLICTING with main: rebase or merge origin/main and resolve it before pushing.");
  }
  return problems;
}

// Fixed prefixes and unquoted paths whatever the user's diff.* config says (mnemonicPrefix or noPrefix would change the headers).
const DIFF_ARGS = ["-c", "core.quotepath=false", "diff", "-U0", "--no-color", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/"];

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function readPatternsFile(file) {
  if (!file || !existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

/** @returns {boolean} whether `origin/main` resolves locally (false before a first push, never throws) */
function hasOriginMain() {
  try {
    execFileSync("git", ["rev-parse", "--verify", "-q", "origin/main"], { stdio: ["ignore", "ignore", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

/** @returns {boolean} whether `origin/main` is an ancestor of HEAD (false when it is not, never throws) */
function isMainMerged() {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", "origin/main", "HEAD"], { stdio: ["ignore", "ignore", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

/** @returns {{ pr?: { state: string; mergeable: string }; problem?: string }} only "no pull requests found" means "no PR"; any other gh failure is a problem */
function prForBranch() {
  try {
    const json = execFileSync("gh", ["pr", "view", "--json", "state,mergeable"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { pr: JSON.parse(json) };
  } catch (error) {
    const stderr = String(error?.stderr ?? "");
    if (/no pull requests? found/i.test(stderr)) return {};
    const why = stderr.trim().split("\n")[0] || String(error?.message ?? error);
    return { problem: `Could not check the PR state with gh (${why}); a merged PR must not be pushed to, so fix gh and rerun.` };
  }
}

function runChecks() {
  const root = git(["rev-parse", "--show-toplevel"]).trim();
  process.chdir(root);
  const problems = [];

  const originMain = hasOriginMain();
  if (originMain) {
    const { pr, problem } = prForBranch();
    if (problem) problems.push(problem);
    problems.push(...checkPr(pr, isMainMerged()));
  } else {
    console.log("preflight: no origin/main yet: scanning all tracked files; PR checks skipped");
  }

  const patterns = [...PATH_PATTERNS, ...readPatternsFile(process.env.PREFLIGHT_PATTERNS_FILE)];
  const untracked = git(["ls-files", "-z", "--others", "--exclude-standard"]) // -z: no quoting of spaces or non-ASCII names
    .split("\0")
    .filter((file) => file !== "")
    .flatMap((file) => {
      try {
        return readFileSync(file, "utf8")
          .split("\n")
          .map((text, index) => ({ file, line: index + 1, text }));
      } catch {
        return []; // unreadable (a directory or a vanished file): nothing to scan
      }
    });
  const base = diffBase(originMain);
  const committedDiff = originMain ? git([...DIFF_ARGS, `${base}...HEAD`]) : git([...DIFF_ARGS, base, "HEAD"]);
  const lines = [...addedLines(committedDiff), ...addedLines(git([...DIFF_ARGS, "HEAD"])), ...untracked];
  const messages = originMain ? git(["log", "--format=%B", "origin/main..HEAD"]) : git(["log", "--format=%B", "HEAD"]);
  const hits = dedupeHits([...scanLines(lines, patterns), ...scanMessages(messages, patterns)]);
  for (const hit of hits) {
    const what = hit.pattern < PATH_PATTERNS.length ? "a local absolute path" : "a private identifier (PREFLIGHT_PATTERNS_FILE)";
    problems.push(`${hit.file}:${hit.line} contains ${what}. Remove it before pushing.`);
  }

  if (problems.length === 0) {
    console.log("preflight: ok");
    return;
  }
  for (const problem of problems) console.error(`preflight: ${problem}`);
  process.exitCode = 1;
}

function main() {
  try {
    runChecks();
  } catch (error) {
    const stderr = String(error?.stderr ?? "").trim();
    const why = stderr.split("\n")[0] || String(error?.message ?? error);
    console.error(`preflight: unexpected git failure (${why}). Fix it and rerun.`);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
