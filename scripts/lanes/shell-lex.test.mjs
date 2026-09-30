// scripts/lanes/shell-lex.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CAT_HEREDOC_RE, HEREDOC_RE, LIT_DOLLAR, LIT_TICK, QUOTED_TICK, ansiCString, dequoted, heredocOperator, launchedCommands, lex, literalSubstitution, mark,
  mayBeNode, mayExpandTo, plainLiteralSubstitution, readGrant, readHeredoc, releaseTagCommand, runsRuntimeText, shellTextIndexes, skipRedirectTarget, unmark, wmiProcessCreate,
} from "./shell-lex.mjs";

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
    // A `$(cat <<D` delimiter that is not plain (`'E F'`) is never read as one (#310).
    if (want.delim === "E F") assert.equal(CAT_HEREDOC_RE.exec(`$(cat ${text}\n`), null);
    else assert.deepEqual(heredocOperator(CAT_HEREDOC_RE.exec(`$(cat ${text}\n`)), want, `$(cat ${text}`);
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

// --- one lexer for both guards (#351) -----------------------------------------------------------------------------

// A lexed word with start-guard's stand-ins shown, so an assertion names which character was marked.
const shown = (s) => s.replaceAll(LIT_DOLLAR, "<$>").replaceAll(LIT_TICK, "<`>").replaceAll(QUOTED_TICK, "<'`>");
const lexBodies = (cmd) => {
  const r = lex(cmd, { bodies: true });
  return { ...r, segments: r.segments.map((s) => s.map(shown)), targets: r.targets.map(shown) };
};

test("#351 criterion 1: lex(cmd, { bodies: true }) returns writes, fd duplications, stdin, pipes, targets and bodies", () => {
  assert.deepEqual(lexBodies("cat <<EOF | sh\necho hi\nEOF\nnode < s.js 2>&1 > out.txt"), {
    segments: [["cat"], ["sh"], ["node"]],
    writes: [false, false, "dup"],
    stdin: [undefined, undefined, "s.js"],
    pipes: [true, false, false],
    targets: ["s.js", "1", "out.txt"],
    bodies: [{ text: "echo hi", literal: true, toShell: true, seg: 0, start: 15, end: 26 }],
  });
  // An arithmetic expression, a backtick command (quoted or not) and a substitution in a redirection target are bodies.
  assert.deepEqual(lexBodies('echo "$((x + $(id)))" `whoami` > "`date`.log"'), {
    segments: [["echo", "0", "<'`>whoami<'`>"]],
    writes: [true],
    stdin: [undefined],
    pipes: [false],
    targets: ["`date`.log"],
    bodies: [{ text: "x + $(id)", literal: false }, { text: "whoami", literal: false }, { text: "date", literal: false }],
  });
  // `>>` writes, a here-string stays a word, and `&>` is one operator.
  assert.deepEqual(lexBodies('printf x >> a.txt; cat <<<"hi"').segments, [["printf", "x"], ["cat", "hi"]]);
  assert.deepEqual(lexBodies('printf x >> a.txt; cat <<<"hi"').writes, [true, false]);
  assert.deepEqual(lexBodies("echo &> f"), { segments: [["echo"]], writes: [true], stdin: [undefined], pipes: [false], targets: ["f"], bodies: [] });
});

test("#351 criterion 1: start-guard.mjs has no lexer of its own and calls shell-lex.mjs's", () => {
  const text = source("start-guard.mjs");
  assert.doesNotMatch(text, /function lex\b/);
  assert.match(text, /import \{[^}]*\blex\b[^}]*\} from "\.\/shell-lex\.mjs"/);
  assert.match(text, /\blex\([^)]*\{ bodies: true(, collapse)? \}\)/);
  // Every call asks for start-guard's shape: the words shape would read its commands with approve-guard's rules.
  for (const call of text.matchAll(/\blex\([^)]*\)/g)) assert.match(call[0], /\{ bodies: true(, collapse)? \}/, call[0]);
});

test("#351 criterion 2: readHeredoc, literalSubstitution and readGrant exist once, in shell-lex.mjs, and both guards import from it", () => {
  const lexText = source("shell-lex.mjs");
  for (const name of ["readHeredoc", "literalSubstitution", "readGrant"]) {
    assert.match(lexText, new RegExp(`^export function ${name}\\(`, "m"), `shell-lex.mjs defines ${name}`);
  }
  for (const name of ["approve-guard.mjs", "start-guard.mjs"]) {
    const text = source(name);
    for (const def of [/function readHeredoc\b/, /function literalSubstitution\b/, /function readGrant\b/, /const EXPANDS_RE\b/, /PLAIN_CAT_HEREDOC_RE =/]) {
      assert.doesNotMatch(text, def, `${name} defines ${def.source}`);
    }
    assert.match(text, /import \{[^}]*\breadGrant\b[^}]*\} from "\.\/shell-lex\.mjs"/, `${name} imports readGrant`);
    // start.mjs and post-review.mjs still import readGrant from the guard they belong to.
    assert.match(text, /export \{ readGrant \} from "\.\/shell-lex\.mjs";/, `${name} re-exports readGrant`);
  }
});

test("#351 criterion 3: the WRAPPERS fixture and the #262 criterion 1 test body live once, in shell-lex.fixtures.mjs", () => {
  assert.match(source("shell-lex.fixtures.mjs"), /^export const WRAPPERS = /m);
  for (const name of ["approve-guard.test.mjs", "start-guard.test.mjs"]) {
    const text = source(name);
    assert.doesNotMatch(text, /const WRAPPERS\b/, `${name} keeps its own WRAPPERS`);
    assert.doesNotMatch(text, /test\("#262 criterion 1:/, `${name} keeps its own #262 criterion 1 body`);
    assert.match(text, /import \{[^}]*\bWRAPPERS\b[^}]*\} from "\.\/shell-lex\.fixtures\.mjs"/, `${name} imports the fixture`);
  }
});

test("#351 criterion 5: readHeredoc reads unterminated, tab-stripped, and quoted versus unquoted bodies", () => {
  assert.deepEqual(readHeredoc("one\ntwo", 0, "EOF", false), { body: "one\ntwo", end: 7, terminated: false });
  assert.deepEqual(readHeredoc("", 0, "EOF", false), { body: "", end: 0, terminated: false });
  // Tabs are stripped for <<- only, and only leading ones: a tab-led delimiter ends only a <<- body.
  assert.deepEqual(readHeredoc("\t\tx\ty\n\tEOF\nrest", 0, "EOF", true), { body: "x\ty", end: 10, terminated: true });
  assert.deepEqual(readHeredoc("\tx\n\tEOF\n", 0, "EOF", false), { body: "\tx\n\tEOF", end: 8, terminated: false });
  // A delimiter line must be exactly the delimiter: trailing text does not end the body.
  assert.equal(readHeredoc("EOF x\nEOF", 0, "EOF", false).body, "EOF x");
  // Through each shape of lex: a quoted delimiter's body is literal, an unquoted one is literal only with nothing to expand.
  const bodies = lex("cat <<-'EOF'\n\tx $y\n\tEOF\ncat <<EOF\n$y\nEOF\ncat <<EOF\nplain\nEOF", { bodies: true }).bodies;
  assert.deepEqual(bodies.map((b) => [b.text, b.literal]), [["x $y", true], ["$y", false], ["plain", true]]);
  assert.deepEqual(lex("cat <<-'EOF'\n\tx $y\n\tEOF\ncat <<EOF\n$y\nEOF").map((s) => s.heredocs), [[{ body: "x $y", quoted: true }], [{ body: "$y", quoted: false }]]);
});

