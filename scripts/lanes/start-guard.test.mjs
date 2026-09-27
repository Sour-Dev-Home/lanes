// scripts/lanes/start-guard.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BG_DENY_REASON, DENY_REASON, GRANT_TTL_MS, decidePreToolUse, findBgLaunches, findStartInvocations, onUserPromptSubmit, parseAutoPrompt, parseStartPrompt, runHook } from "./start-guard.mjs";

const NOW = Date.parse("2026-09-27T12:00:00Z");
const START = "node scripts/lanes/start.mjs 12 14";
const grant = (over = {}) => ({ sessionId: "s1", issues: [12, 14], at: new Date(NOW - 60_000).toISOString(), ...over });
const bash = (command, over = {}) => ({ hook_event_name: "PreToolUse", session_id: "s1", tool_name: "Bash", tool_input: { command }, ...over });
const tmp = () => mkdtempSync(join(tmpdir(), "start-guard-"));
const out = (s) => (s === "" ? null : JSON.parse(s).hookSpecificOutput);

// --- UserPromptSubmit ---------------------------------------------------------------------------------------------

test("only a prompt that is exactly /start <N ...> names issues", () => {
  assert.deepEqual(parseStartPrompt("/start 12"), [12]);
  assert.deepEqual(parseStartPrompt("/start 12 14\n"), [12, 14]);
  assert.deepEqual(parseStartPrompt("  /start   12   14  "), [12, 14]);
  for (const p of ["/start", "/start ", "/start #12", "/start 12,14", "/start abc", "please /start 12", "/start 12; rm", "/start 0", "/start -1", "/start 1e3", "/start 99999999999999999999", "/starting 12", "/start 12 x", undefined, 12]) {
    assert.equal(parseStartPrompt(p), null, JSON.stringify(p));
  }
});

test("UserPromptSubmit /start N M grants { sessionId, issues, at }", () => {
  assert.deepEqual(onUserPromptSubmit({ session_id: "s1", prompt: "/start 12 14" }, NOW), { action: "grant", sessionId: "s1", grant: { sessionId: "s1", issues: [12, 14], at: new Date(NOW).toISOString() } });
});

test("UserPromptSubmit of any other prompt clears the session's grant", () => {
  assert.deepEqual(onUserPromptSubmit({ session_id: "s1", prompt: "/lane 12" }, NOW), { action: "clear", sessionId: "s1" });
  assert.deepEqual(onUserPromptSubmit({ session_id: "s1", prompt: "/approve 12" }, NOW), { action: "clear", sessionId: "s1" });
});

test("UserPromptSubmit with an unsafe or missing session id does nothing", () => {
  for (const id of ["../x", "a/b", "", undefined, "a".repeat(200)]) assert.deepEqual(onUserPromptSubmit({ session_id: id, prompt: "/start 12" }, NOW), { action: "none" });
});

// --- detection ----------------------------------------------------------------------------------------------------

test("the plain start command is detected with its issues", () => {
  assert.deepEqual(findStartInvocations(START), [{ issues: [12, 14], standalone: true }]);
  assert.deepEqual(findStartInvocations(`${START}\n`), [{ issues: [12, 14], standalone: true }]);
});

test("wrapped, chained or indirect start.mjs runs are detected and never standalone", () => {
  for (const cmd of [
    `bash -c "${START}"`,
    `sh -c '${START}'`,
    `env X=1 ${START}`,
    `echo hi; ${START}`,
    `true && ${START}`,
    `${START} | cat`,
    `${START} > out.txt`,
    `cd . && ${START}`,
    `node ./scripts/lanes/start.mjs 12`,
    `node scripts\\lanes\\start.mjs 12`,
    `node "scripts/lanes/start.mjs" 12`,
    `node scripts/lanes/sta""rt.mjs 12`,
    `node /abs/repo/scripts/lanes/start.mjs 12`,
    `node.exe scripts/lanes/start.mjs 12`,
    `S=scripts/lanes/start.mjs; node $S 12`,
    `node $(echo scripts/lanes/start.mjs) 12`,
    `node scripts/lanes/start.mjs $N`,
    `node scripts/lanes/start.mjs 12 --dry-run`,
    `node --inspect scripts/lanes/start.mjs 12`,
    `node -e "import('./scripts/lanes/start.mjs')"`,
    `scripts/lanes/start.mjs 12`,
    `eval "node scripts/lanes/start.mjs 12"`,
  ]) {
    const found = findStartInvocations(cmd);
    assert.ok(found.length > 0, `not detected: ${cmd}`);
    assert.ok(found.every((f) => !f.standalone), `standalone: ${cmd}`);
  }
});

