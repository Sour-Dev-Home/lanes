// scripts/lanes/approve-guard.mjs — the barrier between a session and posting review/owner (owner decision, 2026-09-27).
// Wired in .claude/settings.json as two hooks:
//   UserPromptSubmit: node scripts/lanes/approve-guard.mjs user-prompt-submit
//     a prompt that is exactly `/approve <N> [<N>...]` (1 to 10 distinct numbers) writes one grant { sessionId, pr: N, at }
//     per PR to .lanes/approve/<session>.<N>.json (#275); any other prompt in that session deletes them all, except an automated input (AUTOMATED_INPUT_PREFIXES), which neither
//     creates nor deletes one (#262).
//   PreToolUse (Bash): node scripts/lanes/approve-guard.mjs pre-tool-use
//     `post-review.mjs owner` is allowed (no prompt) only as the plain command, only with a grant from this
//     session under 15 minutes old for the same --pr. The allow keeps the grant: post-review.mjs checks it again
//     claims it (renames it to <grant>.json.claimed) before any gh call and deletes that after the status is posted, so every route to review/owner needs a fresh /approve (#81). Every other owner command is denied; anything else gets no
//     decision. A PreToolUse `allow` cannot skip an `ask` rule (observed on 2.1.283), so there is no `ask` rule for
//     the owner command any more: this hook's deny is the barrier, and it holds in every permission mode.
//   PreToolUse (PowerShell) runs the same hook (#61): powershellAsBash reads the command with PowerShell's rules into the
//     Bash command with the same words, which is scanned as above; the plain form must also hold no character
//     PowerShell gives a meaning of its own, and a command that cannot be read is denied when it names post-review.
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { lex, mark, ORIGINAL, RUNS_ON_EXPANSION_RE, unmark } from "./shell-lex.mjs";

