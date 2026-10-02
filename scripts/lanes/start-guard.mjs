// scripts/lanes/start-guard.mjs — the barrier between a session and launching lanes (#51, from the #18 security review).
// Wired in .claude/settings.json as hooks:
//   UserPromptSubmit: node scripts/lanes/start-guard.mjs user-prompt-submit
//     a prompt that is exactly `/start <N> [<N> ...]` writes a grant { sessionId, issues, at } to
//     .lanes/start/<session>.json, and one that is exactly `/start --auto` or `/start --auto --go` writes
//     { sessionId, auto: "dry" | "go", at } (#76); any other prompt in that session deletes it, except an automated input
//     (shell-lex.mjs's AUTOMATED_INPUT_PREFIXES), which neither creates nor deletes one (#262).
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
//     shell-lex.mjs) and scanned as the Bash command with the same words, under the same grant rules; one that
//     cannot be read is denied when it names start.mjs, queue.mjs or --bg. Raw-text checks drop quotes first, so a
//     name split by quoting (st"art.mjs, --"bg") still reads whole. A jq program or gh --jq/--template value keeps its
//     `$` literal. A node -e script that names a target still counts as a run (owner decision, 2026-09-28).
//   Either tool (#316): a powershell/pwsh -EncodedCommand value (-e, -enc, -ec, any prefix) is decoded and decided as a
//     PowerShell call of its own, and never allowed; a word ending in claude counts as claude (`CommandLine=claude`,
//     a Windows path whose backslashes a nested script drops); and a WMI/CIM process creation (Win32_Process Create,
//     wmic process call create) whose call holds anything expanded at run time is denied.
//   Either tool (#378): shell text known only at run time (`eval "$X"`, `source "$F"`, `sh -c "$(cat f)"`) is denied
//     with or without a grant; a Win32_Process method named at run time (`$o.$m(…)`) counts as a WMI process creation;
//     and a program glob that could expand to node (`n*de`, `[n]ode`) is read as node. The rules live in shell-lex.mjs.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ASSIGN_RE, LIT_DOLLAR, LIT_TICK, QUOTED_TICK, basename, dequoted, feedsShell, isAutomatedInput, launchedCommands, lex, mayBeNode,
  mayExpandTo, powershellAsBash, preToolUseOutput, readGrant, releaseTagCommand, runtimeTextWords, scriptSubcommand, shellTextIndexes,
  withoutLiteralSubstitutions, wmiProcessCreate,
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
export const RUNTIME_TEXT_DENY_REASON =
  "this command runs shell text known only at run time (eval, source or a shell's -c given $VAR, $(…) or a backtick), which could be start.mjs, queue.mjs or claude --bg, so start-guard denies it; run the command itself";
// ADR 0017 decision 3: a pushed v* tag releases, so only the owner makes one, from their own terminal (#404).
export const TAG_DENY_REASON =
  "creating or pushing a v* tag starts a release, which the owner does from their own terminal, never from a Claude session (ADR 0017)";
const SESSION_RE = /^[A-Za-z0-9_-]{1,128}$/;
const START_PROMPT_RE = /^\/start((?:\s+[1-9][0-9]{0,8})+)$/;
// The only form that may be allowed: the plain command with plain issue numbers, nothing chained, wrapped or redirected.
const PLAIN_RE = /^node scripts\/lanes\/start\.mjs((?: [1-9][0-9]{0,8})+)$/;
const AUTO_PROMPT_RE = /^\/start\s+--auto(\s+--go)?$/;
const AUTO_PLAIN_RE = /^node scripts\/lanes\/start\.mjs --auto( --go)?$/;
const AUTO_FORMS = { dry: "--auto", go: "--auto --go" };
const START_WORD_RE = /start\.mjs$/i;
// The scripts whose path arguments are data: lessons.mjs reads them as Scope paths and never runs them (#441, #502).
const DATA_SCRIPT_RE = /(?:^|[\\/])lessons\.mjs$/i;
const QUEUE_WORD_RE = /queue\.mjs$/i;
// Matched at a word's end (#316): `CommandLine=claude` in a WMI hashtable, or `C:toolsclaude.exe` once a nested script
// has dropped a Windows path's backslashes. Not after a dot, so a `~/.claude` directory is no claude.
const CLAUDE_RE = /(?<!\.)claude(-code)?(\.exe|\.cmd|\.ps1)?$/i;
const BG_FLAG_RE = /^--(bg|background)(=.*)?$/;
// What a glob word is matched against (#308): the script names, and every name CLAUDE_RE reads as claude.
const START_NAMES = ["start.mjs"];
const QUEUE_NAMES = ["queue.mjs"];
const CLAUDE_NAMES = ["claude", "claude-code"].flatMap((n) => [n, `${n}.exe`, `${n}.cmd`, `${n}.ps1`]);
/**
 * True when a word is claude: its end matches CLAUDE_RE, or its last path component after any `=` is a glob that could
 * match claude (`cl*.exe`, `C:\tools\c?aude`, `CommandLine=cl*`), which PowerShell resolves as a program name (#308).
 */
