// scripts/lanes/shell-lex.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CAT_HEREDOC_RE, HEREDOC_RE, heredocOperator, lex, literalSubstitution, readHeredoc, skipRedirectTarget, unmark } from "./shell-lex.mjs";

const source = (name) => readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
// A lexed segment's words with the literal stand-ins turned back into their characters.
const words = (seg) => [...seg].map(unmark);

test("#194 criterion 1: shell-lex exports the heredoc reader, the literal substitution and the lexer", () => {
  assert.equal(typeof readHeredoc, "function");
  assert.equal(typeof literalSubstitution, "function");
  assert.equal(typeof lex, "function");
  const segments = lex("cat <<'EOF' > out.txt\nbody\nEOF\ngit commit -m \"$(cat <<'M'\nmsg\nM\n)\"");
  assert.equal(segments.length, 2);
  assert.deepEqual(words(segments[0]), ["cat"]);
  assert.deepEqual(segments[0].redirects, [{ text: " out.txt", herestring: false, toFile: true }]);
  assert.deepEqual(segments[0].heredocs, [{ body: "body", quoted: true }]);
  assert.deepEqual(words(segments[1]), ["git", "commit", "-m", "msg"]);
  assert.deepEqual([...segments[1].literal], [3]);
});

test("#194 criterion 2: both guards import shell-lex.mjs and keep no copy of its heredoc helpers", () => {
  for (const name of ["approve-guard.mjs", "start-guard.mjs"]) {
    const text = source(name);
    assert.match(text, /^import \{[^}]*\} from "\.\/shell-lex\.mjs";$/m, `${name} imports shell-lex.mjs`);
    for (const def of [/function readHeredoc\b/, /function literalSubstitution\b/, /const HEREDOC_RE\b/, /const CAT_HEREDOC_RE\b/]) {
      assert.doesNotMatch(text, def, `${name} defines ${def.source}`);
    }
  }
  assert.match(source("approve-guard.mjs"), /import \{[^}]*\blex\b[^}]*\} from "\.\/shell-lex\.mjs"/);
});

test("#194 criterion 4: heredocs, quoted, unquoted, <<-, <<\\EOF and unterminated", () => {
  const quoted = lex("cat <<'EOF'\n$(x)\nEOF");
  assert.deepEqual(quoted[0].heredocs, [{ body: "$(x)", quoted: true }]);
  assert.deepEqual(lex('cat <<"EOF"\na\nEOF')[0].heredocs, [{ body: "a", quoted: true }]);
  assert.deepEqual(lex("cat <<EOF\n$(x)\nEOF")[0].heredocs, [{ body: "$(x)", quoted: false }]);
  assert.deepEqual(lex("cat <<\\EOF\n$(x)\nEOF")[0].heredocs, [{ body: "$(x)", quoted: true }]);
  // <<- strips leading tabs from every line, the delimiter line included.
  assert.deepEqual(lex("cat <<-EOF\n\t\tone\n\tEOF\necho after")[0].heredocs, [{ body: "one", quoted: false }]);
  assert.deepEqual(words(lex("cat <<-EOF\n\t\tone\n\tEOF\necho after")[1]), ["echo", "after"]);
  // Unterminated: the body runs to the end, as in bash, and nothing after it is lexed as a command.
  const open = lex("cat <<EOF\nnode x.mjs\nmore");
  assert.equal(open.length, 1);
  assert.deepEqual(open[0].heredocs, [{ body: "node x.mjs\nmore", quoted: false }]);
  assert.deepEqual(readHeredoc("a\nb", 0, "EOF", false), { body: "a\nb", end: 3, terminated: false });
  assert.deepEqual(readHeredoc("a\r\nEOF\nrest", 0, "EOF", false), { body: "a", end: 6, terminated: true });
});

test("#194 criterion 4: redirection targets are no words and keep their raw text", () => {
  const [seg] = lex("node post-review.mjs 2>err.log >> 'out file' < in.txt test-hunter");
  assert.deepEqual(words(seg), ["node", "post-review.mjs", "test-hunter"]);
  assert.deepEqual(seg.redirects, [
    { text: "err.log", herestring: false, toFile: true },
    { text: " 'out file'", herestring: false, toFile: true },
    { text: " in.txt", herestring: false, toFile: false },
  ]);
  assert.deepEqual(lex("cmd 2>&1")[0].redirects, [{ text: "1", herestring: false, toFile: false }]);
  assert.deepEqual(lex('bash <<< "echo hi"')[0].redirects, [{ text: ' "echo hi"', herestring: true, toFile: false }]);
  assert.equal(skipRedirectTarget('> "a b"; next', 1), 7);
});