export const GRANT_TTL_MS = 15 * 60 * 1000;
export const DENY_REASON = "owner approval only from /approve <N> in this session";
// A command that names post-review but cannot be parsed (an unterminated quote) fails closed with this reason (#100).
export const UNPARSED_REASON = `the command could not be parsed and names post-review.mjs: ${DENY_REASON}`;
const SESSION_RE = /^[A-Za-z0-9_-]{1,128}$/;
const APPROVE_RE = /^\/approve ([1-9][0-9]{0,8})$/;
// `/approve <N> [<N>...]`: numbers separated by one space, so the match is linear (#275).
const APPROVE_LIST_RE = /^\/approve((?: [1-9][0-9]{0,8})+)$/;
export const MAX_APPROVE_PRS = 10;
const PR_RE = /^[1-9][0-9]{0,8}$/;
const POST_REVIEW_RE = /post-review(\.mjs)?$/i;
const NON_OWNER_REVIEWERS = new Set(["test-hunter", "ui-reviewer", "security-reviewer", "architecture-advisor"]);
const VALUED_FLAGS = new Set(["--file", "--pr", "--sha"]);
// The only form that may be allowed: the plain command, nothing chained, nested, redirected or substituted.
const PLAIN_PREFIX = "node scripts/lanes/post-review.mjs owner ";
const SHELL_META_RE = /[;&|`$<>()\n\r\\]/;
const MAX_DEPTH = 4;

/** The PR number of a prompt that is exactly `/approve <N>` (surrounding whitespace ignored), else null. */
export function parseApprovePrompt(prompt) {
  if (typeof prompt !== "string") return null;
  const m = APPROVE_RE.exec(prompt.trim());
  return m ? Number(m[1]) : null;
}

/**
 * The PR numbers of a prompt that is exactly `/approve <N> [<N>...]` (surrounding whitespace ignored): 1 to
 * MAX_APPROVE_PRS distinct numbers, in the order typed. More numbers, a duplicate or any other text is null (#275).
 */
export function parseApprovePrompts(prompt) {
  if (typeof prompt !== "string") return null;
  const m = APPROVE_LIST_RE.exec(prompt.trim());
  if (!m) return null;
  const prs = m[1].slice(1).split(" ").map(Number);
  if (prs.length > MAX_APPROVE_PRS || new Set(prs).size !== prs.length) return null;
  return prs;
}

// How the harness opens an input the owner did not type: a subagent or background task finishing, or a message or
// idle notice from another session. It arrives as a prompt of its own. Shared with start-guard.mjs (#262).
export const AUTOMATED_INPUT_PREFIXES = Object.freeze([
  "<task-notification>",
  "Another Claude session sent a message:",
  "<cross-session-message",
  "[Cross-session idle notice]",
]);

/** True for a prompt that starts (after leading whitespace) with one of AUTOMATED_INPUT_PREFIXES, exact case. */
export function isAutomatedInput(prompt) {
  if (typeof prompt !== "string") return false;
  const p = prompt.trimStart();
  return AUTOMATED_INPUT_PREFIXES.some((w) => p.startsWith(w));
}

/**
 * UserPromptSubmit: one grant per PR for `/approve <N> [<N>...]` (#275), clear for any other prompt, nothing for a
 * session id unsafe as a file name or for an automated input (#262). Keeping the grants across an automated input is
 * safe: such a prompt never creates one, whatever its body says, and each grant still lapses after GRANT_TTL_MS and is
 * spent by its one run.
 */
export function onUserPromptSubmit(input, now = Date.now()) {
  const sessionId = input?.session_id;
  if (typeof sessionId !== "string" || !SESSION_RE.test(sessionId)) return { action: "none" };
  if (isAutomatedInput(input.prompt)) return { action: "none" };
  const prs = parseApprovePrompts(input.prompt);
  if (prs === null) return { action: "clear", sessionId };
  const at = new Date(now).toISOString();
  return { action: "grant", sessionId, grants: prs.map((pr) => ({ sessionId, pr, at })) };
}

/** A session's grant file for one PR: <session>.<pr>.json. A session id holds no '.', so the name is unambiguous (#275). */
export function grantFileName(sessionId, pr) {
  return `${sessionId}.${pr}.json`;
}

/** Deletes every grant file `sessionId` holds in `dir`: <session>.<pr>.json, and <session>.json from before #275. */
function clearSessionGrants(dir, sessionId) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  const prefix = `${sessionId}.`;
  for (const name of names) {
    if (name === `${sessionId}.json` || (name.startsWith(prefix) && name.endsWith(".json") && PR_RE.test(name.slice(prefix.length, -".json".length)))) {
      // One file that cannot be deleted must not stop the rest, nor the new grants written after the clear.
      try {
        rmSync(join(dir, name), { force: true });
      } catch {
        // It still lapses after GRANT_TTL_MS and is spent by its one run.
      }
    }
  }
}

/** The reviewer and --pr of one post-review invocation, from the words after the script path. */
function readPostReviewArgs(args) {
  let pr;
  let prCount = 0;
  let reviewer;
  let flagsDone = false;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (flagsDone || a === "--") {
      if (a !== "--" || flagsDone) reviewer ??= a;
      flagsDone = true;
    } else if (VALUED_FLAGS.has(a)) {
      if (a === "--pr") {
        pr = args[i + 1];
        prCount += 1;
      }
      i += 1;
    } else if (!a.startsWith("--")) {
      reviewer ??= a;
    }
  }
  return { reviewer, pr: prCount === 1 ? pr : undefined };
}

const ASSIGN_RE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;
const VAR_REF_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;
// What is left of a word after substitution that could still expand to anything.
const UNRESOLVED_RE = /[$`]/;
// bun and deno run a script too (start-guard.mjs already counts them for the analogous concern); each takes a
// `run` subcommand ahead of its options and script, which is not itself an option or the script.
const NODE_RE = /^(node|nodejs|bun|deno)(\.exe)?$/i;
const RUNS_VIA_RUN_RE = /^(bun|deno)(\.exe)?$/i;
// Commands that run their arguments as shell text: eval and source always, a shell after a -c flag.
const EVAL_RE = /^(eval|source|\.)$/;
const SHELL_RE = /^(sh|bash|zsh|dash|ksh|ash|busybox)(\.exe)?$/i;
// Shells with another syntax (#119): every argument after one may be its command text (powershell.exe runs its
// arguments as a command by default, cmd takes /c or /k anywhere, and `-c`/`-Command` have prefixes and `=` forms), so
// all of them count as run, joined into one command line as those shells do. cmd and fish text is rewritten into bash
// terms and scanned like bash -c text (see asBashText); powershell's splicing (`$x`, `(…)`, `{…}`, `+` concatenation,
// the backtick escape) has no bash reading, so powershell text holding any of it fails closed.
const FOREIGN_SHELL_RE = /^(powershell|pwsh|cmd|fish)(\.exe)?$/i;
const POWERSHELL_SPLICE_RE = /[$`(){}+[\]]/;
// powershell's -EncodedCommand (and its -e, -ec and prefix forms) takes base64 UTF-16LE: read it decoded.
const isEncodedFlag = (w) => /^[-/]e[a-z]*$/i.test(w) && (w.slice(1).toLowerCase() === "ec" || "encodedcommand".startsWith(w.slice(1).toLowerCase()));
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** A word a foreign shell runs, as text: an -EncodedCommand value decoded, any other word with its real characters. */
function foreignText(plain, i, shellName) {
  const text = unmark(plain[i]);
  if (/^(powershell|pwsh)/i.test(shellName) && isEncodedFlag(plain[i - 1] ?? "") && BASE64_RE.test(text)) {
    return Buffer.from(text, "base64").toString("utf16le");
  }
  return text;
}

/**
 * cmd or fish text in bash terms, or null for powershell: cmd's `^` escape is dropped and its `%X%`/`!X!` (and any other
 * `%` or `!`) become an unresolved `${X}`/`$`; fish's `(…)` command substitution becomes `$(…)`.
 */
function asBashText(text, shellName) {
  if (/^cmd/i.test(shellName)) {
    return text.replace(/\^(.?)/gs, "$1").replace(/%([A-Za-z_][A-Za-z0-9_]*)%|!([A-Za-z_][A-Za-z0-9_]*)!/g, (_, a, b) => `\${${a ?? b}}`).replace(/[%!]/g, "$");
  }
  if (/^fish/i.test(shellName)) return text.replace(/(^|[^$])\(/g, "$1$(");
  return null;
}
// Commands that hand their arguments to a shell as text without a -c flag of bash's (#219): watch, ssh, su -c,
// script -c, flock -c, parallel, tmux, screen. Every argument after one counts as run.
const SHELL_TEXT_COMMANDS = new Set(["watch", "ssh", "su", "runuser", "script", "flock", "parallel", "tmux", "screen"]);
// Commands that only print, list or search their arguments: a "node" among them is never run. Every other command
// word may be a wrapper (env, sudo, time, xargs, …), so a "node" behind it counts.
const NON_RUNNING_COMMANDS = new Set(["echo", "printf", "grep", "egrep", "fgrep", "rg", "ls", "which", "where", "whereis", "type", "cat", "head", "tail", "wc", "file", "stat", "man"]);
// Text tools whose quoted argument is a program in their own language, not shell (#148): its `$` and backticks mean
// nothing to bash, so it is scanned only when it names post-review (awk's system() can still run it).
const PROGRAM_RE = /^(awk|gawk|mawk|nawk|sed|gsed|jq)(\.exe)?$/i;
// Commands that read a heredoc or a literal `$(cat <<'EOF' … EOF)` as data (a file, a commit message, a PR body),
// never as a script (#100).
const DATA_COMMANDS = new Set([...NON_RUNNING_COMMANDS, "git", "gh", "tee"]);
// Node options known to take no value. Any other bare option (no `=value`) may take the next word as its value, so
// that word and the one after it are both treated as the script: an option missing here only costs a false deny.
const NODE_BOOLEAN_FLAGS = new Set([
  "--test", "--test-only", "--watch", "--watch-preserve-output", "--no-warnings", "--no-deprecation",
  "--trace-warnings", "--trace-deprecation", "--throw-deprecation", "--pending-deprecation", "--enable-source-maps",
  "--inspect", "--inspect-brk", "--inspect-wait", "--expose-gc", "--preserve-symlinks", "--preserve-symlinks-main",
  "--experimental-strip-types", "--no-experimental-strip-types", "--experimental-transform-types",
  "--experimental-vm-modules", "--experimental-test-coverage", "--experimental-detect-module", "--trace-uncaught",
  "--abort-on-uncaught-exception", "--frozen-intrinsics", "--check", "-c", "--interactive", "-i",
]);

/**
 * The last index of node's options and script: options, their possible values and the first word that is surely not
 * an option's value. Every word from node up to it could load or be post-review.mjs. The last word if none is surely it.
 */
function nodeScriptEnd(plain, nodeAt) {
  let maybeValue = false;
  for (let i = nodeAt + 1; i < plain.length; i += 1) {
    const w = plain[i];
    if (w === "--") return Math.min(i + 1, plain.length - 1);
    if (w.startsWith("-") && w !== "-") {
      maybeValue = !w.includes("=") && !NODE_BOOLEAN_FLAGS.has(w);
    } else if (maybeValue) {
      maybeValue = false;
    } else {
      return i;
    }
  }
  return plain.length - 1;
}

// Builtins whose `NAME=value` arguments are assignments too.
const ASSIGNING_BUILTINS = new Set(["export", "declare", "local", "readonly", "typeset"]);

/**
 * The indexes of a simple command's assignment words: the `NAME=value` words before its command word, and those after
 * export, declare, local, readonly or typeset. Any other `NAME=value` word is an argument (`echo "n=$n"`, #152).
 */
function assignmentIndexes(words) {
  const at = new Set();
  let i = 0;
  for (; i < words.length && ASSIGN_RE.test(words[i]); i += 1) at.add(i);
  if (ASSIGNING_BUILTINS.has(words[i])) {
    for (let j = i + 1; j < words.length; j += 1) if (ASSIGN_RE.test(words[j])) at.add(j);
  }
  return at;
}

/**
 * The assignment words of the command's segments. The lexer cannot tell a sequence from exclusive branches
 * (`true && R=own || R=xyz`, if/else, case), so a name given two different values is left out: its references stay
 * unresolved and fail closed.
 */
function collectAssignments(segments, assigned) {
  const assignments = {};
  const ambiguous = new Set();
  for (const [k, words] of segments.entries()) {
    for (const j of assigned[k]) {
      const m = ASSIGN_RE.exec(words[j]);
      if (!m) continue;
      if (Object.prototype.hasOwnProperty.call(assignments, m[1]) && assignments[m[1]] !== m[2]) ambiguous.add(m[1]);
      assignments[m[1]] = m[2];
    }
  }
  for (const name of ambiguous) delete assignments[name];
  return assignments;
}

/**
 * Every `$NAME`/`${NAME}` reference with a same-command assignment replaced by its value, whole word or spliced into
 * one, so `S=…post-review.mjs; node $S` and `X=review; node scripts/lanes/post-$X.mjs` are both seen. Values are
 * substituted once, not recursively: a value that still holds `$` stays unresolved.
 */
function resolveVars(words, assignments) {
  return words.map((w) =>
    w.replace(VAR_REF_RE, (ref, braced, bare) => {
      const name = braced ?? bare;
      return Object.prototype.hasOwnProperty.call(assignments, name) ? assignments[name] : ref;
    }),
  );
}

const GLOB_RE = /[*?[{]/;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
// Brace sequences: {1..9} and {a..z}, each with an optional ..step (which only thins the range, so it is ignored).
const INT_SEQ_RE = /^[+-]?[0-9]+\.\.[+-]?[0-9]+(\.\.[+-]?[0-9]+)?$/;
const CHAR_SEQ_RE = /^([A-Za-z])\.\.([A-Za-z])(\.\.[+-]?[0-9]+)?$/;

/** The index of the `}` closing the `{` at `open`, or -1. */
function closingBrace(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i += 1) {
    if (s[i] === "{") depth += 1;
    else if (s[i] === "}" && (depth -= 1) === 0) return i;
  }
  return -1;
}

/** `s` split at the commas outside any nested brace. */
function topLevelCommas(s) {
  const parts = [""];
  let depth = 0;
  for (const c of s) {
    if (c === "," && depth === 0) parts.push("");
    else {
      if (c === "{") depth += 1;
      else if (c === "}") depth -= 1;
      parts[parts.length - 1] += c;
    }
  }
  return parts;
}

// Stands for the numbers an integer sequence {1..9} expands to, which no name needs spelled out.
const DIGITS = "";
// How many words a brace expansion may produce before the guard stops expanding and fails closed.
const MAX_EXPANSIONS = 1024;

/**
 * The words bash's brace expansion makes of `s`, as bash reads it (#142, #167): the leftmost list `{a,b}` or sequence
 * `{a..c}`/`{1..3}` expands, each result is expanded again from that brace on, and any other brace is literal text.
 * A marked (quoted or escaped) brace or comma is plain text, so it neither opens, closes nor splits a group. Null when
 * the expansion would make more than MAX_EXPANSIONS words.
 */
function braceExpand(s) {
  const out = [];
  const walk = (str, from) => {
    if (out.length > MAX_EXPANSIONS) return;
    for (let i = str.indexOf("{", from); i !== -1; i = str.indexOf("{", i + 1)) {
      const end = closingBrace(str, i);
      if (end === -1) continue;
      const inner = str.slice(i + 1, end);
      const parts = topLevelCommas(inner);
      let alts = null;
      let seq;
      if (parts.length > 1) alts = parts;
      else if (INT_SEQ_RE.test(inner)) alts = [DIGITS];
      else if ((seq = CHAR_SEQ_RE.exec(inner))) {
        const [lo, hi] = [seq[1].charCodeAt(0), seq[2].charCodeAt(0)].sort((a, b) => a - b);
        alts = [];
        for (let code = lo; code <= hi; code += 1) alts.push(mark(String.fromCharCode(code)));
      }
      if (alts === null) continue;
      for (const alt of alts) walk(str.slice(0, i) + alt + str.slice(end + 1), i);
      return;
    }
    out.push(str);
  };
  walk(s, 0);
  return out.length > MAX_EXPANSIONS ? null : out;
}

/**
 * A regex source matching everything a glob pattern (with no brace left to expand) can match, as bash reads it. A
 * closed brace is literal text. An unclosed `{` is literal to bash too (#123), but it is read as optional, so a word
 * such as post-review{.mjs that names the script once the stray brace is dropped still fails closed.
 */
function patternRe(s) {
  let re = "";
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (c === "*") re += ".*";
    else if (c === "?") re += ".";
    else if (c === DIGITS) re += "-?[0-9]+";
    else if (c === "[") {
      const end = s.indexOf("]", i + 2);
      if (end === -1) re += "\\[";
      else {
        re += ".";
        i = end;
      }
    } else if (c === "{" && closingBrace(s, i) === -1) re += "\\{?";
    else re += escapeRe(ORIGINAL[c] ?? c);
  }
  return re;
}

/**
 * Whether a word bash would glob- or brace-expand could expand to post-review.mjs: the last path component of one of
 * its brace expansions, as a pattern, matches the name. A word with too many expansions to check counts as a match.
 */
function mayExpandToPostReview(w) {
  if (!GLOB_RE.test(w)) return false;
  const words = braceExpand(w);
  if (words === null) return true;
  return words.some((x) => {
    const pattern = new RegExp(`^${patternRe(x.slice(x.lastIndexOf("/") + 1))}$`, "i");
    return pattern.test("post-review.mjs") || pattern.test("post-review");
  });
}

/** Text with every quote and backslash dropped, so a name split by quoting (pos"t-review) reads whole. */
const unquoted = (s) => s.replace(/['"\\]/g, "");

/** The command word of a simple command, without its directory. */
const commandName = (plain) => plain[0]?.split(/[\\/]/).at(-1);

/**
 * A quoted script, as in bash -c "…", sh -c '…' or eval "…": scan it as a command of its own. One that still holds
 * `$` or a glob may splice a name inside it, so it is scanned too. `shell` is true when the word is run as shell text
 * (so its quoted `$`, backticks and globs come alive again); otherwise only its live ones count (#219), and a quoted
 * `$`, backtick or regex in, say, `echo '`x` foo'` or node -e code is no script. True when `w` was such a script.
 */
function scanNested(w, depth, out, shell) {
  const text = unmark(w);
  if (!/[\s;&|()<>]/.test(text) || !(/post-review/i.test(unquoted(text)) || /[$`*?[{]/.test(shell ? unquoted(text) : w))) return false;
  scanScript(text, depth, out);
  return true;
}