test("#351 criterion 5: literalSubstitution and plainLiteralSubstitution", () => {
  const quoted = "$(cat <<'EOF'\n$HOME `x`\nEOF\n)";
  assert.deepEqual(literalSubstitution(quoted, 0), { body: "$HOME `x`", end: quoted.length - 1 });
  assert.deepEqual(plainLiteralSubstitution(quoted, 0), { body: "$HOME `x`", end: quoted.length - 1 });
  // start-guard's rule: an unquoted body with any `$`, backtick or backslash could still expand.
  assert.deepEqual(literalSubstitution("$(cat <<EOF\n$HOME\nEOF\n)", 0)?.body, "$HOME");
  assert.equal(plainLiteralSubstitution("$(cat <<EOF\n$HOME\nEOF\n)", 0), null);
  assert.equal(plainLiteralSubstitution("$(cat <<EOF\na\\b\nEOF\n)", 0), null);
  assert.deepEqual(plainLiteralSubstitution("$(cat <<EOF\nplain\nEOF\n)", 0)?.body, "plain");
  // ...and only a plain delimiter (#269): one bash unquotes in its own way is never read as literal.
  assert.equal(plainLiteralSubstitution("$(cat <<\"E\\$F\"\nx\nE$F\n)", 0), null);
  assert.equal(plainLiteralSubstitution("$(cat <<'E F'\nx\nE F\n)", 0), null);
  assert.deepEqual(literalSubstitution("$(cat <<'EF'\nx\nEF\n)", 0)?.body, "x");
  assert.equal(plainLiteralSubstitution("echo", 0), null);
  assert.equal(plainLiteralSubstitution("x $(cat <<'EOF'\nhi\nEOF\n)", 2)?.body, "hi");
});