test("#194 criterion 4: literal $(cat <<'EOF' … EOF) substitutions", () => {
  const cmd = "$(cat <<'EOF'\nhello $(world)\nEOF\n) tail";
  assert.deepEqual(literalSubstitution(cmd, 0), { body: "hello $(world)", end: cmd.indexOf(")", cmd.indexOf("EOF\n)")) });
  // Unquoted: a body that runs a command while it expands is no literal; a plain $VAR is, unless the caller says so.
  assert.equal(literalSubstitution("$(cat <<EOF\n$(x)\nEOF\n)", 0), null);
  assert.equal(literalSubstitution("$(cat <<EOF\n`x`\nEOF\n)", 0), null);
  assert.deepEqual(literalSubstitution("$(cat <<EOF\n$HOME\nEOF\n)", 0)?.body, "$HOME");
  assert.equal(literalSubstitution("$(cat <<EOF\n$HOME\nEOF\n)", 0, /[$`\\]/), null);
  assert.deepEqual(literalSubstitution("$(cat <<\\EOF\n$(x)\nEOF\n)", 0)?.body, "$(x)");
  assert.deepEqual(literalSubstitution("$(cat <<-'EOF'\n\tx\n\tEOF\n)", 0)?.body, "x");
  // Not one: another command, no newline after the operator, no closing `)`, or an unterminated body.
  assert.equal(literalSubstitution("$(echo <<'EOF'\nx\nEOF\n)", 0), null);
  assert.equal(literalSubstitution("$(cat <<'EOF' x\nEOF\n)", 0), null);
  assert.equal(literalSubstitution("$(cat <<'EOF'\nx\nEOF\n; )", 0), null);
  assert.equal(literalSubstitution("$(cat <<'EOF'\nx", 0), null);
});

test("#194 edge: the operator reads the same delimiter from either regex", () => {
  for (const [text, want] of [
    ["<<EOF", { delim: "EOF", stripTabs: false, quoted: false }],
    ["<<-'E F'", { delim: "E F", stripTabs: true, quoted: true }],
    ['<< "EOF"', { delim: "EOF", stripTabs: false, quoted: true }],
    ["<<\\EOF", { delim: "EOF", stripTabs: false, quoted: true }],
    ["<<-\\EOF", { delim: "EOF", stripTabs: true, quoted: true }],
  ]) {
    assert.deepEqual(heredocOperator(HEREDOC_RE.exec(text)), want, text);
    assert.deepEqual(heredocOperator(CAT_HEREDOC_RE.exec(`$(cat ${text}\n`)), want, `$(cat ${text}`);
  }
  assert.equal(HEREDOC_RE.exec("<<<x"), null);
  assert.equal(HEREDOC_RE.exec("<<$x"), null);
});

test("#194 edge: empty input, an empty body, two heredocs on one line, and unterminated quotes", () => {
  assert.deepEqual(lex(""), []);
  assert.deepEqual(lex("cat <<'EOF'\nEOF")[0].heredocs, [{ body: "", quoted: true }]);
  const two = lex("cat <<A <<'B'\none\nA\ntwo\nB\necho z");
  assert.deepEqual(two[0].heredocs, [{ body: "one", quoted: false }, { body: "two", quoted: true }]);
  assert.deepEqual(words(two[1]), ["echo", "z"]);
  assert.throws(() => lex("echo 'open"), /unterminated '/);
  assert.throws(() => lex('echo "open'), /unterminated "/);
  assert.throws(() => lex("echo "), /private-use/);
});

test("#194 edge: segments, pipes and literal marking", () => {
  const segs = lex("a | b || c; d & e");
  assert.deepEqual(segs.map(words), [["a"], ["b"], ["c"], ["d"], ["e"]]);
  assert.equal(segs[0].pipedOut, true);
  assert.equal(segs[1].pipedOut, undefined);
  // A quoted `$` is marked literal (not the live character); unmark restores it.
  const [seg] = lex("echo '$x' \"$y\"");
  assert.notEqual(seg[1], "$x");
  assert.equal(unmark(seg[1]), "$x");
  assert.equal(seg[2], "$y");
});

test("#194 edge: a bare literal substitution word, a backslash in a redirect target, and CRLF heredocs", () => {
  const [seg] = lex("echo $(cat <<'EOF'\nhi $HOME\nEOF\n) tail");
  assert.deepEqual(words(seg), ["echo", "hi $HOME", "tail"]);
  assert.ok(seg.literal.has(1));
  assert.equal(skipRedirectTarget("> a\\ b c", 1), 6);
  const r = readHeredoc("a\r\nEOF\r\n", 0, "EOF", false);
  assert.deepEqual([r.body, r.terminated], ["a", true]);
  assert.equal(literalSubstitution("$(cat <<-\\EOF\r\n\t$(x)\r\n\tEOF\r\n)", 0)?.body, "$(x)");
});
