// scripts/lanes/approve-guard.mjs — the barrier between a session and posting review/owner (owner decision, 2026-09-27).
// Wired in .claude/settings.json as two hooks:
//   UserPromptSubmit: node scripts/lanes/approve-guard.mjs user-prompt-submit
//     a prompt that is exactly `/approve <N>` writes a grant { sessionId, pr: N, at } to .lanes/approve/<session>.json;
//     any other prompt in that session deletes it.
//   PreToolUse (Bash): node scripts/lanes/approve-guard.mjs pre-tool-use
//     `post-review.mjs owner` is allowed (no prompt) once, only as the plain command, only with a grant from this
//     session under 15 minutes old for the same --pr. Every other owner command is denied; anything else gets no
//     decision. A PreToolUse `allow` cannot skip an `ask` rule (observed on 2.1.283), so there is no `ask` rule for
//     the owner command any more: this hook's deny is the barrier, and it holds in every permission mode.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const GRANT_TTL_MS = 15 * 60 * 1000;
export const DENY_REASON = "owner approval only from /approve <N> in this session";
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

/** UserPromptSubmit: grant for `/approve <N>`, clear for any other prompt, nothing for a session id unsafe as a file name. */
export function onUserPromptSubmit(input, now = Date.now()) {
  const sessionId = input?.session_id;
  if (typeof sessionId !== "string" || !SESSION_RE.test(sessionId)) return { action: "none" };
  const pr = parseApprovePrompt(input.prompt);
  if (pr === null) return { action: "clear", sessionId };
  return { action: "grant", sessionId, grant: { sessionId, pr, at: new Date(now).toISOString() } };
}

/**
 * Shell-ish lexer: words (quotes and backslashes resolved, nothing expanded) grouped into simple commands split on
 * ; & | ( ) newlines and redirections. Throws on an unterminated quote.
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
const NODE_RE = /^(node|nodejs)(\.exe)?$/i;
// Commands that only print, list or search their arguments: a "node" among them is never run. Every other command
// word may be a wrapper (env, sudo, time, xargs, …), so a "node" behind it counts.
const NON_RUNNING_COMMANDS = new Set(["echo", "printf", "grep", "egrep", "fgrep", "rg", "ls", "which", "where", "whereis", "type", "cat", "head", "tail", "wc", "file", "stat", "man"]);
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

/** `NAME=value` words anywhere in the command's segments, in order, so a later assignment overrides an earlier one. */
function collectAssignments(segments) {
  const assignments = {};
  for (const words of segments) {
    for (const w of words) {
      const m = ASSIGN_RE.exec(w);
      if (m) assignments[m[1]] = m[2];
    }
  }
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

function scan(cmd, depth, out) {
  let segments;
  try {
    segments = lex(cmd);
  } catch {
    if (/post-review/i.test(cmd)) out.push({ pr: undefined, standalone: false });
    return;
  }
  // `S=scripts/lanes/post-review.mjs; node $S owner … --pr N` must be caught too: resolve same-command
  // `NAME=value` assignments into later `$NAME`/`${NAME}` references before looking for the script and its args.
  const assignments = collectAssignments(segments);
  for (const rawWords of segments) {
    const words = resolveVars(rawWords, assignments);
    // The command word and the script node runs (also behind env, time or sudo), counted without `NAME=value` words.
    const plain = words.filter((w) => !ASSIGN_RE.test(w));
    // Node's options and the script: any of them that still holds `$` or a backtick could load or be post-review.mjs.
    // Every word that looks like node counts, since an earlier one may only be an argument (`sudo -u node node …`).
    const nodeRange = new Set();
    const runsArgs = !NON_RUNNING_COMMANDS.has(plain[0]?.split(/[\\/]/).at(-1));
    plain.forEach((p, at) => {
      if ((at > 0 && !runsArgs) || !NODE_RE.test(p.split(/[\\/]/).at(-1))) return;
      for (let j = at + 1; j <= nodeScriptEnd(plain, at); j += 1) nodeRange.add(j);
    });
    plain.forEach((w, i) => {
      if (/[\s;&|()<>]/.test(w) && /post-review|[$`]/i.test(w)) {
        // A quoted script, as in bash -c "…", sh -c '…' or eval "…": scan it as a command of its own. One that still
        // holds `$` may splice a name inside it, so it is scanned too.
        if (depth >= MAX_DEPTH) out.push({ pr: undefined, standalone: false });
        else scan(w, depth + 1, out);
      } else if (POST_REVIEW_RE.test(w)) {
        const { reviewer, pr } = readPostReviewArgs(plain.slice(i + 1));
        // Fail closed: a reviewer word that could expand to anything counts as the owner.
        if (reviewer === "owner" || (reviewer !== undefined && /[$`*?[]/.test(reviewer))) out.push({ pr, standalone: false });
      } else if (UNRESOLVED_RE.test(w) && (i === 0 || nodeRange.has(i))) {
        // The command word, or a node option or the script node runs, that could still expand to post-review.mjs:
        // fail closed.
        out.push({ pr: undefined, standalone: false });
      }
    });
  }
}