test("commands that only mention start.mjs, or run its tests, are not start runs", () => {
  for (const cmd of ["node --test scripts/lanes/start.test.mjs", "git diff scripts/lanes/start.mjs", "cat scripts/lanes/start.mjs", "grep -n claude scripts/lanes/start.mjs", "npm start", "node scripts/lanes/status.mjs", 'git commit -m "the guard on start.mjs"', "", undefined]) {
    assert.deepEqual(findStartInvocations(cmd), [], String(cmd));
  }
});

test("edge: a quoted script that cannot be read and names start.mjs fails closed", () => {
  assert.deepEqual(findStartInvocations(`git commit -m "don't run start.mjs"`), [{ issues: undefined, standalone: false }]);
  assert.deepEqual(findStartInvocations(`node scripts/lanes/start.mjs "12`), [{ issues: undefined, standalone: false }]);
});

test("edge: a variable spliced into start.mjs's name, or a script word that stays unresolved, is a start run", () => {
  // Found by the test-hunter: bash expands `X=start; node scripts/lanes/$X.mjs 12` to the plain start command.
  for (const cmd of ["X=start; node scripts/lanes/$X.mjs 12", "X=mjs; node scripts/lanes/start.$X 12", "X=star; node scripts/lanes/${X}t.mjs 12", "node scripts/lanes/$UNKNOWN.mjs 12", "node --inspect $SCRIPT 12", "$SCRIPT 12"]) {
    assert.ok(findStartInvocations(cmd).length > 0, `bypass not caught: ${cmd}`);
  }
});

test("edge: a variable spliced into the --bg flag, or left unresolved after claude, is a background launch", () => {
  // Found by the test-hunter: bash expands `F=bg; claude --$F x` to `claude --bg x`.
  for (const cmd of ["F=bg; claude --$F x", "F=--bg; claude $F x", "claude $FLAGS x", "C=claude; F=bg; $C --$F x", "$C --$F x", "$CLAUDE --bg x", "claude$UNDEFINED --bg x"]) {
    assert.ok(findBgLaunches(cmd), `bypass not caught: ${cmd}`);
  }
});

test("edge: a $ in an ordinary argument is neither a start run nor a background launch", () => {
  for (const cmd of ['node scripts/lanes/status.mjs --since "$D"', 'cd "$DIR" && git status', 'gh pr view "$PR"', "X=start; echo $X.mjs"]) {
    assert.deepEqual(findStartInvocations(cmd), [], cmd);
    assert.equal(findBgLaunches(cmd), false, cmd);
  }
});

test("edge: an everyday git/gh command that merely mentions start.mjs or --bg in text, alongside an unrelated $VAR elsewhere in the same call, is not a start run or a background launch", () => {
  // Found by the test-hunter: the whole-string fail-closed fallback (for real indirection like `$(...)`) also fires
  // on a commit message or --body that just names start.mjs/--bg, as soon as the command has an unrelated $VAR
  // anywhere else (e.g. a quoted "$FILE" used for something else entirely). That denies routine lane work such as a
  // commit describing a fix to this very guard.
  for (const cmd of [`git commit -m "fix start.mjs typo" && echo "$X"`, `gh pr comment 12 --body "see start.mjs" && cat "$FILE"`, `echo "$VAR" && git log --oneline -- start.mjs`, `grep -n "\\$X" scripts/lanes/start.mjs`]) {
    assert.deepEqual(findStartInvocations(cmd), [], cmd);
  }
  for (const cmd of [`git commit -m "mention --bg mode in docs" && echo "$DONE"`]) {
    assert.equal(findBgLaunches(cmd), false, cmd);
  }
});