const isClaude = (w) => {
  const b = basename(w);
  return CLAUDE_RE.test(b) || mayExpandTo(b.slice(b.lastIndexOf("=") + 1), CLAUDE_NAMES);
};
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
// Every command is lexed in shell-lex.mjs's bodies shape; its words shape is the other shape it offers.
const lexBodies = (cmd, collapse = false) => lex(cmd, { bodies: true, collapse });
const unliteral = (s) => s.replaceAll(LIT_DOLLAR, "$").replaceAll(LIT_TICK, QUOTED_TICK);
// dequoted and withoutLiteralSubstitutions, the raw-text readers, live in shell-lex.mjs beside the WMI reader (#308).

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
// shell-lex.mjs's shellTextIndexes since #404, shared with the run-time text rule: a -c script after options such as
// `--` or `-e`, eval behind `command -p`, and su, runuser, script, flock, fish or sg text count too.
const runsAsShell = (words, i) => shellTextIndexes(words).has(i);
const unliteralLive = (s) => s.replaceAll(LIT_DOLLAR, "$").replaceAll(LIT_TICK, "`");

/**
 * A quoted word handed to powershell or pwsh, read with PowerShell's rules as the PowerShell tool's command is (#404),
 * so `($env:Path -split ';').Count` is a value PowerShell prints, not a program `$env:Path`. Text PowerShell's reader
 * cannot read is read as shell text, as before.
 */
function powershellText(w) {
  try {
    return powershellAsBash(unliteralLive(w));
  } catch {
    return unliteral(w);
  }
}

