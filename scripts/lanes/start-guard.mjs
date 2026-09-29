// scripts/lanes/start-guard.mjs — the barrier between a session and launching lanes (#51, from the #18 security review).
// Wired in .claude/settings.json next to approve-guard.mjs, as two hooks:
//   UserPromptSubmit: node scripts/lanes/start-guard.mjs user-prompt-submit
//     a prompt that is exactly `/start <N> [<N> ...]` writes a grant { sessionId, issues, at } to
//     .lanes/start/<session>.json, and one that is exactly `/start --auto` or `/start --auto --go` writes
//     { sessionId, auto: "dry" | "go", at } (#76); any other prompt in that session deletes it, except an automated input
//     (approve-guard's AUTOMATED_INPUT_PREFIXES), which neither creates nor deletes one (#262).
//   PreToolUse (Bash): node scripts/lanes/start-guard.mjs pre-tool-use
//     `start.mjs` is allowed only as the plain `node scripts/lanes/start.mjs <N ...>` or
//     `node scripts/lanes/start.mjs --auto [--go]`, only with a grant from this session under 15 minutes old for the
//     same issue numbers or the same auto form (a dry-run grant never allows --go). The hook leaves the grant in place:
//     start.mjs checks it again and deletes it after its launches (ADR 0007). Every other start.mjs run is denied. A direct
//     `claude --bg` is always denied: start.mjs launches lanes itself (execFileSync, not a Bash tool call), so no
//     session ever needs it. A `queue.mjs` run is always denied too, grant or not: the owner runs it in their own
//     terminal (#95, ADR 0005). Anything else gets no decision. A deny holds in every permission mode.
//     Text a call only writes to a file (cat, echo or printf with `>`, beside cd or mkdir), a `node -e` script that
//     names no lane script, and arithmetic `$((…))` are not read as commands (#89, #102). A redirection target is no
//     word of its command, though a substitution in it is still read (#191); a backtick substitution is read wherever
//     it stands (#197); and the command find -exec or xargs runs is read, with what they hand it unresolved (#113).
//     Text piped into a shell (`cat <<'EOF' | sh`, `echo '…' | bash`) has its backticks read live (#246).
//   PreToolUse (PowerShell) runs the same hook (#61): the command is read with PowerShell's rules (powershellAsBash in
//     approve-guard.mjs) and scanned as the Bash command with the same words, under the same grant rules; one that
//     cannot be read is denied when it names start.mjs, queue.mjs or --bg. Raw-text checks drop quotes first, so a
//     name split by quoting (st"art.mjs, --"bg") still reads whole. A jq program or gh --jq/--template value keeps its
//     `$` literal. A node -e script that names a target still counts as a run (owner decision, 2026-09-28).
//   Either tool (#316): a powershell/pwsh -EncodedCommand value (-e, -enc, -ec, any prefix) is decoded and decided as a
//     PowerShell call of its own, and never allowed; a word ending in claude counts as claude (`CommandLine=claude`,
//     a Windows path whose backslashes a nested script drops); and a WMI/CIM process creation (Win32_Process Create,
//     wmic process call create) whose call holds anything expanded at run time is denied.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isAutomatedInput, powershellAsBash, preToolUseOutput } from "./approve-guard.mjs";
import {
  ASSIGN_RE, LIT_DOLLAR, LIT_TICK, QUOTED_TICK, SHELL_RE, basename, feedsShell, lex, plainLiteralSubstitution, readGrant,
} from "./shell-lex.mjs";

// start.mjs reads the grant with the guard's own reader.
export { readGrant } from "./shell-lex.mjs";

export const GRANT_TTL_MS = 15 * 60 * 1000;
export const DENY_REASON = "lanes are launched only from /start <N> typed by the owner in this session";
export const BG_DENY_REASON = "claude --bg is never run directly; the owner launches lanes with /start <N>";
export const QUEUE_DENY_REASON = "queue.mjs runs only in the owner's own terminal, never from a Claude session, lane or schedule (ADR 0005)";
export const UNRESOLVED_DENY_REASON =
  "this command runs a program named only at run time ($VAR, $(…) or a backtick), which could be start.mjs or queue.mjs: queue.mjs runs only in the owner's own terminal, and lanes are launched only from /start <N> typed by the owner";
export const PARSE_DENY_REASON =
  "this command could not be parsed (an unterminated quote or nesting too deep) and it names start.mjs or --bg, so start-guard denies it; rewrite it, for example a commit message with git commit -F <file>";
export const WMI_DENY_REASON =
  "this WMI/CIM process creation (Win32_Process Create, wmic process call create) builds its command line at run time (a variable, a hashtable or an expression), which could be claude --bg or a lane script, so start-guard denies it; run the program directly";