/**
 * Every `post-review.mjs owner` invocation in a Bash command, including ones behind env, chains, subshells or
 * `bash -c`. `standalone` is true only for the plain `node scripts/lanes/post-review.mjs owner …` with nothing around it.
 * @returns {{ pr: string | undefined, standalone: boolean }[]}
 */
export function findOwnerInvocations(command) {
  const cmd = String(command ?? "");
  // Without the name or a substitution that could splice it (`post-$X.mjs`), there is nothing to find.
  if (!/post-review|[$`]/i.test(cmd)) return [];
  const out = [];
  scan(cmd, 0, out);
  // Deeper indirection (a variable built from another, `$(…)`, backticks) cannot be resolved statically: with an
  // `owner` word and a substitution anywhere, fail closed and count it as an owner command.
  if (out.length === 0 && /[$`]/.test(cmd) && /(^|[\s'"`(])owner($|[\s'"`)])/.test(cmd)) out.push({ pr: undefined, standalone: false });
  // Leading/trailing whitespace (a trailing newline the model appends to a Bash command is common) must not turn the
  // plain command into a "wrapped" one: trim before checking the exact prefix and for embedded shell metacharacters.
  const trimmedCmd = cmd.trim();
  if (out.length === 1 && out[0].pr !== undefined && trimmedCmd.startsWith(PLAIN_PREFIX) && !SHELL_META_RE.test(trimmedCmd)) {
    const segments = lex(trimmedCmd); // scan() lexed this cmd already, so it cannot throw here
    if (segments.length === 1 && segments[0][1] === "scripts/lanes/post-review.mjs" && segments[0][2] === "owner") out[0].standalone = true;
  }
  return out;
}

function validGrant(grant) {
  return grant !== null && typeof grant === "object" && typeof grant.sessionId === "string" && Number.isSafeInteger(grant.pr) && grant.pr > 0 && typeof grant.at === "string" && !Number.isNaN(Date.parse(grant.at));
}

/**
 * PreToolUse: null (no decision) unless the command runs `post-review.mjs owner`; then allow only with this session's
 * fresh grant for the same --pr, and deny everything else.
 * @param grant the session's grant file as parsed, null when there is none, or { unreadable: true }
 * @returns {null | { decision: "allow", reason: string, consumeGrant: true } | { decision: "deny", reason: string }}
 */
export function decidePreToolUse(input, grant, now = Date.now()) {
  if (input?.tool_name !== "Bash") return null;
  const found = findOwnerInvocations(input.tool_input?.command);
  if (found.length === 0) return null;
  const deny = { decision: "deny", reason: DENY_REASON };
  const sessionId = input.session_id;
  if (found.length !== 1 || !found[0].standalone) return deny;
  if (typeof sessionId !== "string" || !SESSION_RE.test(sessionId) || !validGrant(grant)) return deny;
  if (grant.sessionId !== sessionId || String(grant.pr) !== found[0].pr) return deny;
  const age = now - Date.parse(grant.at);
  if (age < 0 || age >= GRANT_TTL_MS) return deny;
  return { decision: "allow", reason: `owner approval from /approve ${grant.pr} in this session`, consumeGrant: true };
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
      if (d.decision === "allow") rmSync(file); // single use; if it cannot be removed, the catch below denies
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
    const dir = fileURLToPath(new URL("../../.lanes/approve/", import.meta.url));
    out = runHook(process.argv[2], readFileSync(0, "utf8"), { dir });
  } catch {
    out = process.argv[2] === "user-prompt-submit" ? "" : preToolUseOutput("deny", DENY_REASON);
  }
  process.stdout.write(out);
}