test("a direct claude --bg is detected behind any wrapper", () => {
  for (const cmd of [
    `claude --bg "/lane 12"`,
    `claude "/lane 12" --bg`,
    `claude --bg=true "/lane 12"`,
    `claude --background "/lane 12"`,
    `claude.exe --bg "/lane 12"`,
    `claude.cmd --bg x`,
    `/usr/local/bin/claude --bg x`,
    `npx claude --bg x`,
    `npx @anthropic-ai/claude-code --bg x`,
    `env A=1 claude --bg x`,
    `cd .. && claude --bg "/lane 12"`,
    `bash -c 'claude --bg "/lane 12"'`,
    `powershell -Command "claude --bg '/lane 12'"`,
    `cla""ude --bg x`,
    `C=claude; $C --bg x`,
    `$(which claude) --bg x`,
    "`which claude` --bg x",
    `claude --bg "unterminated`,
    `nohup claude --bg x &`,
  ]) {
    assert.ok(findBgLaunches(cmd), `not detected: ${cmd}`);
  }
});

test("claude without --bg, or --bg without claude, is not a background launch", () => {
  for (const cmd of ["claude agents --json", "claude attach abc", "claude logs abc", "claude --version", "echo --bg", "git log --oneline", 'git commit -m "docs: claude attach"', `git commit -m "don't run claude attach"`, "", undefined]) {
    assert.equal(findBgLaunches(cmd), false, String(cmd));
  }
});

// --- PreToolUse (criteria 1-3) ------------------------------------------------------------------------------------

test("criterion 1: /start in this session allows the plain start command once, for the same issues", () => {
  assert.deepEqual(decidePreToolUse(bash(START), grant(), NOW), { decision: "allow", reason: "owner launch from /start 12 14 in this session", consumeGrant: true });
});

test("criterion 1: a lane (no grant) is denied start.mjs", () => {
  assert.deepEqual(decidePreToolUse(bash(START), null, NOW), { decision: "deny", reason: DENY_REASON });
  assert.deepEqual(decidePreToolUse(bash(START), { unreadable: true }, NOW), { decision: "deny", reason: DENY_REASON });
});

test("criterion 1: an expired, future or mismatched grant is denied", () => {
  const deny = { decision: "deny", reason: DENY_REASON };
  assert.deepEqual(decidePreToolUse(bash(START), grant({ at: new Date(NOW - GRANT_TTL_MS).toISOString() }), NOW), deny);
  assert.deepEqual(decidePreToolUse(bash(START), grant({ at: new Date(NOW - GRANT_TTL_MS + 1).toISOString() }), NOW).decision, "allow");
  assert.deepEqual(decidePreToolUse(bash(START), grant({ at: new Date(NOW + 60_000).toISOString() }), NOW), deny);
  assert.deepEqual(decidePreToolUse(bash(START), grant({ issues: [12] }), NOW), deny);
  assert.deepEqual(decidePreToolUse(bash(START), grant({ issues: [12, 14, 15] }), NOW), deny);
  assert.deepEqual(decidePreToolUse(bash(START), grant({ issues: [12, 15] }), NOW), deny);
  assert.deepEqual(decidePreToolUse(bash(START), grant({ sessionId: "s2" }), NOW), deny);
  assert.deepEqual(decidePreToolUse(bash(START, { session_id: "../x" }), grant({ sessionId: "../x" }), NOW), deny);
});

test("criterion 1: the same issues in another order are still the same grant", () => {
  assert.equal(decidePreToolUse(bash("node scripts/lanes/start.mjs 14 12"), grant(), NOW).decision, "allow");
});

test("criterion 1: a granted session still cannot wrap or chain start.mjs", () => {
  for (const cmd of [`${START}; echo done`, `bash -c "${START}"`, `${START} && claude --bg x`, `node scripts/lanes/start.mjs 12 14 --x`]) {
    assert.equal(decidePreToolUse(bash(cmd), grant(), NOW).decision, "deny", cmd);
  }
});