const SESSION_RE = /^[A-Za-z0-9_-]{1,128}$/;
const START_PROMPT_RE = /^\/start((?:\s+[1-9][0-9]{0,8})+)$/;
// The only form that may be allowed: the plain command with plain issue numbers, nothing chained, wrapped or redirected.
const PLAIN_RE = /^node scripts\/lanes\/start\.mjs((?: [1-9][0-9]{0,8})+)$/;
const AUTO_PROMPT_RE = /^\/start\s+--auto(\s+--go)?$/;
const AUTO_PLAIN_RE = /^node scripts\/lanes\/start\.mjs --auto( --go)?$/;
const AUTO_FORMS = { dry: "--auto", go: "--auto --go" };
const START_WORD_RE = /start\.mjs$/i;
const QUEUE_WORD_RE = /queue\.mjs$/i;
const NODE_RE =/^(node|nodejs|bun|deno)(\.exe)?$/i;
// Matched at a word's end (#316): `CommandLine=claude` in a WMI hashtable, or `C:toolsclaude.exe` once a nested script
// has dropped a Windows path's backslashes. Not after a dot, so a `~/.claude` directory is no claude.
const CLAUDE_RE = /(?<!\.)claude(-code)?(\.exe|\.cmd|\.ps1)?$/i;
const BG_FLAG_RE = /^--(bg|background)(=.*)?$/;
const MAX_DEPTH = 4;


/** The issue numbers of a prompt that is exactly `/start <N> [<N> ...]` (surrounding whitespace ignored), else null. */
export function parseStartPrompt(prompt) {
  if (typeof prompt !== "string") return null;
  const m = START_PROMPT_RE.exec(prompt.trim());
  return m ? m[1].trim().split(/\s+/).map(Number) : null;
}

/** "dry" for a prompt that is exactly `/start --auto`, "go" for exactly `/start --auto --go`, else null. */
export function parseAutoPrompt(prompt) {
  if (typeof prompt !== "string") return null;
  const m = AUTO_PROMPT_RE.exec(prompt.trim());
  return m ? (m[1] ? "go" : "dry") : null;
}

/**
 * UserPromptSubmit: grant for `/start <N ...>` or `/start --auto [--go]`, clear for any other prompt, nothing for a
 * session id unsafe as a file name or for an automated input (a subagent report, task notification or peer message,
 * #262). Keeping the grant across an automated input is safe: such a prompt never creates one, whatever its body says,
 * and the grant still lapses after GRANT_TTL_MS and is spent by start.mjs's one run.
 */
export function onUserPromptSubmit(input, now = Date.now()) {
  const sessionId = input?.session_id;
  const acts = typeof sessionId === "string" && SESSION_RE.test(sessionId) && !isAutomatedInput(input.prompt);
  if (!acts) return { action: "none" };
  const at = new Date(now).toISOString();
  const auto = parseAutoPrompt(input.prompt);
  if (auto !== null) return { action: "grant", sessionId, grant: { sessionId, auto, at } };
  const issues = parseStartPrompt(input.prompt);
  if (issues === null) return { action: "clear", sessionId };
  return { action: "grant", sessionId, grant: { sessionId, issues, at } };
}

// A `$` or backtick the shell takes literally is lexed as LIT_DOLLAR or LIT_TICK (shell-lex.mjs), so UNRESOLVED_RE
// sees only the ones that expand (#89). A quoted script is walked with them restored: the shell that runs it (bash -c,
// eval) expands them; a restored backtick comes back as QUOTED_TICK, so a literal message such as 'Fix `start.mjs`'
// is not read as a run of start.mjs (#197).
// Every command is lexed in shell-lex.mjs's bodies shape; its words shape is approve-guard.mjs's.
const lexBodies = (cmd) => lex(cmd, { bodies: true });
const unliteral = (s) => s.replaceAll(LIT_DOLLAR, "$").replaceAll(LIT_TICK, QUOTED_TICK);
// Text with every quote, backslash and backtick dropped (PowerShell's curly quotes too), for the checks that read raw
// text: a name split by quoting, as in st"art.mjs or --"bg", reads whole (#61, like #62 in approve-guard.mjs).
const dequoted = (s) => s.replace(new RegExp(`['"\\\\\`‘-„${LIT_TICK}${QUOTED_TICK}]`, "g"), "");

/** `cmd` without its literal `$(cat <<'D' … D)` substitutions, for the raw-text checks: their text is only data. */
function withoutLiteralSubstitutions(cmd) {
  let out = "";
  for (let i = 0; i < cmd.length; i += 1) {
    const lit = cmd[i] === "$" ? plainLiteralSubstitution(cmd, i) : null;
    if (lit) i = lit.end;
    else out += cmd[i];
  }
  return out;
}