/** Text that may be run as a script (a heredoc fed to a shell): scan it as a command of its own. */
function scanScript(text, depth, out) {
  if (depth >= MAX_DEPTH) out.push({ pr: undefined, standalone: false });
  else scan(text, depth + 1, out);
}

function scan(cmd, depth, out) {
  let segments;
  try {
    segments = lex(cmd);
  } catch {
    // An unterminated quote: bash will not run it, but fail closed on the name with any quoting removed.
    if (/post-review/i.test(unquoted(cmd))) out.push({ pr: undefined, standalone: false, unparsed: true });
    return;
  }
  // `S=scripts/lanes/post-review.mjs; node $S owner … --pr N` must be caught too: resolve same-command
  // `NAME=value` assignments into later `$NAME`/`${NAME}` references before looking for the script and its args.
  const assigned = segments.map(assignmentIndexes);
  const assignments = collectAssignments(segments, assigned);
  // The command word and the script node runs (also behind env, time or sudo), counted without assignment words;
  // `literalAt` holds the indexes (in `plains`) of words read from a literal `$(cat <<'EOF' … EOF)`.
  const plains = [];
  const literalAt = [];
  segments.forEach((raw, k) => {
    const kept = raw.map((_, j) => j).filter((j) => !assigned[k].has(j));
    plains.push(resolveVars(kept.map((j) => raw[j]), assignments));
    literalAt.push(new Set(kept.flatMap((j, i) => (raw.literal?.has(j) ? [i] : []))));
  });
  // Whether segment k's output flows down a pipe into anything that may run it: `echo node … | bash` runs what echo
  // prints, `grep node … | wc -l` does not.
  const feedsRunner = (k) => {
    for (let m = k; segments[m]?.pipedOut; m += 1) if (!NON_RUNNING_COMMANDS.has(commandName(plains[m + 1] ?? []))) return true;
    return false;
  };
  plains.forEach((plain, k) => {
    const name = commandName(plain);
    // Node's options and the script: any of them that still holds `$` or a backtick could load or be post-review.mjs.
    // Every word that looks like node counts, since an earlier one may only be an argument (`sudo -u node node …`).
    const nodeRange = new Set();
    // A command that only prints or searches its arguments runs none of them, unless its output feeds a runner.
    const runsArgs = !NON_RUNNING_COMMANDS.has(name) || feedsRunner(k);
    // Literal `$(cat <<'EOF' … EOF)` words given to a command that reads them as data are not scripts.
    const readsData = (DATA_COMMANDS.has(name) || PROGRAM_RE.test(name ?? "")) && !feedsRunner(k);
    // An awk, sed or jq program is scanned only when it names post-review (#148).
    const programArgs = PROGRAM_RE.test(name ?? "") && !feedsRunner(k);
    // A heredoc body is a script unless a data command reads it. awk and sed are no data commands here: they can run
    // their input (system($0), sed's e). A body written to a file (tee, `>`) that a later command in this one may run
    // is scanned too (#140 security review), and an unquoted body still runs its `$(…)` and backticks. That is what
    // closes #193 (`tee s.sh <<'EOF' … EOF` then `bash s.sh`); the non-heredoc form (`echo "…" > s.sh; bash s.sh`) was
    // never an exception, since an argument naming post-review is scanned whatever command it goes to.
    const writesFile = name === "tee" || (segments[k].redirects ?? []).some((r) => r.toFile);
    const laterRuns = () => plains.some((p, m) => m > k && p.length > 0 && !DATA_COMMANDS.has(commandName(p)));
    // Inside a process substitution (`bash <(cat <<'EOF' … EOF)`), the output goes to the command around it: a script.
    const heredocIsData = DATA_COMMANDS.has(name) && !segments[k].inProcSub && !feedsRunner(k) && !(writesFile && laterRuns());
    for (const { body, quoted } of segments[k].heredocs ?? []) {
      if (!heredocIsData || (!quoted && RUNS_ON_EXPANSION_RE.test(body))) scanScript(body, depth, out);
    }
    plain.forEach((p, at) => {
      if ((at > 0 && !runsArgs) || !NODE_RE.test(p.split(/[\\/]/).at(-1))) return;
      // bun/deno's own `run` subcommand sits ahead of the options and script; skip over it before scanning those.
      const start = RUNS_VIA_RUN_RE.test(p.split(/[\\/]/).at(-1)) && plain[at + 1] === "run" ? at + 1 : at;
      for (let j = start + 1; j <= nodeScriptEnd(plain, start); j += 1) nodeRange.add(j);
    });
    // Words that eval, source or a shell's -c runs as shell text: one still holding `$` or a backtick could be any
    // command at all (`eval $A$B` with both ambiguous), so it fails closed like node's script.
    let evalFrom = Infinity;
    // The first word a powershell, pwsh, cmd or fish runs, and that shell's name (#119).
    let foreignFrom = Infinity;
    let foreignName;
    plain.forEach((p, at) => {
      if ((at > 0 && !runsArgs) || at >= evalFrom) return;
      const name = p.split(/[\\/]/).at(-1);
      if (EVAL_RE.test(name) || SHELL_TEXT_COMMANDS.has(name)) evalFrom = at + 1;
      else if (name === "sudo" && plain.some((w, j) => j > at && /^(-[A-Za-z]*[si][A-Za-z]*|--shell|--login)$/.test(w))) evalFrom = at + 1;
      else if (FOREIGN_SHELL_RE.test(name)) {
        evalFrom = at + 1;
        foreignFrom = at + 1;
        foreignName = name;
      } else if (SHELL_RE.test(name)) {
        const c = plain.findIndex((w, j) => j > at && /^-[A-Za-z]*c[A-Za-z]*$/.test(w));
        if (c !== -1) evalFrom = c + 1;
      }
    });
    // What powershell, pwsh, cmd or fish runs: its arguments as one command line, scanned in bash terms (#119).
    if (foreignFrom !== Infinity) {
      const line = plain.slice(foreignFrom).map((_, j) => foreignText(plain, foreignFrom + j, foreignName)).join(" ");
      const bashText = asBashText(line, foreignName);
      if (bashText === null && POWERSHELL_SPLICE_RE.test(line)) out.push({ pr: undefined, standalone: false });
      else scanScript(bashText ?? line, depth, out);
    }
    // Every argument is shell text when the output feeds a shell, or goes to a file a later command may run (#219).
    const argsRun = feedsRunner(k) || (writesFile && laterRuns());
    // An assigned value may be run later by eval or sh -c "$CMD", and an ambiguous one is never substituted: scan
    // every value that looks like a script as a command of its own.
    for (const j of assigned[k]) scanNested(ASSIGN_RE.exec(segments[k][j])[2], depth, out, true);
    // A redirection target is no argument, but a herestring is a script and a quoted `$(…)` or backtick in any other
    // target runs. A plain file target ("$TMP/out file.txt") is neither.
    for (const { text, herestring } of segments[k].redirects ?? []) {
      if (!herestring && !/\$\(|`/.test(text)) continue;
      let words;
      try {
        words = lex(text).flat();
      } catch {
        words = [text];
      }
      for (const w of words) scanNested(w, depth, out, herestring);
    }
    plain.forEach((raw, i) => {
      // A word run as shell text reads with its quoted characters alive again.
      const shell = i >= evalFrom || argsRun;
      const w = shell ? unmark(raw) : raw;
      if (i > 0 && ((readsData && literalAt[k].has(i)) || (programArgs && !/post-review/i.test(unquoted(w))))) {
        // Data for a command that does not run it: a commit message, a PR body, an awk program.
      } else if (scanNested(raw, depth, out, shell)) {
        // Scanned as a command of its own.
      } else if (POST_REVIEW_RE.test(w)) {
        const { reviewer, pr } = readPostReviewArgs(plain.slice(i + 1).map((x) => (shell ? unmark(x) : x)));
        // Fail closed: a reviewer word that could expand to anything counts as the owner.
        if (reviewer === "owner" || (reviewer !== undefined && /[$`*?[{]/.test(reviewer))) out.push({ pr, standalone: false });
      } else if ((UNRESOLVED_RE.test(w) || mayExpandToPostReview(w)) && (i === 0 || nodeRange.has(i) || (i >= evalFrom && UNRESOLVED_RE.test(w)))) {
        // The command word, a node option or the script node runs, or text a shell evaluates, that could still expand
        // to post-review.mjs: fail closed.
        out.push({ pr: undefined, standalone: false });
      }
    });
  });
}

