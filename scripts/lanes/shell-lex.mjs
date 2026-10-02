// scripts/lanes/shell-lex.mjs — the shell reading both guards share (#194, #351): heredocs, literal
// $(cat <<'EOF' … EOF) substitutions, redirection targets, the one lexer commands are read with (the words shape
// and start-guard.mjs's `{ bodies: true }`), the grant-file reader, and the hook helpers start-guard.mjs uses
// (isAutomatedInput, powershellAsBash, preToolUseOutput).
import { readFileSync } from "node:fs";

/**
 * The index just past a redirection target starting at `i` (after skipping leading whitespace). Quotes inside the
 * target are skipped, not resolved.
 */
export function skipRedirectTarget(cmd, i) {
  let j = i;
  while (j < cmd.length && /\s/.test(cmd[j])) j += 1;
  while (j < cmd.length) {
    const c = cmd[j];
    if (c === "$" && cmd[j + 1] === "'") {
      // `$'…'`, where a backslash escapes the next character, `\'` included (#310).
      j = Math.min(ansiCEnd(cmd, j) + 1, cmd.length);
    } else if (c === "'") {
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

// --- ANSI-C quoting and a literal `$` (#310) --------------------------------------------------------------------

/** The index of the `'` closing the `$'` at `i` (a backslash escapes the next character, `\'` too), or the text's length. */
function ansiCEnd(cmd, i) {
  for (let j = i + 2; j < cmd.length; j += 1) {
    if (cmd[j] === "\\") j += 1;
    else if (cmd[j] === "'") return j;
  }
  return cmd.length;
}

const ANSI_C_SIMPLE = { a: 7, b: 8, e: 27, E: 27, f: 12, n: 10, r: 13, t: 9, v: 11, "\\": 92, "'": 39, '"': 34, "?": 63 };
const ANSI_C_ESCAPE_RE = /\\(?:([abeEfnrtv\\'"?])|([0-7]{1,3})|x([0-9A-Fa-f]{1,2})|u([0-9A-Fa-f]{1,4})|U([0-9A-Fa-f]{1,8})|c([^\\])|([^]))/y;
// A private-use character is one of this file's markers (LITERAL, LIT_DOLLAR, …): one an escape spells reads as U+FFFD,
// an ordinary character to bash as it is, so it never stands for a marked `$` that `unmark` would bring back to life.
const PRIVATE_USE_RE = /[-]/g;
const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

/**
 * `$'…'` at `i`, bash's ANSI-C quoting (#310): its text with the escapes resolved as bash does (`\n`, `\t`, `\xHH`,
 * `\uHHHH`, `\UHHHHHHHH`, octal, `\cX`, `\'`, …; an unknown one keeps its backslash; a NUL ends the text), read as UTF-8
 * bytes the way bash writes them out, and `end`, the index of its closing `'`. Null when `i` holds no `$'`. Throws
 * when it is unterminated.
 */
export function ansiCString(cmd, i) {
  if (cmd[i] !== "$" || cmd[i + 1] !== "'") return null;
  const end = ansiCEnd(cmd, i);
  if (end >= cmd.length) throw new Error("unterminated $'");
  const inner = cmd.slice(i + 2, end);
  const bytes = [];
  // Byte by byte: spreading a long run into push() would overflow the call's argument limit.
  const text = (s) => {
    for (const b of utf8.encode(s)) bytes.push(b);
  };
  for (let j = 0; j < inner.length; ) {
    if (inner[j] !== "\\") {
      const next = inner.indexOf("\\", j);
      const stop = next === -1 ? inner.length : next;
      text(inner.slice(j, stop));
      j = stop;
      continue;
    }
    ANSI_C_ESCAPE_RE.lastIndex = j;
    const m = ANSI_C_ESCAPE_RE.exec(inner);
    if (!m) {
      // A backslash ending the text (`$'\c'` reads `\c` whole): kept as it is.
      text(inner.slice(j));
      break;
    }
    j += m[0].length;
    const [, simple, octal, hex, u4, u8, ctrl, other] = m;
    if (simple) bytes.push(ANSI_C_SIMPLE[simple]);
    else if (octal) bytes.push(parseInt(octal, 8) & 0xff);
    else if (hex) bytes.push(parseInt(hex, 16));
    else if (u4 || u8) {
      const cp = parseInt(u4 ?? u8, 16);
      text(cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) ? "�" : String.fromCodePoint(cp));
    } else if (ctrl) bytes.push(ctrl === "?" ? 0x7f : ctrl.charCodeAt(0) < 0x80 ? ctrl.toUpperCase().charCodeAt(0) & 0x1f : 0x3f);
    else text(`\\${other}`);
  }
  const nul = bytes.indexOf(0);
  return { text: fromUtf8.decode(new Uint8Array(nul === -1 ? bytes : bytes.slice(0, nul))).replace(PRIVATE_USE_RE, "�"), end };
}

/** `text` with every `$'…'` in it resolved: raw text as bash may read it, for the checks that look for a name. */
const ansiCResolved = (text) =>
  text.replace(/\$'(?:[^'\\]|\\[^])*'/g, (s) => {
    try {
      return ansiCString(s, 0).text;
    } catch {
      return s;
    }
  });

/**
 * True when the `$` at `j` is a plain character to bash (#310): nothing it expands follows (no name, digit, special
 * parameter, `{`, `(` or `[`), only whitespace, the end, shell punctuation, or a backslash escaping a character other
 * than a newline (`"a$\|b"`). In double quotes (`quoted`) the closing `"` leaves it plain too; bare, `$"…"` and `$'…'`
 * are quoting of their own, and a backslash-newline joins the next line on, so each keeps it live.
 */
function literalDollar(cmd, j, quoted) {
  const next = cmd[j + 1];
  if (next === undefined) return true;
  if (next === "\\") return cmd[j + 2] !== undefined && cmd[j + 2] !== "\n" && cmd[j + 2] !== "\r";
  if (next === '"') return quoted;
  return /[\s|;&<>),./:=+%^~\]}]/.test(next);
}