// A search's pattern (#404): grep's and rg's first operand, or each -e/--regexp value, is matched against text and
// never run nor printed as given, so a quoted pattern that names a lanes script (`grep -n "node scripts/lanes/queue.mjs"
// f`, `rg start.mjs docs`) is no run. Only the pattern: a file operand may be printed (`grep -l`, `ls`), and cat, head
// or tail print their here-string (`bash <(cat <<< "…")`), so any other word of any command is read as before
// (security review rounds 1 and 2), the false positives of `cat n* f` and `echo foo * f` being accepted. rg counts only
// without --pre, which runs a program on every file it searches.
const SEARCH_RE = /^(grep|egrep|fgrep|rg)(\.exe)?$/i;
// The options a search may have for its pattern to be exempt, an allowlist: none of them prints the pattern or a value
// given to it (security review round 3: -o, -x, rg's -r/--replace and the --*-separator options do), and none runs a
// program (rg's --pre). Short flags may be combined (-rn); -A, -B, -C and -m take a number, -g/--glob and -t/--type a
// word that is a file filter. Any other option leaves every word read as before.
const SEARCH_FLAGS_RE = /^-[nrRiIlLcqswvHEFPS]+$/;
// rg's -r is --replace, which prints its value: rg's short flags leave r and R out.
const RG_FLAGS_RE = /^-[niIlLcqswvHEFPS]+$/;
const SEARCH_LONG = new Set([
  "--line-number", "--recursive", "--ignore-case", "--files-with-matches", "--files-without-match", "--count", "--quiet", "--word-regexp",
  "--invert-match", "--with-filename", "--no-messages", "--fixed-strings", "--extended-regexp", "--smart-case", "--hidden",
]);
// grep's file filters (#576), as -g is rg's: a glob that picks the files searched, never printed nor run. Without a `$`,
// backtick or whitespace, so one that expands at run time or splits into more words leaves every word read as before.
const GREP_FILTER_RE = /^--(include|exclude|exclude-dir)=[^$`\s]*$/;
const SEARCH_NUMBER_RE = /^-[ABCm]$/;
const SEARCH_FILTER = new Set(["-g", "--glob", "-t", "--type"]);

/**
 * The indexes of simple command `words` that are a grep or rg pattern (SEARCH_RE): the first operand, or each -e or
 * --regexp value, when every option is on the allowlist above. None for any other command or option.
 */
function searchPatterns(words) {
  const at = new Set();
  const cmd = words.findIndex((w) => !ASSIGN_RE.test(w));
  if (cmd === -1 || !SEARCH_RE.test(basename(words[cmd]))) return at;
  const flags = /^rg/i.test(basename(words[cmd])) ? RG_FLAGS_RE : SEARCH_FLAGS_RE;
  const found = new Set();
  let operand = -1;
  let options = true;
  for (let i = cmd + 1; i < words.length; i += 1) {
    const w = words[i];
    if (!options || !w.startsWith("-") || w === "-") {
      if (operand === -1) operand = i;
      continue;
    }
    if (w === "--") options = false;
    else if (w === "-e" || w === "--regexp") found.add((i += 1));
    else if (SEARCH_NUMBER_RE.test(w) && /^[0-9]+$/.test(words[i + 1] ?? "")) i += 1;
    else if (/^-[ABCm][0-9]+$/.test(w)) continue;
    else if (SEARCH_FILTER.has(w)) i += 1;
    else if (flags === SEARCH_FLAGS_RE && GREP_FILTER_RE.test(w) && !UNRESOLVED_RE.test(w)) continue;
    else if (!flags.test(w) && !SEARCH_LONG.has(w)) return at;
  }
  if (found.size === 0 && operand !== -1) found.add(operand);
  return found;
}

/**
 * The index of the word in `own` (a simple command's words without assignments) that is or may be node: node or a
 * glob that could be node anywhere but a search pattern (#404), since any other command may run its arguments or print
 * them for a shell to run, whether through a pipe, `<(…)` or `<<<` (security review, #404).
 */
function nodeWordAt(own) {
  const patterns = searchPatterns(own);
  return own.findIndex((w, i) => !patterns.has(i) && mayBeNode(w));
}

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
const isDataOnly = ({ segments, writes, pipes }) =>
  segments.every(
    (words, k) =>
      PLACE_COMMANDS.has(words[0]) ||
      (WRITE_COMMANDS.has(words[0]) && writes[k] === true) ||
      isQuietWrite(words, writes[k], pipes?.[k]),
  );

// Also plain: tee (it writes its stdin to the files named), or echo and printf with no redirection, as in
// `tee notes.md <<'EOF' … EOF` or `cat > f <<'EOF' … EOF && echo ok` (#642). Nothing is piped on and every word is a
// plain name or text, so no process substitution (`>(bash)`), expansion or later pipe can run what they print.
const QUIET_COMMANDS = new Set(["tee", "echo", "printf"]);
const PLAIN_WORD_RE = /^[^\s$`()<>|&;{}*?[\]!\\]*$/;
const isQuietWrite = (words, writes, piped) =>
  QUIET_COMMANDS.has(words[0]) && writes === false && piped !== true && words.slice(1).every((w) => PLAIN_WORD_RE.test(w));

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