/**
 * Every `post-review.mjs owner` invocation in a Bash command, including ones behind env, chains, subshells or
 * `bash -c`. `standalone` is true only for the plain `node scripts/lanes/post-review.mjs owner …` with nothing around it.
 * `unparsed` is set on an entry for a part that could not be parsed and names post-review.
 * @returns {{ pr: string | undefined, standalone: boolean, unparsed?: true }[]}
 */
export function findOwnerInvocations(command) {
  return ownerInvocations(String(command ?? ""), String(command ?? ""), SHELL_META_RE);
}

/**
 * findOwnerInvocations of the Bash text `cmd`, where `typed` is the command as the session typed it (the PowerShell
 * text for the PowerShell tool) and `meta` the characters that keep it from being the plain command.
 */
function ownerInvocations(cmd, typed, meta) {
  // No raw-text pre-filter: the name can be split by quotes (pos"t-review.mjs) or matched by a glob, so only the
  // lexed words can tell.
  const out = [];
  scan(cmd, 0, out);
  // No fallback for an `owner` word next to a `$` anywhere (#140): it denied everyday commands such as
  // `echo "owner $X"`, and post-review.mjs itself refuses the owner's approval without a fresh grant (#81, ADR 0004).
  // Leading/trailing whitespace (a trailing newline the model appends to a Bash command is common) must not turn the
  // plain command into a "wrapped" one: trim before checking the exact prefix and for embedded shell metacharacters.
  const trimmed = typed.trim();
  if (out.length === 1 && out[0].pr !== undefined && trimmed.startsWith(PLAIN_PREFIX) && !meta.test(trimmed)) {
    const segments = lex(cmd.trim()); // scan() lexed this cmd already, so it cannot throw here
    if (segments.length === 1 && segments[0][1] === "scripts/lanes/post-review.mjs" && segments[0][2] === "owner") out[0].standalone = true;
  }
  return out;
}

