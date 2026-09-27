// scripts/lanes/start-guard.mjs — the barrier between a session and launching lanes (#51, from the #18 security review).
// Wired in .claude/settings.json next to approve-guard.mjs, as two hooks:
//   UserPromptSubmit: node scripts/lanes/start-guard.mjs user-prompt-submit
//     a prompt that is exactly `/start <N> [<N> ...]` writes a grant { sessionId, issues, at } to
//     .lanes/start/<session>.json; any other prompt in that session deletes it.
//   PreToolUse (Bash): node scripts/lanes/start-guard.mjs pre-tool-use
//     `start.mjs` is allowed once, only as the plain `node scripts/lanes/start.mjs <N ...>`, only with a grant from this
//     session under 15 minutes old for the same issue numbers. Every other start.mjs run is denied. A direct
//     `claude --bg` is always denied: start.mjs launches lanes itself (execFileSync, not a Bash tool call), so no
//     session ever needs it. Anything else gets no decision. A deny holds in every permission mode.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const GRANT_TTL_MS = 15 * 60 * 1000;
export const DENY_REASON = "lanes are launched only from /start <N> typed by the owner in this session";
export const BG_DENY_REASON = "claude --bg is never run directly; the owner launches lanes with /start <N>";
const SESSION_RE = /^[A-Za-z0-9_-]{1,128}$/;
const START_PROMPT_RE = /^\/start((?:\s+[1-9][0-9]{0,8})+)$/;
// The only form that may be allowed: the plain command with plain issue numbers, nothing chained, wrapped or redirected.
const PLAIN_RE = /^node scripts\/lanes\/start\.mjs((?: [1-9][0-9]{0,8})+)$/;
const START_WORD_RE = /start\.mjs$/i;
const NODE_RE =/^(node|nodejs|bun|deno)(\.exe)?$/i;
const CLAUDE_RE = /^claude(-code)?(\.exe|\.cmd|\.ps1)?$/i;
const BG_FLAG_RE = /^--(bg|background)(=.*)?$/;
const MAX_DEPTH = 4;

const basename = (w) => w.split(/[\\/]/).at(-1);

/** The issue numbers of a prompt that is exactly `/start <N> [<N> ...]` (surrounding whitespace ignored), else null. */
export function parseStartPrompt(prompt) {
  if (typeof prompt !== "string") return null;
  const m = START_PROMPT_RE.exec(prompt.trim());
  return m ? m[1].trim().split(/\s+/).map(Number) : null;
}

/** UserPromptSubmit: grant for `/start <N ...>`, clear for any other prompt, nothing for a session id unsafe as a file name. */
export function onUserPromptSubmit(input, now = Date.now()) {
  const sessionId = input?.session_id;
  if (typeof sessionId !== "string" || !SESSION_RE.test(sessionId)) return { action: "none" };
  const issues = parseStartPrompt(input.prompt);
  if (issues === null) return { action: "clear", sessionId };
  return { action: "grant", sessionId, grant: { sessionId, issues, at: new Date(now).toISOString() } };
}

/**
 * Shell-ish lexer (the same rules as approve-guard.mjs): words (quotes and backslashes resolved, nothing expanded)
 * grouped into simple commands split on ; & | ( ) newlines and redirections. Throws on an unterminated quote.
 * @returns {string[][]}
 */
function lex(cmd) {
  const segments = [[]];
  let word = null;
  const endWord = () => {
    if (word !== null) segments.at(-1).push(word);
    word = null;
  };
  const endSegment = () => {
    endWord();
    if (segments.at(-1).length > 0) segments.push([]);
  };
  for (let i = 0; i < cmd.length; i += 1) {
    const c = cmd[i];
    if (c === "'") {
      const end = cmd.indexOf("'", i + 1);
      if (end === -1) throw new Error("unterminated '");
      word = (word ?? "") + cmd.slice(i + 1, end);
      i = end;
    } else if (c === '"') {
      let j = i + 1;
      let s = "";
      for (; j < cmd.length && cmd[j] !== '"'; j += 1) {
        if (cmd[j] === "\\" && '"\\$`'.includes(cmd[j + 1] ?? "")) j += 1;
        s += cmd[j];
      }
      if (j >= cmd.length) throw new Error('unterminated "');
      word = (word ?? "") + s;
      i = j;
    } else if (c === "\\") {
      if (cmd[i + 1] !== "\n") word = (word ?? "") + (cmd[i + 1] ?? "");
      i += 1;
    } else if (";&|()\n\r".includes(c)) {
      endSegment();
    } else if ("<>".includes(c) || /\s/.test(c)) {
      endWord();
    } else {
      word = (word ?? "") + c;
    }
  }
  endSegment();
  return segments.filter((s) => s.length > 0);
}

