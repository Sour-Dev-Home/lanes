// scripts/lanes/shell-lex.mjs — the shell lexing both guards share (#194): heredocs, literal $(cat <<'EOF' … EOF)
// substitutions, redirection targets, and the lexer approve-guard.mjs reads commands with. start-guard.mjs keeps its
// own lexer (another return shape, with arithmetic and backtick bodies) but reads heredocs through the helpers here.

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
export function lex(cmd) {
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
        pending.push({ segment: segments.at(-1), ...heredocOperator(doc) });
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
