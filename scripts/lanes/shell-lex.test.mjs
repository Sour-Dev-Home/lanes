// scripts/lanes/shell-lex.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CAT_HEREDOC_RE, HEREDOC_RE, LIT_DOLLAR, LIT_TICK, QUOTED_TICK, ansiCString, dequoted, heredocOperator, launchedCommands, lex, literalSubstitution, mark,
  mayBeNode, mayExpandTo, plainLiteralSubstitution, readGrant, readHeredoc, runsRuntimeText, skipRedirectTarget, unmark, wmiProcessCreate,
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
  assert.match(text, /\blex\([^)]*\{ bodies: true \}\)/);
  // Every call asks for start-guard's shape: the words shape would read its commands with approve-guard's rules.
  for (const call of text.matchAll(/\blex\([^)]*\)/g)) assert.match(call[0], /\{ bodies: true \}/, call[0]);
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

test("#378 criterion 3: mayBeNode reads node, and a glob that could expand to it, as node", () => {
  for (const w of ["node", "node.exe", "/usr/bin/node", "nodejs", "bun", "deno", "n*de", "no?e", "[n]ode", "/usr/bin/n*de", "N*DE", "n{o,x}de", "*", "n*"]) {
    assert.equal(mayBeNode(w), true, w);
  }
  for (const w of ["ls", "n*y", "nod", "[n]odx", "scripts/lanes/*.test.mjs", "no?e?x", mark("n*de"), ""]) {
    assert.equal(mayBeNode(w), false, w);
  }
});
