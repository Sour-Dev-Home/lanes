// scripts/lanes/shell-lex.mjs — the shell reading both guards share (#194, #351): heredocs, literal
// $(cat <<'EOF' … EOF) substitutions, redirection targets, the one lexer both read commands with (each in its own
// shape: approve-guard.mjs's words, start-guard.mjs's `{ bodies: true }`), and the grant-file reader.
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
export const HEREDOC_RE = /^<<(-?)[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|(\\)?([^\s;&|()<>'"`$]+))/;
// `$(cat <<D` and the end of its line: the start of a substitution whose output is only a heredoc's body.
export const CAT_HEREDOC_RE = /^\$\([ \t]*cat[ \t]+<<(-?)[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|(\\)?([A-Za-z0-9_.-]+))[ \t]*\r?\n/;
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
  const m = CAT_HEREDOC_RE.exec(cmd.slice(i));
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
// The opener of a `$(cat <<D` substitution with a delimiter of letters, digits, `_`, `.` or `-` only (bare or quoted,
// and at most the one backslash before a bare word that `<<\EOF` uses), ending its line. Bash unquotes any other
// delimiter (`"E\$F"` is `E$F`) in ways this lexer might not, so that body is never read as literal text (#269), the
// rule start-guard.mjs's PLAIN_DELIM_RE and DELIM_END_RE apply to top-level heredocs (#240).
const PLAIN_CAT_HEREDOC_RE = /^\$\([ \t]*cat[ \t]+<<-?[ \t]*(?:'[A-Za-z0-9_.-]+'|"[A-Za-z0-9_.-]+"|\\?[A-Za-z0-9_.-]+)[ \t]*\r?\n/;
const CAT_OPENER_MAX = 4096;

/**
 * start-guard.mjs's literalSubstitution: `$(cat <<'D' … D)` at `i` with a plain delimiter (PLAIN_CAT_HEREDOC_RE), whose
 * body, if its delimiter is unquoted, holds nothing that could expand (EXPANDS_RE). Null otherwise.
 */
export const plainLiteralSubstitution = (cmd, i) =>
  PLAIN_CAT_HEREDOC_RE.test(cmd.slice(i, i + CAT_OPENER_MAX)) ? literalSubstitution(cmd, i, EXPANDS_RE) : null;

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
export function lex(cmd, { bodies: withBodies = false } = {}) {
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
  const endWord = () => {
    if (word !== null && target) {
      targets.push(word);
      if (target === "stdin") stdin[stdin.length - 1] = word;
      target = false;
    } else if (word !== null) {
      if (wordLiteral) (segments.at(-1).literal ??= new Set()).add(segments.at(-1).length);
      segments.at(-1).push(word);
    }
    word = null;
    wordLiteral = false;
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
        const escaped = cmd[j] === "\\" && '"\\$`'.includes(cmd[j + 1] ?? "");
        if (escaped) j += 1;
        s += escaped || !"$`".includes(cmd[j]) ? quote(cmd[j]) : cmd[j];
      }
      if (j >= cmd.length) throw new Error('unterminated "');
      word = (word ?? "") + s;
      i = j;
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
      const next = withBodies ? bodiesOperator(i) : wordsOperator(i);
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