test("criterion 2: a direct claude --bg is denied in every session, even with a /start grant", () => {
  const deny = { decision: "deny", reason: BG_DENY_REASON };
  assert.deepEqual(decidePreToolUse(bash('claude --bg "/lane 12"'), null, NOW), deny);
  assert.deepEqual(decidePreToolUse(bash('claude --bg "/lane 12"'), grant(), NOW), deny);
  assert.deepEqual(decidePreToolUse(bash('claude --bg "/lane 12"', { permission_mode: "bypassPermissions" }), grant(), NOW), deny);
  assert.deepEqual(decidePreToolUse(bash('claude --bg "/lane 12"', { session_id: undefined }), null, NOW), deny);
});

test("anything else, and other tools, get no decision", () => {
  assert.equal(decidePreToolUse(bash("git status"), null, NOW), null);
  assert.equal(decidePreToolUse(bash("claude agents --json"), null, NOW), null);
  assert.equal(decidePreToolUse({ tool_name: "Read", tool_input: { file_path: "scripts/lanes/start.mjs" } }, null, NOW), null);
  assert.equal(decidePreToolUse(bash(undefined), null, NOW), null);
  assert.equal(decidePreToolUse(null, null, NOW), null);
});

// --- /start --auto (#76) ------------------------------------------------------------------------------------------

const AUTO = "node scripts/lanes/start.mjs --auto";
const GO = "node scripts/lanes/start.mjs --auto --go";
const autoGrant = (auto, over = {}) => ({ sessionId: "s1", auto, at: new Date(NOW - 60_000).toISOString(), ...over });

test("#76 criterion 1: only a prompt that is exactly /start --auto or /start --auto --go names an auto form", () => {
  assert.equal(parseAutoPrompt("/start --auto"), "dry");
  assert.equal(parseAutoPrompt("/start --auto --go"), "go");
  assert.equal(parseAutoPrompt("  /start   --auto   --go \n"), "go");
  for (const p of ["/start", "/start --go", "/start --go --auto", "/start --auto --go --go", "/start --auto 12", "/start 12 --auto", "/start --auto=go", "/start --autogo", "/start --auto --gone", "/start --AUTO", "please /start --auto", "/start --auto; rm", "/starting --auto", undefined, 12]) {
    assert.equal(parseAutoPrompt(p), null, JSON.stringify(p));
  }
  assert.equal(parseStartPrompt("/start --auto"), null);
});

test("#76 criterion 1: UserPromptSubmit grants each auto form and records which one was typed", () => {
  const at = new Date(NOW).toISOString();
  assert.deepEqual(onUserPromptSubmit({ session_id: "s1", prompt: "/start --auto" }, NOW), { action: "grant", sessionId: "s1", grant: { sessionId: "s1", auto: "dry", at } });
  assert.deepEqual(onUserPromptSubmit({ session_id: "s1", prompt: "/start --auto --go" }, NOW), { action: "grant", sessionId: "s1", grant: { sessionId: "s1", auto: "go", at } });
  assert.deepEqual(onUserPromptSubmit({ session_id: "s1", prompt: "/start --go" }, NOW), { action: "clear", sessionId: "s1" });
  assert.deepEqual(onUserPromptSubmit({ session_id: "../x", prompt: "/start --auto" }, NOW), { action: "none" });
});

test("#76: the plain auto commands are detected as standalone with their form", () => {
  assert.deepEqual(findStartInvocations(AUTO), [{ auto: "dry", standalone: true }]);
  assert.deepEqual(findStartInvocations(`${GO}\n`), [{ auto: "go", standalone: true }]);
});

test("#76 criterion 2: each auto form is allowed with a fresh grant for that exact form", () => {
  assert.deepEqual(decidePreToolUse(bash(AUTO), autoGrant("dry"), NOW), { decision: "allow", reason: "owner run of /start --auto in this session", consumeGrant: true });
  assert.deepEqual(decidePreToolUse(bash(GO), autoGrant("go"), NOW), { decision: "allow", reason: "owner run of /start --auto --go in this session", consumeGrant: true });
});