// An awk program is no shell text either (#576), and runs a command only through system() or a pipe (`print | "sh"`,
// `"cmd" | getline`). One with neither is text awk matches and prints, so a literal backtick in it (the pattern
// `/^```markdown/`) is a plain character, not an unresolved word at the start of a command.
const AWK_RE = /^(awk|gawk|mawk|nawk)(\.exe)?$/i;
const AWK_RUNS_RE = /system|\|/i;
const AWK_FILE_RE = /^(-[fEi]|--(file|exec|include))/;

/** The indexes of a simple command's words that are an awk program or option value, when awk is its command word and none of them can run a command. */
function awkText(words) {
  const at = new Set();
  const cmd = words.findIndex((w) => !ASSIGN_RE.test(w));
  if (cmd === -1 || !AWK_RE.test(basename(words[cmd]))) return at;
  const rest = words.slice(cmd + 1);
  if (rest.some((w) => AWK_RUNS_RE.test(unliteral(w)))) return at;
  // A program read from a file (-f, -E, -i, gawk's --file, --exec, --include) is text this check never sees, and it may run
  // a `-v` or operand value as a command: every word then counts as before.
  if (rest.some((w) => AWK_FILE_RE.test(unliteral(w)))) return at;
  rest.forEach((_, i) => at.add(cmd + 1 + i));
  return at;
}

// Programs that only print or filter the words they are given and never run them (#669), so a `$` or backtick the shell
// kept literal inside single quotes stays text for them: `echo '$(date)'`, `head -n 1 '$x'`. A program that runs its
// words (a shell, eval, node -e, xargs, find -exec, sed's `e`) is not here and is read as before.
const TEXT_COMMANDS = new Set(["echo", "printf", "cat", "head", "tail", "wc", "cut", "tr", "uniq"]);

/** The indexes of a simple command's words whose literal `$` and backticks are text: every argument of a TEXT_COMMANDS program, or an awk program that cannot run a command (awkText). */
function literalTextWords(words) {
  const at = awkText(words);
  const cmd = words.findIndex((w) => !ASSIGN_RE.test(w));
  if (cmd !== -1 && TEXT_COMMANDS.has(basename(words[cmd]).replace(/\.exe$/i, ""))) words.forEach((_, i) => i > cmd && at.add(i));
  return at;
}

// What a TEXT_COMMANDS program's output may be piped into and still be text: these print, count or filter their input and
// never run it, unlike a shell, xargs, tee (a file a later `bash f` runs), awk (`system($0)`) or sed (`e`).
const TEXT_SINKS = new Set([...TEXT_COMMANDS, "sort", "grep", "egrep", "fgrep", "rg"]);

/**
 * True when simple command `k` writes no file and its output goes nowhere a shell, runtime or later script could read
 * it: not redirected, and piped on only through TEXT_SINKS (itself without a redirect, to the end). Its quoted `$` is
 * then no more than text printed to the terminal; any other consumer reads it as before (the #588 allowlist lesson).
 */
function outputStaysText({ segments, writes, pipes }, k) {
  for (let i = k; i < segments.length; i += 1) {
    if (writes[i] !== false) return false;
    if (i > k && !TEXT_SINKS.has(basename(segments[i][0] ?? "").replace(/\.exe$/i, ""))) return false;
    if (pipes?.[i] !== true) return true;
  }
  return false;
}

/**
 * The words after awk that may name a command the program runs or whose output a shell runs (#588): `print | "node
 * queue.mjs"` runs a command from inside the program, and `awk '{print "node queue.mjs"}' | sh` hands its output to a
 * shell. Neither shows as a command word when the program is read as shell text, so each word is read as text (as a
 * node -e script is) for the names. A program that neither runs nor feeds a shell is text awk prints, as above.
 */
function awkNamedWords(words, piped) {
  const at = words.findIndex((w) => AWK_RE.test(basename(w)));
  if (at === -1) return [];
  const rest = words.slice(at + 1);
  return piped || rest.some((w) => AWK_RUNS_RE.test(unliteral(w))) ? rest : [];
}

// The text fields of `gh issue|pr create|comment|edit|close|review`, which gh stores and never runs (#477).
const GH_PROSE_FLAGS = new Set(["--title", "-t", "--body", "-b", "--comment", "-c"]);
const GH_PROSE_VERBS = new Set(["create", "comment", "edit", "close", "reopen", "review"]);