const ASSIGN_RE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;
const VAR_REF_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;
// What is left of a word after substitution that could still expand to anything.
const UNRESOLVED_RE = /[$`]/;

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
 * Walks every simple command of `cmd`, recursing into every quoted script. `visit(words)` is called per simple
 * command; `onOpaque(text)` for a part that cannot be read (unterminated quote, nesting too deep), which the caller
 * fails closed on when the text names what it looks for.
 */
function walk(cmd, depth, visit, onOpaque) {
  let segments;
  try {
    segments = lex(cmd);
  } catch {
    onOpaque(cmd);
    return;
  }
  for (const words of resolveSegments(segments)) {
    visit(words);
    for (const w of words) {
      if (!isNestedScript(w)) continue;
      if (depth >= MAX_DEPTH) onOpaque(w);
      else walk(w, depth + 1, visit, onOpaque);
    }
  }
}

/**
 * Every run of `start.mjs` in a Bash command: the script as the command itself, or as an argument of node, including
 * runs behind env, chains, subshells or `bash -c`. `standalone` is true only for the plain
 * `node scripts/lanes/start.mjs <N ...>` with nothing around it. Merely naming the file (cat, git diff) is not a run.
 * @returns {{ issues: number[] | undefined, standalone: boolean }[]}
 */
export function findStartInvocations(command) {
  const cmd = String(command ?? "");
  const out = [];
  walk(
    cmd,
    0,
    (words) => {
      const plain = words.filter((w) => !ASSIGN_RE.test(w));
      const nodeAt = plain.findIndex((p) => NODE_RE.test(basename(p)));
      const scriptAt = nodeAt === -1 ? -1 : plain.findIndex((p, i) => i > nodeAt && !p.startsWith("-"));
      plain.forEach((w, i) => {
        // Unquoted `scripts\lanes\start.mjs` loses its backslashes in the lexer, as in bash: match the word's end.
        if (START_WORD_RE.test(w) && (i === 0 || (nodeAt !== -1 && nodeAt < i))) out.push({ issues: undefined, standalone: false });
        // The command word, or the script node runs, that still holds `$` or a backtick could expand to start.mjs.
        else if (UNRESOLVED_RE.test(w) && (i === 0 || i === scriptAt)) out.push({ issues: undefined, standalone: false });
      });
    },
    (text) => {
      if (/start\.mjs/i.test(text)) out.push({ issues: undefined, standalone: false });
    },
  );
  // No raw-text fallback: `node $(echo …start.mjs)` and backticks leave `$` or a backtick in the script word, which
  // the visitor above already counts, and one would deny `git commit -m "…start.mjs" && echo "$X"`.
  // A trailing newline the model appends to a Bash command must not turn the plain command into a wrapped one.
  const m = PLAIN_RE.exec(cmd.trim());
  if (out.length === 1 && m) out[0] = { issues: m[1].trim().split(" ").map(Number), standalone: true };
  return out;
}

/** True when a Bash command runs `claude --bg` (or `--background`) directly, behind any wrapper, or cannot be read. */
export function findBgLaunches(command) {
  const cmd = String(command ?? "");
  let found = false;
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
      if (/--(bg|background)/.test(text)) found = true;
    },
  );
  // `$(which claude) --bg`: the lexer splits the substitution off, so claude and its flag land in different simple
  // commands. Only a `$(` that names claude, with a --bg word in the same call, fails closed; an unrelated "$VAR" does not.
  if (!found && /\$\([^)]*claude/i.test(cmd) && /(^|[\s'"])--(bg|background)([=\s'"]|$)/.test(cmd)) found = true;
  return found;
}

function validGrant(grant) {
  return (
    grant !== null &&
    typeof grant === "object" &&
    typeof grant.sessionId === "string" &&
    Array.isArray(grant.issues) &&
    grant.issues.length > 0 &&
    grant.issues.every((n) => Number.isSafeInteger(n) && n > 0) &&
    new Set(grant.issues).size === grant.issues.length &&
    typeof grant.at === "string" &&
    !Number.isNaN(Date.parse(grant.at))
  );
}

const sameIssues = (a, b) => a.length === b.length && [...a].sort((x, y) => x - y).every((n, i) => n === [...b].sort((x, y) => x - y)[i]);

/**
 * PreToolUse: null (no decision) unless the command runs `claude --bg` or `start.mjs`. `claude --bg` is always denied;
 * start.mjs is allowed only with this session's fresh grant for the same issues, and denied otherwise.
 * @param grant the session's grant file as parsed, null when there is none, or { unreadable: true }
 * @returns {null | { decision: "allow", reason: string, consumeGrant: true } | { decision: "deny", reason: string }}
 */
export function decidePreToolUse(input, grant, now = Date.now()) {
  if (input?.tool_name !== "Bash") return null;
  const command = input.tool_input?.command;
  if (findBgLaunches(command)) return { decision: "deny", reason: BG_DENY_REASON };
  const found = findStartInvocations(command);
  if (found.length === 0) return null;
  const deny = { decision: "deny", reason: DENY_REASON };
  const sessionId = input.session_id;
  if (found.length !== 1 || !found[0].standalone) return deny;
  if (typeof sessionId !== "string" || !SESSION_RE.test(sessionId) || !validGrant(grant)) return deny;
  if (grant.sessionId !== sessionId || !sameIssues(grant.issues, found[0].issues)) return deny;
  const age = now - Date.parse(grant.at);
  if (age < 0 || age >= GRANT_TTL_MS) return deny;
  return { decision: "allow", reason: `owner launch from /start ${grant.issues.join(" ")} in this session`, consumeGrant: true };
}

function readGrant(file) {
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
      // Never block a prompt; a grant that was not written only means start.mjs is denied.
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
      if (d.decision === "allow") rmSync(file); // single use; if it cannot be removed, the catch below denies
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