test("#76 criterion 2: a dry-run grant never allows --go, and no grant crosses forms", () => {
  const deny = { decision: "deny", reason: DENY_REASON };
  assert.deepEqual(decidePreToolUse(bash(GO), autoGrant("dry"), NOW), deny);
  assert.deepEqual(decidePreToolUse(bash(AUTO), autoGrant("go"), NOW), deny);
  assert.deepEqual(decidePreToolUse(bash(AUTO), grant(), NOW), deny);
  assert.deepEqual(decidePreToolUse(bash(GO), grant(), NOW), deny);
  assert.deepEqual(decidePreToolUse(bash(START), autoGrant("go"), NOW), deny);
  assert.deepEqual(decidePreToolUse(bash(AUTO), null, NOW), deny);
});

test("#76 criterion 2: a stale, future or other-session auto grant is refused", () => {
  const deny = { decision: "deny", reason: DENY_REASON };
  for (const [cmd, form] of [[AUTO, "dry"], [GO, "go"]]) {
    assert.deepEqual(decidePreToolUse(bash(cmd), autoGrant(form, { at: new Date(NOW - GRANT_TTL_MS).toISOString() }), NOW), deny);
    assert.equal(decidePreToolUse(bash(cmd), autoGrant(form, { at: new Date(NOW - GRANT_TTL_MS + 1).toISOString() }), NOW).decision, "allow");
    assert.deepEqual(decidePreToolUse(bash(cmd), autoGrant(form, { at: new Date(NOW + 60_000).toISOString() }), NOW), deny);
    assert.deepEqual(decidePreToolUse(bash(cmd), autoGrant(form, { sessionId: "s2" }), NOW), deny);
  }
});

test("#76 criterion 2: chained, wrapped or altered auto forms are denied even with a grant", () => {
  for (const [cmd, form] of [
    [`${AUTO}; echo done`, "dry"],
    [`${GO} && echo done`, "go"],
    [`bash -c "${GO}"`, "go"],
    [`sh -c '${AUTO}'`, "dry"],
    [`env X=1 ${GO}`, "go"],
    [`${GO} | cat`, "go"],
    [`${AUTO} > plan.txt`, "dry"],
    [`${GO} && claude --bg x`, "go"],
    [`node ./scripts/lanes/start.mjs --auto --go`, "go"],
    [`node scripts/lanes/start.mjs --go --auto`, "go"],
    [`node scripts/lanes/start.mjs --auto --go --go`, "go"],
    [`node scripts/lanes/start.mjs --auto 12`, "dry"],
    [`node scripts/lanes/start.mjs --auto=go`, "go"],
    [`node scripts/lanes/start.mjs  --auto  --go`, "go"],
    [`node scripts/lanes/start.mjs "--auto" --go`, "go"],
    [`F=--go; node scripts/lanes/start.mjs --auto $F`, "go"],
    [`${AUTO}; ${GO}`, "go"],
  ]) {
    assert.equal(decidePreToolUse(bash(cmd), autoGrant(form), NOW).decision, "deny", cmd);
  }
});

test("#76 edge: a grant holding both issues and an auto form, or an unknown form, is malformed and denies", () => {
  const deny = { decision: "deny", reason: DENY_REASON };
  assert.deepEqual(decidePreToolUse(bash(GO), autoGrant("go", { issues: [12] }), NOW), deny);
  assert.deepEqual(decidePreToolUse(bash(START), grant({ auto: "go" }), NOW), deny);
  for (const auto of ["GO", "", "go ", null, 1, true]) assert.deepEqual(decidePreToolUse(bash(GO), autoGrant(auto), NOW), deny, JSON.stringify(auto));
});