/**
 * The indexes of a simple command's words that are prose gh posts (title, body, comment), when gh is its command word.
 * Such a word is still walked when it reads as a script, but one that cannot be lexed (`…the App's credentials…` holds
 * an apostrophe inside double quotes) is no script: denying it as unreadable refused a valid `gh issue create` (#477).
 */
function proseWords(words) {
  const at = new Set();
  const cmd = words.findIndex((w) => !ASSIGN_RE.test(w));
  if (cmd === -1 || !GH_RE.test(basename(words[cmd])) || !["issue", "pr"].includes(words[cmd + 1]) || !GH_PROSE_VERBS.has(words[cmd + 2])) return at;
  for (let i = cmd + 3; i < words.length; i += 1) {
    if (/^--(title|body|comment)=/.test(words[i])) at.add(i);
    else if (GH_PROSE_FLAGS.has(words[i])) at.add(++i);
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
  if (at === -1) return scripts;
  // `deno eval [options] <code>` (#308): any word after its options may be the code, so each is read as JavaScript.
  if (scriptSubcommand(words, at) === "eval") {
    for (let i = at + 2; i < words.length; i += 1) if (!words[i].startsWith("-")) scripts.set(i, words[i]);
    return scripts;
  }
  if (!EVAL_PROGRAM_RE.test(basename(words[at])) && !(/[*?[{]/.test(words[at]) && mayBeNode(words[at]))) return scripts;
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
function walk(cmd, depth, visit, onOpaque, onEval, collapse = false) {
  let lexed;
  try {
    lexed = lexBodies(cmd, collapse);
  } catch {
    onOpaque(cmd);
    return;
  }
  const nested = (text) => (depth >= MAX_DEPTH ? onOpaque(text) : walk(text, depth + 1, visit, onOpaque, onEval, collapse));
  const dataOnly = depth === 0 && isDataOnly(lexed);
  const scan = (words, stdin, piped = false, written = false, textOut = false) => {
    if (!dataOnly) visit(words, stdin);
    const scripts = dataOnly ? new Map() : evalScripts(words);
    const programs = programWords(words);
    // Only a word that names the queue script or start.mjs is read, so an unresolved `$` in an awk program is no new denial (#588).
    if (!dataOnly) for (const w of awkNamedWords(words, piped || cmd.includes("<("))) if (/(queue|start)\.mjs/i.test(jsNames(unliteral(w)))) onEval(unliteral(w));
    const prose = proseWords(words);
    const literal = textOut ? literalTextWords(words) : new Set();
    // A search's pattern is no script (#404), unless a shell reads the output or a here-string in the call could be
    // mistaken for the pattern (`grep <<< "…" x`, whose here-string grep reads as its input and prints).
    const patterns = piped || cmd.includes("<<<") ? new Set() : searchPatterns(words);
    // A jq program or Go template is no shell text (#576), so one naming queue.mjs only in its text is no run, unless the
    // call hands the program's output on: any pipe out of it (xargs node, tee), any redirect (`>`, `2>&1`), or a process
    // substitution a shell may read.
    const quiet = piped || written || cmd.includes("<(") ? new Set() : new Set([...programs, ...awkText(words), ...scriptDataWords(words)]);
    const powershellAt = words.findIndex((w) => PS_SHELL_RE.test(basename(w)));
    words.forEach((w, i) => {
      if (scripts.has(i)) onEval(scripts.get(i));
      else if (isNestedScript(w) && !((dataOnly || patterns.has(i) || quiet.has(i)) && !UNRESOLVED_RE.test(w))) {
        // A jq program or Go template keeps its quoted `$` literal: `$s` there is its own variable (#61). PowerShell's
        // text is read with its own rules (#404).
        if (literal.has(i) && !piped && !runsAsShell(words, i)) {
          // Text a program prints or matches: its quoted `$` stays literal, but a name it spells is still read (#669).
          nested(w);
        } else if (prose.has(i) && !piped && !runsAsShell(words, i)) {
          const text = unliteral(w);
          try {
            lexBodies(text);
          } catch {
            // The shell still runs a live `$(…)` or backtick in the word, so only text without one is prose (#477).
            if (!UNRESOLVED_RE.test(w)) return;
          }
          nested(text);
        } else if (powershellAt !== -1 && i > powershellAt && !piped) nested(powershellText(w));
        else nested(piped || runsAsShell(words, i) ? unliteralLive(w) : programs.has(i) ? w : unliteral(w));
      }
    });
    // What a command piped into a shell prints may be its arguments (echo, printf): read them as one live script (#246).
    if (piped && words.length > 1) nested(unliteralLive(words.slice(1).join(" ")));
    // What cmd /c, start, schtasks /tr or a scheduled-task cmdlet starts is a command line of its own (#308), also
    // when find -exec or xargs runs the launcher.
    if (!dataOnly) for (const line of launchedCommands(words)) nested(line);
  };
  for (const [k, words] of resolveSegments(lexed.segments).entries()) {
    scan(words, lexed.stdin[k], feedsShell(lexed.segments, lexed.pipes, k), lexed.writes[k] !== false || lexed.pipes[k] === true, !cmd.includes("<(") && !cmd.includes(">(") && outputStaysText(lexed, k));
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
  // A glob that could expand to node (`n*de`, `[n]ode`) runs node too (#378); a command that only prints or searches
  // runs none of its arguments, glob or `node`, and one that prints them only a glob its output would run (#404).
  const nodeAt = nodeWordAt(own);
  const scripts = scriptCandidates(plain, nodeAt);
  return { plain, nodeAt, scripts, counts: (i) => i < own.length || scripts.has(i) };
}

/**
 * True when word `i` is data for the script node runs, not something node runs: node is the command word, the script
 * word before `i` is not itself node-like (`node node -ArgumentList …`, how a PowerShell launcher reads, leaves the rest
 * unknown), and `i` is neither a script candidate nor an option before the script (`-r x`, `--import=x`).
 */
function isScriptData(plain, nodeAt, scripts, i) {
  const scriptEnd = Math.max(-1, ...scripts);
  const script = plain[Math.min(...scripts)] ?? "";
  // Only a script known to take its arguments as data: a runner (`node tsx/cli.mjs queue.mjs`) or launcher runs them (#502).
  return nodeAt === 0 && DATA_SCRIPT_RE.test(script) && !mayBeNode(script) && !scripts.has(i) && !(plain[i].startsWith("-") && (scripts.size === 0 || i < scriptEnd));
}

/**
 * The indexes of a simple command's words (assignments counted) that are data for a script that takes its arguments as
 * data (DATA_SCRIPT_RE): a quoted argument holding several paths (`--paths 'a queue.mjs b'`, #576) is no shell text.
 */
function scriptDataWords(words) {
  const at = new Set();
  if (!words.some((w) => DATA_SCRIPT_RE.test(w))) return at;
  const index = [];
  words.forEach((w, i) => {
    if (!ASSIGN_RE.test(w)) index.push(i);
  });
  const { plain, nodeAt, scripts } = commandWords(words);
  if (nodeAt === -1) return at;
  plain.forEach((_, k) => {
    if (isScriptData(plain, nodeAt, scripts, k)) at.add(index[k]);
  });
  return at;
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
      // Node runs the first script word and the values of options before it; a word after the script is that script's
      // data (`node lessons.mjs --paths … start.mjs`, #441). An option word (`-r start.mjs`, `--import=start.mjs`) counts
      // up to there.
      // Only when node is the command word itself: behind another program (`rg --pre node x start.mjs`) node's arguments
      // are not known.
      const isNodeData = (i) => isScriptData(plain, nodeAt, scripts, i);
      plain.forEach((w, i) => {
        if (!counts(i)) return;
        // Unquoted `scripts\lanes\start.mjs` loses its backslashes in the lexer, as in bash: match the word's end.
        if (START_WORD_RE.test(w) && (i === 0 || (nodeAt !== -1 && nodeAt < i && !isNodeData(i)))) out.push({ issues: undefined, standalone: false });
        // A glob that could expand to start.mjs, as the command word or node's script (#308).
        else if (mayExpandTo(w, START_NAMES) && (i === 0 || scripts.has(i))) out.push({ issues: undefined, standalone: false });
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
        // A word after node's script is that script's data (`node lessons.mjs --paths … queue.mjs`, #502), as for start.mjs.
        if (QUEUE_WORD_RE.test(w) && (i === 0 || (nodeAt !== -1 && nodeAt < i && !isScriptData(plain, nodeAt, scripts, i)))) found = true;
        else if (mayExpandTo(w, QUEUE_NAMES) && (i === 0 || scripts.has(i))) found = true;
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

/**
 * Whether a simple command anywhere in a Bash command, nested scripts included, runs shell text known only at run time
 * (shell-lex.mjs's runtimeTextWords: `eval "$X"`, `source "$F"`, `sh -c "$(cat f)"`), which could be any command
 * (#378), as `found`; and `leading`, when such text starts with the expansion, so nothing of it is known at all.
 */
function scanRuntimeText(command) {
  let found = false;
  let leading = false;
  walk(
    String(command ?? ""),
    0,
    (words) => {
      for (const w of runtimeTextWords(words)) {
        found = true;
        if (w[0] === "$" || w[0] === "`" || w[0] === QUOTED_TICK) leading = true;
      }
    },
    () => {},
    () => {},
  );
  return { found, leading };
}

/** True when a simple command anywhere in a Bash command, nested scripts included, creates or pushes a v* tag (#404). */
function scanReleaseTags(command) {
  let found = false;
  // Read as written, and with each `$(…)` as one word of its statement, which it would otherwise end (#477).
  for (const collapse of [false, true]) {
    walk(
      String(command ?? ""),
      0,
      (words) => {
        if (releaseTagCommand(words)) found = true;
      },
      () => {},
      () => {},
      collapse,
    );
  }
  return found;
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
      const at = words.findIndex(isClaude);
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
  // A v* tag, made or pushed, is the owner's alone, whatever grant there is (ADR 0017, #404).
  if (scanReleaseTags(command)) return { decision: "deny", reason: TAG_DENY_REASON };
  const bg = scanBgLaunches(command);
  if (bg.found) return { decision: "deny", reason: bg.unparsed ? PARSE_DENY_REASON : BG_DENY_REASON };
  // Before any grant is read: no /start grant, of any form, reaches queue.mjs.
  const queue = scanQueueInvocations(command);
  if (queue.found) return { decision: "deny", reason: QUEUE_DENY_REASON };
  // Shell text known only at run time could be either script or claude --bg: denied whatever grant there is (#378).
  // Text that starts with the expansion (`eval "$X"`) gets this reason; text with a known start whose program word
  // is the unknown part (`bash -c "x |$Y"`) keeps the reason below. Only the reason differs: both deny.
  const runtimeText = scanRuntimeText(command);
  if (runtimeText.leading) return { decision: "deny", reason: RUNTIME_TEXT_DENY_REASON };
  // A program named only at run time could be either script (findStartInvocations denies the same words); a command
  // that names start.mjs keeps the start reason. Only the reason differs: both deny.
  if (queue.unresolved && !/start\.mjs/i.test(dequoted(withoutLiteralSubstitutions(command)))) return { decision: "deny", reason: UNRESOLVED_DENY_REASON };
  if (runtimeText.found) return { decision: "deny", reason: RUNTIME_TEXT_DENY_REASON };
  const found = startInvocations(command, typed);
  // A WMI/CIM process creation's literal command line was read above; one built at run time could be anything (#316).
  // For the PowerShell tool a hashtable or expression reads as `$` in the Bash text, so that is where it is looked for.
  if (found.length === 0) return wmiProcessCreate(typed) && UNRESOLVED_RE.test(command) ? { decision: "deny", reason: WMI_DENY_REASON } : null;
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