// `<<D`, `<<-D`, `<<'D'`, `<<"D"` or `<<\D`; a quoted delimiter, or one led by a backslash, makes the body literal
// (bash expands neither in it). `<<<` is a here-string, not this.
export const HEREDOC_RE = /^<<(-?)[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|(\\)?([^\s;&|()<>'"`$]+))/;
// `$(cat <<D` and the end of its line: the start of a substitution whose output is only a heredoc's body. D is letters,
// digits, `_`, `.` or `-` only (bare or quoted, and at most the one backslash before a bare word that `<<\EOF` uses):
// bash unquotes any other delimiter (`"E\$F"` is `E$F`) in ways this lexer might not, so that body is never read as
// literal text, in either shape (#269, #310), the rule start-guard.mjs's PLAIN_DELIM_RE and DELIM_END_RE apply to
// top-level heredocs (#240).
export const CAT_HEREDOC_RE = /^\$\([ \t]*cat[ \t]+<<(-?)[ \t]*(?:'([A-Za-z0-9_.-]+)'|"([A-Za-z0-9_.-]+)"|(\\)?([A-Za-z0-9_.-]+))[ \t]*\r?\n/;
// A `$(cat <<D` opener longer than this is not read as one.
const CAT_OPENER_MAX = 4096;
// Text in an unquoted heredoc body that runs a command while bash expands it.
export const RUNS_ON_EXPANSION_RE = /\$\(|`/;

/**
 * The heredoc operator a HEREDOC_RE or CAT_HEREDOC_RE match read: its delimiter word, whether it is `<<-` (leading
 * tabs stripped) and whether the body is literal (a quoted or backslash-led delimiter, #140).
 */
export function heredocOperator(m) {
  return { delim: m[2] ?? m[3] ?? m[5], stripTabs: m[1] === "-", quoted: m[5] === undefined || m[4] !== undefined };
}

/**
 * The body of a heredoc starting at `from`: every line up to the one that is exactly `delim` (after leading tabs,
 * for `<<-`). `end` is the index of the newline ending the delimiter line; an unterminated body runs to the end, as in
 * bash, with `terminated` false.
 */
export function readHeredoc(cmd, from, delim, stripTabs) {
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
 * reads as that text, as if single-quoted. Null for any other substitution, or an unquoted delimiter whose body
 * matches `expands` (by default a `$(…)` or backtick, which runs while it expands). `end` is the index of the
 * closing `)`.
 */
export function literalSubstitution(cmd, i, expands = RUNS_ON_EXPANSION_RE) {
  const m = CAT_HEREDOC_RE.exec(cmd.slice(i, i + CAT_OPENER_MAX));
  if (!m) return null;
  const { delim, stripTabs, quoted } = heredocOperator(m);
  const { body, end, terminated } = readHeredoc(cmd, i + m[0].length, delim, stripTabs);
  if (!terminated || (!quoted && expands.test(body))) return null;
  const close = /^\s*\)/.exec(cmd.slice(end));
  return close ? { body, end: end + close[0].length - 1 } : null;
}

// A `$`, backtick, brace, comma or glob character that quoting or a backslash made literal (#142, #219) stays in its
// word as a private-use stand-in, so the brace, glob and substitution checks read it as bash does: plain text. `unmark`
// puts the real characters back wherever the word is handed on as shell text to run (bash -c '…', eval, a pipe into
// a shell), where bash reads them afresh.
export const LITERAL = { $: "", "`": "", "{": "", "}": "", ",": "", "*": "", "?": "", "[": "" };
export const ORIGINAL = Object.fromEntries(Object.entries(LITERAL).map(([c, m]) => [m, c]));
export const mark = (s) => s.replace(/[$`{},*?[]/g, (c) => LITERAL[c]);
export const unmark = (s) => s.replace(/[-]/g, (m) => ORIGINAL[m]);

// start-guard.mjs's shape marks only a `$` or backtick the shell takes literally (single-quoted, escaped, or in a
// literal heredoc message), as one of these, so its unresolved check sees only the ones that expand (#89).
export const LIT_DOLLAR = "";
export const LIT_TICK = "";
// A backtick substitution's word, and a restored literal backtick, hold this one: still unresolved, but read as a
// plain character, not as the start of a substitution the way a live backtick is (#197).
export const QUOTED_TICK = "";
const literal = (s) => s.replaceAll("$", LIT_DOLLAR).replaceAll("`", LIT_TICK);

// Text in an unquoted heredoc body that bash could still expand: any `$`, backtick or backslash (#89), stricter than
// RUNS_ON_EXPANSION_RE, which lets a plain `$VAR` stay text.
const EXPANDS_RE = /[$`\\]/;
/**
 * start-guard.mjs's literalSubstitution: `$(cat <<'D' … D)` at `i` whose body, if its delimiter is unquoted, holds
 * nothing that could expand (EXPANDS_RE). Null otherwise.
 */
export const plainLiteralSubstitution = (cmd, i) => literalSubstitution(cmd, i, EXPANDS_RE);

// A redirection operator: `>`, `>>`, `>|`, `>&`, `<`, `<&`, `<>`, `&>` or `&>>` (#191).
const REDIRECT_RE = /^(?:&>>?|>[>|&]?|<[&>]?)/;
// A `NAME=value` assignment word, and a POSIX shell's program name (start-guard.mjs reads both too).
export const ASSIGN_RE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;
export const SHELL_RE = /^(bash|sh|zsh|dash|ksh|ash)(\.exe)?$/i;
export const basename = (w) => w.split(/[\\/]/).at(-1);

/** The index of the backtick closing the one at `i` (a backslash escapes the next character), or -1. */
function backtickEnd(cmd, i) {
  for (let j = i + 1; j < cmd.length; j += 1) {
    if (cmd[j] === "\\") j += 1;
    else if (cmd[j] === "`") return j;
  }
  return -1;
}

/**
 * `$((…))` at `i`, an arithmetic expansion (#102): its expression and the index of its closing `)`. Null for anything
 * that is not plainly one (a quote, backtick, backslash or newline inside, `$( (…) )`, or no closing `))`), which is
 * then lexed as before.
 */
function arithmetic(cmd, i) {
  if (!cmd.startsWith("$((", i)) return null;
  let depth = 0;
  for (let j = i + 3; j < cmd.length; j += 1) {
    const c = cmd[j];
    if ("'\"`\\\n".includes(c)) return null;
    if (c === "(") depth += 1;
    else if (c === ")") {
      if (depth > 0) depth -= 1;
      else return cmd[j + 1] === ")" ? { expr: cmd.slice(i + 3, j), end: j + 1 } : null;
    }
  }
  return null;
}

/**
 * An arithmetic expression as a script to walk: its variables are numbers there, so they read as 0. Whatever is left,
 * such as a `$(…)` inside, is walked like any quoted script.
 */
const arithmeticScript = (expr) => expr.replace(/\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$[A-Za-z_][A-Za-z0-9_]*|\$[0-9#?]/g, "0");

/**
 * True when segment k's output is piped into a shell further down its pipeline (#246): a shell named anywhere in a
 * piped-to command (`| sh`, `| env bash -s`, `| xargs sh -c`), or eval, source or `.` as its command word.
 */
export function feedsShell(segments, pipes, k) {
  for (let j = k + 1; j < segments.length && pipes[j - 1]; j += 1) {
    const words = segments[j];
    const program = words.find((w) => !ASSIGN_RE.test(w));
    if (words.some((w) => SHELL_RE.test(basename(w))) || program === "eval" || program === "source" || program === ".") return true;
  }
  return false;
}

// --- Globs, launchers and WMI process creation (#308) ------------------------------------------------------------

const GLOB_RE = /[*?[{]/;
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
const DIGITS = String.fromCharCode(0xe00f);
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
 * The index of the `]` closing the bracket expression that opens at `open`, as bash reads one, or -1: a `!` or `^`
 * right after the `[` negates, a `]` first is a member, and a POSIX class `[:alpha:]` (or `[=a=]`, `[.a.]`) is one
 * member however many characters spell it (#404), so `[[:alpha:]]ode` closes after the second `]`. A class that never
 * closes is plain text; one delimiter's first miss is remembered, so a run of `[[:` stays linear.
 */
function bracketEnd(s, open) {
  let i = open + 1;
  if (s[i] === "!" || s[i] === "^") i += 1;
  if (s[i] === "]") i += 1;
  const unclosed = new Set();
  for (; i < s.length; i += 1) {
    if (s[i] === "]") return i;
    const d = s[i + 1];
    if (s[i] === "[" && (d === ":" || d === "=" || d === ".") && !unclosed.has(d)) {
      const close = s.indexOf(`${d}]`, i + 2);
      if (close === -1) unclosed.add(d);
      else i = close + 1;
    }
  }
  return -1;
}

/**
 * The steps of a glob pattern (with no brace left to expand), as bash reads it: `*` any run, `?` and a closed `[…]`
 * (bracketEnd) one character, an integer sequence's DIGITS an optional `-` and one or more digits, and anything else
 * itself. A closed brace is literal text. An unclosed `{` is literal to bash too (#123), but it is read as optional,
 * so a word such as post-review{.mjs that names the script once the stray brace is dropped still fails closed.
 */
function globSteps(s) {
  const steps = [];
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (c === "*") {
      if (steps.at(-1)?.kind !== "any") steps.push({ kind: "any" });
    } else if (c === "?") steps.push({ kind: "one" });
    else if (c === DIGITS) steps.push({ kind: "digits" });
    else if (c === "[" && bracketEnd(s, i) !== -1) {
      steps.push({ kind: "one" });
      i = bracketEnd(s, i);
    } else if (c === "{" && closingBrace(s, i) === -1) steps.push({ kind: "optional", ch: "{" });
    else steps.push({ kind: "char", ch: (ORIGINAL[c] ?? c).toLowerCase() });
  }
  return steps;
}

/**
 * Whether the glob `steps` match all of `name` (lower case), walked as a set of positions in the name: linear in the
 * steps for each position, with no backtracking regex, so a run of `*` cannot take exponential time (#308 security
 * review round 2).
 */
function globMatches(steps, name) {
  let at = new Set([0]);
  for (const step of steps) {
    const next = new Set();
    for (const p of at) {
      if (step.kind === "any") for (let q = p; q <= name.length; q += 1) next.add(q);
      else if (step.kind === "one") {
        if (p < name.length) next.add(p + 1);
      } else if (step.kind === "optional") {
        next.add(p);
        if (name[p] === step.ch) next.add(p + 1);
      } else if (step.kind === "digits") {
        const from = name[p] === "-" ? [p, p + 1] : [p];
        for (let q of from) while (q < name.length && /[0-9]/.test(name[q])) next.add((q += 1));
      } else if (name[p] === step.ch) next.add(p + 1);
    }
    if (next.size === 0) return false;
    at = next;
  }
  return at.has(name.length);
}

// A glob word longer than this, or with more braces, is not expanded: it counts as a match (bounded work, #308).
const MAX_GLOB_WORD = 1024;
const MAX_GLOB_BRACES = 64;

/**
 * Whether a word a shell (or PowerShell, for a program name) would glob- or brace-expand could expand to one of
 * `names`: the last path component (after `/` or `\`) of one of its brace expansions, as a pattern, matches a name,
 * ignoring case as Windows does. A marked (quoted) glob character is plain text. A word with too many expansions to
 * check, longer than MAX_GLOB_WORD or with more than MAX_GLOB_BRACES braces counts as a match. Shared by
 * approve-guard.mjs (post-review.mjs) and start-guard.mjs (start.mjs, queue.mjs, claude), #308.
 */
export function mayExpandTo(w, names) {
  if (!GLOB_RE.test(w)) return false;
  if (w.length > MAX_GLOB_WORD || w.split("{").length - 1 > MAX_GLOB_BRACES) return true;
  const words = braceExpand(w);
  if (words === null) return true;
  return words.some((x) => {
    const steps = globSteps(basename(x));
    return names.some((n) => globMatches(steps, n.toLowerCase()));
  });
}

// node and the runtimes that run a script or code given as an argument the same way.
export const NODE_RE = /^(node|nodejs|bun|deno)(\.exe)?$/i;
const NODE_NAMES = ["node", "nodejs", "bun", "deno", "node.exe", "nodejs.exe", "bun.exe", "deno.exe"];

/**
 * True when word `w` names node, nodejs, bun or deno, or is a glob that could expand to one (#378): `n*de`, `no?e` or
 * `[n]ode` runs node once a file of that name matches, so both guards read it as node. Shared by approve-guard.mjs
 * and start-guard.mjs.
 */
export const mayBeNode = (w) => NODE_RE.test(basename(w)) || mayExpandTo(w, NODE_NAMES);

// `$`, a backtick, or the QUOTED_TICK lex's bodies shape puts around an unquoted backtick substitution it walks apart.
const LIVE_RE = new RegExp(`[$\`${QUOTED_TICK}]`);
const EVAL_WORDS = new Set(["eval", "source", "."]);
const SHELL_C_RE = /^-[A-Za-z]*c[A-Za-z]*$/;
// A shell's options that take the next word as their value (`-o errexit`, `+O extglob`, `--rcfile x`).
const SHELL_VALUED_RE = /^(?:[-+][oO]|--rcfile|--init-file)$/;
// Programs that hand their -c (or --command) value to a shell as text (#404): su, runuser, script, flock and fish.
const TEXT_C_RE = /^(su|runuser|script|flock|fish)(\.exe)?$/i;
// A -c value glued to its flag (`-c"$X"`, `--command=$X`).
const GLUED_C_RE = /^(?:-[A-Za-z]*c.|--command=)/s;
// sg runs every word after its group as shell text, with or without -c.
const SG_RE = /^sg(\.exe)?$/i;
const POWERSHELL_RE = /^(powershell|pwsh)(\.exe)?$/i;
// Words that put a program right after them (a wrapper, its options or a duration aside): the new text runners above
// count only there, so `grep -rn sg "$DIR"` is no sg run.
const RUNS_NEXT_RE = /^(env|exec|command|builtin|nohup|time|timeout|nice|sudo|doas|setsid|stdbuf|ionice|chrt|taskset|xargs|su|runuser|flock|watch)(\.exe)?$/i;
const KEYWORD_RE = /^(?:if|then|else|elif|do|while|until|time|!|\{)$/;
// `$env:NAME` is PowerShell's environment read (#404): in a word handed to powershell it is PowerShell's, not the
// shell's, the risk of a shell variable named `env` being accepted, as bash sets none.
const powershellLive = (w) => LIVE_RE.test(w.replace(/\$env:/gi, ""));

/** The index of the word after builtin or command and their own options (-p, --) at `at`, or `at` for any other word. */
function pastBuiltin(words, at) {
  while (words[at] === "builtin" || words[at] === "command") {
    at += 1;
    while (words[at] === "--" || /^-p+$/.test(words[at] ?? "")) at += 1;
  }
  return at;
}

/** The index of the script a shell's -c flag at `c` takes: the first word after it that is no option (#404). */
function shellScriptAt(words, c) {
  for (let i = c + 1; i < words.length; i += 1) {
    if (words[i] === "--") return i + 1;
    if (SHELL_VALUED_RE.test(words[i])) i += 1;
    else if (!/^[-+]/.test(words[i])) return i;
  }
  return words.length;
}

/**
 * The indexes of simple command `words` that a shell runs as text: the arguments of eval, source or `.` as the
 * command word (behind builtin or command and their options too, #404); the script a shell's -c takes, with a shell
 * named anywhere earlier and options such as `--`, `-e` or `+x` between (#404); the -c or --command value of su,
 * runuser, script, flock or fish, and every word after sg's group, each where a program stands. PowerShell's own text
 * is not shell text: runtimeTextWords reads it apart.
 */
export function shellTextIndexes(words) {
  const at = new Set();
  let cmd = words.findIndex((w) => !ASSIGN_RE.test(w));
  while (cmd !== -1 && cmd < words.length) {
    const next = KEYWORD_RE.test(words[cmd]) ? cmd + 1 : pastBuiltin(words, cmd);
    if (next === cmd) break;
    cmd = next;
  }
  if (cmd !== -1 && EVAL_WORDS.has(words[cmd])) for (let i = cmd + 1; i < words.length; i += 1) at.add(i);
  // Whether a word that puts a program after it stands before word p, kept as a flag: a slice per word is quadratic
  // in the word count (#468).
  let wrapped = false;
  words.forEach((w, p) => {
    const name = basename(w);
    const program = wrapped || p === cmd;
    wrapped ||= RUNS_NEXT_RE.test(name);
    if (SHELL_RE.test(name)) {
      for (let c = p + 1; c < words.length; c += 1) if (SHELL_C_RE.test(words[c])) at.add(shellScriptAt(words, c));
      return;
    }
    if (!program) return;
    if (TEXT_C_RE.test(name)) {
      for (let c = p + 1; c < words.length; c += 1) {
        if (SHELL_C_RE.test(words[c]) || words[c] === "--command") at.add(c + 1);
        else if (GLUED_C_RE.test(words[c])) at.add(c);
      }
    } else if (SG_RE.test(name)) for (let i = p + 2; i < words.length; i += 1) at.add(i);
    // ssh hands its remote command to the remote shell as text, so one known only at run time could be any command (#477).
    else if (SSH_RE.test(name)) for (let i = sshCommandAt(words, p); i < words.length; i += 1) at.add(i);
  });
  return at;
}

/**
 * The words of simple command `words`, as lex gives them, that are shell text known only at run time (#378): a word
 * shellTextIndexes finds that still holds `$` or a backtick, or any word after powershell or pwsh (where a program
 * stands) that does, bar a `$env:` read (#404). Such text could be any command at all. A `$` or backtick in single
 * quotes is marked by lex, so `bash -c 'echo $HOME'` and `eval 'echo $X'` hold none.
 */
export function runtimeTextWords(words) {
  const at = shellTextIndexes(words);
  const cmd = words.findIndex((w) => !ASSIGN_RE.test(w));
  const ps = words.findIndex((w, p) => POWERSHELL_RE.test(basename(w)) && (p === cmd || words.slice(0, p).some((x) => RUNS_NEXT_RE.test(basename(x)))));
  return words.filter((w, i) => (at.has(i) && LIVE_RE.test(w)) || (ps !== -1 && i > ps && powershellLive(w)));
}

/** True when simple command `words` runs shell text known only at run time (runtimeTextWords), #378. */
export const runsRuntimeText = (words) => runtimeTextWords(words).length > 0;

// A PowerShell method named at run time (#378): `.$m(…)`, `."$m"(…)`, `.${m}(…)`, `.$($n)(…)`, each maybe through
// `.Invoke(…)`; any member named by an expression, `.(…)`, which covers `.($m)` and a format or concatenation such as
// `.('{0}{1}' -f 'Cre','ate')` (#404); a method looked up by a computed key (`.PSObject.Methods[$m]`); WMI's own
// `.InvokeMethod(` and reflection's `.InvokeMember(` (#404); a method held in a variable and invoked (`$f.Invoke(`,
// #404); and ForEach-Object (`%`, `foreach`) given a variable or wildcard member name, or any `-MemberName` (by a prefix)
// given a variable or expression (#404). Each run is bounded ({0,64}, whitespace {0,16}), so repeated `.( $` or `.$(`
// stays linear (security review, #378): a guard that times out fails open. A longer computed name still holds `$`,
// which the create/Win32_Process checks read.
const COMPUTED_METHOD_RE =
  /\.\s{0,16}(?:\(|(?:\$\{[^}]{0,64}\}|\$\([^)]{0,64}\)|\$[\w:]{1,64})\s{0,16}(?:\.\s{0,16}invoke\s{0,16})?\()|\$[\w:]{1,64}\s{0,16}\.\s{0,16}invoke\s{0,16}\(|\bmethods\s{0,16}\[|\binvoke(?:method|member)\s{0,16}\(|(?:\bforeach(?:-object)?|%)\s{1,16}(?:\$|[\w-]{0,64}[*?])|\s-m[a-z]{0,9}\s{0,16}:?\s{0,16}[$(]/i;

// Programs that start another program from their arguments with no `node` or shell `-c` in sight (#308).
const CMD_RE = /^cmd(\.exe)?$/i;
const START_RE = /^start(\.exe)?$/i;
const SCHTASKS_RE = /^schtasks(\.exe)?$/i;
const TASK_CMDLET_RE = /^(new-scheduledtaskaction|register-scheduledtask|set-scheduledtask|register-scheduledjob|set-scheduledjob)$/i;
// cmd's start options; /node, /affinity and /machine take a value. Any other `/word` may be a program's path.
const START_FLAG_RE = /^\/(i|b|min|max|wait|separate|shared|low|normal|high|realtime|abovenormal|belownormal|elevate)$/i;
const START_VALUED_FLAG_RE = /^\/(d|node|affinity|machine)$/i;
// cmd's /c or /k (Git Bash's //c too), with any command glued to it; and cmd's call.
const CMD_RUN_RE = /^\/\/?[ck](.*)$/is;
const CALL_RE = /^call$/i;
// Wrappers that run the command after them, and their options or a duration (timeout 5).
const WRAPPER_RE = /^(env|exec|command|nohup|time|timeout|nice|sudo)(\.exe)?$/i;
// A PowerShell parameter name (`-Execute`, `-TaskName:`): anything else is a value.
const PS_PARAMETER_RE = /^-[A-Za-z][A-Za-z0-9]*:?$/;
// What cmd expands at run time (%X%, !X!): unresolved in the text handed on.
const CMD_VAR = "${LANES_CMD_VAR}";

/** The index of a simple command's program, past assignments and wrappers (env, timeout 5, nohup, …). */
function launcherAt(words) {
  let wrapped = false;
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i];
    if (ASSIGN_RE.test(w)) continue;
    if (WRAPPER_RE.test(basename(w))) wrapped = true;
    else if (!(wrapped && (w.startsWith("-") || /^[0-9.]+[smhd]?$/.test(w)))) return i;
  }
  return words.length;
}

/**
 * The command lines a simple command's words start through a launcher that names no program with node or a shell
 * (#308), for both guards to read as commands of their own: what `cmd /c` or `/k` runs (glued `/cx` and Git Bash's
 * `//c` too, with %X% and !X! unresolved) and what cmd's `call` runs; the program cmd's or Git Bash's `start` opens by
 * its file association, with its options dropped wherever they stand, from the first word left and, as that word may
 * be a window title, from the second too; schtasks' `/tr` value; and the values given to
 * New-ScheduledTaskAction, Register-ScheduledTask, Set-ScheduledTask or the ScheduledJob pair (-FilePath, -ScriptBlock),
 * joined and each alone, since any of them could
 * be the program. Empty for any other command.
 * @param {string[]} words
 * @returns {string[]}
 */
export function launchedCommands(words) {
  const at = launcherAt(words);
  if (at >= words.length) return [];
  const name = basename(words[at]);
  const args = words.slice(at + 1);
  if (CMD_RE.test(name)) {
    // `/c`, `/K`, Git Bash's `//c`, and cmd's `/cprogram` with the command glued on (security review round 1).
    const c = args.findIndex((w) => CMD_RUN_RE.test(w));
    if (c === -1) return [];
    const glued = CMD_RUN_RE.exec(args[c])[1];
    return [[...(glued ? [glued] : []), ...args.slice(c + 1)].join(" ").replace(/%[^%\s]*%|![^!\s]*!/g, CMD_VAR)];
  }
  // cmd's call runs the rest as a command.
  if (CALL_RE.test(name)) return [args.join(" ")];
  if (START_RE.test(name)) {
    // Options may come before or after a title (`start "t" /b x`), so every one is dropped wherever it stands.
    const rest = [];
    for (let i = 0; i < args.length; i += 1) {
      const w = args[i].replace(/^\/\//, "/");
      if (START_VALUED_FLAG_RE.test(w)) i += 1;
      else if (!START_FLAG_RE.test(w)) rest.push(args[i]);
    }
    return [rest.join(" "), rest.slice(1).join(" ")];
  }
  if (SCHTASKS_RE.test(name)) {
    const t = args.findIndex((w) => /^[-/]tr$/i.test(w));
    return t === -1 ? [] : [args[t + 1] ?? ""];
  }
  if (TASK_CMDLET_RE.test(name)) {
    const values = args.filter((w) => !PS_PARAMETER_RE.test(w));
    return [values.join(" "), ...values];
  }
  return [];
}

// --- Release tags (ADR 0017 decision 3, #404) -----------------------------------------------------------------------

const GIT_RE = /^git(\.exe)?$/i;
// git's own options that take the next word as their value.
const GIT_VALUED = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env", "--exec-path"]);
// git tag's options that take the next word as their value, and those that list, delete or verify instead of creating.
const TAG_VALUED = new Set(["-m", "-F", "-u", "--message", "--file", "--local-user", "--cleanup", "--format", "--sort", "--contains", "--no-contains", "--merged", "--no-merged", "--points-at", "--column", "--trailer"]);
const TAG_READS_RE = /^(?:-[A-Za-z]*[ldv][A-Za-z]*|-n[0-9]*|--list|--delete|--verify|--contains|--no-contains|--merged|--no-merged|--points-at)(?:=.*)?$/s;
// git push's options that take the next word as their value, and those that push every tag.
const PUSH_VALUED = new Set(["-o", "--push-option", "--repo", "--receive-pack", "--exec"]);
const PUSH_TAGS_RE = /^--(?:tags|follow-tags|mirror)$/;
// A ref that is, or could be, a v* tag: `v1.2.3`, `refs/tags/v1`, or a pattern such as `refs/tags/*` that pushes
// every tag (read on the word with quoted glob characters restored).
const RELEASE_REF_RE = /^\+?(?:refs\/tags\/)?(?:v|[*?[])/i;
// A ref name known only at run time (#424): `$` or a backtick in a refspec's destination, or a braced or command
// substitution anywhere in it, since that may itself hold the `:` that splits source from destination (`${V:-v1}`).
const BRACED_OR_COMMAND_RE = new RegExp(`\\$[({]|[\`${QUOTED_TICK}]`);
const runtimeRef = (w) => BRACED_OR_COMMAND_RE.test(w) || LIVE_RE.test(w.split(":").at(-1));
// A tag's ref as update-ref names it in full (#424).
const TAG_REF_RE = /^refs\/tags\/(?:v|[*?[])/i;
const UPDATE_REF_VALUED = new Set(["-m"]);
// `-c alias.NAME=VALUE` and `--config-env[=]alias.NAME=ENV`: an alias given on the command line (#424).
const ALIAS_RE = /^alias\.([^=]+)=(.*)$/is;
// gh release create (or its alias new) makes the tag on the remote when it does not exist yet (#424); these options of
// its take the next word as their value.
const GH_RE = /^gh(\.exe)?$/i;
const GH_RELEASE_VALUED = new Set(["-t", "--title", "-n", "--notes", "-F", "--notes-file", "--target", "--discussion-category", "--notes-start-tag", "-R", "--repo"]);
// What xargs appends to its command, or puts in place of its replace string: known only at run time.
const XARGS_RE = /^xargs(\.exe)?$/i;
const XARGS_INPUT = "${LANES_XARGS_INPUT}";
const XARGS_VALUED = new Set(["-a", "-d", "-E", "-L", "-n", "-P", "-s", "--arg-file", "--delimiter", "--eof", "--max-lines", "--max-args", "--max-procs", "--max-chars", "--process-slot-var"]);
const SSH_RE = /^ssh(\.exe)?$/i;
const SSH_VALUED = new Set(["-B", "-b", "-c", "-D", "-E", "-e", "-F", "-I", "-i", "-J", "-L", "-l", "-m", "-O", "-o", "-p", "-Q", "-R", "-S", "-W", "-w"]);
// git fetch's options that take the next word as their value.
const FETCH_VALUED = new Set(["--depth", "--deepen", "--shallow-since", "--shallow-exclude", "--upload-pack", "--jobs", "-j", "--filter", "--server-option", "-o", "--refmap", "--negotiation-tip"]);

/** The command words xargs at `words[at]` runs: those after its options, with its input appended or put in place of its replace string (#468). */
function xargsCommand(words, at) {
  let replace = null;
  let i = at + 1;
  for (; i < words.length; i += 1) {
    const w = words[i];
    if (w === "--") {
      i += 1;
      break;
    }
    if (!w.startsWith("-") || w === "-") break;
    if (w === "-I") replace = words[(i += 1)] ?? null;
    else if (w.startsWith("-I")) replace = w.slice(2);
    else if (w === "-i" || w === "--replace") replace = "{}";
    else if (w.startsWith("-i")) replace = w.slice(2);
    else if (w.startsWith("--replace=")) replace = w.slice("--replace=".length);
    else if (XARGS_VALUED.has(w)) i += 1;
  }
  const command = words.slice(i);
  if (command.length === 0) return [];
  // A quoted `{}` is marked literal: the replace string stands in it too (`xargs -I{} sh -c 'git tag {}'`, #477).
  const swap = (w) => (w.includes(replace) ? w.replaceAll(replace, XARGS_INPUT) : unmark(w).replaceAll(replace, XARGS_INPUT));
  return replace ? command.map(swap) : [...command, XARGS_INPUT];
}

/** The remote command words of ssh at `words[at]`: those after its options and its host (#468). */
const sshCommand = (words, at) => words.slice(sshCommandAt(words, at));

/** The index where the remote command of ssh at `words[at]` starts (#468), or past the end when it has none. */
function sshCommandAt(words, at) {
  let i = at + 1;
  for (; i < words.length; i += 1) {
    if (words[i] === "--") {
      i += 1;
      break;
    }
    if (!words[i].startsWith("-")) break;
    if (SSH_VALUED.has(words[i])) i += 1;
  }
  // words[i] is the host; a `--` may stand between it and the command.
  return words[i + 1] === "--" ? i + 2 : i + 1;
}

// A fetch destination git completes to refs/tags/… itself: `tags/v1` (git's get_local_ref adds `refs/` to heads/, tags/ and remotes/).
const FETCH_TAGS_DST_RE = /^tags\/(?:v|[*?[])/i;

/** True when git fetch's arguments `rest` write a v* tag: a `src:dst` refspec whose destination could be one, or `tag NAME` (#468). */
function fetchWritesTag(rest) {
  const args = [];
  const specWritesTag = (w) => w.includes(":") && (RELEASE_REF_RE.test(unmark(w).split(":").at(-1)) || FETCH_TAGS_DST_RE.test(unmark(w).split(":").at(-1)) || runtimeRef(w));
  for (let j = 0; j < rest.length; j += 1) {
    // --stdin reads refspecs known only at run time; --refmap names the refspec that maps what was fetched (#477).
    if (rest[j] === "--stdin") return true;
    const refmap = /^--refmap=(.*)$/s.exec(rest[j])?.[1] ?? (rest[j] === "--refmap" ? rest[j + 1] : undefined);
    if (refmap !== undefined && (specWritesTag(refmap) || LIVE_RE.test(refmap))) return true;
    if (FETCH_VALUED.has(rest[j])) j += 1;
    else if (!rest[j].startsWith("-")) args.push(rest[j]);
  }
  // The first argument is the repository; each one after it is a refspec, or `tag` before a tag's name.
  return args.slice(1).some((w, k, specs) => specWritesTag(w) || (w === "tag" && k + 1 < specs.length));
}

// How many -c aliases deep releaseTagCommand follows before failing closed.
const MAX_ALIAS_DEPTH = 8;

// A boolean value git or gh reads as false (Go's ParseBool), or one known only at run time.
const isFalse = (v) => /^(?:0|f|false)$/i.test(unmark(v)) || LIVE_RE.test(v);

/**
 * True when gh release edit at `words[sub]` publishes a draft (`--draft=false`, or a value known only at run time) or
 * points the release at a v* tag (`--tag v2`, or one known only at run time) (#468). `--draft` alone or `=true` drafts.
 */
function ghReleaseEdit(words, sub) {
  for (let j = sub + 1; j < words.length; j += 1) {
    const w = words[j];
    const draft = /^--draft=(.*)$/s.exec(w)?.[1];
    const tag = /^--tag=(.*)$/s.exec(w)?.[1] ?? (w === "--tag" ? words[j + 1] ?? "" : undefined);
    if (draft !== undefined && isFalse(draft)) return true;
    if (tag !== undefined && (RELEASE_REF_RE.test(unmark(tag)) || LIVE_RE.test(tag))) return true;
    if (GH_RELEASE_VALUED.has(w) || w === "--tag") j += 1;
  }
  return false;
}

/** True when gh release create at `words[at]` names a v* tag, one known only at run time, or none (gh then asks); or gh release edit publishes a draft. */
function ghReleaseTag(words, at) {
  if (words[at + 1] !== "release") return false;
  // release's own -R/--repo may stand before its subcommand (`gh release --repo o/r create v1`, security review).
  let sub = at + 2;
  while (/^(?:-R|--repo)(?:=.*)?$/s.test(words[sub] ?? "") || /^-R./s.test(words[sub] ?? "")) sub += /^(?:-R|--repo)$/.test(words[sub]) ? 2 : 1;
  if (words[sub] === "edit") return ghReleaseEdit(words, sub);
  if (!["create", "new"].includes(words[sub])) return false;
  for (let j = sub + 1; j < words.length; j += 1) {
    if (GH_RELEASE_VALUED.has(words[j])) j += 1;
    else if (!words[j].startsWith("-")) return RELEASE_REF_RE.test(unmark(words[j])) || LIVE_RE.test(words[j]);
  }
  return true;
}

// Config git reads from the environment (#441): GIT_CONFIG_KEY_n names a key (its GIT_CONFIG_VALUE_n and
// GIT_CONFIG_COUNT need no reading), GIT_CONFIG_PARAMETERS holds `'key'='value'` pairs. Names are read in any case, as
// Windows environment names are.
const ENV_KEY_RE = /^GIT_CONFIG_KEY_[^=]*=(.*)$/is;
const ENV_PARAMETERS_RE = /^GIT_CONFIG_PARAMETERS=(.*)$/is;
const TAG_CONFIG_RE = /(?:^|[^A-Za-z0-9_.])(?:alias\.|push\.followtags)/i;

/**
 * True when any word of `words` (an assignment, `export NAME=…` or `env NAME=…` too, whatever the program) sets an
 * environment config key that is `push.followTags` or an `alias.…`: the alias's expansion may be `tag` or `push`, so
 * the setting itself is denied rather than followed, and this covers a setting made in an earlier statement (#441). A key
 * or parameter list known only at run time (`export GIT_CONFIG_KEY_0=$K`) is denied where it is set too, since it may be
 * either, and the command using it may stand behind a launcher or in a later statement (#468).
 */
function envConfigSetsTagPath(words) {
  return words.some((w) => {
    const key = ENV_KEY_RE.exec(w)?.[1];
    if (key !== undefined) return LIVE_RE.test(key) || /^(?:alias\.|push\.followtags$)/i.test(unmark(key));
    const parameters = ENV_PARAMETERS_RE.exec(w)?.[1];
    return parameters !== undefined && (LIVE_RE.test(parameters) || TAG_CONFIG_RE.test(unmark(parameters)));
  });
}

/** True when a GIT_CONFIG_KEY_n before the program is known only at run time: the key may be any alias (#441). */
const envConfigKeyUnknown = (before) => {
  const e = before.findIndex((w) => ENV_RE.test(basename(w)));
  // An operand of env built by a run-time expansion (`env $(echo GIT_CONFIG_KEY_0=alias.x) git push`) may be that assignment (#477).
  return before.some((w) => LIVE_RE.test(ENV_KEY_RE.exec(w)?.[1] ?? "")) || (e !== -1 && before.slice(e + 1).some((w) => !w.startsWith("-") && LIVE_RE.test(w) && !ASSIGN_RE.test(w)));
};

// gh api's options that take the next word as their value, and those that put fields in the request body.
const GH_API_VALUED = new Set(["-X", "--method", "-f", "--raw-field", "-F", "--field", "-H", "--header", "-q", "--jq", "-t", "--template", "--input", "--hostname", "--cache", "-p", "--preview"]);
const GH_API_BODY_RE = /^(?:-f|-F|--raw-field|--field|--input)(?:=|$)|^-[fF]./s;

/**
 * True when `gh api` at `words[at]` writes a v* tag ref (#441): a POST or PATCH (or a request with body fields, which
 * gh sends as POST) to a `git/refs` endpoint naming `refs/tags/v…` in its ref field or its path, or a ref known only at
 * run time, or a body read from --input; or to `releases` with a tag_name that is v*, or known only at run time (a release
 * creates its tag). A DELETE or GET writes no tag.
 */
function ghApiTag(words, at) {
  if (words[at + 1] !== "api") return false;
  const args = words.slice(at + 2);
  let method;
  let endpoint;
  for (let j = 0; j < args.length; j += 1) {
    const w = args[j];
    const glued = /^--method=(.*)$/s.exec(w)?.[1] ?? /^-X(.+)$/s.exec(w)?.[1];
    if (glued !== undefined) method = unmark(glued).toUpperCase();
    else if (w === "-X" || w === "--method") method = unmark(args[++j] ?? "").toUpperCase();
    else if (GH_API_VALUED.has(w)) j += 1;
    else if (!w.startsWith("-") && endpoint === undefined) endpoint = w;
  }
  if (endpoint === undefined) return false;
  const writes = method === undefined ? args.some((w) => GH_API_BODY_RE.test(w)) : !["GET", "DELETE", "HEAD"].includes(method);
  if (!writes) return false;
  // A query string does not change the endpoint (`git/refs?x=1`).
  const path = unmark(endpoint).split("?")[0];
  if (/(?:^|\/)git\/refs\/tags\/(?:v|[*?[])/i.test(path) || (/(?:^|\/)git\/refs\/tags\//i.test(path) && LIVE_RE.test(endpoint))) return true;
  const refs = /(?:^|\/)git\/refs\/?$/i.test(path);
  const releases = /(?:^|\/)releases\/?$/i.test(path);
  // A release updated by id: PATCH publishes a draft (`draft=false`) or points it at another tag (#468).
  const release = /(?:^|\/)releases\/[^/]+$/i.test(path);
  if (!refs && !releases && !release) return runtimeEndpoint(endpoint);
  if (args.some((w) => /^(?:--input)(?:=|$)/.test(w))) return true;
  const fields = refs ? ["ref"] : release ? ["tag_name", "draft"] : ["tag_name"];
  for (const w of args) {
    for (const field of fields) {
      const value = new RegExp(`(?:^|[^A-Za-z0-9_])${field}=(.*)$`, "s").exec(w)?.[1] ?? new RegExp(`^-[fF]${field}=(.*)$`, "s").exec(w)?.[1];
      if (value === undefined) continue;
      if (field === "draft") {
        // `-F draft=@f` reads the value from a file.
        if (isFalse(value) || value.startsWith("@")) return true;
        continue;
      }
      if (refs ? TAG_REF_RE.test(unmark(value)) : /^v/i.test(unmark(value))) return true;
      // A value read from a file (`-F ref=@f`) is known only when gh runs.
      if (LIVE_RE.test(value) || BRACED_OR_COMMAND_RE.test(value) || value.startsWith("@")) return true;
    }
  }
  return false;
}

// Path segments after which a run-time id is an issue, a pull request or the like, never a ref or a release.
const API_ID_PARENTS = new Set(["issues", "pulls", "comments", "labels", "milestones", "runs", "jobs", "reviews", "check-runs", "statuses", "commits", "actions", "artifacts"]);

/**
 * True when a writing gh api endpoint is known only at run time (#468): it starts with an expansion (`$EP`,
 * `"$BASE/git/refs"`), or its last segment is one and follows no segment that names an id's collection, so it may be
 * `git/refs` or a release. `repos/o/r/issues/$N/comments` ends in a static segment and is read as written.
 */
function runtimeEndpoint(endpoint) {
  const segments = endpoint.split("?")[0].split("/");
  if (!LIVE_RE.test(segments.join("/"))) return false;
  return LIVE_RE.test(segments[0]) || (LIVE_RE.test(segments.at(-1)) && !API_ID_PARENTS.has(segments.at(-2)?.toLowerCase() ?? ""));
}

/**
 * True when simple command `words` creates or pushes a `v*` tag (ADR 0017 decision 3): git, as the program behind any
 * wrappers, running `tag` with a name starting with v and no list, delete or verify option, or `push` with --tags,
 * --follow-tags or --mirror, `-c push.followTags=…`, or a refspec whose destination is a v* ref (`v1.2.3`,
 * `refs/tags/v1`, `HEAD:refs/tags/v1`, `tag v1`). A branch starting with v counts too: git alone knows which it is.
 * Since #424 also: a tag name or refspec destination known only at run time (`"$V"`, `$(cat VERSION)`, `${V:-v1}`);
 * with --repo given, every positional word as a refspec; `update-ref` of a `refs/tags/v*` ref (or one named at run
 * time, or `--stdin`); a `-c alias.NAME=…` alias used as the subcommand, read as what it expands to (one that runs a
 * shell with `!`, or whose value is known only at run time or through --config-env, fails closed); and gh release
 * create (or new) naming a v* tag, one known only at run time, or none. Since #441 also: the same `push.followTags` and
 * `alias.NAME` config given as GIT_CONFIG_COUNT, GIT_CONFIG_KEY_n and GIT_CONFIG_VALUE_n; `symbolic-ref` of a
 * `refs/tags/v*` ref; `fast-import`; and `gh api` writing a `git/refs` ref (or a release's tag_name) that is a v* tag or
 * known only at run time. Aliases from git config files are outside the rule (ADR 0017). Both guards deny it from any
 * session; the owner tags from their own terminal.
 */
export function releaseTagCommand(words) {
  return releaseTagAt(words, 0);
}

const ENV_RE = /^env(\.exe)?$/i;

/**
 * `words` with env's -S / --split-string text split into the words it stands for (#477): `env -S 'A=b git push'` runs
 * git with A set. Repeated while a split text holds another, to a fixed depth.
 */
function envSplitExpanded(words) {
  for (let round = 0; round < MAX_ALIAS_DEPTH; round += 1) {
    const e = words.findIndex((w) => ENV_RE.test(basename(w)));
    if (e === -1) return words;
    let next = null;
    for (let j = e + 1; j < words.length && next === null; j += 1) {
      const w = words[j];
      const glued = /^--split-string=(.*)$/s.exec(w)?.[1] ?? /^-S(.+)$/s.exec(w)?.[1];
      const text = glued ?? (w === "-S" || w === "--split-string" ? words[j + 1] : undefined);
      if (text !== undefined) {
        try {
          next = [...words.slice(0, j), ...lex(unmark(text)).flat(), ...words.slice(j + (glued !== undefined ? 1 : 2))];
        } catch {
          return words;
        }
      } else if (!w.startsWith("-") && !ASSIGN_RE.test(w)) break;
    }
    if (next === null) return words;
    words = next;
  }
  return words;
}

/** True when shell text `text` holds a v* tag command: read as written, and with each `$(…)` as one word of its statement (#477). */
function shellTextTags(text, depth) {
  for (const collapse of [false, true]) {
    let segments;
    try {
      segments = lex(text, { collapse });
    } catch {
      return false;
    }
    if (segments.some((s) => releaseTagAt(s, depth))) return true;
  }
  return false;
}

/** releaseTagCommand, `depth` -c aliases deep. */
function releaseTagAt(words, depth) {
  words = envSplitExpanded(words);
  if (depth === 0 && envConfigSetsTagPath(words)) return true;
  let at = launcherAt(words);
  // An operand of env known only at run time may be an assignment (#477): the program is the word after it.
  while (at < words.length - 1 && LIVE_RE.test(words[at]) && words.slice(0, at).some((w) => ENV_RE.test(basename(w)))) at += 1;
  if (at >= words.length) return false;
  if (GH_RE.test(basename(words[at]))) return ghReleaseTag(words, at) || ghApiTag(words, at);
  // A shell's -c text is read as commands of their own (#477): behind xargs -I the replace string has become run-time input.
  if (SHELL_RE.test(basename(words[at]))) {
    const c = words.findIndex((w, j) => j > at && /^-[A-Za-z]*c[A-Za-z]*$/.test(w));
    return c !== -1 && c + 1 < words.length && (depth >= MAX_ALIAS_DEPTH || shellTextTags(unmark(words[c + 1]), depth + 1));
  }
  // A launcher hands its command words on (#468): xargs, with its input as a run-time argument, and ssh, to the remote shell.
  // Each launcher is a level, capped like the alias chain: a chain of thousands fails closed instead of costing time.
  if (XARGS_RE.test(basename(words[at]))) return depth >= MAX_ALIAS_DEPTH || releaseTagAt([...words.slice(0, at), ...xargsCommand(words, at)], depth + 1);
  if (SSH_RE.test(basename(words[at]))) return depth >= MAX_ALIAS_DEPTH || releaseTagAt(sshCommand(words, at), depth + 1);
  if (!GIT_RE.test(basename(words[at]))) return false;
  let i = at + 1;
  let followTags = false;
  // A GIT_CONFIG_KEY_n known only at run time: any command that is not a built-in might be its alias.
  const unknownKey = envConfigKeyUnknown(words.slice(0, at));
  const aliases = new Map();
  for (; i < words.length && words[i].startsWith("-"); i += 1) {
    const env = /^--config-env=(.*)$/s.exec(words[i])?.[1] ?? (words[i] === "--config-env" ? words[i + 1] : undefined);
    if (/^push\.followtags/i.test((words[i] === "-c" ? words[i + 1] : env) ?? "")) followTags = true;
    const alias = ALIAS_RE.exec((words[i] === "-c" ? words[i + 1] : env) ?? "");
    // A --config-env alias takes its value from the environment: nothing of it is known here.
    if (alias) aliases.set(alias[1].toLowerCase(), env === undefined ? alias[2] : null);
    if (GIT_VALUED.has(words[i])) i += 1;
  }
  const sub = words[i];
  const rest = words.slice(i + 1);
  // git fast-import writes any ref, tags among them, from its input; symbolic-ref makes a ref an alias of another (#441).
  if (sub === "fast-import") return true;
  if (sub === "symbolic-ref") {
    const options = rest.filter((w, k) => w.startsWith("-") && !UPDATE_REF_VALUED.has(rest[k - 1]));
    if (options.some((w) => /^(-d|--delete)$/.test(w))) return false;
    const ref = rest.find((w, k) => !w.startsWith("-") && !UPDATE_REF_VALUED.has(rest[k - 1]));
    return ref !== undefined && (TAG_REF_RE.test(unmark(ref)) || runtimeRef(ref));
  }
  // A subcommand known only at run time (`git $(echo tag) v1`) may be any of the commands read here, or nothing at all
  // (`git $(true) push --tags`): it is read as each in turn with the words after it, so one with no tag or push words
  // (`git $(echo log)`) stays allowed (#511).
  if (sub !== undefined && LIVE_RE.test(sub)) {
    return depth >= MAX_ALIAS_DEPTH || [null, "tag", "push", "update-ref", "fetch"].some((c) => releaseTagAt([...words.slice(0, i), ...(c === null ? [] : [c]), ...rest], depth + 1));
  }
  // An unreadable config key may be an alias for anything but the commands read above.
  if (unknownKey && sub !== undefined && !["tag", "push", "update-ref"].includes(sub)) return true;
  if (unknownKey && sub === "push") return true;
  // git ignores an alias that shadows a built-in command, so `-c alias.tag=log tag v1` still tags.
  if (sub !== undefined && !["tag", "push", "update-ref"].includes(sub) && aliases.has(sub.toLowerCase())) {
    const value = aliases.get(sub.toLowerCase());
    if (value === null || LIVE_RE.test(value) || value.startsWith("!") || depth >= MAX_ALIAS_DEPTH) return true;
    // git keeps its own options, the other aliases among them, for what the alias expands to.
    return releaseTagAt([...words.slice(at, i), ...unmark(value).trim().split(/\s+/), ...rest], depth + 1);
  }
  if (sub === "update-ref") {
    // Options only: a -m value of `-d` deletes nothing (security review).
    const options = rest.filter((w, k) => w.startsWith("-") && !UPDATE_REF_VALUED.has(rest[k - 1]));
    if (options.includes("--stdin")) return true;
    if (options.includes("-d")) return false;
    const ref = rest.find((w, k) => !w.startsWith("-") && !UPDATE_REF_VALUED.has(rest[k - 1]));
    return ref !== undefined && (TAG_REF_RE.test(unmark(ref)) || runtimeRef(ref));
  }
  if (sub === "fetch") return fetchWritesTag(rest);
  const args = [];
  let reads = false;
  let repoGiven = false;
  for (let j = i + 1; j < words.length; j += 1) {
    const w = words[j];
    if (sub === "tag" && TAG_READS_RE.test(w)) reads = true;
    if (sub === "push" && PUSH_TAGS_RE.test(w)) return true;
    if (sub === "push" && (w === "--repo" || w.startsWith("--repo="))) repoGiven = true;
    if ((sub === "tag" && (TAG_VALUED.has(w) || /^-[A-Za-z]*[mFu]$/.test(w))) || (sub === "push" && PUSH_VALUED.has(w))) j += 1;
    else if (!w.startsWith("-")) args.push(w);
  }
  if (sub === "tag") return !reads && args.length > 0 && (RELEASE_REF_RE.test(unmark(args[0])) || LIVE_RE.test(args[0]));
  if (sub !== "push") return false;
  if (followTags) return true;
  // The first argument is the remote, unless --repo named it (#424); each one after it is a refspec, or `tag` before a
  // tag's name.
  return args
    .slice(repoGiven ? 0 : 1)
    .some((w, k, specs) => RELEASE_REF_RE.test(unmark(w).split(":").at(-1)) || runtimeRef(w) || (w === "tag" && k + 1 < specs.length));
}

/**
 * The subcommand bun or deno at `words[at]` takes ahead of its options and script: `run` runs a file, and deno's
 * `eval` runs its code argument as JavaScript, the way node -e does (#308). Null for any other word.
 */
export function scriptSubcommand(words, at) {
  const name = basename(words[at] ?? "");
  if (/^(bun|deno)(\.exe)?$/i.test(name) && words[at + 1] === "run") return "run";
  if (/^deno(\.exe)?$/i.test(name) && words[at + 1] === "eval") return "eval";
  return null;
}

/** `cmd` without its literal `$(cat <<'D' … D)` substitutions, for the raw-text checks: their text is only data. */
export function withoutLiteralSubstitutions(cmd) {
  let out = "";
  for (let i = 0; i < cmd.length; i += 1) {
    const lit = cmd[i] === "$" ? plainLiteralSubstitution(cmd, i) : null;
    if (lit) i = lit.end;
    else out += cmd[i];
  }
  return out;
}

// Text with every quote, backslash and backtick dropped (PowerShell's curly quotes too), for the checks that read raw
// text: a name split by quoting, as in st"art.mjs or --"bg", reads whole (#61, like #62 in approve-guard.mjs). A name
// spelled in `$'…'` escapes reads whole too: the text is followed by a copy with each `$'…'` resolved (#310), so what
// either reading names counts.
const DEQUOTE_RE = new RegExp(`['"\\\\\`${String.fromCharCode(0x2018)}-${String.fromCharCode(0x201e)}${LIT_TICK}${QUOTED_TICK}]`, "g");
export const dequoted = (s) => (s.includes("$'") ? `${s}\n${ansiCResolved(s)}` : s).replace(DEQUOTE_RE, "");

// `Create` as a whole word, however the call spells it (`.Create(`, `% Create`, `-MemberName Create`, `.Create.Invoke(`,
// `ExecMethod_("Create"`, `call create`): "created", "creating" and the like do not count (#477).
const WMI_CREATE_RE = /(?<![a-z0-9])create(?![a-z0-9])/i;

/**
 * True when a call creates a process through WMI or CIM (#316): it names Win32_Process, or runs wmic's `process`, with
 * a `create`. Read on the text with quotes, `+`, whitespace and literal messages dropped, so 'Win32'+'_Process' reads
 * whole. A class named by a wildcard that could match Win32_Process (Win32_Pro*, Win32_[P]rocess) counts too (#308).
 */
export function wmiProcessCreate(text) {
  const plain = dequoted(withoutLiteralSubstitutions(String(text ?? ""))).replace(/\+/g, "");
  const flat = plain.replace(/[\s()]/g, "").toLowerCase();
  // Create, or a WMI/CIM method call whose method name may be built at run time (-MethodName $m, security review round
  // 1; `$o.$m(…)`, `$o.PSObject.Methods[$m]`, `$o.InvokeMethod($m, …)`, #378).
  // "create" counts only as a method or an argument of the call (#477), not inside "created" or "gh issue create".
  // A quote, backslash or backtick glued to it (`create"calc"`) ends the word too, so read the text with them as spaces as well.
  const spaced = withoutLiteralSubstitutions(String(text ?? "")).replace(DEQUOTE_RE, " ").replace(/\+/g, "");
  if (!WMI_CREATE_RE.test(plain) && !WMI_CREATE_RE.test(spaced) &&!/\b(invoke-(cim|wmi)method|icim|iwmi)\b/i.test(plain) && !COMPUTED_METHOD_RE.test(plain)) return false;
  if (/win32_process/.test(flat) || (/wmic/.test(flat) && /process/.test(flat))) return true;
  // Each word, and what follows a `[type]` cast glued to it ([wmiclass]Win32_Proc* once quotes are dropped). A word
  // with no literal character (`*`, `??`) names nothing, so it cannot be the class (#477).
  const words = plain.split(/[^\w.*?[\]]+/).flatMap((t) => [t, ...[...t.matchAll(/\](?=[\w*?])/g)].map((m) => t.slice(m.index + 1))]);
  return words.some((t) => /[*?[]/.test(t) && /[a-z0-9_]/i.test(t.replace(/[*?[\]]/g, "")) && mayExpandTo(t, ["win32_process"]));
}

/** A grant file, parsed: null when it does not exist, { unreadable: true } when it cannot be read or parsed. */
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

const MAX_UNCLOSED = 16;

/** The index of the `)` closing a `$(` whose contents start at `from`, or -1 when it never closes. */
function substitutionEnd(cmd, from) {
  let depth = 1;
  let single = false;
  let double = false;
  for (let i = from; i < cmd.length; i += 1) {
    const c = cmd[i];
    if (c === "\\" && !single) i += 1;
    else if (c === "'" && !double) single = !single;
    else if (c === '"' && !single) double = !double;
    else if (!single && !double && c === "(") depth += 1;
    else if (!single && !double && c === ")" && (depth -= 1) === 0) return i;
  }
  return -1;
}

/**
 * `cmd` with each `$(…)` outside single quotes replaced by `${LANES_SUBSTITUTION}`: a word known only at run time that
 * does not end the statement (#477). One that never closes stays as it is.
 */
function collapsedSubstitutions(cmd) {
  let unclosed = 0;
  let out = "";
  let single = false;
  let double = false;
  for (let i = 0; i < cmd.length; i += 1) {
    const c = cmd[i];
    if (c === "\\" && !single) {
      out += c + (cmd[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (c === "'" && !double) single = !single;
    else if (c === '"' && !single) double = !double;
    else if (c === "$" && cmd[i + 1] === "(" && !single && unclosed < MAX_UNCLOSED) {
      const end = substitutionEnd(cmd, i + 2);
      if (end !== -1) {
        out += "${LANES_SUBSTITUTION}";
        i = end;
        continue;
      }
      // Each search that fails scans to the end: after a few, stop, so a run of openers costs bounded time.
      unclosed += 1;
    }
    out += c;
  }
  return out;
}

/**
 * Shell-ish lexer: words (quotes and backslashes resolved, nothing expanded) grouped into simple commands split on
 * ; & | ( ) newlines and redirections. A redirection's target (and a bare fd number right before it, as in `2>file`)
 * is never a word: bash does not pass it to the program, so it must not shift argument positions such as the
 * reviewer word. Its raw text goes to the segment's `redirects` instead, since a `$(…)` in it still runs and a
 * herestring (`bash <<< "…"`) is a script. A heredoc's body is not lexed as commands on the outer line (#100): it goes
 * to its segment's `heredocs`, and a literal `$(cat <<'EOF' … EOF)` reads as its body, with that word's index in the
 * segment's `literal`. A segment whose output a `|` or `|&` feeds into the next one has `pipedOut` set
 * (`(echo …) | sh` marks the echo). A quoted or escaped `$`, backtick, brace, comma or glob character is marked
 * literal (see LITERAL). Throws on an unterminated quote. That is approve-guard.mjs's shape.
 *
 * With `{ bodies: true }` it returns start-guard.mjs's shape, `{ segments, writes, stdin, pipes, targets, bodies }`,
 * where a quoted or escaped `$` or backtick alone is marked (LIT_DOLLAR, LIT_TICK) and a literal substitution needs a
 * plain delimiter (plainLiteralSubstitution). A heredoc's body is not lexed as commands: it is returned in `bodies`,
 * for the caller to read as a quoted script, as is an arithmetic expansion's expression (its word reads as `0`), as is
 * a backtick substitution's command (#197). A body is `literal` when the shell expands nothing in it. A redirection
 * target (and a fd number right before its operator, as in `2>file`) is lexed as a word, but no word of its command:
 * it is returned in `targets`, for the caller to scan for a substitution (#191). A here-string (`<<<`) stays a word.
 * `writes[k]` is true when segment k redirects output (`>`), "dup" once it duplicates an fd (`2>&1`); `stdin[k]` is
 * its `<` target; `pipes[k]` is true when its output is piped (`|` or `|&`, not `||`) into the next, and a heredoc
 * body is `toShell` when a shell reads it: its own command, or one down its pipeline (#246). Throws on an unterminated
 * quote or backtick.
 * @returns {(string[] & { pipedOut?: true, redirects?: { text: string, herestring: boolean, toFile: boolean }[], heredocs?: { body: string, quoted: boolean }[], literal?: Set<number> })[]}
 */
export function lex(cmd, { bodies: withBodies = false, collapse = false } = {}) {
  // `collapse` (#477): each unquoted `$(…)` reads as one word of its statement, so the words around it stay together
  // for the tag rules; what the substitution runs is read from the lexing without it.
  if (collapse) cmd = collapsedSubstitutions(cmd);
  // A raw stand-in character would read as a marked one: refuse to parse it, so a command naming post-review fails
  // closed. start-guard.mjs's shape never refused one.
  if (!withBodies && /[-]/.test(cmd)) throw new Error("private-use character");
  // How a quoted or escaped character is marked literal, and which `$(cat <<D … D)` reads as its body, per shape.
  const quote = withBodies ? literal : mark;
  const literalSub = withBodies ? plainLiteralSubstitution : literalSubstitution;
  const segments = [[]];
  const pending = [];
  let word = null;
  let wordLiteral = false;
  // Words shape: parenthesis depth, and the depths at which a process substitution opened: its segments are `inProcSub`.
  let parens = 0;
  const procSubs = [];
  let procSubNext = false;
  // Bodies shape: per segment, whether it writes (true, or "dup" once it duplicates an fd), whether its output is
  // piped into the next, and the target of its input redirection (`<`), which node reads as its script when no
  // argument is one; the redirection targets and bodies of the whole command; and whether the next word is a
  // redirection target: false, "stdin" or "other".
  const writes = [false];
  const pipes = [false];
  const stdin = [undefined];
  const targets = [];
  const bodies = [];
  let target = false;
  const markProcSub = () => {
    if (procSubs.length > 0) segments.at(-1).inProcSub = true;
    else delete segments.at(-1).inProcSub;
  };
  // A `case` statement's patterns are no commands (#404): `case x in *) …;; *) …;; esac` would otherwise read each
  // `*` as a program word. `cases` counts the open `case … in`s; `inPattern` is true from `in` or `;;` (`;&`, `;;&`)
  // up to the pattern's `)`, whose words are then dropped. `esac` there ends the statement instead. Only an `in`
  // ended by whitespace opens a pattern: `in;` is a word followed by a new command. `at` is the index being read.
  let cases = 0;
  let inPattern = false;
  let at = 0;
  const endWord = () => {
    if (word !== null && target) {
      targets.push(word);
      if (target === "stdin") stdin[stdin.length - 1] = word;
      target = false;
    } else if (word !== null) {
      const seg = segments.at(-1);
      if (wordLiteral) (seg.literal ??= new Set()).add(seg.length);
      seg.push(word);
      if (cases > 0 && word === "esac" && seg.slice(0, -1).every((w) => KEYWORD_RE.test(w))) {
        inPattern = false;
        cases -= 1;
      } else if (!inPattern && word === "in" && /\s/.test(cmd[at] ?? "") && seg.length >= 3 && seg.at(-3) === "case" && seg.slice(0, -3).every((w) => KEYWORD_RE.test(w))) {
        cases += 1;
        inPattern = true;
        word = null;
        wordLiteral = false;
        endSegment();
      }
    }
    word = null;
    wordLiteral = false;
  };
  // In a pattern: `)` ends it and drops its words, unless a backtick substitution is in them (read as before, so what
  // it runs is still seen); `|` separates alternatives; a leading `(` or line break is optional syntax. Any other
  // operator (`$(`, `;`, `&`, a redirection, a line break after a word) leaves pattern reading, so the rest is read as
  // before: `"case" x in; node …)` is a command named case and then node, which bash runs. Returns the index to go on
  // from, or null.
  const patternOperator = (i) => {
    const c = cmd[i];
    const empty = word === null && segments.at(-1).length === 0;
    if ((c === "\n" || c === "\r") && empty) return i;
    if (";&<>\n\r".includes(c)) {
      inPattern = false;
      return null;
    }
    if (c === ")") {
      endWord();
      const seg = segments.at(-1);
      inPattern = false;
      if (!seg.some((w) => w.includes("`") || w.includes(QUOTED_TICK))) segments[segments.length - 1] = [];
      if (!withBodies) markProcSub();
      return i;
    }
    if (c === "|") {
      endWord();
      return i;
    }
    if (c === "(" && empty) return i;
    if (c === "(") inPattern = false;
    return null;
  };
  // Every new segment (after ; & | || && newlines and parentheses) takes the process-substitution mark it is under.
  const endSegment = () => {
    endWord();
    target = false;
    if (segments.at(-1).length > 0) {
      segments.push([]);
      writes.push(false);
      pipes.push(false);
      stdin.push(undefined);
    }
    if (!withBodies) markProcSub();
  };
  const markPiped = () => {
    endWord();
    const last = segments.at(-1).length > 0 ? segments.at(-1) : segments.at(-2);
    if (last) last.pipedOut = true;
    endSegment();
  };
  // A backtick substitution at `j` (bodies shape): its command, unescaped as `unescape` says, is a body to walk.
  const backtickBody = (j, unescape) => {
    const close = backtickEnd(cmd, j);
    if (close === -1) throw new Error("unterminated `");
    const inner = cmd.slice(j + 1, close).replace(unescape, "$1");
    bodies.push({ text: inner, literal: false });
    return { inner, close };
  };

  // Words shape (approve-guard.mjs): `|`, `||`, `;`, `&`, parentheses and newlines split commands; `<` and `>` start a
  // redirection whose target is skipped as raw text into the segment's `redirects`, or a heredoc. Returns the index
  // to go on from, or null when `i` holds no operator.
  const wordsOperator = (i) => {
    const c = cmd[i];
    if (c === "|" && cmd[i + 1] === "|") {
      endSegment();
      return i + 1;
    }
    if (c === "|") {
      markPiped();
      return cmd[i + 1] === "&" ? i + 1 : i;
    }
    if (";&()\n\r".includes(c)) {
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
      return i;
    }
    if (c !== "<" && c !== ">") return null;
    // A bare fd number immediately before `<`/`>` (as in `2>file`) is part of the operator, not a word.
    if (word !== null && /^[0-9]+$/.test(word)) word = null;
    else endWord();
    const doc = c === "<" && cmd[i + 1] === "<" && cmd[i + 2] !== "<" ? HEREDOC_RE.exec(cmd.slice(i)) : null;
    if (doc) {
      pending.push({ segment: segments.at(-1), ...heredocOperator(doc) });
      return i + doc[0].length - 1;
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
    return end - 1;
  };

  // Bodies shape (start-guard.mjs): a here-string's word stays a word; a redirection operator (REDIRECT_RE) makes the
  // next word its target; `;`, `&`, `|`, parentheses and newlines split commands; `<<` opens a heredoc. Returns the
  // index to go on from, or null when `i` holds no operator.
  const bodiesOperator = (i) => {
    const c = cmd[i];
    if (c === "<" && cmd.startsWith("<<<", i)) {
      // A here-string: its word is the command's input, read as a script like any quoted word.
      endWord();
      return i + 2;
    }
    if (REDIRECT_RE.test(cmd.slice(i, i + 3)) && !cmd.startsWith("<<", i)) {
      // A bare fd number right before the operator (`2>file`) belongs to it (#191).
      if (c !== "&" && word !== null && /^[0-9]+$/.test(word)) word = null;
      endWord();
      const op = REDIRECT_RE.exec(cmd.slice(i, i + 3))[0];
      // An fd duplication (`2>&1`) keeps its command from reading as data-only, as when `&` still split it off.
      if (/[<>]&/.test(op)) writes[writes.length - 1] = "dup";
      else if (op.includes(">") && writes.at(-1) !== "dup") writes[writes.length - 1] = true;
      target = op === "<" || op === "<>" ? "stdin" : "other";
      return i + op.length - 1;
    }
    if (";&|()\n\r".includes(c)) {
      if (c === "|" && cmd[i - 1] !== "|" && cmd[i + 1] !== "|" && segments.at(-1).length > 0) pipes[pipes.length - 1] = true;
      endSegment();
      return i;
    }
    if (c === "<" && cmd[i - 1] !== "<" && cmd[i + 1] === "<" && cmd[i + 2] !== "<" && HEREDOC_RE.test(cmd.slice(i))) {
      const m = HEREDOC_RE.exec(cmd.slice(i));
      endWord();
      // `toShell`: a shell reads the body as its script (`bash <<'EOF'`), so even a quoted body's backticks run.
      const program = segments.at(-1).find((w) => !ASSIGN_RE.test(w));
      pending.push({ ...heredocOperator(m), toShell: program !== undefined && SHELL_RE.test(basename(program)), seg: segments.length - 1 });
      return i + m[0].length - 1;
    }
    return null;
  };

  for (let i = 0; i < cmd.length; i += 1) {
    const c = cmd[i];
    at = i;
    if (c === "'") {
      const end = cmd.indexOf("'", i + 1);
      if (end === -1) throw new Error("unterminated '");
      word = (word ?? "") + quote(cmd.slice(i + 1, end));
      i = end;
    } else if (c === '"') {
      let j = i + 1;
      let s = "";
      for (; j < cmd.length && cmd[j] !== '"'; j += 1) {
        const lit = cmd[j] === "$" ? literalSub(cmd, j) : null;
        if (lit) {
          s += quote(lit.body);
          if (!withBodies) wordLiteral = true;
          j = lit.end;
          continue;
        }
        if (withBodies) {
          const arith = cmd[j] === "$" ? arithmetic(cmd, j) : null;
          if (arith) {
            bodies.push({ text: arithmeticScript(arith.expr), literal: false });
            s += "0";
            j = arith.end;
            continue;
          }
          if (cmd[j] === "`") {
            // A live backtick substitution runs even with no whitespace to make the word a nested script, as in
            // "`scripts/lanes/queue.mjs`" (#113 test-hunter): its command is a body to walk; the word keeps its text.
            const { close } = backtickBody(j, /\\([`$\\"])/g);
            s += cmd.slice(j, close + 1);
            j = close;
            continue;
          }
        } else {
          // Inside double quotes only `$` (with a `${…}` reference's braces) and a backtick stay live, and only when
          // no backslash escapes them.
          const ref = cmd[j] === "$" && cmd[j + 1] === "{" ? cmd.indexOf("}", j) : -1;
          if (ref !== -1 && !cmd.slice(j, ref).includes('"')) {
            s += cmd.slice(j, ref + 1);
            j = ref;
            continue;
          }
        }
        // A backslash-newline inside double quotes joins the lines, as bare (#310): `"post-revi\<newline>ew.mjs"`.
        if (cmd[j] === "\\" && cmd[j + 1] === "\n") {
          j += 1;
          continue;
        }
        const escaped = cmd[j] === "\\" && '"\\$`'.includes(cmd[j + 1] ?? "");
        if (escaped) j += 1;
        // A `$` bash reads as a plain character (`"a$\|b"`, `"x |y$"`) is marked like a quoted one (#310).
        s += escaped || !"$`".includes(cmd[j]) || (cmd[j] === "$" && literalDollar(cmd, j, true)) ? quote(cmd[j]) : cmd[j];
      }
      if (j >= cmd.length) throw new Error('unterminated "');
      word = (word ?? "") + s;
      i = j;
    } else if (c === "$" && cmd[i + 1] === "'") {
      // ANSI-C quoting (#310): one literal string with its escapes resolved.
      const ansi = ansiCString(cmd, i);
      word = (word ?? "") + quote(ansi.text);
      i = ansi.end;
    } else if (c === "$" && literalDollar(cmd, i, false)) {
      // A bare `$` bash reads as a plain character (`a$ b`, `a$\|b`), as in double quotes (#310).
      word = (word ?? "") + quote(c);
    } else if (c === "$" && literalSub(cmd, i)) {
      const lit = literalSub(cmd, i);
      word = (word ?? "") + quote(lit.body);
      if (!withBodies) wordLiteral = true;
      i = lit.end;
    } else if (withBodies && c === "$" && arithmetic(cmd, i)) {
      const arith = arithmetic(cmd, i);
      bodies.push({ text: arithmeticScript(arith.expr), literal: false });
      word = (word ?? "") + "0";
      i = arith.end;
    } else if (withBodies && c === "`") {
      // A backtick substitution is one word, whitespace and all (#197). Its command runs, so it is returned as a body
      // to walk; the word holds it between QUOTED_TICKs (so it still reads as unresolved) with no shell syntax, so
      // the caller does not read the same text again as a nested script.
      const { inner, close } = backtickBody(i, /\\([`$\\])/g);
      word = (word ?? "") + QUOTED_TICK + inner.replace(/[\s;&|()<>]/g, "_") + QUOTED_TICK;
      i = close;
    } else if (c === "\\") {
      if (cmd[i + 1] !== "\n") word = (word ?? "") + quote(cmd[i + 1] ?? "");
      i += 1;
    } else if (c === "\n" && pending.length > 0) {
      // The heredocs opened on this line: their bodies follow it, each up to its delimiter line.
      endSegment();
      let end = i;
      for (const h of pending.splice(0)) {
        const r = readHeredoc(cmd, end + 1, h.delim, h.stripTabs);
        if (withBodies) bodies.push({ text: r.body, literal: h.quoted || !EXPANDS_RE.test(r.body), toShell: h.toShell, seg: h.seg, start: end + 1, end: r.end });
        else (h.segment.heredocs ??= []).push({ body: r.body, quoted: h.quoted });
        end = r.end;
      }
      i = end;
    } else {
      let next = inPattern ? patternOperator(i) : null;
      // `;;`, `;&` or `;;&` inside a case: the next clause's pattern follows.
      if (next === null && cases > 0 && !inPattern && c === ";" && (cmd[i + 1] === ";" || cmd[i + 1] === "&")) {
        endSegment();
        inPattern = true;
        next = cmd.startsWith(";;&", i) ? i + 2 : i + 1;
      }
      if (next === null) next = withBodies ? bodiesOperator(i) : wordsOperator(i);
      if (next !== null) i = next;
      // A `<<` that HEREDOC_RE does not read ends the word (bodies shape; the words shape reads every `<` above).
      else if (c === "<" || /\s/.test(c)) endWord();
      else word = (word ?? "") + c;
    }
  }
  endSegment();
  if (!withBodies) return segments.filter((s) => s.length > 0 || s.redirects || s.heredocs);
  // A pipeline can go on after the heredoc's body (`cat <<'EOF' |` then the body, then `sh`), so this waits for the end.
  for (const b of bodies) if (b.seg !== undefined && feedsShell(segments, pipes, b.seg)) b.toShell = true;
  // Only the last segment can be empty, so `writes` stays aligned with the segments kept.
  const kept = segments.filter((s) => s.length > 0);
  return { segments: kept, writes: writes.slice(0, kept.length), stdin: stdin.slice(0, kept.length), pipes: pipes.slice(0, kept.length), targets, bodies };
}

// --- Hook inputs and output (moved from the retired approve-guard.mjs, #616) -----------------------------------------
// How the harness opens an input the owner did not type: a subagent or background task finishing, or a message or
// idle notice from another session. It arrives as a prompt of its own. Shared with start-guard.mjs (#262).
export const AUTOMATED_INPUT_PREFIXES = Object.freeze([
  "<task-notification>",
  "Another Claude session sent a message:",
  "<cross-session-message",
  "[Cross-session idle notice]",
  "[SYSTEM NOTIFICATION - NOT USER INPUT]",
]);

// A completion notice the harness wraps in a system-reminder block (#492): the block opens the prompt and holds the task notice.
const REMINDER_OPEN = "<system-reminder>";
const TASK_NOTICE_TAG = "<task-notification>";

const REMINDER_CLOSE = "</system-reminder>";
const AGENT_MESSAGE_OPEN = "<agent-message";
const AGENT_MESSAGE_CLOSE = "</agent-message>";
const TYPED_COMMAND_LINE_RE = /^[ \t]*\/(?:approve|start)\b/m;

/** The prompt without its leading `<system-reminder>` blocks and the blank space around them (an unclosed block stays). */
export function withoutLeadingReminders(prompt) {
  if (typeof prompt !== "string") return prompt;
  let p = prompt.trimStart();
  while (p.startsWith(REMINDER_OPEN)) {
    const end = p.indexOf(REMINDER_CLOSE);
    if (end === -1) break;
    p = p.slice(end + REMINDER_CLOSE.length).trimStart();
  }
  return p;
}

/**
 * `text` with every closed `open … close` block replaced by a newline, and whether there was one. A block is the same
 * match as `open[^>]*>[\s\S]*?close` (`tagged`) or `open[\s\S]*?close`, found with indexOf so that the scan stays
 * linear whatever the input: once one opener has no closer, no later opener has one either, so the scan stops (#548).
 */
function replaceBlocks(text, open, close, tagged) {
  let out = "";
  let from = 0;
  let found = false;
  for (let at = text.indexOf(open); at !== -1; at = text.indexOf(open, from)) {
    let bodyAt = at + open.length;
    if (tagged) {
      // `\b` after the tag name: `<agent-messages>` is another tag.
      if (/\w/.test(text[bodyAt] ?? "")) {
        out += text.slice(from, bodyAt);
        from = bodyAt;
        continue;
      }
      const gt = text.indexOf(">", bodyAt);
      if (gt === -1) break;
      bodyAt = gt + 1;
    }
    const end = text.indexOf(close, bodyAt);
    if (end === -1) break;
    out += `${text.slice(from, at)}\n`;
    from = end + close.length;
    found = true;
  }
  return { found, text: out + text.slice(from) };
}

/**
 * True for a prompt that starts, after any leading `<system-reminder>` blocks and blank lines, with one of
 * AUTOMATED_INPUT_PREFIXES (exact case); for a `<system-reminder>` block that holds a `<task-notification>` (#492); and
 * for a prompt holding a closed `<agent-message ...>` hand-back however it is wrapped, unless a `/approve` or `/start`
 * line stands outside the hand-back and reminder blocks (#546).
 */
export function isAutomatedInput(prompt) {
  if (typeof prompt !== "string") return false;
  const p = withoutLeadingReminders(prompt);
  if (AUTOMATED_INPUT_PREFIXES.some((w) => p.startsWith(w))) return true;
  const t = prompt.trimStart();
  if (t.startsWith(REMINDER_OPEN) && t.includes(TASK_NOTICE_TAG)) return true;
  const messages = replaceBlocks(p, AGENT_MESSAGE_OPEN, AGENT_MESSAGE_CLOSE, true);
  if (!messages.found) return false;
  const outside = replaceBlocks(messages.text, REMINDER_OPEN, REMINDER_CLOSE, false).text;
  return !TYPED_COMMAND_LINE_RE.test(outside);
}

/** The PreToolUse hook output for one decision. */
export const preToolUseOutput = (decision, reason) => JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: reason } });

// --- PowerShell (#61) ------------------------------------------------------------------------------------------------
// The PowerShell tool's command is read with PowerShell's own rules and written out as a Bash command with the same
// words, which both guards then scan with their Bash rules. A literal piece of a word goes out single-quoted, and
// whatever PowerShell expands ($x, ${x}, @x) as `$1`, which no guard resolves, so it reads as unresolved. A group,
// subexpression, array, hashtable or script block is `$1` in its word too, and its statements go out as statements of
// their own after the one holding it, so they are scanned as commands, the way a Bash substitution's are. A statement that starts with a value ($x, a string, a group, a type) is an expression
// PowerShell prints, never a command it runs, so it goes out behind `echo`; `& x` and `. x` run x, so there x stays the
// command word, whatever it is. Anything that cannot be read throws: the guards fail closed on it when it names what
// they look for.

// A powershell/pwsh -EncodedCommand flag (-e, -enc, -ec or any prefix of the full name) and the base64 text it takes.
const isEncodedFlag = (w) => /^[-/]e[a-z]*$/i.test(w) && (w.slice(1).toLowerCase() === "ec" || "encodedcommand".startsWith(w.slice(1).toLowerCase()));
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

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
// A [powershell]::Create() instance's AddCommand or AddScript runs whatever it is given (#308), and so may a static
// Create on a type held in a variable ([type]'powershell' | % { $_::Create() }, security review round 1).
const PS_OPAQUE_RE = /scriptblock|invokescript|invokecommand|add-type|process\]?::start|processstartinfo|diagnostics\.process|activator\]|comobject|alias:|powershell\]::create|\.add(?:command|script)\b|\$\w*::create\b/i;
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
  let joined = false;
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
      // A `+` against a quote ('cla'+'ude') joins strings when PowerShell reads the word as an expression (#308).
      if (c === "+" && (PS_SINGLE + PS_DOUBLE).split("").some((q) => src[i - 1] === q || src[i + 1] === q)) joined = true;
      addLiteral(parts, c);
    }
  }
  if (i === start && parts.length === 0) throw new Error(`unexpected ${src[i]}`);
  const value = parts.map((p) => (p.lit !== undefined ? p.lit : p.glob ? p.raw : PS_VAR)).join("");
  return { parts, end: i, value, literal: parts.every((p) => p.lit !== undefined || p.glob), expression: PS_EXPRESSION_START.includes(src[start]), joined };
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
    // anything piped into it) expands (#61 security review: Start-Process node -ArgumentList $a), or joins strings
    // with `+`, with or without spaces around it, as the parenthesised form does (#308: iex 'cla'+'ude --b'+'g').
    const spliced = (w) => !w.literal || w.joined || w.value === "+";
    if (args.some(spliced) || (runner && stmt.pipedInto && stmt.pipedLive)) extra.push(PS_VAR);
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
      // A +-joined string ('cla'+'ude --bg' | iex) is spliced at run time too (#308).
      pipeLive ||= stmt.items.some((x) => x.word && (!x.word.literal || x.word.joined || x.word.value === "+"));
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