// --- PowerShell (#61) ------------------------------------------------------------------------------------------------
// The PowerShell tool's command is read with PowerShell's own rules and written out as a Bash command with the same
// words, which both guards then scan with their Bash rules. A literal piece of a word goes out single-quoted, and
// whatever PowerShell expands ($x, ${x}, @x) as `$1`, which no guard resolves, so it reads as unresolved. A group,
// subexpression, array, hashtable or script block is `$1` in its word too, and its statements go out as statements of
// their own after the one holding it, so they are scanned as commands, the way a Bash substitution's are. A statement that starts with a value ($x, a string, a group, a type) is an expression
// PowerShell prints, never a command it runs, so it goes out behind `echo`; `& x` and `. x` run x, so there x stays the
// command word, whatever it is. Anything that cannot be read throws: the guards fail closed on it when it names what
// they look for.

const PS_SINGLE = "'‘’‚‛";
const PS_DOUBLE = '"“”„';
const PS_ESCAPES = { 0: "\0", a: "\x07", b: "\b", e: "\x1b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" };
const PS_MAX_DEPTH = 32;
const PS_VAR = "$1";
const PS_NAME_CHAR_RE = /[\p{L}\p{N}_:]/u;
// A statement whose first character is one of these starts with a value, not a command name.
const PS_EXPRESSION_START = `$@([{-${PS_SINGLE}${PS_DOUBLE}`;
// `$x =`, `[string]$x +=`, `$a, $b =`, `$h['k'].v =`: an assignment, whose right side is a statement of its own.
// The type part allows one nested `[…]` and no space, so no two ways to match the same text (a nested quantifier over
// an ambiguous class made `[a][a]…[a]x` take seconds per statement, #61 security review).
const PS_ASSIGN_RE = /^(?:\[[\p{L}\p{N}_.,]+(?:\[[\p{L}\p{N}_.,]*\])?\]\s*)*\$(?:\{[^}\n]*\}|[\p{L}\p{N}_:]+)(?:\.[\p{L}\p{N}_]+|\[[^\]()\n]*\])*(?:\s*,\s*\$(?:\{[^}\n]*\}|[\p{L}\p{N}_:]+))*\s*(?:[-+*/%]|\?\?)?=(?!=)/u;
// `>`, `>>`, `2>`, `*>>`, `2>&1`: PowerShell's redirections. `<` is reserved and never parses.
const PS_REDIRECT_RE = /^([1-6*])?(>>?)(&[1-6])?/;
// Commands that run a string as PowerShell code: each reads as Bash's eval, with its string arguments read as
// PowerShell too. powershell and pwsh run their arguments as a command line, read the same way.
const PS_EVAL_RE = /^(iex|invoke-expression|icm|invoke-command|start-job|sajb|start-threadjob)$/i;
const PS_SHELL_RE = /^(powershell|pwsh)$/i;
// Commands that start their first argument as a program, or open it with its file association (node, for a .mjs):
// each reads as node, with every string argument split into words, as Start-Process joins -ArgumentList.
const PS_LAUNCH_RE = /^(start-process|saps|start|invoke-item|ii)$/i;
// .NET, COM, script-block and alias-drive routes to running code or a program that no word shows: a command using any
// of them fails closed as a whole.
const PS_OPAQUE_RE = /scriptblock|invokescript|invokecommand|add-type|process\]?::start|processstartinfo|diagnostics\.process|activator\]|comobject|alias:/i;
// Commands that rename a program (an alias for node or claude): as a command word, their statement fails closed. Only
// the command word counts, so a word such as "sal" in a message or file name does not (#61 test-hunter round 2).
const PS_ALIAS_RE = /^(set-alias|new-alias|import-alias|sal|nal|ipal)$/i;
// The names a PowerShell quote or backtick inside a string could hide from a Bash reading.
const PS_NAMES_RE = /start\.mjs|queue\.mjs|post-review|--(?:bg|background)|claude/gi;
const psDequoted = (s) => s.replace(/['"`‘-„]/g, "");
const bashQuote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
const psNames = (s) => new Set([...s.matchAll(PS_NAMES_RE)].map((m) => m[0].toLowerCase()));
// Every word of `text`, quotes and backticks dropped, behind `$1`: a command no guard can resolve, so it fails closed.
// Source as the reader takes it (#61 security review). Every line end PowerShell knows (CR, CRLF, NEL, LS, PS) becomes
// LF, so a comment or statement ends where PowerShell ends it; and a private-use character, which the guards use as a
// marker, becomes U+FFFD, so it can neither pose as a marker nor make the reader give up.
// Built from code points: a raw U+2028 or U+2029 in a regex literal is a line break to JavaScript.
const PS_LINE_END_RE = new RegExp(`\\r\\n?|[${String.fromCharCode(0x85, 0x2028, 0x2029)}]`, "g");
const psSource = (s) => s.replace(PS_LINE_END_RE, "\n").replace(/[-]/g, "�");
const psOpaque = (text) => [PS_VAR, ...psDequoted(text).split(/\s+/).filter(Boolean).map(bashQuote)].join(" ");

/** A word's parts as Bash text: literal runs single-quoted, everything else as it is. */
function bashWord(parts) {
  let s = "";
  for (const p of parts) s += p.lit !== undefined ? bashQuote(p.lit) : p.raw;
  return s === "" ? "''" : s;
}

/** Adds literal text to `parts`, joining it to a literal part before it. */
function addLiteral(parts, s) {
  if (parts.at(-1)?.lit !== undefined) parts.at(-1).lit += s;
  else parts.push({ lit: s });
}

/**
 * The escape a backtick at `i` starts: its text, and the index of its last character. `special` (in a double-quoted
 * string or here-string) reads `n, `t, `u{…} and the rest as the characters they stand for; elsewhere a backtick only
 * makes the next character literal.
 */
function psEscape(src, i, special) {
  const c = src[i + 1];
  if (c === undefined) throw new Error("backtick at the end");
  if (special && c === "u" && src[i + 2] === "{") {
    const close = src.indexOf("}", i + 3);
    const code = close === -1 ? NaN : Number.parseInt(src.slice(i + 3, close), 16);
    if (!Number.isInteger(code) || code > 0x10ffff) throw new Error("bad `u{…} escape");
    return { text: String.fromCodePoint(code), end: close };
  }
  return { text: (special && PS_ESCAPES[c]) || c, end: i + 1 };
}

/**
 * A group, subexpression, array, hashtable or script block from `from` up to `closer`: its value is `$1` in the word,
 * and its statements are scanned beside the statement holding it (in `ctx.extra`). Returns the closer's index.
 */
function psGroup(src, from, closer, parts, ctx) {
  const inner = psStatements(src, from, closer, ctx.depth + 1);
  parts.push({ raw: PS_VAR });
  if (inner.text.trim() !== "") ctx.extra.push(inner.text);
  return inner.end;
}

/** `$…` at `i`: a subexpression, a variable or a literal `$`, added to `parts`. Returns the index of its last character. */
function psDollar(src, i, parts, ctx) {
  const next = src[i + 1] ?? "";
  if (next === "(") return psGroup(src, i + 2, ")", parts, ctx);
  if (next === "{") {
    let j = i + 2;
    for (; j < src.length && src[j] !== "}"; j += 1) if (src[j] === "`") j += 1;
    if (j >= src.length) throw new Error("unterminated ${");
    parts.push({ raw: PS_VAR });
    return j;
  }
  if (next !== "" && "$?^".includes(next)) {
    parts.push({ raw: PS_VAR });
    return i + 1;
  }
  let j = i + 1;
  while (j < src.length && PS_NAME_CHAR_RE.test(src[j])) j += 1;
  if (j === i + 1) {
    addLiteral(parts, "$");
    return i;
  }
  parts.push({ raw: PS_VAR });
  return j - 1;
}

/** The expandable text from `i` to `end` (a here-string's body): backtick escapes and `$` expand, quotes are text. */
function psExpandable(src, i, end, parts, ctx) {
  for (let j = i; j < end; j += 1) {
    if (src[j] === "`") {
      const e = psEscape(src, j, true);
      addLiteral(parts, e.text);
      j = e.end;
    } else if (src[j] === "$") j = psDollar(src, j, parts, ctx);
    else addLiteral(parts, src[j]);
  }
}

/** The index of a here-string's closing quote (at the start of a line, followed by `@`) from `from`, or -1. */
function hereStringEnd(src, from, quotes) {
  for (let p = from; p < src.length - 1; p += 1) {
    if (quotes.includes(src[p]) && src[p + 1] === "@" && (p === from || src[p - 1] === "\n")) return p;
  }
  return -1;
}

/**
 * One PowerShell word from `start`: its parts (literal text, or raw Bash for what expands), `end` (the index after it),
 * `value` (its text, with `$1` for each part that expands) and `literal` (nothing in it expands). A group's statements
 * go to `ctx.extra`.
 */
function psWord(src, start, ctx) {
  const parts = [];
  let i = start;
  for (; i < src.length; i += 1) {
    const c = src[i];
    if (/\s/.test(c) || ";|&,<>)}".includes(c)) break;
    const here = i === start && c === "@" && (PS_SINGLE + PS_DOUBLE).includes(src[i + 1] ?? "\0") ? /^[ \t]*\r?\n/.exec(src.slice(i + 2)) : null;
    if (here) {
      const single = PS_SINGLE.includes(src[i + 1]);
      const from = i + 2 + here[0].length;
      const close = hereStringEnd(src, from, single ? PS_SINGLE : PS_DOUBLE);
      if (close === -1) throw new Error("unterminated here-string");
      const bodyEnd = close > from ? close - (src[close - 2] === "\r" ? 2 : 1) : from;
      if (single) addLiteral(parts, src.slice(from, bodyEnd));
      else psExpandable(src, from, bodyEnd, parts, ctx);
      i = close + 1;
    } else if (i === start && c === "@" && (src[i + 1] === "(" || src[i + 1] === "{")) {
      i = psGroup(src, i + 2, src[i + 1] === "(" ? ")" : "}", parts, ctx);
    } else if (i === start && c === "@" && PS_NAME_CHAR_RE.test(src[i + 1] ?? "")) {
      // Splatting: @args passes a variable's values as arguments.
      parts.push({ raw: PS_VAR });
      while (PS_NAME_CHAR_RE.test(src[i + 1] ?? "")) i += 1;
    } else if (c === "(" || c === "{") {
      i = psGroup(src, i + 1, c === "(" ? ")" : "}", parts, ctx);
    } else if (PS_SINGLE.includes(c)) {
      // A single-quoted string: all literal; two quotes in a row are one quote.
      let s = "";
      let j = i + 1;
      for (; j < src.length; j += 1) {
        if (!PS_SINGLE.includes(src[j])) s += src[j];
        else if (PS_SINGLE.includes(src[j + 1] ?? "\0")) s += src[++j];
        else break;
      }
      if (j >= src.length) throw new Error("unterminated '");
      addLiteral(parts, s);
      i = j;
    } else if (PS_DOUBLE.includes(c)) {
      let j = i + 1;
      for (; j < src.length; j += 1) {
        if (PS_DOUBLE.includes(src[j])) {
          if (!PS_DOUBLE.includes(src[j + 1] ?? "\0")) break;
          addLiteral(parts, src[++j]);
        } else if (src[j] === "`") {
          const e = psEscape(src, j, true);
          addLiteral(parts, e.text);
          j = e.end;
        } else if (src[j] === "$") j = psDollar(src, j, parts, ctx);
        else addLiteral(parts, src[j]);
      }
      if (j >= src.length) throw new Error('unterminated "');
      if (parts.length === 0) addLiteral(parts, "");
      i = j;
    } else if (c === "$") {
      i = psDollar(src, i, parts, ctx);
    } else if (c === "`") {
      // A backtick before a line break continues the line: it ends this word.
      if (src[i + 1] === "\n" || (src[i + 1] === "\r" && src[i + 2] === "\n")) break;
      const e = psEscape(src, i, false);
      addLiteral(parts, e.text);
      i = e.end;
    } else if ("*?[]".includes(c)) {
      // A wildcard stays live: PowerShell 7 expands it in a native command's arguments outside Windows.
      parts.push({ raw: c, glob: true });
    } else {
      addLiteral(parts, c);
    }
  }
  if (i === start && parts.length === 0) throw new Error(`unexpected ${src[i]}`);
  const value = parts.map((p) => (p.lit !== undefined ? p.lit : p.glob ? p.raw : PS_VAR)).join("");
  return { parts, end: i, value, literal: parts.every((p) => p.lit !== undefined || p.glob), expression: PS_EXPRESSION_START.includes(src[start]) };
}

/** A PowerShell command name as the guards compare it: its last path component, lower case, without .exe. */
const psCommandName = (value) => value.split(/[\\/]/).at(-1).toLowerCase().replace(/\.exe$/, "");

/** Text PowerShell will run as a command, read as PowerShell: its Bash text, or an opaque command when unreadable. */
function psShadow(text, depth) {
  try {
    return psStatements(psSource(text), 0, null, depth + 1).text;
  } catch {
    return psOpaque(text);
  }
}

/**
 * One statement as Bash text. `extra` collects statements to scan beside it: what a PowerShell runner runs, and a
 * string whose quotes or backticks hide a name from the Bash reading.
 */
function psStatementText(stmt, extra, depth) {
  const words = stmt.items.filter((x) => x.word).map((x) => x.word);
  const first = words[0];
  const expression = !stmt.call && first?.expression;
  const name = first && !expression ? psCommandName(first.value) : "";
  const runner = PS_EVAL_RE.test(name) || PS_SHELL_RE.test(name);
  const launch = PS_LAUNCH_RE.test(name);
  for (const w of words) {
    const shown = psNames(w.value);
    if ([...psNames(psDequoted(w.value))].some((n) => !shown.has(n))) extra.push(psOpaque(w.value));
  }
  if (PS_ALIAS_RE.test(name)) extra.push(psOpaque(words.map((w) => w.value).join(" ")));
  if (runner || launch) {
    const args = words.slice(1);
    // What a runner runs, or a launcher starts, is only known at run time when any argument (or, for a runner,
    // anything piped into it) expands (#61 security review: Start-Process node -ArgumentList $a).
    if (args.some((w) => !w.literal) || (runner && stmt.pipedInto && stmt.pipedLive)) extra.push(PS_VAR);
    if (runner && args.length > 0) extra.push(psShadow(args.map((w) => w.value).join(" "), depth));
    // An -EncodedCommand value, given to powershell directly or through Start-Process, is read decoded.
    for (const [k, w] of args.entries()) {
      if (k > 0 && isEncodedFlag(args[k - 1].value) && BASE64_RE.test(w.value)) extra.push(psShadow(Buffer.from(w.value, "base64").toString("utf16le"), depth));
    }
  }
  const out = expression ? ["echo"] : [];
  for (const item of stmt.items) {
    if (item.redirect) out.push(item.redirect);
    else if (item.word === first && !expression && PS_EVAL_RE.test(name)) out.push("eval");
    else if (item.word === first && !expression && launch) out.push("node");
    else if (launch && item.word.literal) out.push(...item.word.value.split(/\s+/).filter(Boolean).map((s) => bashQuote(s.replaceAll('"', ""))));
    else out.push(bashWord(item.word.parts));
  }
  return out.join(" ");
}

/**
 * PowerShell statements from `start` up to `closer` (`)` or `}`, or the end of `src` when null), as Bash text. `end` is
 * the index of the closer. Throws on anything unreadable: an unterminated string, comment or group, a stray closer, a
 * `<`, nesting deeper than PS_MAX_DEPTH. `src` has gone through psSource.
 */
function psStatements(src, start, closer, depth) {
  // PowerShell itself runs deeper nesting, so this limit of the reader (not of the language) is marked for the guards
  // to deny whatever the command names (#61 security review).
  if (depth > PS_MAX_DEPTH) throw Object.assign(new Error("nesting too deep"), { readerLimit: true });
  const pieces = [];
  const extra = [];
  let stmt = { items: [], call: false };
  // Whether a statement earlier in this pipeline holds a word that expands, and the literal words it sends on.
  let pipeLive = false;
  let pipeText = [];
  const finish = (sep) => {
    if (stmt.items.length > 0) {
      stmt.pipedLive = pipeLive;
      pieces.push(psStatementText(stmt, extra, depth));
      pipeLive ||= stmt.items.some((x) => x.word && !x.word.literal);
      pipeText.push(...stmt.items.filter((x) => x.word?.literal).map((x) => x.word.value));
    }
    const piped = sep === "|";
    if (piped) pieces.push("|");
    else {
      pipeLive = false;
      pipeText = [];
      if (sep) pieces.push(sep);
    }
    stmt = { items: [], call: false, pipedInto: piped };
  };
  // A runner fed by a pipe runs what the statements before it send: read their literal words as PowerShell too.
  const feedsRunner = () => {
    const w = stmt.items.find((x) => x.word)?.word;
    if (stmt.pipedInto && w && !stmt.call && PS_EVAL_RE.test(psCommandName(w.value)) && pipeText.length > 0) extra.push(psShadow(pipeText.join(" "), depth));
  };
  let i = start;
  while (i < src.length) {
    const c = src[i];
    const atStart = stmt.items.length === 0 && !stmt.call;
    if (/\s/.test(c) && c !== "\n") {
      i += 1;
    } else if (c === "`" && /^`\r?\n/.test(src.slice(i))) {
      i += src[i + 1] === "\r" ? 3 : 2;
    } else if (c === "<" && src[i + 1] === "#") {
      const e = src.indexOf("#>", i + 2);
      if (e === -1) throw new Error("unterminated <#");
      i = e + 2;
    } else if (c === "#") {
      const e = src.indexOf("\n", i);
      i = e === -1 ? src.length : e;
    } else if (closer !== null && c === closer) {
      feedsRunner();
      finish();
      return { text: pieces.join(" ") + extra.map((x) => ` ; ${x}`).join(""), end: i };
    } else if (c === ")" || c === "}" || c === "<") {
      throw new Error(`unexpected ${c}`);
    } else if (c === "\n" || c === ";") {
      feedsRunner();
      finish(";");
      i += 1;
    } else if (c === "|" || (c === "&" && src[i + 1] === "&")) {
      feedsRunner();
      const op = src[i + 1] === c ? c + c : c;
      finish(op);
      i += op.length;
    } else if (c === "&" && atStart) {
      // The call operator: what follows is the command, whatever it is.
      stmt.call = true;
      i += 1;
    } else if (c === "&") {
      feedsRunner();
      finish(";");
      i += 1;
    } else if (c === "." && atStart && /\s/.test(src[i + 1] ?? "")) {
      // Dot-sourcing runs what follows, like the call operator.
      stmt.call = true;
      i += 1;
    } else if (atStart && PS_ASSIGN_RE.test(src.slice(i))) {
      i += PS_ASSIGN_RE.exec(src.slice(i))[0].length;
    } else if (c === ",") {
      i += 1;
    } else if (PS_REDIRECT_RE.test(src.slice(i)) && (c === ">" || src[i + 1] === ">")) {
      const [op, fd, arrow, dup] = PS_REDIRECT_RE.exec(src.slice(i));
      stmt.items.push({ redirect: dup ? `${fd && fd !== "*" ? fd : ""}>${dup}` : `${fd === "*" ? "&" : (fd ?? "")}${arrow}` });
      i += op.length;
    } else if (/^--%(\s|$)/.test(src.slice(i, i + 4))) {
      // Stop-parsing: the rest of the line goes to the program as it is, with only %NAME% expanded.
      const e = src.indexOf("\n", i);
      const rest = src.slice(i + 3, e === -1 ? src.length : e);
      for (const chunk of rest.split(/\s+/).filter(Boolean)) {
        const parts = [];
        chunk.replaceAll('"', "").split(/(%[^%\s]+%)/).forEach((s, k) => (k % 2 === 1 ? parts.push({ raw: PS_VAR }) : s && addLiteral(parts, s)));
        stmt.items.push({ word: { parts, value: chunk, literal: parts.every((p) => p.lit !== undefined), expression: false } });
      }
      i = e === -1 ? src.length : e;
    } else {
      const word = psWord(src, i, { depth, extra });
      stmt.items.push({ word });
      i = word.end;
    }
  }
  if (closer !== null) throw new Error(`unclosed ${closer}`);
  feedsRunner();
  finish();
  return { text: pieces.join(" ") + extra.map((x) => ` ; ${x}`).join(""), end: src.length };
}

/**
 * A PowerShell command as a Bash command with the same words (see the note above psStatements), for the guards to scan.
 * Throws when it cannot be read with PowerShell's rules; an error with `readerLimit` set is a limit of this reader
 * (nesting too deep), which PowerShell itself may still run, so the guards deny it whatever it names.
 */
export function powershellAsBash(command) {
  const src = psSource(String(command ?? ""));
  const { text } = psStatements(src, 0, null, 0);
  return PS_OPAQUE_RE.test(psDequoted(src)) ? `${text} ; ${psOpaque(src)}` : text;
}

/** A PowerShell command's text with every quote and backtick dropped, for the fail-closed name check. */
const unquotedPowerShell = (command) => psDequoted(String(command ?? ""));

// The owner command through PowerShell is plain only without any character PowerShell gives a meaning of its own.
const PS_META_RE = new RegExp(`[;&|\`$<>(){}@,#%*?[\\]\\n\\r\\\\${String.fromCharCode(0x2018)}-${String.fromCharCode(0x201e, 0x85, 0x2028, 0x2029, 0xe000)}-${String.fromCharCode(0xf8ff)}]`);

/** The directory the UserPromptSubmit hook writes grants to: .lanes/approve/ in the checkout holding this script. */
export function grantDir() {
  return fileURLToPath(new URL("../../.lanes/approve/", import.meta.url));
}

/** A grant file's shape: { sessionId: string, pr: positive integer, at: a parseable date }. */
export function validGrant(grant) {
  return grant !== null && typeof grant === "object" && typeof grant.sessionId === "string" && Number.isSafeInteger(grant.pr) && grant.pr > 0 && typeof grant.at === "string" && !Number.isNaN(Date.parse(grant.at));
}

/** A valid grant for exactly `pr`, written no more than GRANT_TTL_MS ago (and not in the future). */
export function isFreshGrant(grant, pr, now = Date.now()) {
  if (!validGrant(grant) || grant.pr !== pr) return false;
  const age = now - Date.parse(grant.at);
  return age >= 0 && age < GRANT_TTL_MS;
}

/**
 * PreToolUse: null (no decision) unless the command runs `post-review.mjs owner`; then allow only with this session's
 * fresh grant for the same --pr, and deny everything else.
 * @param grantOrLookup the session's grant file as parsed, null when there is none, or { unreadable: true }; or a
 *   function from the command's --pr (a string of digits) to that, so each PR reads its own grant file (#275)
 * The allow leaves the grant in place: post-review.mjs checks it again, claims it before any gh call (#180) and deletes it once the status is posted (#81).
 * @returns {null | { decision: "allow" | "deny", reason: string }}
 */
export function decidePreToolUse(input, grantOrLookup, now = Date.now()) {
  const tool = input?.tool_name;
  if (tool !== "Bash" && tool !== "PowerShell") return null;
  const command = String(input.tool_input?.command ?? "");
  let found;
  if (tool === "PowerShell") {
    // Read with PowerShell's rules (#61); a command that cannot be read fails closed when it names post-review.
    let bashText;
    try {
      bashText = powershellAsBash(command);
    } catch (e) {
      return e?.readerLimit || /post-review/i.test(unquotedPowerShell(command)) ? { decision: "deny", reason: UNPARSED_REASON } : null;
    }
    found = ownerInvocations(bashText, command, PS_META_RE);
  } else {
    found = findOwnerInvocations(command);
  }
  if (found.length === 0) return null;
  if (found.some((f) => f.unparsed)) return { decision: "deny", reason: UNPARSED_REASON };
  const deny = { decision: "deny", reason: DENY_REASON };
  const sessionId = input.session_id;
  if (found.length !== 1 || !found[0].standalone) return deny;
  if (typeof sessionId !== "string" || !SESSION_RE.test(sessionId)) return deny;
  if (typeof grantOrLookup === "function" && !PR_RE.test(String(found[0].pr ?? ""))) return deny;
  const grant = typeof grantOrLookup === "function" ? grantOrLookup(found[0].pr) : grantOrLookup;
  if (!validGrant(grant)) return deny;
  if (grant.sessionId !== sessionId || String(grant.pr) !== found[0].pr) return deny;
  if (!isFreshGrant(grant, grant.pr, now)) return deny;
  return { decision: "allow", reason: `owner approval from /approve ${grant.pr} in this session` };
}

/** One grant file, parsed: null when it does not exist, { unreadable: true } when it cannot be read or parsed. */
export function readGrant(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    return e.code === "ENOENT" ? null : { unreadable: true };
  }
  try {
    return JSON.parse(text);
  } catch {
    return { unreadable: true };
  }
}

/**
 * The path of a grant file in `dir` holding a fresh grant for `pr` (from any session), or null. A missing directory, an
 * unreadable file or a file that is not *.json counts as no grant.
 */
export function findFreshGrant(dir, pr, now = Date.now()) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  for (const name of names.sort()) {
    if (!name.endsWith(".json")) continue;
    const file = join(dir, name);
    if (isFreshGrant(readGrant(file), pr, now)) return file;
  }
  return null;
}

const preToolUseOutput = (decision, reason) => JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: reason } });