const VAR_REF_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;
// What is left of a word after substitution that could still expand to anything.
const UNRESOLVED_RE = /[$`]/;

/**
 * Same-command `NAME=value` assignments substituted into every `$NAME`/`${NAME}` reference, whole word or spliced
 * into one, so `S=…start.mjs; node $S` and `X=start; node scripts/lanes/$X.mjs` are both seen.
 */
function resolveSegments(segments) {
  const assignments = {};
  for (const words of segments) {
    for (const w of words) {
      const m = ASSIGN_RE.exec(w);
      if (m) assignments[m[1]] = m[2];
    }
  }
  return segments.map((words) =>
    words.map((w) =>
      w.replace(VAR_REF_RE, (ref, braced, bare) => {
        const name = braced ?? bare;
        return Object.prototype.hasOwnProperty.call(assignments, name) ? assignments[name] : ref;
      }),
    ),
  );
}

/** A quoted script, as in bash -c "…", sh -c '…', eval "…" or node -e "…": a word holding shell syntax. */
const isNestedScript = (w) => /[\s;&|()<>]/.test(w);

/**
 * True when word `i` is a script a shell runs: the value of a shell's `-c` (`-lc`, `-ec`, …), with a shell named
 * anywhere earlier (so `env bash -c`, `timeout 5 bash -c` still count, the same as node is found behind a wrapper
 * elsewhere in this file), or an argument of eval or source when the command word itself (not merely some earlier
 * one) is eval, source or `.`: unlike a shell run through a wrapper, eval and source are shell builtins, so nothing
 * can run them but the shell itself as the command word, and anchoring there keeps an unrelated word that happens to
 * equal "." or "eval" (a grep pattern, a commit message word, a directory) from turning a later quoted word live.
 * Its literal backticks then run too, while a literal message elsewhere ('Fix `start.mjs`') stays text.
 */
const runsAsShell = (words, i) => {
  if (i > 0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(words[i - 1]) && words.slice(0, i - 1).some((w) => SHELL_RE.test(basename(w)))) return true;
  const cmdAt = words.findIndex((w) => !ASSIGN_RE.test(w));
  return cmdAt !== -1 && cmdAt < i && (words[cmdAt] === "eval" || words[cmdAt] === "source" || words[cmdAt] === ".");
};
const unliteralLive = (s) => s.replaceAll(LIT_DOLLAR, "$").replaceAll(LIT_TICK, "`");

// Programs that write what they are given to a file, and never run it (#89); cd and mkdir may come alongside.
const WRITE_COMMANDS = new Set(["cat", "echo", "printf"]);
const PLACE_COMMANDS = new Set(["cd", "mkdir"]);

/**
 * True when every simple command of a whole lexed Bash call is plainly (no assignment, variable or wrapper in front)
 * cat, echo or printf with an output redirection, or cd or mkdir, as in
 * `mkdir -p .lanes/verdicts && cat > .lanes/verdicts/x.json <<'EOF' … EOF`: nothing in the call can run the text it
 * writes, not a pipe (`| sh`), a process substitution (`>(bash)`), a group or function (`{`), nor a later
 * `bash file`. Only the top level counts: a nested script's output may be run by the command around it.
 */
const isDataOnly = ({ segments, writes }) =>
  segments.every((words, k) => PLACE_COMMANDS.has(words[0]) || (WRITE_COMMANDS.has(words[0]) && writes[k] === true));

// The words that are a jq program or a Go template (#61): every argument of jq, and the value of gh's --jq, -q,
// --template or -t. Neither language runs a command, so a quoted `$s` in one is that language's variable, which the
// shell never expands; read as the shell's, it denied `gh pr view --jq '.x as $s | $s'` as a program named at run time.
const GH_PROGRAM_FLAGS = new Set(["--jq", "-q", "--template", "-t"]);
const JQ_RE = /^(jq|gojq)(\.exe)?$/i;
const GH_RE = /^gh(\.exe)?$/i;

/** The indexes of a simple command's words that are a jq program or Go template, when jq or gh is its command word. */
function programWords(words) {
  const at = new Set();
  const cmd = words.findIndex((w) => !ASSIGN_RE.test(w));
  if (cmd === -1) return at;
  const name = basename(words[cmd]);
  for (let i = cmd + 1; i < words.length; i += 1) {
    if (JQ_RE.test(name) || (GH_RE.test(name) && /^--(jq|template)=/.test(words[i]))) at.add(i);
    else if (GH_RE.test(name) && GH_PROGRAM_FLAGS.has(words[i])) at.add(i + 1);
  }
  return at;
}

// A node -e script that names start.mjs, queue.mjs or claude --bg counts as a run, whatever else it does (owner
// decision on #61, 2026-09-28: no exemption for scripts that only write text; four review rounds each found a way to
// launch through one). The owner session writes such scripts to a file instead.
// A node -e script's text as names are looked for in it: quotes, `+` and whitespace dropped, so "st" + "art.mjs" reads whole.
const jsNames = (js) => js.replace(new RegExp(`["'\`+\\s${LIT_TICK}]`, "g"), "");

const EVAL_FLAGS = new Set(["-e", "--eval", "-pe"]);
// -p/--print take an optional script: in `node -p -e '<script>'` the script is the word after -e (#318).
const PRINT_FLAGS = new Set(["-p", "--print"]);
const EVAL_PROGRAM_RE = /^(node|nodejs|bun)(\.exe)?$/i;

/**
 * The indexes of the words that `node -e`/`--eval`/`-p`/`--print` (or bun's) runs as JavaScript, with their text, when
 * node is the command word itself. Behind a wrapper (env, timeout, eval) they are read as shell text, as before #89.
 * The word after -p/--print is read as a script even when it starts with `-` (`-require(…)` is JavaScript too), but
 * such a word is also still read as a flag, so `-p -e '<script>'` reads the script after -e.
 */
function evalScripts(words) {
  const scripts = new Map();
  const at = words.findIndex((w) => !ASSIGN_RE.test(w));
  if (at === -1 || !EVAL_PROGRAM_RE.test(basename(words[at]))) return scripts;
  let afterFlag = false;
  for (let i = at + 1; i < words.length; i += 1) {
    const w = words[i];
    const eq = /^(--eval|--print)=(.*)$/s.exec(w);
    if (eq) scripts.set(i, eq[2]);
    else if (EVAL_FLAGS.has(w)) {
      if (i + 1 < words.length) scripts.set(i + 1, words[i + 1]);
      i += 1;
    } else if (PRINT_FLAGS.has(w)) {
      if (i + 1 < words.length) scripts.set(i + 1, words[i + 1]);
      if (!words[i + 1]?.startsWith("-")) i += 1;
    } else if (w.startsWith("-")) afterFlag = !w.includes("=");
    else if (afterFlag) afterFlag = false;
    else break;
  }
  return scripts;
}

/**
 * Walks every simple command of `cmd`, recursing into every quoted script and every heredoc body (either may be run:
 * `bash -c "…"`, `bash <<EOF`, `cat <<EOF | sh`) and every redirection target. `visit(words, stdin)` is called per simple command
 * (with its `<` target, if any), including the one find -exec or xargs runs; `onOpaque(text)` for a
 * part that cannot be read (unterminated quote, nesting too deep), which the caller fails closed on when the text
 * names what it looks for; `onEval(text)` for a `node -e` script, which is JavaScript, not shell (#89). A whole call
 * that only prints or writes text (isDataOnly) has only what the shell expands in it walked: a word with a `$` or
 * backtick, a heredoc that is not literal, an arithmetic expression. A simple command piped into a shell has its
 * words, and its arguments joined as one line, walked with their backticks live (#246).
 */
function walk(cmd, depth, visit, onOpaque, onEval) {
  let lexed;
  try {
    lexed = lexBodies(cmd);
  } catch {
    onOpaque(cmd);
    return;
  }
  const nested = (text) => (depth >= MAX_DEPTH ? onOpaque(text) : walk(text, depth + 1, visit, onOpaque, onEval));
  const dataOnly = depth === 0 && isDataOnly(lexed);
  const scan = (words, stdin, piped = false) => {
    if (!dataOnly) visit(words, stdin);
    const scripts = dataOnly ? new Map() : evalScripts(words);
    const programs = programWords(words);
    words.forEach((w, i) => {
      if (scripts.has(i)) onEval(scripts.get(i));
      else if (isNestedScript(w) && !(dataOnly && !UNRESOLVED_RE.test(w))) {
        // A jq program or Go template keeps its quoted `$` literal: `$s` there is its own variable (#61).
        nested(piped || runsAsShell(words, i) ? unliteralLive(w) : programs.has(i) ? w : unliteral(w));
      }
    });
    // What a command piped into a shell prints may be its arguments (echo, printf): read them as one live script (#246).
    if (piped && words.length > 1) nested(unliteralLive(words.slice(1).join(" ")));
  };
  for (const [k, words] of resolveSegments(lexed.segments).entries()) {
    scan(words, lexed.stdin[k], feedsShell(lexed.segments, lexed.pipes, k));
    // The command find -exec or xargs runs is a simple command of its own (#113).
    if (!dataOnly) for (const sub of runnerCommands(words)) scan(sub);
  }
  // A redirection target is no word, but a substitution in it still runs (#191).
  for (const t of lexed.targets) if (isNestedScript(t) && !(dataOnly && !UNRESOLVED_RE.test(t))) nested(unliteral(t));
  // A quoted heredoc's backticks are literal text, as in a single-quoted word.
  for (const body of lexed.bodies) if (!(dataOnly && body.literal)) nested(body.literal && !body.toShell ? body.text.replaceAll("`", QUOTED_TICK) : body.text);
}

// What find hands its -exec command for `{}`, and the arguments xargs appends from its input: known only at run time,
// so each reads as unresolved (#113).
const FOUND_PATH = "${LANES_FIND_PATH}";
const XARGS_INPUT = "${LANES_XARGS_INPUT}";
const FIND_RE = /^find(\.exe)?$/i;
const XARGS_RE = /^xargs(\.exe)?$/i;
const FIND_EXEC = new Set(["-exec", "-execdir", "-ok", "-okdir"]);
// xargs options whose value may be the next word.
const XARGS_VALUE_FLAGS = new Set(["-a", "-d", "-E", "-L", "-n", "-P", "-s", "--arg-file", "--delimiter", "--eof", "--max-lines", "--max-args", "--max-procs", "--max-chars", "--process-slot-var"]);
const fromInput = (w) => w.includes(FOUND_PATH) || w.includes(XARGS_INPUT);

/**
 * The commands a simple command runs through find (`-exec`, `-execdir`, `-ok`, `-okdir` up to `;` or `+`, with `{}`
 * as FOUND_PATH) or xargs (the words after its options, with its -I/-i replace string as XARGS_INPUT, or XARGS_INPUT
 * appended). Empty for anything else, `find` without -exec, or a bare `xargs` (which runs echo).
 */
function runnerCommands(words) {
  const plain = words.filter((w) => !ASSIGN_RE.test(w));
  const at = plain.findIndex((w) => FIND_RE.test(basename(w)) || XARGS_RE.test(basename(w)));
  if (at === -1) return [];
  const subs = [];
  if (FIND_RE.test(basename(plain[at]))) {
    for (let i = at + 1; i < plain.length; i += 1) {
      if (!FIND_EXEC.has(plain[i])) continue;
      const sub = [];
      for (i += 1; i < plain.length && plain[i] !== ";" && plain[i] !== "+"; i += 1) sub.push(plain[i].replaceAll("{}", FOUND_PATH));
      if (sub.length > 0) subs.push(sub);
    }
    return subs;
  }
  let replace = null;
  let i = at + 1;
  for (; i < plain.length; i += 1) {
    const w = plain[i];
    if (w === "--") {
      i += 1;
      break;
    }
    if (!w.startsWith("-") || w === "-") break;
    if (w === "-I") {
      replace = plain[i + 1] ?? null;
      i += 1;
    } else if (w.startsWith("-I")) replace = w.slice(2);
    else if (w === "-i" || w === "--replace") replace = "{}";
    else if (w.startsWith("-i")) replace = w.slice(2);
    else if (w.startsWith("--replace=")) replace = w.slice("--replace=".length);
    else if (XARGS_VALUE_FLAGS.has(w)) i += 1;
  }
  if (i >= plain.length) return [];
  const sub = plain.slice(i);
  return [replace ? sub.map((w) => w.replaceAll(replace, XARGS_INPUT)) : [...sub, XARGS_INPUT]];
}

/** True when a whole Bash call only writes text (isDataOnly); false when it cannot be read. */
function writesOnly(cmd) {
  try {
    return isDataOnly(lexBodies(cmd));
  } catch {
    return false;
  }
}

/**
 * The indexes of the words node/bun/deno at `nodeAt` could run as its script: every word up to the first resolved one
 * that must be the script. A flag's value may be the next word (`-r dotenv/config $X`, #95 security review), so a word
 * right after a flag without `=` is skipped as possibly its value, as is bun/deno's `run`.
 */
function scriptCandidates(plain, nodeAt) {
  const at = new Set();
  if (nodeAt === -1) return at;
  let afterFlag = false;
  for (let i = nodeAt + 1; i < plain.length; i += 1) {
    const w = plain[i];
    if (w.startsWith("-")) {
      afterFlag = !w.includes("=");
      continue;
    }
    at.add(i);
    if (UNRESOLVED_RE.test(w) || afterFlag || w === "run") {
      afterFlag = false;
      continue;
    }
    break;
  }
  return at;
}

/**
 * A simple command's words without assignments, then its stdin target when it has one, as `plain`; node's index; the
 * indexes node could run as its script; and `counts(i)`, false for a stdin target that is no such index: node reads
 * its stdin as the script only when no argument is one (`node < queue.mjs`, #95), and a target is no argument (#191).
 */
function commandWords(words, stdin) {
  const own = words.filter((w) => !ASSIGN_RE.test(w));
  const plain = stdin === undefined ? own : [...own, stdin];
  const nodeAt = own.findIndex((p) => NODE_RE.test(basename(p)));
  const scripts = scriptCandidates(plain, nodeAt);
  return { plain, nodeAt, scripts, counts: (i) => i < own.length || scripts.has(i) };
}

/**
 * Every run of `start.mjs` in a Bash command: the script as the command itself, or as an argument of node, including
 * runs behind env, chains, subshells or `bash -c`. `standalone` is true only for the plain
 * `node scripts/lanes/start.mjs <N ...>` (with its `issues`) or `node scripts/lanes/start.mjs --auto [--go]` (with its
 * `auto` form) with nothing around it. Merely naming the file (cat, git diff) is not a run. A part that cannot be
 * read and names start.mjs counts as a run with `unparsed: true`.
 * @returns {({ issues: number[] | undefined, standalone: boolean, unparsed?: true } | { auto: "dry" | "go", standalone: true })[]}
 */
export function findStartInvocations(command) {
  return startInvocations(String(command ?? ""), String(command ?? ""));
}

/** findStartInvocations of the Bash text `cmd`, where `typed` is the command as typed (PowerShell's, for that tool). */
function startInvocations(cmd, typed) {
  const out = [];
  walk(
    cmd,
    0,
    (words, stdin) => {
      const { plain, nodeAt, scripts, counts } = commandWords(words, stdin);
      plain.forEach((w, i) => {
        if (!counts(i)) return;
        // Unquoted `scripts\lanes\start.mjs` loses its backslashes in the lexer, as in bash: match the word's end.
        if (START_WORD_RE.test(w) && (i === 0 || (nodeAt !== -1 && nodeAt < i))) out.push({ issues: undefined, standalone: false });
        // The command word, or a word node could run as its script, that still holds `$` or a backtick could expand to start.mjs.
        else if (UNRESOLVED_RE.test(w) && (i === 0 || scripts.has(i))) out.push({ issues: undefined, standalone: false });
      });
    },
    (text) => {
      if (/start\.mjs/i.test(dequoted(text))) out.push({ issues: undefined, standalone: false, unparsed: true });
    },
    // A node -e script that names start.mjs could import or spawn it; one the shell expands could be anything.
    (js) => {
      if (/start\.mjs/i.test(jsNames(js)) || UNRESOLVED_RE.test(js)) out.push({ issues: undefined, standalone: false });
    },
  );
  // No raw-text fallback: `node $(echo …start.mjs)` and backticks leave `$` or a backtick in the script word, which
  // the visitor above already counts, and one would deny `git commit -m "…start.mjs" && echo "$X"`.
  // A trailing newline the model appends to a Bash command must not turn the plain command into a wrapped one.
  const m = PLAIN_RE.exec(typed.trim());
  if (out.length === 1 && m) out[0] = { issues: m[1].trim().split(" ").map(Number), standalone: true };
  const a = AUTO_PLAIN_RE.exec(typed.trim());
  if (out.length === 1 && a) out[0] = { auto: a[1] ? "go" : "dry", standalone: true };
  return out;
}

/**
 * True when a Bash command runs `queue.mjs` (#95, ADR 0005): the script as the command itself, or as an argument of
 * node, bun or deno, behind any wrapper, chain, `bash -c` or heredoc. A part that cannot be read and names queue.mjs, or
 * a command or script word that stays unresolved (`$X`, a backtick) in a simple command that names queue.mjs, also
 * counts: either could be a run. Merely naming the file (cat, git diff, `node --test …queue.test.mjs`) is not a run.
 */
export function findQueueInvocations(command) {
  return scanQueueInvocations(command).found;
}

/**
 * findQueueInvocations, and `unresolved`: a command or script word elsewhere that stays unresolved, which could be
 * queue.mjs (or start.mjs) once expanded, as in `X=$(… | base64 -d); node $X` (#95 security review).
 */
function scanQueueInvocations(command) {
  let found = false;
  let unresolved = false;
  const cmd = String(command ?? "");
  // What find or xargs hands a command comes from elsewhere in the call: `find -name queue.mjs`, `echo …queue.mjs |`.
  const namesAnywhere = /queue\.mjs/i.test(dequoted(withoutLiteralSubstitutions(cmd)));
  walk(
    cmd,
    0,
    (words, stdin) => {
      const { plain, nodeAt, scripts, counts } = commandWords(words, stdin);
      const names = plain.some((w) => /queue\.mjs/i.test(w)) || (namesAnywhere && plain.some(fromInput));
      plain.forEach((w, i) => {
        if (!counts(i)) return;
        if (QUEUE_WORD_RE.test(w) && (i === 0 || (nodeAt !== -1 && nodeAt < i))) found = true;
        else if (UNRESOLVED_RE.test(w) && (i === 0 || scripts.has(i))) {
          if (names) found = true;
          else unresolved = true;
        }
      });
    },
    (text) => {
      if (/queue\.mjs/i.test(dequoted(text))) found = true;
    },
    (js) => {
      if (/queue\.mjs/i.test(jsNames(js))) found = true;
      else if (UNRESOLVED_RE.test(js)) unresolved = true;
    },
  );
  return { found, unresolved };
}

/** True when a Bash command runs `claude --bg` (or `--background`) directly, behind any wrapper, or cannot be read. */
export function findBgLaunches(command) {
  return scanBgLaunches(command).found;
}

/** findBgLaunches, and whether only a part that cannot be read (and names --bg) made it true. */
function scanBgLaunches(command) {
  const cmd = String(command ?? "");
  let found = false;
  let opaque = false;
  walk(
    cmd,
    0,
    (words) => {
      const at = words.findIndex((w) => CLAUDE_RE.test(basename(w)));
      // After claude, a word that still holds `$` or a backtick could expand to --bg: fail closed.
      if (at !== -1 && words.slice(at + 1).some((w) => BG_FLAG_RE.test(w) || UNRESOLVED_RE.test(w))) found = true;
      // `$C --bg`, `claude$X --bg`, `$C --$F`, backticks: a command word that could be claude, with a flag that could be --bg.
      const cmdWord = words.find((w) => !ASSIGN_RE.test(w));
      if (cmdWord !== undefined && UNRESOLVED_RE.test(cmdWord) && words.some((w) => BG_FLAG_RE.test(w) || (w.startsWith("-") && UNRESOLVED_RE.test(w)))) found = true;
    },
    (text) => {
      if (/--(bg|background)/.test(dequoted(text))) opaque = true;
    },
    // A node -e script that names claude and --bg could spawn it.
    (js) => {
      const names = jsNames(js);
      if (/claude/i.test(names) && /--(bg|background)/.test(names)) found = true;
    },
  );
  // `$(which claude) --bg`: the lexer splits the substitution off, so claude and its flag land in different simple
  // commands. Only a `$(` that names claude, with a --bg word in the same call, fails closed; an unrelated "$VAR" does
  // not, nor does a literal `$(cat <<'EOF' … EOF)` message that merely names both. A call that only writes text has
  // no command a substitution could run as claude: every simple command in it, split-off substitutions included, is
  // cat, echo, printf, cd or mkdir, and walk() reads each expanding part itself. Quotes are dropped first, so
  // `$(which cla"ude") --"bg"` is read as it runs (#61).
  const raw = dequoted(withoutLiteralSubstitutions(cmd));
  if (!found && !writesOnly(cmd) && /\$\([^)]*claude/i.test(raw) && /(^|[\s'"])--(bg|background)([=\s'"]|$)/.test(raw)) found = true;
  return { found: found || opaque, unparsed: !found && opaque };
}

const PS_SHELL_RE = /^(powershell|pwsh)(\.exe)?$/i;
// powershell's -EncodedCommand, any prefix of it from -e, and -ec, led by -, -- or /; `-e:<value>` carries its value.
const ENCODED_FLAG_RE = /^(?:--?|\/)([A-Za-z]+)(?::(.*))?$/s;

/** The value an -EncodedCommand word `w` names: the next word, its own `:value`, or undefined when `w` is no such flag. */
function encodedValue(w, next) {
  const m = ENCODED_FLAG_RE.exec(w);
  if (!m) return undefined;
  const name = m[1].toLowerCase();
  if (name !== "ec" && !"encodedcommand".startsWith(name)) return undefined;
  return m[2] ?? next;
}

/**
 * Every -EncodedCommand script a call hands powershell or pwsh (#316), decoded as powershell does (base64 of UTF-16LE),
 * wherever the walk reaches: behind a wrapper, in `bash -c`, run by find or xargs. `unresolved` is true when a value
 * still holds `$` or a backtick, a script known only at run time.
 */
function encodedScripts(cmd) {
  const scripts = [];
  let unresolved = false;
  walk(
    cmd,
    0,
    (words) => {
      const at = words.findIndex((w) => PS_SHELL_RE.test(basename(w)));
      if (at === -1) return;
      for (let i = at + 1; i < words.length; i += 1) {
        const value = encodedValue(words[i], words[i + 1]);
        if (value === undefined) continue;
        if (UNRESOLVED_RE.test(value)) unresolved = true;
        // Node's decoder skips what is no base64, as powershell's rejects it: a value it cannot run decodes to noise.
        else scripts.push(Buffer.from(value.replace(/\s/g, ""), "base64").toString("utf16le"));
      }
    },
    () => {},
    () => {},
  );
  return { scripts, unresolved };
}

/**
 * True when a call creates a process through WMI or CIM (#316): it names Win32_Process, or runs wmic's `process`, with
 * a `create`. Read on the text with quotes, `+`, whitespace and literal messages dropped, so 'Win32'+'_Process' reads whole.
 */
function wmiCreate(text) {
  const flat = dequoted(withoutLiteralSubstitutions(text)).replace(/[\s+()]/g, "").toLowerCase();
  return /create/.test(flat) && (/win32_process/.test(flat) || (/wmic/.test(flat) && /process/.test(flat)));
}

/** A grant names either issues or one auto form, never both. */
function validGrant(grant) {
  if (grant === null || typeof grant !== "object" || typeof grant.sessionId !== "string") return false;
  if (typeof grant.at !== "string" || Number.isNaN(Date.parse(grant.at))) return false;
  if ("auto" in grant) return !("issues" in grant) && Object.hasOwn(AUTO_FORMS, grant.auto);
  return (
    Array.isArray(grant.issues) &&
    grant.issues.length > 0 &&
    grant.issues.every((n) => Number.isSafeInteger(n) && n > 0) &&
    new Set(grant.issues).size === grant.issues.length
  );
}

const sameIssues = (a, b) => a.length === b.length && [...a].sort((x, y) => x - y).every((n, i) => n === [...b].sort((x, y) => x - y)[i]);

/**
 * Why `grant` does not allow the start.mjs run `run` in session `sessionId` at `now`, or null when it does: the grant
 * must be this session's, name the same issue numbers or the same auto form, and be under GRANT_TTL_MS old. Shared by
 * the PreToolUse hook and start.mjs (ADR 0007), so both read a grant the same way.
 * @param grant the session's grant file as parsed, null when there is none, or { unreadable: true }
 * @param {{ issues: number[] } | { auto: "dry" | "go" }} run
 * @returns {string | null}
 */
export function grantRefusal(grant, sessionId, run, now) {
  if (typeof sessionId !== "string" || !SESSION_RE.test(sessionId)) return "no session id, so no /start grant can be checked";
  if (grant === null || grant === undefined) return "no /start grant in this session";
  if (!validGrant(grant)) return "the /start grant is unreadable or malformed";
  if (grant.sessionId !== sessionId) return "the /start grant belongs to another session";
  if (run.auto !== undefined) {
    if (grant.auto === undefined) return "the /start grant is for issue numbers, not --auto";
    if (grant.auto !== run.auto) return run.auto === "go" ? "a /start --auto grant never allows --go" : "the /start grant is for --auto --go, not a dry run";
  } else if (grant.auto !== undefined) {
    return `the /start grant is for ${AUTO_FORMS[grant.auto]}, not issue numbers`;
  } else if (!sameIssues(grant.issues, run.issues)) {
    return `the /start grant is for other issue numbers (${grant.issues.join(" ")})`;
  }
  const age = now - Date.parse(grant.at);
  if (age < 0) return "the /start grant is dated in the future";
  if (age >= GRANT_TTL_MS) return "the /start grant is older than 15 minutes";
  return null;
}

/**
 * PreToolUse: null (no decision) unless the command runs `claude --bg` or `start.mjs`. `claude --bg` is always denied;
 * start.mjs is allowed only with this session's fresh grant for the same issues or the same auto form, and denied
 * otherwise. An allow leaves the grant in place: start.mjs checks it again and deletes it after its launches (ADR 0007).
 * @param grant the session's grant file as parsed, null when there is none, or { unreadable: true }
 * @returns {null | { decision: "allow" | "deny", reason: string }}
 */
export function decidePreToolUse(input, grant, now = Date.now()) {
  return decide(input, grant, now, 0);
}

/** decidePreToolUse, `depth` -EncodedCommand scripts down. */
function decide(input, grant, now, depth) {
  const tool = input?.tool_name;
  if (tool !== "Bash" && tool !== "PowerShell") return null;
  const typed = String(input.tool_input?.command ?? "");
  let command = typed;
  if (tool === "PowerShell") {
    // Read with PowerShell's rules, then scanned as Bash (#61). One that cannot be read fails closed on the names.
    try {
      command = powershellAsBash(typed);
    } catch (e) {
      const text = dequoted(typed);
      if (/queue\.mjs/i.test(text)) return { decision: "deny", reason: QUEUE_DENY_REASON };
      // A limit of the reader, not of PowerShell (nesting too deep), is denied whatever it names.
      return e?.readerLimit || /start\.mjs|--(bg|background)/i.test(text) ? { decision: "deny", reason: PARSE_DENY_REASON } : null;
    }
  }
  // An -EncodedCommand script is a PowerShell call of its own (#316). Whatever it decides becomes a deny: only the
  // plain start.mjs command, typed as the whole call, is ever allowed.
  const encoded = encodedScripts(command);
  for (const script of encoded.scripts) {
    if (depth >= MAX_DEPTH) return { decision: "deny", reason: PARSE_DENY_REASON };
    const d = decide({ ...input, tool_name: "PowerShell", tool_input: { command: script } }, grant, now, depth + 1);
    if (d !== null) return d.decision === "deny" ? d : { decision: "deny", reason: DENY_REASON };
  }
  if (encoded.unresolved) return { decision: "deny", reason: UNRESOLVED_DENY_REASON };
  const bg = scanBgLaunches(command);
  if (bg.found) return { decision: "deny", reason: bg.unparsed ? PARSE_DENY_REASON : BG_DENY_REASON };
  // Before any grant is read: no /start grant, of any form, reaches queue.mjs.
  const queue = scanQueueInvocations(command);
  if (queue.found) return { decision: "deny", reason: QUEUE_DENY_REASON };
  // A program named only at run time could be either script (findStartInvocations denies the same words); a command
  // that names start.mjs keeps the start reason. Only the reason differs: both deny.
  if (queue.unresolved && !/start\.mjs/i.test(dequoted(withoutLiteralSubstitutions(command)))) return { decision: "deny", reason: UNRESOLVED_DENY_REASON };
  const found = startInvocations(command, typed);
  // A WMI/CIM process creation's literal command line was read above; one built at run time could be anything (#316).
  // For the PowerShell tool a hashtable or expression reads as `$` in the Bash text, so that is where it is looked for.
  if (found.length === 0) return wmiCreate(typed) && UNRESOLVED_RE.test(command) ? { decision: "deny", reason: WMI_DENY_REASON } : null;
  if (found.every((f) => f.unparsed)) return { decision: "deny", reason: PARSE_DENY_REASON };
  const deny = { decision: "deny", reason: DENY_REASON };
  if (found.length !== 1 || !found[0].standalone) return deny;
  const run = found[0];
  if (grantRefusal(grant, input.session_id, run, now) !== null) return deny;
  if (run.auto !== undefined) return { decision: "allow", reason: `owner run of /start ${AUTO_FORMS[run.auto]} in this session` };
  return { decision: "allow", reason: `owner launch from /start ${grant.issues.join(" ")} in this session` };
}

/** The grant file of session `sessionId` in `dir`, or null for a session id unsafe as a file name. */
export function grantPath(dir, sessionId) {
  return typeof sessionId === "string" && SESSION_RE.test(sessionId) ? join(dir, `${sessionId}.json`) : null;
}

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
      // Never block a prompt; a grant that was not written only means start.mjs is denied.
    }
    return "";
  }
  if (event === "pre-tool-use") {
    try {
      const input = JSON.parse(raw);
      const file = grantPath(dir, input?.session_id);
      const d = decidePreToolUse(input, file ? readGrant(file) : null, now);
      if (d === null) return "";
      // An allow leaves the grant: start.mjs checks it again and deletes it after its launches (ADR 0007).
      return preToolUseOutput(d.decision, d.reason);
    } catch {
      return preToolUseOutput("deny", DENY_REASON);
    }
  }
  throw new Error("usage: start-guard.mjs user-prompt-submit|pre-tool-use < hook-input.json");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // A hook that crashes is a non-blocking error and the tool call proceeds, so every failure here must answer deny.
  let out;
  try {
    const dir = fileURLToPath(new URL("../../.lanes/start/", import.meta.url));
    out = runHook(process.argv[2], readFileSync(0, "utf8"), { dir });
  } catch {
    out = process.argv[2] === "user-prompt-submit" ? "" : preToolUseOutput("deny", DENY_REASON);
  }
  process.stdout.write(out);
}