test("#351 criterion 5: readGrant tells a missing, unreadable and corrupt grant file apart", () => {
  const dir = mkdtempSync(join(tmpdir(), "shell-lex-grant-"));
  try {
    writeFileSync(join(dir, "ok.json"), '{"sessionId":"s1","pr":5}\n');
    writeFileSync(join(dir, "bad.json"), "{not json");
    writeFileSync(join(dir, "empty.json"), "");
    mkdirSync(join(dir, "a-dir.json"));
    assert.deepEqual(readGrant(join(dir, "ok.json")), { sessionId: "s1", pr: 5 });
    assert.equal(readGrant(join(dir, "missing.json")), null);
    assert.deepEqual(readGrant(join(dir, "bad.json")), { unreadable: true });
    assert.deepEqual(readGrant(join(dir, "empty.json")), { unreadable: true });
    assert.deepEqual(readGrant(join(dir, "a-dir.json")), { unreadable: true }, "a directory is unreadable, not missing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#351 edge: the bodies shape marks only `$` and backticks, and never refuses a stand-in character", () => {
  assert.deepEqual(lexBodies("echo 'a$b`c{d}' \"x\\$y\" \\$z *").segments, [["echo", "a<$>b<`>c{d}", "x<$>y", "<$>z", "*"]]);
  assert.deepEqual(lexBodies("echo ").segments, [["echo", ""]]);
  assert.throws(() => lex("echo "), /private-use/);
});

test("#351 edge: the bodies shape on empty, malformed and unterminated input", () => {
  assert.deepEqual(lex("", { bodies: true }), { segments: [], writes: [], stdin: [], pipes: [], targets: [], bodies: [] });
  assert.deepEqual(lex("   \n ; ", { bodies: true }).segments, []);
  assert.throws(() => lex("echo `open", { bodies: true }), /unterminated `/);
  assert.throws(() => lex('echo "`open"', { bodies: true }), /unterminated `/);
  assert.throws(() => lex("echo 'open", { bodies: true }), /unterminated '/);
  // `$((` with no closing `))` is no arithmetic expansion: it lexes as before, with no body.
  assert.deepEqual(lexBodies("echo $((1 + 2").segments, [["echo", "$"], ["1", "+", "2"]]);
  assert.deepEqual(lexBodies("echo $((1 + 2").bodies, []);
  // An unterminated heredoc's body runs to the end.
  assert.deepEqual(lex("bash <<EOF\nnode x", { bodies: true }).bodies, [{ text: "node x", literal: true, toShell: true, seg: 0, start: 11, end: 17 }]);
});

test("#351 edge: the two shapes read pipes as each guard did", () => {
  // approve-guard's shape marks the group before `| sh`; start-guard's marks a pipe only from a non-empty command.
  assert.equal(lex("(echo x) | sh")[0].pipedOut, true);
  assert.deepEqual(lex("(echo x) | sh", { bodies: true }).pipes, [false, false]);
  assert.deepEqual(lex("a | b || c |& d", { bodies: true }).pipes, [true, false, true, false]);
});

// --- #308: the glob, launcher and WMI readers both guards share ---------------------------------------------------

test("#308 criterion 6: mayExpandTo reads a glob or brace word's last path component against the names", () => {
  for (const w of ["scripts/lanes/st*.mjs", "scripts/lanes/[s]tart.mjs", "star?.mjs", "{x,s}tart.mjs", "scripts\\lanes\\st*.mjs", "*", "ST*.MJS"]) {
    assert.equal(mayExpandTo(w, ["start.mjs"]), true, w);
  }
  for (const w of ["scripts/lanes/start.mjs", "*.test.mjs", "re*.mjs", "st*.js", "", "st*/x.mjs"]) {
    assert.equal(mayExpandTo(w, ["start.mjs"]), false, w);
  }
  // A marked (quoted) glob character is plain text, and too many expansions count as a match.
  assert.equal(mayExpandTo(`st${mark("*")}.mjs`, ["start.mjs"]), false);
  assert.equal(mayExpandTo("{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}", ["start.mjs"]), true);
  assert.equal(mayExpandTo("cl*.exe", ["claude", "claude.exe"]), true);
});

test("#308 edge: mayExpandTo takes bounded time on runs of stars and huge or brace-heavy words (security review round 2)", () => {
  const started = Date.now();
  assert.equal(mayExpandTo(`${"*".repeat(40)}.mjs`, ["start.mjs"]), true);
  assert.equal(mayExpandTo(`${"*".repeat(40)}.xyz`, ["start.mjs"]), false);
  assert.equal(mayExpandTo(`${"*a".repeat(200)}`, ["start.mjs"]), false);
  assert.equal(mayExpandTo(`${"?".repeat(100000)}`, ["start.mjs"]), true);
  assert.equal(mayExpandTo(`${"{".repeat(10000)}a${"}".repeat(10000)}`, ["start.mjs"]), true);
  assert.equal(mayExpandTo("{a,b}".repeat(20000), ["start.mjs"]), true);
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`);
  // At the limits: exactly MAX_GLOB_WORD characters is still checked, one more counts as a match.
  assert.equal(mayExpandTo(`${"x".repeat(1023)}*`, ["start.mjs"]), false);
  assert.equal(mayExpandTo(`${"x".repeat(1024)}*`, ["start.mjs"]), true);
  // Integer sequences, an unclosed brace and a class still read as before.
  assert.equal(mayExpandTo("start{1..3}.mjs", ["start-2.mjs"]), true);
  assert.equal(mayExpandTo("start{1..3}.mjs", ["start.mjs"]), false);
  assert.equal(mayExpandTo("post-review{.mjs", ["post-review.mjs"]), true);
  assert.equal(mayExpandTo("[s]tart.mjs", ["start.mjs"]), true);
  assert.equal(mayExpandTo("[s.mjs", ["start.mjs"]), false);
});

test("#308 criterion 6: launchedCommands reads cmd /c, start, schtasks /tr and the scheduled-task cmdlets", () => {
  assert.deepEqual(launchedCommands(["cmd", "/c", "start", "x.mjs", "1"]), ["start x.mjs 1"]);
  assert.deepEqual(launchedCommands(["cmd.exe", "/S", "/K", "dir"]), ["dir"]);
  assert.deepEqual(launchedCommands(["cmd", "/c", "echo", "%X%"]), ["echo ${LANES_CMD_VAR}"]);
  assert.deepEqual(launchedCommands(["start", "/b", "", "x.mjs", "1"]), [" x.mjs 1", "x.mjs 1"]);
  assert.deepEqual(launchedCommands(["start", "x.mjs"]), ["x.mjs", ""]);
  assert.deepEqual(launchedCommands(["schtasks", "/create", "/tn", "x", "/TR", "node a.mjs"]), ["node a.mjs"]);
  assert.deepEqual(launchedCommands(["New-ScheduledTaskAction", "-Execute", "node", "-Argument", "a.mjs 1"]), ["node a.mjs 1", "node", "a.mjs 1"]);
  assert.deepEqual(launchedCommands(["Register-ScheduledTask", "-TaskName", "x", "-Action", "$1"]), ["x $1", "x", "$1"]);
  // Behind an assignment or a wrapper too.
  assert.deepEqual(launchedCommands(["A=1", "env", "timeout", "5", "cmd", "/c", "x"]), ["x"]);
});

test("#308 edge: launchedCommands on empty, flag-only and non-launcher words", () => {
  for (const words of [[], ["A=1"], ["cmd"], ["cmd", "/c"], ["schtasks", "/tr"], ["schtasks", "/query"], ["echo", "cmd", "/c", "x"], ["npm", "start"], ["git", "commit", "-m", "start x.mjs"]]) {
    const texts = launchedCommands(words);
    assert.ok(texts.every((t) => t.trim() === ""), JSON.stringify(words));
  }
});

test("#308 criterion 6: wmiProcessCreate reads Win32_Process Create, wmic process call create and a class wildcard", () => {
  for (const t of [
    "Invoke-CimMethod -ClassName Win32_Process -MethodName Create",
    "Invoke-CimMethod -ClassName ('Win32'+'_Process') -MethodName Create",
    "wmic process call create x",
    "(Get-WmiObject -List Win32_Pro*).Create($c)",
    "(Get-CimClass -ClassName Win32_[P]rocess).Create($c)",
  ]) {
    assert.equal(wmiProcessCreate(t), true, t);
  }
  for (const t of [
    "Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine",
    "Get-WmiObject -List Win32_Pro*",
    "Get-ChildItem *.md; gh pr create --title x",
    "git commit -m \"$(cat <<'EOF'\nWin32_Process Create\nEOF\n)\"",
    "",
  ]) {
    assert.equal(wmiProcessCreate(t), false, t);
  }
});

// --- #310: ANSI-C quoting, plain heredoc delimiters, a literal `$` ---------------------------------------------------

test("#310 criterion 1: $'…' is one literal string with its escapes resolved as bash does", () => {
  assert.deepEqual(words(lex("grep $'a\\tb\\nc\\x41\\u00e9\\'d\\\\' f")[0]), ["grep", "a\tb\ncAé'd\\", "f"]);
  assert.deepEqual(words(lex("grep -n $' ' x")[0]), ["grep", "-n", " ", "x"]);
  assert.deepEqual(words(lex("node scripts/lanes/post-revie$'\\x77'.mjs owner")[0]), ["node", "scripts/lanes/post-review.mjs", "owner"]);
  // Literal: a `$` or backtick it holds is marked, in both shapes.
  assert.deepEqual([...lex("echo $'$x'")[0]], ["echo", mark("$x")]);
  assert.deepEqual(lex("echo $'`$x`'", { bodies: true }).segments[0], ["echo", `${LIT_TICK}${LIT_DOLLAR}x${LIT_TICK}`]);
  assert.deepEqual(ansiCString("$'a\\x41'z", 0), { text: "aA", end: 7 });
  assert.equal(ansiCString("$x", 0), null);
});

test("#310 edge: $'…' octal, control, \\e, \\U, a NUL cutting the rest, an unknown escape and a bad hex escape", () => {
  const read = (s) => ansiCString(s, 0)?.text;
  // Octal takes at most three digits: \010 is a backspace, then a plain 2.
  assert.equal(read("$'\\101\\0102'"), "A\b2");
  assert.equal(read("$'a\\0b'"), "a");
  assert.equal(read("$'\\cA\\c?\\e\\E'"), "\x01\x7f\x1b\x1b");
  assert.equal(read("$'\\U0001F600'"), "\u{1F600}");
  assert.equal(read("$'a\\x00b'"), "a");
  assert.equal(read("$'\\q\\xg\\u'"), "\\q\\xg\\u");
  assert.equal(read("$'\\\"\\?\\a\\b\\f\\r\\v'"), "\"?\x07\b\f\r\v");
  // A long string reads whole (no argument-limit overflow).
  assert.equal(read(`$'${"a".repeat(500_000)}'`).length, 500_000);
  // Raw bytes read as UTF-8, as bash writes them out: \xe2\x80\xa8 is U+2028.
  assert.equal(read("$'\\xe2\\x80\\xa8'"), " ");
});

test("#310 edge: an unterminated $'…' throws, and a private-use character it spells never reads as a marker", () => {
  assert.throws(() => lex("echo $'abc"), /unterminated/);
  assert.throws(() => lex("echo $'abc\\'", { bodies: true }), /unterminated/);
  //  is the words shape's marked `$`: resolved, it must not come back as a real `$` in a nested script.
  const [seg] = lex("bash -c $'\\ue000(x)'");
  assert.equal(unmark(seg[2]).includes("$"), false);
  assert.equal(lex("echo $'\\ue024'", { bodies: true }).segments[0][1].includes(LIT_DOLLAR), false);
});

test("#310 test-hunter edge: a marker spelled as UTF-8 bytes, and a \\u / \\U out of range or a surrogate, read as U+FFFD", () => {
  const read = (s) => ansiCString(s, 0)?.text;
  // \xee\x80\x80 and \356\200\200 are U+E000 in UTF-8, a marker character: it must not survive.
  assert.equal(read("$'\\xee\\x80\\x80'"), "�");
  assert.equal(read("$'\\356\\200\\200'"), "�");
  assert.equal(read("$'\\U00110000\\ud800'"), "��");
  assert.equal(unmark(lex("bash -c $'\\xee\\x80\\x80(x)'")[0][2]).includes("$"), false);
});

test("#310 edge: $'…' inside double quotes is not ANSI-C, and a redirection target skips a $'…' holding \\'", () => {
  assert.deepEqual(words(lex('echo "$\'x\'"')[0]), ["echo", "$'x'"]);
  const cmd = "echo >$'a\\'b' ; node x";
  assert.equal(skipRedirectTarget(cmd, 6), cmd.indexOf(" ;"));
  assert.deepEqual(words(lex(cmd)[1]), ["node", "x"]);
});

test("#310 edge: the raw-text reader also sees a $'…' name resolved", () => {
  assert.match(dequoted("node scripts/lanes/q$'\\x75'eue.mjs"), /queue\.mjs/);
  assert.match(dequoted("$(which cla$'\\x75'de) --bg"), /\$\([^)]*claude/);
  assert.equal(dequoted("a 'b'"), "a b");
});

test("#310 criterion 2: a $(cat <<D body is literal only when D is plain, in both shapes", () => {
  for (const opener of ["$(cat <<\"E\\$F\"\n", "$(cat <<'E F'\n", "$(cat <<\"E`x`\"\n", "$(cat <<''\n"]) {
    assert.equal(CAT_HEREDOC_RE.test(opener), false, opener);
    assert.equal(literalSubstitution(`${opener}x\nE$F\n)`, 0), null, opener);
  }
  for (const opener of ["$(cat <<'E.F-1'\n", '$(cat <<"EOF"\n', "$(cat <<\\EOF\n", "$(cat <<-EOF\n"]) assert.match(opener, CAT_HEREDOC_RE);
  assert.deepEqual(literalSubstitution("$(cat <<'M'\nmsg $x\nM\n)", 0), { body: "msg $x", end: 21 });
});

test("#310 criterion 4: a $ bash takes literally, in double quotes or bare, is marked in both shapes", () => {
  for (const [cmd, word] of [
    ['grep "a$\\|b" f', "a$\\|b"], ['grep "x |y$" f', "x |y$"], ['echo "x ;y$"', "x ;y$"], ['grep "^\\s+at |^\\s*$" f', "^\\s+at |^\\s*$"],
    ['echo "a$ b$,c$/d$=e$:f$]"', "a$ b$,c$/d$=e$:f$]"], ["echo a$\\|b", "a$|b"], ["echo a$", "a$"],
  ]) {
    assert.equal(lex(cmd)[0][1], mark(word), cmd);
    assert.equal(lex(cmd, { bodies: true }).segments[0][1], word.replaceAll("$", LIT_DOLLAR), cmd);
  }
});

test("#310 criterion 5: a $ bash expands stays live, and so do $\"…\", $[…] and a $ before a line continuation", () => {
  for (const [cmd, word] of [
    ['echo "x |$Y"', "x |$Y"], ['echo "$X"', "$X"], ['echo "$1$$$!$#$@$-"', "$1$$$!$#$@$-"],
    ['echo "a$\\\nX"', "a$X"], ["echo a$\\\nX", "a$X"], ['echo a$"x"', "a$x"], ['echo "a\\\nb$X"', "ab$X"],
  ]) {
    assert.equal(lex(cmd)[0][1], word, cmd);
    assert.equal(lex(cmd, { bodies: true }).segments[0][1], word, cmd);
  }
  // `$[` is bash's old arithmetic: live, so the `[` is no glob bracket here either.
  assert.equal(lex('echo "a$[1]"')[0][1], `a$${mark("[")}1]`);
  assert.equal(lex('echo "a$[1]"', { bodies: true }).segments[0][1], "a$[1]");
});

test("#378 criterion 1: runsRuntimeText reads eval, source and a shell's -c given text known only at run time", () => {
  for (const cmd of [
    'eval "$X"', "eval $A$B", 'source "$F"', 'bash -c "$X"', 'sh -c "$(cat f)"', 'eval "$(ssh-agent -s)"', '. "$F"', "eval `cat f`",
    'X=1 eval "$Y"', 'builtin eval "$X"', 'command source "$F"', 'env bash -c "$X"', 'timeout 5 sh -c "$X"', 'bash -lc "$X"', "eval echo $X",
  ]) {
    assert.equal(runsRuntimeText(lex(cmd)[0]), true, cmd);
  }
  for (const cmd of [
    'echo "$X"', "git commit -F msg.txt", "eval echo hi", "source ~/.bashrc", "bash -c 'echo $HOME'", "eval 'echo $X'", 'grep -c "$X" f',
    'bash -c "echo hi" "$X"', 'bash "$F"', "eval", "source", 'echo eval "$X"', 'command -v eval "$X"',
  ]) {
    assert.equal(runsRuntimeText(lex(cmd)[0]), false, cmd);
  }
  // edge: nothing to read, or no command word at all.
  assert.equal(runsRuntimeText([]), false);
  assert.equal(runsRuntimeText(["X=1"]), false);
});

test("#378 criterion 2: wmiProcessCreate reads a Win32_Process method named at run time", () => {
  for (const t of [
    "([wmiclass]'Win32_Process').$m(1)", "$o = [wmiclass]'Win32_Process'; $o.$m($c)", "$o = [wmiclass]'Win32_Process'; $o.\"$m\"($c)",
    "$o = [wmiclass]'Win32_Process'; $o.($m)($c)", "$o = [wmiclass]'Win32_Process'; $o.${m}($c)", "$o = [wmiclass]'Win32_Process'; $o.$($n)($c)",
    "$o = [wmiclass]'Win32_Process'; $o.$m.Invoke($c)", "$o = [wmiclass]'Win32_Process'; $o.PSObject.Methods[$m].Invoke($c)",
    "$o = [wmiclass]'Win32_Process'; $o.InvokeMethod($m, $a)", "([wmiclass]'Win32_Pro*').$m(1)", "([wmiclass]'Win32_Process') . $m (1)",
  ]) {
    assert.equal(wmiProcessCreate(t), true, t);
  }
  for (const t of [
    "([wmiclass]'Win32_Process').Properties", "Get-CimInstance Win32_Process", "Get-CimInstance Win32_Process | % { $_.$p }",
    "$o = [wmiclass]'Win32_Process'; $o.$p", "$x.$m(1)", "([wmiclass]'Win32_Service').$m(1)", "",
  ]) {
    assert.equal(wmiProcessCreate(t), false, t);
  }
});

test("#378 edge: a long run of computed-method openers is read in bounded time (ReDoS, security review)", () => {
  for (const unit of [".( $", ".$(", ".${", ". . $"]) {
    const text = `[wmiclass]'Win32_Process'; ${unit.repeat(40_000)}`;
    const t0 = performance.now();
    wmiProcessCreate(text);
    assert.ok(performance.now() - t0 < 500, `${JSON.stringify(unit)} took ${Math.round(performance.now() - t0)} ms`);
  }
});

// --- #404: the run-time text, computed WMI method, glob and release tag gaps #378 left ----------------------------

test("#404 criterion 1: a shell's -c script after --, -e, -x or +x is read as run-time text", () => {
  for (const cmd of ['bash -c -- "$X"', 'bash -c -e "$X"', 'bash -c -x "$X"', 'bash -c +x "$X"', 'sh -c -o errexit "$X"', 'bash -c -e -- "$X"']) {
    assert.equal(runsRuntimeText(lex(cmd)[0]), true, cmd);
  }
  for (const cmd of ["bash -c -- 'echo $X'", 'bash -c -e "echo hi" "$X"']) assert.equal(runsRuntimeText(lex(cmd)[0]), false, cmd);
});

test("#404 criterion 2: builtin and command are looked through with their own options before eval, source and dot", () => {
  for (const cmd of ['command -p eval "$X"', 'command -- eval "$X"', 'builtin -- source "$F"', 'command -p -- . "$F"', 'builtin command eval "$X"']) {
    assert.equal(runsRuntimeText(lex(cmd)[0]), true, cmd);
  }
  assert.equal(runsRuntimeText(lex('command -v eval "$X"')[0]), false);
});

test("#404 criterion 3: su, runuser, script, flock, sg, fish and pwsh given run-time text are read as such", () => {
  for (const cmd of [
    'su -c "$X"', 'su root -c "$X"', 'runuser -c "$X" u', 'script -c "$X" /dev/null', 'flock /tmp/l -c "$X"', 'sg grp -c "$X"', 'sg grp "$X"',
    'fish -c "$X"', 'pwsh -c "$X"', 'pwsh -Command "$X"', 'powershell -Command "& $p"', 'su --command="$X"', 'sudo -u root su -c "$X"',
  ]) {
    assert.equal(runsRuntimeText(lex(cmd)[0]), true, cmd);
  }
  for (const cmd of ["su -c 'echo $X'", 'grep -rn sg "$DIR"', 'echo script -c "$X"', `powershell -NoProfile -Command "($env:Path -split ';').Count"`]) {
    assert.equal(runsRuntimeText(lex(cmd)[0]), false, cmd);
  }
});

const COMPUTED_WMI = [
  `$o = Get-WmiObject Win32_Process; $o.('{0}{1}' -f 'Cre','ate')('node x')`,
  `$o = [wmiclass]'Win32_Process'; $o.("Cr" + $e)('node x')`,
  `$o = [wmiclass]'Win32_Process'; $o | ForEach-Object -MemberName $m 'node x'`,
  `$o = [wmiclass]'Win32_Process'; $o | % $m 'node x'`,
  `$o = [wmiclass]'Win32_Process'; $o.GetType().InvokeMember($m, 'InvokeMethod', $null, $o, @('node x'))`,
  `$o = [wmiclass]'Win32_Process'; $f = $o.$m; $f.Invoke('node x')`,
];

test("#404 criterion 4: a Win32_Process method named by a computed expression is read as process creation", () => {
  for (const t of COMPUTED_WMI) assert.equal(wmiProcessCreate(t), true, t);
  for (const t of ["Get-CimInstance Win32_Process | % { $_.$p }", "$o = [wmiclass]'Win32_Process'; $o.$p", "Get-CimInstance Win32_Process | ForEach-Object Name"]) {
    assert.equal(wmiProcessCreate(t), false, t);
  }
});

test("#404 criterion 5: the widened computed-method reader stays linear", () => {
  for (const unit of [".( $", ".(", "% $", " -m $", "$a.invoke", ".GetType().InvokeMember"]) {
    const text = `[wmiclass]'Win32_Process'; ${unit.repeat(40_000)}`;
    const t0 = performance.now();
    wmiProcessCreate(text);
    assert.ok(performance.now() - t0 < 500, `${JSON.stringify(unit)} took ${Math.round(performance.now() - t0)} ms`);
  }
});

test("#404 criterion 6: a POSIX class in a glob bracket is one character", () => {
  for (const w of ["[[:alpha:]]ode", "[[:lower:]]od[[:alpha:]]", "n[[:alnum:]]de", "[![:digit:]]ode", "[[=n=]]ode", "[[.n.]]ode"]) assert.equal(mayBeNode(w), true, w);
  // A bracket is read as any one character, whatever its members (failing closed), so only the length can rule out.
  for (const w of ["[[:alpha:]]", "[[:alpha:]ode", "[[:alpha:]]oode"]) assert.equal(mayBeNode(w), false, w);
  // edge: an unclosed class or bracket, and a long run of openers, stay bounded.
  assert.equal(mayBeNode("[[:alpha"), false);
  const t0 = performance.now();
  mayBeNode(`${"[[:".repeat(300)}x`);
  assert.ok(performance.now() - t0 < 500);
});

test("#404 criterion 13: a case pattern is no command word, in either lexer shape", () => {
  for (const cmd of ['case ":$PATH:" in *:/usr/bin:*) echo yes;; esac', "case x in a|*) echo a;; *) echo b;; esac", "case x in (n*) echo a;; (*) echo b;; esac"]) {
    const flat = lex(cmd).map(words);
    assert.ok(flat.every((seg) => !/[*]/.test(seg[0])), `${cmd}: ${JSON.stringify(flat)}`);
    assert.ok(lex(cmd, { bodies: true }).segments.every((seg) => !/[*]/.test(seg[0])), cmd);
  }
  assert.deepEqual(lex("case x in *) node a.mjs;; esac").map(words).find((s) => s[0] === "node"), ["node", "a.mjs"]);
  // edge: a pattern holding a substitution is read as before, so what it runs is still seen.
  assert.ok(lex("case x in $(node b.mjs)) echo;; esac").map(words).some((s) => s[0] === "node"));
  // edge: an operator after `in` leaves pattern reading, so a command after it is never dropped (bash runs it).
  for (const cmd of ['( "case" x in; node a.mjs )', "case x in\nnode a.mjs\n)", "case x in & node a.mjs )", "case x in a) ;; b; node a.mjs )"]) {
    assert.ok(lex(cmd).map(words).some((s) => s[0] === "node"), cmd);
    assert.ok(lex(cmd, { bodies: true }).segments.some((s) => s[0] === "node"), cmd);
  }
  assert.equal(lex("case x in\n  *) echo;;\n  n*) echo;;\nesac").map(words).some((s) => /[*]/.test(s[0])), false);
  // edge: `in` elsewhere is no case.
  assert.deepEqual(lex("echo case x in *)").map(words)[0], ["echo", "case", "x", "in", "*"]);
});

test("#404 criterion 11: releaseTagCommand reads creating and pushing a v* tag", () => {
  for (const cmd of [
    "git tag v1.2.3", "git tag -a v1.2.3 -m x", "git tag -m x v1.2.3", "git -C . tag -s v2", "git push --tags", "git push --follow-tags",
    "git push origin v1.2.3", "git push origin refs/tags/v1.2.3", "git push origin HEAD:refs/tags/v1", "git push --mirror origin", "env git tag v1",
    "git push origin tag v1.2.3", "git -c push.followTags=true push",
    // edge (test-hunter): a pattern refspec pushes every tag, v* among them, quoted or not.
    "git push origin 'refs/tags/*'", "git push origin refs/tags/*:refs/tags/*",
  ]) {
    assert.equal(releaseTagCommand(lex(cmd)[0]), true, cmd);
  }
  for (const cmd of ["git tag -l", "git tag --list 'v*'", "git push origin main", "git tag", "git push -u origin issue-404-x", "git tag -d v1", "echo git tag v1", "git log v1..HEAD"]) {
    assert.equal(releaseTagCommand(lex(cmd)[0]), false, cmd);
  }
});

test("#404 criterion 11 (test-hunter): a branch named tag, a tag read or removal, and a config read are no tag creation", () => {
  // Kills a `k + 1 < specs.length` off-by-one: `tag` as the last refspec names a branch, not the `tag` keyword.
  for (const cmd of ["git push origin tag", "git tag -fl v1", "git tag --delete v1", "git config push.followTags", "git tag --sort=v:refname"]) {
    assert.equal(releaseTagCommand(lex(cmd)[0]), false, cmd);
  }
  assert.equal(releaseTagCommand(lex("git push origin tag v1")[0]), true);
});

// --- #424: run-time tag names, --repo=, update-ref, git aliases, gh release create, bash -c long options -------------

// The run-time tag and ref forms #424 names, each a v* tag the guards cannot read until the shell runs.
const RUNTIME_TAG_CMDS = [
  'git tag "$V"', "git tag ${V:-v1}", 'git tag "$(cat VERSION)"', "git tag `cat VERSION`", 'git tag -a "$V" -m x', 'git push origin "$V"',
  'git push origin "$(cat VERSION)"', "git push origin ${V:-v1}", 'git push origin "refs/tags/$V"', 'git push origin "HEAD:$V"', 'git push origin tag "$V"',
];

test("#424 criterion 1: a tag or push refspec named only at run time is a release tag", () => {
  for (const cmd of RUNTIME_TAG_CMDS) assert.equal(releaseTagCommand(lex(cmd)[0]), true, cmd);
  // A source known only at run time pushed to a literal branch names no tag; a single-quoted `$` is literal text.
  for (const cmd of ['git push origin "$SHA":refs/heads/main', "git tag -l \"$P\"", "git tag -d \"$V\"", "git tag 'x$V'", "git push \"$R\" main"]) {
    assert.equal(releaseTagCommand(lex(cmd)[0]), false, cmd);
  }
});

test("#424 criterion 2: with --repo given, the first positional word is a refspec, not the remote", () => {
  for (const cmd of ["git push --repo=origin v1", "git push --repo origin v1", "git push --repo=origin refs/tags/v1", "git push --repo=origin HEAD:refs/tags/v2"]) {
    assert.equal(releaseTagCommand(lex(cmd)[0]), true, cmd);
  }
  for (const cmd of ["git push --repo=origin main", "git push --repo origin issue-424-x"]) assert.equal(releaseTagCommand(lex(cmd)[0]), false, cmd);
});

test("#424 criterion 3: update-ref to a v* tag, a -c alias that expands to tag or push, and gh release create are release tags", () => {
  for (const cmd of [
    "git update-ref refs/tags/v1 HEAD", "git update-ref -m x refs/tags/v1 HEAD", 'git update-ref "refs/tags/$V" HEAD', "git update-ref --stdin",
    "git -c alias.t=tag t v1", "git -c alias.p=push p origin v1", "git -c 'alias.t=tag -a' t v1 -m x", "git -c alias.t=push t --tags",
    "git -c 'alias.t=!git tag v1' t", "git --config-env alias.t=X t v1", "git -c \"alias.t=$A\" t v1",
    "gh release create v1.0.0", "gh release create v1.0.0 --notes x", "gh release create --title t v1.0.0", "gh release new v2", 'gh release create "$V"',
    "gh release create -R o/r v1",
  ]) {
    assert.equal(releaseTagCommand(lex(cmd)[0]), true, cmd);
  }
  for (const cmd of [
    "git update-ref refs/heads/main HEAD", "git update-ref -d refs/tags/v1", "git -c alias.t=tag t -l", "git -c alias.s=status s", "git -c alias.t=tag s v1",
    "gh release view v1.0.0", "gh release list", "gh release create x1", "gh pr create --title v1",
  ]) {
    assert.equal(releaseTagCommand(lex(cmd)[0]), false, cmd);
  }
});

test("#424 edge: alias case, glued --config-env, recursive aliases, gh with no tag, and a forced run-time refspec", () => {
  for (const cmd of [
    "git -c alias.T=tag t v1", "git -c alias.t=tag T v1", "git --config-env=alias.t=X t v1", "gh release create", "gh release create --notes x",
    'git push origin "+$V"', "git -c alias.a=b -c alias.b=tag a v1",
    // An alias that names itself (git refuses it) fails closed at the depth cap rather than recursing without end.
    "git -c alias.a=a a", "git -c alias.a=b -c alias.b=a a",
  ]) {
    assert.equal(releaseTagCommand(lex(cmd)[0]), true, cmd);
  }
  for (const cmd of ["git -c alias.t=tag", "git -c alias.a=b -c alias.b=status a", "gh", "git", 'git push origin "$SHA":main', "git -c alias.t= t v1"]) {
    assert.equal(releaseTagCommand(lex(cmd)[0]), false, cmd);
  }
});

test("#424 hunt: an alias shadowing a built-in is ignored by git, so it hides nothing; the alias depth cap is a boundary", () => {
  for (const cmd of ["git -c alias.tag=log tag v1", "git -c alias.push=status push origin v1", "git -c alias.update-ref=log update-ref refs/tags/v1 HEAD"]) {
    assert.equal(releaseTagCommand(lex(cmd)[0]), true, cmd);
  }
  const chain = (n) => `git ${Array.from({ length: n }, (_, k) => `-c alias.a${k}=${k + 1 < n ? `a${k + 1}` : "status"}`).join(" ")} a0`;
  assert.equal(releaseTagCommand(lex(chain(7))[0]), false, "7 aliases deep, ending in status");
  assert.equal(releaseTagCommand(lex(chain(9))[0]), true, "past the cap fails closed");
});

test("#441 criterion 2: environment config, symbolic-ref, fast-import and gh api writes are release tags", () => {
  for (const cmd of [
    "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=push.followTags GIT_CONFIG_VALUE_0=true git push", "env GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.t GIT_CONFIG_VALUE_0=tag git t v1",
    "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.t GIT_CONFIG_VALUE_0='!git tag v1' git t", "git_config_key_0=ALIAS.t git t v1", "export GIT_CONFIG_KEY_0=push.followTags",
    "GIT_CONFIG_PARAMETERS=\"'push.followTags'='true'\" git push", 'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0="$K" GIT_CONFIG_VALUE_0=tag git t v1',
    "git symbolic-ref refs/tags/v1 HEAD", 'git symbolic-ref "refs/tags/$V" refs/heads/main', "git symbolic-ref -m x refs/tags/v1 refs/heads/main", "git fast-import", "git -C x fast-import --quiet",
    "gh api repos/o/r/git/refs -f ref=refs/tags/v1 -f sha=abc", "gh api -X POST repos/o/r/git/refs -fref=refs/tags/v1.0", "gh api repos/o/r/git/refs -f ref=refs/tags/v1 --method=POST",
    'gh api repos/o/r/git/refs -f ref="refs/tags/$V" -f sha=a', "gh api repos/o/r/git/refs --input body.json", "gh api repos/o/r/git/refs/tags/v1 -X PATCH -f sha=a",
    "gh api repos/o/r/releases -f tag_name=v1", "gh api repos/o/r/releases -f tag_name=$V",
    // A query string on the endpoint, a ref read from a file, and a tag path named at run time.
    "gh api 'repos/o/r/git/refs?x=1' -f ref=refs/tags/v1", "gh api repos/o/r/git/refs -F ref=@f", "gh api repos/o/r/git/refs/tags/$V -X PATCH -f sha=a",
  ]) {
    assert.equal(releaseTagCommand(lex(cmd)[0]), true, cmd);
  }
  for (const cmd of [
    "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=user.name GIT_CONFIG_VALUE_0=x git push origin main", "GIT_CONFIG_KEY_0=core.pager GIT_CONFIG_VALUE_0=cat git log",
    "git symbolic-ref HEAD", "git symbolic-ref --short HEAD", "git symbolic-ref -d refs/tags/v1", "git symbolic-ref refs/heads/x refs/heads/main",
    "gh api repos/o/r/git/refs/heads/main", "gh api repos/o/r/git/refs -f ref=refs/heads/x -f sha=a", "gh api repos/o/r/git/refs/tags/v1 -X DELETE", "gh api repos/o/r/git/refs/tags/v1",
    "gh api repos/o/r/git/refs -X GET", "gh api repos/o/r/releases", "gh api repos/o/r/releases -f tag_name=x1", "gh api repos/o/r/issues -f title=v1", "gh api",
  ]) {
    assert.equal(releaseTagCommand(lex(cmd)[0]), false, cmd);
  }
});

test("#424 security review: gh release's own --repo before create, a -m value of -d, and --config-env push.followTags", () => {
  for (const cmd of [
    "gh release --repo o/r create v1", "gh release -R o/r create v1", "gh release -Ro/r create v1", "gh release --repo=o/r new v1",
    "git update-ref -m -d refs/tags/v1 HEAD", "git --config-env=push.followTags=X push", "git --config-env push.followTags=X push origin main",
  ]) {
    assert.equal(releaseTagCommand(lex(cmd)[0]), true, cmd);
  }
  for (const cmd of ["gh release --repo o/r view v1", "gh release -R o/r list", "git update-ref -m x -d refs/tags/v1"]) {
    assert.equal(releaseTagCommand(lex(cmd)[0]), false, cmd);
  }
});

test("#424 criterion 4: a shell's -c skips --rcfile and --init-file with their value to reach the script", () => {
  for (const cmd of ['bash -c --rcfile x "$S"', 'bash -c --init-file x "$S"', 'bash --init-file x -c "$S"', 'bash -c --rcfile x -- "$S"']) {
    assert.deepEqual([...shellTextIndexes(lex(cmd)[0])], [lex(cmd)[0].length - 1], cmd);
    assert.equal(runsRuntimeText(lex(cmd)[0]), true, cmd);
  }
  // The value itself is no script: a run-time rc file with a literal script is no run-time text.
  assert.equal(runsRuntimeText(lex('bash -c --init-file "$F" true')[0]), false);
});

test("#404 criterion 13 (test-hunter): $ENV:Path is a PowerShell variable read whatever its case", () => {
  assert.equal(runsRuntimeText(lex(`powershell -Command "($ENV:Path -split ';').Count"`)[0]), false);
});

test("#378 criterion 3: mayBeNode reads node, and a glob that could expand to it, as node", () => {
  for (const w of ["node", "node.exe", "/usr/bin/node", "nodejs", "bun", "deno", "n*de", "no?e", "[n]ode", "/usr/bin/n*de", "N*DE", "n{o,x}de", "*", "n*"]) {
    assert.equal(mayBeNode(w), true, w);
  }
  for (const w of ["ls", "n*y", "nod", "[n]odx", "scripts/lanes/*.test.mjs", "no?e?x", mark("n*de"), ""]) {
    assert.equal(mayBeNode(w), false, w);
  }
});

test("#441 test-hunter: env -i, a path or option before symbolic-ref and fast-import still read as tag paths; long gh api or config text stays fast", () => {
  for (const cmd of ["env -i GIT_CONFIG_KEY_0=alias.t git t v1", "git.exe fast-import", "git -C x symbolic-ref refs/tags/v1 HEAD", "GIT_CONFIG_KEY_10=alias.t git t", "gh api repos/o/r/git/refs -f sha=a -f ref=refs/tags/v1"]) {
    assert.equal(releaseTagCommand(lex(cmd)[0]), true, cmd);
  }
  const start = Date.now();
  for (const cmd of [`gh api repos/o/r/git/refs ${"-f ref=x ".repeat(5000)}`, `GIT_CONFIG_PARAMETERS=${"a.".repeat(20000)} git push`, `gh api ${"-f a=b ".repeat(5000)}x/git/refs`]) {
    assert.equal(releaseTagCommand(lex(cmd)[0]), false);
  }
  assert.ok(Date.now() - start < 2000);
});

test("#441 final round: query strings, mixed-case config keys, quoted refs and method overrides on gh api are read as the request they make", () => {
  for (const cmd of [
    "gh api repos/o/r/git/refs/tags/v1?force=true -X PATCH", 'gh api "repos/o/r/git/refs?x=1" -f ref=refs/tags/V1', "gh api repos/o/r/git/refs -F ref=@f", "gh api repos/o/r/git/refs -X post -f ref=refs/tags/v1",
    "GIT_CONFIG_KEY_0=ALIAS.t git t v1", "GIT_CONFIG_KEY_0=Push.FollowTags git push", "git symbolic-ref --quiet refs/tags/v1 HEAD", "git -c a=b -C x --no-pager fast-import",
  ]) {
    assert.equal(releaseTagCommand(lex(cmd)[0]), true, cmd);
  }
  for (const cmd of [
    "gh api repos/o/r/git/refs -f ref=refs/tags/v1 --method=DELETE", "gh api repos/o/r/git/refs -f ref=refs/tags/v1 -XGET", "gh api repos/o/r/git/refs/tags/v1?x=1", "GIT_CONFIG_KEY_0=push.followTagsX git push",
    "GIT_CONFIG_KEY_0=alias git push", "git symbolic-ref --short HEAD",
  ]) {
    assert.equal(releaseTagCommand(lex(cmd)[0]), false, cmd);
  }
});

// --- #468: run-time config keys across statements and launchers, xargs and ssh, gh api and release edit, fetch -------

/** releaseTagCommand of any statement of `cmd`, as both guards ask it. */
const tagIn = (cmd) => lex(cmd).some((words) => releaseTagCommand(words));

test("#468 criterion 2: a GIT_CONFIG_KEY_n or GIT_CONFIG_PARAMETERS known only at run time is denied where it is set, in a statement of its own or ahead of a launcher", () => {
  for (const cmd of [
    "export GIT_CONFIG_KEY_0=$K", 'export GIT_CONFIG_KEY_0="$K"; git t v1', "export GIT_CONFIG_KEY_0=$(cat k)", "export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=`cat k`",
    "GIT_CONFIG_KEY_0=$K xargs git push", 'GIT_CONFIG_KEY_0="$K" xargs -n1 git push origin', "env GIT_CONFIG_KEY_0=$K xargs git t", "xargs env GIT_CONFIG_KEY_0=$K git push",
    "export GIT_CONFIG_PARAMETERS=$P", 'GIT_CONFIG_PARAMETERS="$P" git push', "export GIT_CONFIG_KEY_$N=alias.t", "export GIT_CONFIG_KEY_$N=$K",
  ]) {
    assert.equal(tagIn(cmd), true, cmd);
  }
  for (const cmd of [
    "export GIT_CONFIG_KEY_0=core.pager", "GIT_CONFIG_KEY_0=user.name xargs git log", "export GIT_CONFIG_KEY_$N=user.name", "export GIT_CONFIG_KEY_0='$K'",
    "export GIT_CONFIG_COUNT=$N", "export GIT_CONFIG_VALUE_0=$V",
  ]) {
    assert.equal(tagIn(cmd), false, cmd);
  }
});

test("#468 criterion 1: releaseTagCommand reads the command after xargs and ssh, whose run-time input it counts as a tag name", () => {
  for (const cmd of [
    "xargs git tag v1", "xargs git tag", "xargs -n1 git push origin", "xargs -I{} git tag {}", "xargs -I {} git push origin {}", "xargs -0 -P 4 git push --tags", "xargs -- git tag v1",
    "xargs env git tag v1", "xargs git -C x tag v1", "xargs gh release create", "xargs -a f git tag",
    "ssh host git tag v1", "ssh -p 22 -i key host git push --tags", "ssh user@host -- git push origin v1", "ssh -o StrictHostKeyChecking=no host git tag $V",
  ]) {
    assert.equal(tagIn(cmd), true, cmd);
  }
  for (const cmd of [
    "xargs git tag -l", "xargs git tag --list", "xargs echo v1", "xargs git status", "xargs", "xargs -I{}", "xargs git log --oneline",
    "ssh host git tag -l", "ssh host ls v1", "ssh host", "ssh -p 22", "ssh host git push origin main",
  ]) {
    assert.equal(tagIn(cmd), false, cmd);
  }
});

test("#468 criterion 4: gh api with an endpoint known only at run time, gh release edit --draft=false and a fetch into refs/tags/v* are read as tag paths", () => {
  for (const cmd of [
    "gh api $EP -f a=b", 'gh api "$EP" -X POST', "gh api $EP --method PATCH", "gh api ${EP:-x} -f a=b", 'gh api "$BASE/x" -f a=b', "gh api repos/o/r/$REST -f a=b", "gh api repos/o/r/releases/$ID -X PATCH -f draft=false", "gh api repos/o/r/releases/$ID -X PATCH --input b.json",
    "gh api repos/o/r/releases/1 -X PATCH -f draft=false", "gh api repos/o/r/releases/1 -X PATCH -F draft=false", "gh api repos/o/r/releases/1 -X PATCH -f tag_name=v2",
    "gh release edit v1 --draft=false", "gh release edit --draft=false v1", "gh release edit v1 --draft=False", "gh release edit v1 --draft=0", "gh release edit v1 --draft=$D", "gh release edit v1 --notes x --draft=false",
    "gh release --repo o/r edit v1 --draft=false", "gh release edit v1 --tag v2", "gh release edit v1 --tag=$T", "gh release edit v1 -R o/r --draft=false",
    "git fetch . HEAD:refs/tags/v1", "git fetch . HEAD:v1", "git fetch origin +refs/heads/*:refs/tags/*", "git fetch origin main:refs/tags/v1.2", 'git fetch . "HEAD:$T"', "git fetch origin tag v1", "git -C x fetch . +HEAD:refs/tags/v1",
    "git fetch --depth 1 . HEAD:refs/tags/v1",
  ]) {
    assert.equal(tagIn(cmd), true, cmd);
  }
  for (const cmd of [
    "gh api $EP", "gh api $EP -X GET", "gh api repos/o/r/issues/$N/comments -f body=x", "gh api repos/o/r/pulls/$N -X PATCH -f state=closed", "gh api repos/o/r/releases/1 -X PATCH -f name=x", "gh api repos/o/r/releases/1 -X PATCH -f draft=true",
    "gh api repos/o/r/releases/$ID", "gh api repos/o/r/releases/$ID -X PATCH -f name=x", "gh api graphql -f query=x",
    "gh release edit v1 --draft", "gh release edit v1 --draft=true", "gh release edit v1 --notes x", "gh release edit v1 --title draft=false", "gh release view v1 --draft=false", "gh release edit v1 --tag-x y",
    "git fetch origin main", "git fetch origin main:refs/remotes/origin/main", "git fetch --all", "git fetch origin +refs/heads/*:refs/remotes/origin/*", "git fetch . HEAD:refs/heads/x", "git fetch --depth 1 origin main", "git fetch", "git fetch origin v1",
  ]) {
    assert.equal(tagIn(cmd), false, cmd);
  }
});

test("#468 security: chained launchers are followed to a cap and then fail closed, in bounded time", () => {
  assert.equal(tagIn("xargs xargs xargs git tag -l"), false);
  assert.equal(tagIn("xargs ssh h xargs git tag v1"), true);
  const start = Date.now();
  assert.equal(tagIn(`${"xargs ".repeat(3000)}git tag -l`), true, "past the cap fails closed");
  assert.equal(tagIn(`${"ssh h ".repeat(3000)}git tag -l`), true);
  assert.ok(Date.now() - start < 500, `took ${Date.now() - start} ms`);
});

test("#468 test-hunter: a fetch into tags/v1 (git completes it to refs/tags/) and a draft read from a file are tag paths", () => {
  for (const cmd of ["git fetch . HEAD:tags/v1", "git fetch . +HEAD:tags/v1", "git fetch . HEAD:tags/*", "gh api repos/o/r/releases/1 -X PATCH -F draft=@f", "gh api repos/o/r/releases/$ID -X PATCH -F draft=@-", "ssh -- host git tag v1", "ssh -p 22 -- host git push --tags"]) {
    assert.equal(tagIn(cmd), true, cmd);
  }
  for (const cmd of ["git fetch . HEAD:tags/x", "git fetch . HEAD:heads/v1x", "git fetch origin pull/5/head:pr-5", "gh api repos/o/r/releases/1 -X PATCH -F name=@f"]) {
    assert.equal(tagIn(cmd), false, cmd);
  }
});

// --- #477: the WMI check reads "create" as a method and a wildcard as a class name; $(…) does not end a tag statement ---

test("#477 criterion 2: a bare or literal-free glob is no Win32_Process class name, and run-time class names still fail closed", () => {
  for (const t of [
    "(Get-WmiObject -List Win32_Pro*).Create($c)", "(Get-CimClass -ClassName Win32_[P]rocess).Create($c)", "Invoke-CimMethod -ClassName ('Win32'+'_Process') -MethodName Create",
    "$c = 'Win32_Process'; Invoke-CimMethod -ClassName $c -MethodName Create", "([wmiclass]'Win32_Pro*').Create($c)", "Invoke-CimMethod -ClassName Win32_?rocess -MethodName Create",
  ]) {
    assert.equal(wmiProcessCreate(t), true, t);
  }
  for (const t of ["Get-ChildItem * | % { $_.Create(1) }", "issue-477-* created", "gh issue create --body-file f; ls issue-477-*", "Get-WmiObject -List ?? -MethodName Create"]) {
    assert.equal(wmiProcessCreate(t), false, t);
  }
});

test("#477 criterion 3: create counts only as a method or argument of the call, not as text", () => {
  for (const t of [
    "$o = [wmiclass]'Win32_Process'; $o.Create($c)", "$o = [wmiclass]'Win32_Process'; $o . Create ($c)", "Invoke-CimMethod Win32_Process -MethodName Create", "Invoke-CimMethod -MethodName 'Cre'+'ate' Win32_Process",
    "wmic process call create x", "WMIC PROCESS CALL CREATE x", "Invoke-CimMethod -Arguments @{MethodName='Create'} Win32_Process",
    "[wmiclass]'Win32_Process' | % Create $c", "[wmiclass]'Win32_Process' | ForEach-Object Create calc", "[wmiclass]'Win32_Process' | % -MemberName Create -ArgumentList calc",
    "wmic process call create\"calc\"", "wmic process call create'calc'", "wmic process call create\\calc", "[wmiclass]'Win32_Process' | % Create\"calc\"",
    "$w = [wmiclass]'Win32_Process'; $w.Create.Invoke('calc')", "objWMI.ExecMethod_(\"Create\", p); Win32_Process", "[wmiclass]'Win32_Process'.Create",
  ]) {
    assert.equal(wmiProcessCreate(t), true, t);
  }
  for (const t of [
    "echo Win32_Pro* created a process", "echo Win32_Process was creating a thing", "echo Win32_Process was created and creating", "Get-CimInstance Win32_Process | Select Name",
  ]) {
    assert.equal(wmiProcessCreate(t), false, t);
  }
});

test("#477 criterion 5: an unquoted $(…) is one word of its statement for the tag rules", () => {
  const tags = (cmd) => lex(cmd, { collapse: true }).some((s) => releaseTagCommand(s));
  for (const cmd of ["git push $(echo o) --tags", "gh api $(cat e) -f ref=refs/tags/v1", "git push origin $(git rev-parse HEAD):refs/tags/v1", 'git push "$(echo o)" --tags', "git tag $(cat VERSION)"]) assert.equal(tags(cmd), true, cmd);
  for (const cmd of ["git push $(echo o) origin main", "git tag -l $(echo 'v*')", "echo $(git rev-parse HEAD)", "git push 'o $(x)' main"]) assert.equal(tags(cmd), false, cmd);
  assert.deepEqual(lex("echo '$(x)' y", { collapse: true }), lex("echo '$(x)' y"));
  assert.deepEqual(lex("git push $(echo o", { collapse: true }), lex("git push $(echo o"));
});

test("#477 criterion 6: xargs -I{} with a shell -c script, and ssh with a run-time remote command, are read", () => {
  for (const cmd of ["xargs -I{} bash -c 'git tag {}'", "xargs -I{} sh -c 'git tag {}'", "xargs -I{} sh -c 'git tag v1 && echo {}'", "xargs -I@ sh -c 'git push origin @'"]) {
    assert.equal(releaseTagCommand(lex(cmd)[0]), true, cmd);
  }
  for (const cmd of ["xargs -I{} sh -c 'git tag -l {}'", "xargs -I{} sh -c 'echo {}'", "xargs -I{} sh -c 'git log {}'"]) assert.equal(releaseTagCommand(lex(cmd)[0]), false, cmd);
  assert.equal(runsRuntimeText(lex("ssh host $CMD")[0]), true);
  assert.equal(runsRuntimeText(lex('ssh -p 22 host "$CMD"')[0]), true);
  assert.equal(runsRuntimeText(lex("ssh host 'echo $HOME'")[0]), false);
  assert.equal(runsRuntimeText(lex("ssh host ls")[0]), false);
});

test("#477 criterion 7: env -S and an env operand built at run time set a config key the tag rule cannot read", () => {
  for (const cmd of ["env -S 'GIT_CONFIG_KEY_0=$K git push'", "env -S'GIT_CONFIG_KEY_0=$K git push'", "env --split-string='GIT_CONFIG_KEY_0=$K git push'", "env -S 'GIT_CONFIG_KEY_0=alias.x git push'", "env -S 'env -S \"GIT_CONFIG_KEY_0=$K git push\"'"]) {
    assert.equal(releaseTagCommand(lex(cmd)[0]), true, cmd);
  }
  assert.equal(lex("env $(echo GIT_CONFIG_KEY_0=alias.x) git push", { collapse: true }).some((s) => releaseTagCommand(s)), true);
  for (const cmd of ["env -S 'FOO=bar git status'", "env -S 'GIT_CONFIG_KEY_0=core.pager git push origin main'", "env -S 'FOO=bar'"]) assert.equal(releaseTagCommand(lex(cmd)[0]), false, cmd);
});

test("#477 criterion 8: git fetch --refmap into refs/tags/* and --stdin write tags", () => {
  for (const cmd of ["git fetch --refmap=refs/tags/*:refs/tags/* origin", "git fetch --refmap '+refs/heads/*:refs/tags/*' origin", "git fetch --refmap=$M origin", "git fetch --stdin", "git fetch origin --stdin"]) {
    assert.equal(releaseTagCommand(lex(cmd)[0]), true, cmd);
  }
  for (const cmd of ["git fetch --refmap= origin main", "git fetch --refmap=refs/heads/*:refs/remotes/o/* origin", "git fetch origin main"]) assert.equal(releaseTagCommand(lex(cmd)[0]), false, cmd);
});

test("#477 criterion 10: a gh issue create title with an apostrophe inside double quotes lexes in both shapes; an unterminated quote still throws", () => {
  const cmd = `gh issue create --title "start.mjs: launch with only the App's credentials" --body-file f`;
  assert.equal(lex(cmd)[0][4], "start.mjs: launch with only the App's credentials");
  assert.equal(lex(cmd, { bodies: true }).segments[0][4], "start.mjs: launch with only the App's credentials");
  assert.throws(() => lex(`echo "App's`));
  assert.throws(() => lex("echo 'App", { bodies: true }));
});