/** One hook call: `event` is user-prompt-submit or pre-tool-use, `raw` the hook's stdin. Returns what to print. */
export function runHook(event, raw, { dir, now = Date.now() }) {
  if (event === "user-prompt-submit") {
    try {
      const r = onUserPromptSubmit(JSON.parse(raw), now);
      // Every prompt that is not an automated input starts from no grants: a new list replaces the last one (#275).
      if (r.action !== "none") clearSessionGrants(dir, r.sessionId);
      if (r.action === "grant") {
        mkdirSync(dir, { recursive: true });
        for (const g of r.grants) writeFileSync(join(dir, grantFileName(r.sessionId, g.pr)), `${JSON.stringify(g)}\n`);
      }
    } catch {
      // Never block a prompt; a grant that was not written only means the owner command is denied.
    }
    return "";
  }
  if (event === "pre-tool-use") {
    try {
      const input = JSON.parse(raw);
      const sessionId = input?.session_id;
      const safe = typeof sessionId === "string" && SESSION_RE.test(sessionId);
      // Each PR's grant is its own file; decidePreToolUse checks --pr is plain digits before this reads it (#275).
      const lookup = (pr) => (safe && PR_RE.test(pr) ? readGrant(join(dir, grantFileName(sessionId, pr))) : null);
      const d = decidePreToolUse(input, lookup, now);
      if (d === null) return "";
      // An allow keeps the grant: post-review.mjs claims it when it runs (#180) and deletes it only after the review/owner status is posted (#81).
      return preToolUseOutput(d.decision, d.reason);
    } catch {
      return preToolUseOutput("deny", DENY_REASON);
    }
  }
  throw new Error("usage: approve-guard.mjs user-prompt-submit|pre-tool-use < hook-input.json");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // A hook that crashes is a non-blocking error and the tool call proceeds, so every failure here must answer deny.
  let out;
  try {
    out = runHook(process.argv[2], readFileSync(0, "utf8"), { dir: grantDir() });
  } catch {
    out = process.argv[2] === "user-prompt-submit" ? "" : preToolUseOutput("deny", DENY_REASON);
  }
  process.stdout.write(out);
}