test("#76 criterion 3: /start --auto --go then the go command is allowed once by the hook; a dry-run grant refuses --go", () => {
  const dir = tmp();
  try {
    runHook("user-prompt-submit", JSON.stringify({ session_id: "s1", prompt: "/start --auto --go" }), { dir, now: NOW });
    assert.equal(JSON.parse(readFileSync(join(dir, "s1.json"), "utf8")).auto, "go");
    assert.deepEqual(out(runHook("pre-tool-use", JSON.stringify(bash(GO)), { dir, now: NOW + 1000 })), { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "owner run of /start --auto --go in this session" });
    assert.ok(!existsSync(join(dir, "s1.json")));
    assert.equal(out(runHook("pre-tool-use", JSON.stringify(bash(GO)), { dir, now: NOW + 2000 })).permissionDecision, "deny");

    runHook("user-prompt-submit", JSON.stringify({ session_id: "s1", prompt: "/start --auto" }), { dir, now: NOW });
    assert.equal(out(runHook("pre-tool-use", JSON.stringify(bash(GO)), { dir, now: NOW + 1000 })).permissionDecision, "deny");
    assert.equal(out(runHook("pre-tool-use", JSON.stringify(bash(AUTO)), { dir, now: NOW + 1000 })).permissionDecision, "allow");
    assert.equal(out(runHook("pre-tool-use", JSON.stringify(bash(AUTO)), { dir, now: NOW + 2000 })).permissionDecision, "deny");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#76 criterion 3: another session's auto grant is refused by the hook", () => {
  const dir = tmp();
  try {
    runHook("user-prompt-submit", JSON.stringify({ session_id: "owner", prompt: "/start --auto --go" }), { dir, now: NOW });
    assert.equal(out(runHook("pre-tool-use", JSON.stringify(bash(GO, { session_id: "lane" })), { dir, now: NOW })).permissionDecision, "deny");
    assert.ok(existsSync(join(dir, "owner.json")), "another session's denied run does not consume the owner's grant");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#76 criterion 4: start.md and USING.md no longer say the guard denies --auto", () => {
  for (const file of [".claude/commands/start.md", "docs/USING.md"]) {
    const text = readFileSync(file, "utf8");
    assert.doesNotMatch(text, /not (yet )?allow the `--auto`|not yet `--auto`|#76/, file);
    assert.match(text, /\/start --auto/, file);
  }
});

// --- the hook end to end (criterion 3:allowed /start run, denied lane, denied claude --bg, expired grant) ---------

test("criterion 3: /start then start.mjs is allowed once, and the grant is consumed", () => {
  const dir = tmp();
  try {
    runHook("user-prompt-submit", JSON.stringify({ session_id: "s1", prompt: "/start 12 14" }), { dir, now: NOW });
    assert.ok(existsSync(join(dir, "s1.json")));
    assert.deepEqual(out(runHook("pre-tool-use", JSON.stringify(bash(START)), { dir, now: NOW + 1000 })), { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "owner launch from /start 12 14 in this session" });
    assert.ok(!existsSync(join(dir, "s1.json")));
    assert.equal(out(runHook("pre-tool-use", JSON.stringify(bash(START)), { dir, now: NOW + 2000 })).permissionDecision, "deny");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("criterion 3: a lane's start.mjs run is denied", () => {
  const dir = tmp();
  try {
    runHook("user-prompt-submit", JSON.stringify({ session_id: "lane", prompt: "/lane 51" }), { dir, now: NOW });
    assert.deepEqual(out(runHook("pre-tool-use", JSON.stringify(bash(START, { session_id: "lane" })), { dir, now: NOW })), { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: DENY_REASON });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("criterion 3: a direct claude --bg is denied by the hook", () => {
  const dir = tmp();
  try {
    runHook("user-prompt-submit", JSON.stringify({ session_id: "s1", prompt: "/start 12" }), { dir, now: NOW });
    assert.deepEqual(out(runHook("pre-tool-use", JSON.stringify(bash('claude --bg "/lane 12"')), { dir, now: NOW })), { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: BG_DENY_REASON });
    assert.ok(existsSync(join(dir, "s1.json")), "a denied claude --bg does not consume the /start grant");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("criterion 3: an expired or mismatched grant is denied by the hook, and a later prompt clears the grant", () => {
  const dir = tmp();
  try {
    runHook("user-prompt-submit", JSON.stringify({ session_id: "s1", prompt: "/start 12 14" }), { dir, now: NOW });
    assert.equal(out(runHook("pre-tool-use", JSON.stringify(bash(START)), { dir, now: NOW + GRANT_TTL_MS })).permissionDecision, "deny");
    assert.equal(out(runHook("pre-tool-use", JSON.stringify(bash("node scripts/lanes/start.mjs 12")), { dir, now: NOW })).permissionDecision, "deny");
    runHook("user-prompt-submit", JSON.stringify({ session_id: "s1", prompt: "ok thanks" }), { dir, now: NOW });
    assert.ok(!existsSync(join(dir, "s1.json")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("edge: an unreadable or malformed grant file denies", () => {
  const dir = tmp();
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "s1.json"), "{not json");
    assert.equal(out(runHook("pre-tool-use", JSON.stringify(bash(START)), { dir, now: NOW })).permissionDecision, "deny");
    for (const g of [{ sessionId: "s1", issues: [], at: new Date(NOW).toISOString() }, { sessionId: "s1", issues: [12, "14"], at: new Date(NOW).toISOString() }, { sessionId: "s1", issues: [12, 14], at: "never" }, { sessionId: "s1", issues: [12, 12, 14], at: new Date(NOW).toISOString() }]) {
      writeFileSync(join(dir, "s1.json"), JSON.stringify(g));
      assert.equal(out(runHook("pre-tool-use", JSON.stringify(bash(START)), { dir, now: NOW })).permissionDecision, "deny", JSON.stringify(g));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("edge: malformed hook input denies on pre-tool-use and never blocks a prompt", () => {
  const dir = tmp();
  try {
    assert.equal(out(runHook("pre-tool-use", "{not json", { dir, now: NOW })).permissionDecision, "deny");
    assert.equal(runHook("user-prompt-submit", "{not json", { dir, now: NOW }), "");
    assert.equal(runHook("pre-tool-use", JSON.stringify(bash("git status")), { dir, now: NOW }), "");
    assert.throws(() => runHook("other", "{}", { dir }), /usage/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("edge: the script run as a hook denies claude --bg from stdin and writes a /start grant under .lanes/start", () => {
  const r = spawnSync(process.execPath, ["scripts/lanes/start-guard.mjs", "pre-tool-use"], { input: JSON.stringify(bash("claude --bg x", { session_id: "cli-test" })), encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "deny");
  const bad = spawnSync(process.execPath, ["scripts/lanes/start-guard.mjs", "pre-tool-use"], { input: "garbage", encoding: "utf8" });
  assert.equal(JSON.parse(bad.stdout).hookSpecificOutput.permissionDecision, "deny");
  const file = join(".lanes", "start", "cli-test-grant.json");
  try {
    spawnSync(process.execPath, ["scripts/lanes/start-guard.mjs", "user-prompt-submit"], { input: JSON.stringify({ session_id: "cli-test-grant", prompt: "/start 9" }), encoding: "utf8" });
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).issues, [9]);
  } finally {
    rmSync(file, { force: true });
  }
});

test("settings: both start-guard hooks are wired next to the approve guard, and start.mjs is never allow-listed", () => {
  const s = JSON.parse(readFileSync(".claude/settings.json", "utf8"));
  const commands = (event, matcher) => s.hooks[event].filter((h) => h.matcher === matcher).flatMap((h) => h.hooks.map((x) => x.command));
  assert.ok(commands("UserPromptSubmit", undefined).some((c) => /scripts\/lanes\/start-guard\.mjs" user-prompt-submit$/.test(c)));
  assert.ok(commands("PreToolUse", "Bash").some((c) => /scripts\/lanes\/start-guard\.mjs" pre-tool-use$/.test(c)));
  assert.ok(!s.permissions.allow.some((r) => /start\.mjs|claude --bg/.test(r)));
});
