// scripts/lanes/approve-guard.mjs — the barrier between a session and posting review/owner (owner decision, 2026-09-27).
// Wired in .claude/settings.json as two hooks:
//   UserPromptSubmit: node scripts/lanes/approve-guard.mjs user-prompt-submit
//     a prompt that is exactly `/approve <N>` writes a grant { sessionId, pr: N, at } to .lanes/approve/<session>.json;
//     any other prompt in that session deletes it, except an automated input (AUTOMATED_INPUT_PREFIXES), which neither
//     creates nor deletes one (#262).
//   PreToolUse (Bash): node scripts/lanes/approve-guard.mjs pre-tool-use
//     `post-review.mjs owner` is allowed (no prompt) only as the plain command, only with a grant from this
//     session under 15 minutes old for the same --pr. The allow keeps the grant: post-review.mjs checks it again
//     claims it (renames it to <grant>.json.claimed) before any gh call and deletes that after the status is posted, so every route to review/owner needs a fresh /approve (#81). Every other owner command is denied; anything else gets no
//     decision. A PreToolUse `allow` cannot skip an `ask` rule (observed on 2.1.283), so there is no `ask` rule for
//     the owner command any more: this hook's deny is the barrier, and it holds in every permission mode.
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const GRANT_TTL_MS = 15 * 60 * 1000;
export const DENY_REASON = "owner approval only from /approve <N> in this session";
// A command that names post-review but cannot be parsed (an unterminated quote) fails closed with this reason (#100).
export const UNPARSED_REASON = `the command could not be parsed and names post-review.mjs: ${DENY_REASON}`;
const SESSION_RE = /^[A-Za-z0-9_-]{1,128}$/;
const APPROVE_RE = /^\/approve ([1-9][0-9]{0,8})$/;
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
 * UserPromptSubmit: grant for `/approve <N>`, clear for any other prompt, nothing for a session id unsafe as a file
 * name or for an automated input (#262). Keeping the grant across an automated input is safe: such a prompt never
 * creates one, whatever its body says, and the grant still lapses after GRANT_TTL_MS and is spent by its one run.
 */
export function onUserPromptSubmit(input, now = Date.now()) {
  const sessionId = input?.session_id;
  if (typeof sessionId !== "string" || !SESSION_RE.test(sessionId)) return { action: "none" };
  if (isAutomatedInput(input.prompt)) return { action: "none" };
  const pr = parseApprovePrompt(input.prompt);
  if (pr === null) return { action: "clear", sessionId };
  return { action: "grant", sessionId, grant: { sessionId, pr, at: new Date(now).toISOString() } };
}

/**
 * The index just past a redirection target starting at `i` (after skipping leading whitespace). Quotes inside the
 * target are skipped, not resolved.
 */
function skipRedirectTarget(cmd, i) {
  let j = i;
  while (j < cmd.length && /\s/.test(cmd[j])) j += 1;
  while (j < cmd.length) {
    const c = cmd[j];
    if (c === "'") {
      const end = cmd.indexOf("'", j + 1);
      j = end === -1 ? cmd.length : end + 1;
    } else if (c === '"') {
      j += 1;
      while (j < cmd.length && cmd[j] !== '"') j += cmd[j] === "\\" ? 2 : 1;
      j += 1;
    } else if (c === "\\") {
      j += 2;
    } else if (/[\s;&|()<>\n\r]/.test(c)) {
      break;
    } else {
      j += 1;
    }
  }
  return j;
}

// `<<D`, `<<-D`, `<<'D'`, `<<"D"` or `<<\D`; a quoted delimiter, or one led by a backslash, makes the body literal
// (bash expands neither in it). `<<<` is a here-string, not this.
const HEREDOC_RE = /^<<(-?)[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|(\\)?([^\s;&|()<>'"`$]+))/;
// `$(cat <<D` and the end of its line: the start of a substitution whose output is only a heredoc's body.
const CAT_HEREDOC_RE = /^\$\([ \t]*cat[ \t]+<<(-?)[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|(\\)?([A-Za-z0-9_.-]+))[ \t]*\r?\n/;
// Text in an unquoted heredoc body that runs a command while bash expands it.
const RUNS_ON_EXPANSION_RE = /\$\(|`/;

/**
 * The body of a heredoc starting at `from`: every line up to the one that is exactly `delim` (after leading tabs,
 * for `<<-`). `end` is the index of the newline ending the delimiter line; an unterminated body runs to the end, as in
 * bash, with `terminated` false. (The same reader as start-guard.mjs, #86.)
 */
function readHeredoc(cmd, from, delim, stripTabs) {
  const lines = [];
  for (let pos = from; pos < cmd.length; ) {
    const nl = cmd.indexOf("\n", pos);
    const lineEnd = nl === -1 ? cmd.length : nl;
    let line = cmd.slice(pos, lineEnd).replace(/\r$/, "");
    if (stripTabs) line = line.replace(/^\t+/, "");
    if (line === delim) return { body: lines.join("\n"), end: lineEnd, terminated: true };
    lines.push(line);
    pos = lineEnd + 1;
  }
  return { body: lines.join("\n"), end: cmd.length, terminated: false };
}

/**
 * `$(cat <<'D' … D)` at `i`, as in `git commit -m "$(cat <<'EOF' … EOF)"`: its output is the body, known text, so it
 * reads as that text, as if single-quoted. Null for any other substitution, or an unquoted delimiter whose body runs
 * a `$(…)` or backtick while it expands. `end` is the index of the closing `)`.
 */
function literalSubstitution(cmd, i) {
  const m = CAT_HEREDOC_RE.exec(cmd.slice(i));
  if (!m) return null;
  const quoted = m[5] === undefined || m[4] !== undefined;
  const { body, end, terminated } = readHeredoc(cmd, i + m[0].length, m[2] ?? m[3] ?? m[5], m[1] === "-");
  if (!terminated || (!quoted && RUNS_ON_EXPANSION_RE.test(body))) return null;
  const close = /^\s*\)/.exec(cmd.slice(end));
  return close ? { body, end: end + close[0].length - 1 } : null;
}

// A `$`, backtick, brace, comma or glob character that quoting or a backslash made literal (#142, #219) stays in its
// word as a private-use stand-in, so the brace, glob and substitution checks read it as bash does: plain text. `unmark`
// puts the real characters back wherever the word is handed on as shell text to run (bash -c '…', eval, a pipe into
// a shell), where bash reads them afresh.
const LITERAL = { $: "", "`": "", "{": "", "}": "", ",": "", "*": "", "?": "", "[": "" };
const ORIGINAL = Object.fromEntries(Object.entries(LITERAL).map(([c, m]) => [m, c]));
const mark = (s) => s.replace(/[$`{},*?[]/g, (c) => LITERAL[c]);
const unmark = (s) => s.replace(/[-]/g, (m) => ORIGINAL[m]);

/**
 * Shell-ish lexer: words (quotes and backslashes resolved, nothing expanded) grouped into simple commands split on
 * ; & | ( ) newlines and redirections. A redirection's target (and a bare fd number right before it, as in `2>file`)
 * is never a word: bash does not pass it to the program, so it must not shift argument positions such as the
 * reviewer word. Its raw text goes to the segment's `redirects` instead, since a `$(…)` in it still runs and a
 * herestring (`bash <<< "…"`) is a script. A heredoc's body is not lexed as commands on the outer line (#100): it goes
 * to its segment's `heredocs`, and a literal `$(cat <<'EOF' … EOF)` reads as its body, with that word's index in the
 * segment's `literal`. A segment whose output a `|` or `|&` feeds into the next one has `pipedOut` set
 * (`(echo …) | sh` marks the echo). A quoted or escaped `$`, backtick, brace, comma or glob character is marked
 * literal (see LITERAL). Throws on an unterminated quote.
 * @returns {(string[] & { pipedOut?: true, redirects?: { text: string, herestring: boolean, toFile: boolean }[], heredocs?: { body: string, quoted: boolean }[], literal?: Set<number> })[]}
 */
function lex(cmd) {
  // A raw stand-in character would read as a marked one: refuse to parse it, so a command naming post-review fails closed.
  if (/[-]/.test(cmd)) throw new Error("private-use character");
  const segments = [[]];
  const pending = [];
  let word = null;
  let wordLiteral = false;
  // Parenthesis depth, and the depths at which a process substitution opened: its segments are `inProcSub`.
  let parens = 0;
  const procSubs = [];
  let procSubNext = false;
  const markProcSub = () => {
    if (procSubs.length > 0) segments.at(-1).inProcSub = true;
    else delete segments.at(-1).inProcSub;
  };
  const endWord = () => {
    if (word !== null) {
      if (wordLiteral) (segments.at(-1).literal ??= new Set()).add(segments.at(-1).length);
      segments.at(-1).push(word);
    }
    word = null;
    wordLiteral = false;
  };
  // Every new segment (after ; & | || && newlines and parentheses) takes the process-substitution mark it is under.
  const endSegment = () => {
    endWord();
    if (segments.at(-1).length > 0) segments.push([]);
    markProcSub();
  };
  const markPiped = () => {
    endWord();
    const last = segments.at(-1).length > 0 ? segments.at(-1) : segments.at(-2);
    if (last) last.pipedOut = true;
    endSegment();
  };
  for (let i = 0; i < cmd.length; i += 1) {
    const c = cmd[i];
    if (c === "'") {
      const end = cmd.indexOf("'", i + 1);
      if (end === -1) throw new Error("unterminated '");
      word = (word ?? "") + mark(cmd.slice(i + 1, end));
      i = end;
    } else if (c === '"') {
      let j = i + 1;
      let s = "";
      for (; j < cmd.length && cmd[j] !== '"'; j += 1) {
        const lit = cmd[j] === "$" ? literalSubstitution(cmd, j) : null;
        if (lit) {
          s += mark(lit.body);
          wordLiteral = true;
          j = lit.end;
          continue;
        }
        // Inside double quotes only `$` (with a `${…}` reference's braces) and a backtick stay live, and only when no
        // backslash escapes them.
        const ref = cmd[j] === "$" && cmd[j + 1] === "{" ? cmd.indexOf("}", j) : -1;
        if (ref !== -1 && !cmd.slice(j, ref).includes('"')) {
          s += cmd.slice(j, ref + 1);
          j = ref;
          continue;
        }
        const escaped = cmd[j] === "\\" && '"\\$`'.includes(cmd[j + 1] ?? "");
        if (escaped) j += 1;
        s += escaped || !"$`".includes(cmd[j]) ? mark(cmd[j]) : cmd[j];
      }
      if (j >= cmd.length) throw new Error('unterminated "');
      word = (word ?? "") + s;
      i = j;
    } else if (c === "$" && literalSubstitution(cmd, i)) {
      const lit = literalSubstitution(cmd, i);
      word = (word ?? "") + mark(lit.body);
      wordLiteral = true;
      i = lit.end;
    } else if (c === "\\") {
      if (cmd[i + 1] !== "\n") word = (word ?? "") + mark(cmd[i + 1] ?? "");
      i += 1;
    } else if (c === "\n" && pending.length > 0) {
      // The heredocs opened on this line: their bodies follow it, each up to its delimiter line.
      endSegment();
      let end = i;
      for (const h of pending.splice(0)) {
        const r = readHeredoc(cmd, end + 1, h.delim, h.stripTabs);
        (h.segment.heredocs ??= []).push({ body: r.body, quoted: h.quoted });
        end = r.end;
      }
      i = end;
    } else if (c === "|" && cmd[i + 1] === "|") {
      endSegment();
      i += 1;
    } else if (c === "|") {
      markPiped();
      if (cmd[i + 1] === "&") i += 1;
    } else if (";&()\n\r".includes(c)) {
      endSegment();
      if (c === "(") {
        parens += 1;
        if (procSubNext) procSubs.push(parens);
        procSubNext = false;
      } else if (c === ")") {
        if (procSubs.at(-1) === parens) procSubs.pop();
        parens -= 1;
      }
      markProcSub();
    } else if (c === "<" || c === ">") {
      // A bare fd number immediately before `<`/`>` (as in `2>file`) is part of the operator, not a word.
      if (word !== null && /^[0-9]+$/.test(word)) word = null;
      else endWord();
      const doc = c === "<" && cmd[i + 1] === "<" && cmd[i + 2] !== "<" ? HEREDOC_RE.exec(cmd.slice(i)) : null;
      if (doc) {
        pending.push({ segment: segments.at(-1), delim: doc[2] ?? doc[3] ?? doc[5], stripTabs: doc[1] === "-", quoted: doc[5] === undefined || doc[4] !== undefined });
        i += doc[0].length - 1;
        continue;
      }
      let j = i + 1;
      if (cmd[j] === c || cmd[j] === "&") j += 1; // >>, <<, >&, <&
      const herestring = c === "<" && cmd[j] === "<";
      if (herestring) j += 1;
      const end = skipRedirectTarget(cmd, j);
      // `<(…)`/`>(…)`: a process substitution, whose commands follow as segments of their own.
      procSubNext = cmd[end] === "(" && cmd.slice(j, end).trim() === "";
      // `toFile`: output written to a file (`>`, `>>`), not duplicated onto another fd (`2>&1`).
      (segments.at(-1).redirects ??= []).push({ text: cmd.slice(j, end), herestring, toFile: c === ">" && cmd[i + 1] !== "&" && !procSubNext });
      i = end - 1;
    } else if (/\s/.test(c)) {
      endWord();
    } else {
      word = (word ?? "") + c;
    }
  }
  endSegment();
  return segments.filter((s) => s.length > 0 || s.redirects || s.heredocs);
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
  const cmd = String(command ?? "");
  // No raw-text pre-filter: the name can be split by quotes (pos"t-review.mjs) or matched by a glob, so only the
  // lexed words can tell.
  const out = [];
  scan(cmd, 0, out);
  // No fallback for an `owner` word next to a `$` anywhere (#140): it denied everyday commands such as
  // `echo "owner $X"`, and post-review.mjs itself refuses the owner's approval without a fresh grant (#81, ADR 0004).
  // Leading/trailing whitespace (a trailing newline the model appends to a Bash command is common) must not turn the
  // plain command into a "wrapped" one: trim before checking the exact prefix and for embedded shell metacharacters.
  const trimmedCmd = cmd.trim();
  if (out.length === 1 && out[0].pr !== undefined && trimmedCmd.startsWith(PLAIN_PREFIX) && !SHELL_META_RE.test(trimmedCmd)) {
    const segments = lex(trimmedCmd); // scan() lexed this cmd already, so it cannot throw here
    if (segments.length === 1 && segments[0][1] === "scripts/lanes/post-review.mjs" && segments[0][2] === "owner") out[0].standalone = true;
  }
  return out;
}

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
 * @param grant the session's grant file as parsed, null when there is none, or { unreadable: true }
 * The allow leaves the grant in place: post-review.mjs checks it again, claims it before any gh call (#180) and deletes it once the status is posted (#81).
 * @returns {null | { decision: "allow" | "deny", reason: string }}
 */
export function decidePreToolUse(input, grant, now = Date.now()) {
  if (input?.tool_name !== "Bash") return null;
  const found = findOwnerInvocations(input.tool_input?.command);
  if (found.length === 0) return null;
  if (found.some((f) => f.unparsed)) return { decision: "deny", reason: UNPARSED_REASON };
  const deny = { decision: "deny", reason: DENY_REASON };
  const sessionId = input.session_id;
  if (found.length !== 1 || !found[0].standalone) return deny;
  if (typeof sessionId !== "string" || !SESSION_RE.test(sessionId) || !validGrant(grant)) return deny;
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
      const file = r.action === "none" ? null : join(dir, `${r.sessionId}.json`);
      if (r.action === "grant") {
        mkdirSync(dir, { recursive: true });
        writeFileSync(file, `${JSON.stringify(r.grant)}\n`);
      } else if (r.action === "clear") {
        rmSync(file, { force: true });
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
      const file = typeof sessionId === "string" && SESSION_RE.test(sessionId) ? join(dir, `${sessionId}.json`) : null;
      const d = decidePreToolUse(input, file ? readGrant(file) : null, now);
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
