// scripts/lanes/start-guard.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BG_DENY_REASON, DENY_REASON, PARSE_DENY_REASON, QUEUE_DENY_REASON, UNRESOLVED_DENY_REASON, GRANT_TTL_MS, decidePreToolUse, findBgLaunches, findQueueInvocations, findStartInvocations, grantPath, grantRefusal, onUserPromptSubmit, parseAutoPrompt, parseStartPrompt, readGrant, runHook } from "./start-guard.mjs";

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
  assert.deepEqual(findStartInvocations(`git commit -m "don't run start.mjs"`), [{ issues: undefined, standalone: false, unparsed: true }]);
  assert.deepEqual(findStartInvocations(`node scripts/lanes/start.mjs "12`), [{ issues: undefined, standalone: false, unparsed: true }]);
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

test("criterion 1: /start in this session allows the plain start command, for the same issues", () => {
  assert.deepEqual(decidePreToolUse(bash(START), grant(), NOW), { decision: "allow", reason: "owner launch from /start 12 14 in this session" });
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

test("#76 edge: a direct claude --bg is denied even with a fresh --auto or --auto --go grant", () => {
  // Not covered above (that test only tries a numbered-issues grant): an auto grant must not create a second path
  // around the always-on --bg denial.
  const deny = { decision: "deny", reason: BG_DENY_REASON };
  assert.deepEqual(decidePreToolUse(bash('claude --bg "/lane 12"'), autoGrant("dry"), NOW), deny);
  assert.deepEqual(decidePreToolUse(bash('claude --bg "/lane 12"'), autoGrant("go"), NOW), deny);
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
  assert.deepEqual(decidePreToolUse(bash(AUTO), autoGrant("dry"), NOW), { decision: "allow", reason: "owner run of /start --auto in this session" });
  assert.deepEqual(decidePreToolUse(bash(GO), autoGrant("go"), NOW), { decision: "allow", reason: "owner run of /start --auto --go in this session" });
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

// #118: the hook no longer deletes the grant; start.mjs deletes it after its launches (simulated here with rmSync).
test("#76 criterion 3: /start --auto --go then the go command is allowed by the hook until start.mjs spends the grant; a dry-run grant refuses --go", () => {
  const dir = tmp();
  try {
    runHook("user-prompt-submit", JSON.stringify({ session_id: "s1", prompt: "/start --auto --go" }), { dir, now: NOW });
    assert.equal(JSON.parse(readFileSync(join(dir, "s1.json"), "utf8")).auto, "go");
    assert.deepEqual(out(runHook("pre-tool-use", JSON.stringify(bash(GO)), { dir, now: NOW + 1000 })), { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "owner run of /start --auto --go in this session" });
    assert.ok(existsSync(join(dir, "s1.json")), "#118: the hook leaves the grant for start.mjs");
    rmSync(join(dir, "s1.json")); // what start.mjs does after its launches
    assert.equal(out(runHook("pre-tool-use", JSON.stringify(bash(GO)), { dir, now: NOW + 2000 })).permissionDecision, "deny");

    runHook("user-prompt-submit", JSON.stringify({ session_id: "s1", prompt: "/start --auto" }), { dir, now: NOW });
    assert.equal(out(runHook("pre-tool-use", JSON.stringify(bash(GO)), { dir, now: NOW + 1000 })).permissionDecision, "deny");
    assert.equal(out(runHook("pre-tool-use", JSON.stringify(bash(AUTO)), { dir, now: NOW + 1000 })).permissionDecision, "allow");
    rmSync(join(dir, "s1.json"));
    assert.equal(out(runHook("pre-tool-use", JSON.stringify(bash(AUTO)), { dir, now: NOW + 2000 })).permissionDecision, "deny");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#76 edge: typing /start --auto after /start <N ...> replaces the numbered grant, not merges it", () => {
  // Not covered above (those tests only move between the two auto forms): a numbered grant on disk must be fully
  // overwritten, not merged, so the stale issue numbers cannot still unlock a numbered run.
  const dir = tmp();
  try {
    runHook("user-prompt-submit", JSON.stringify({ session_id: "s1", prompt: "/start 12 14" }), { dir, now: NOW });
    runHook("user-prompt-submit", JSON.stringify({ session_id: "s1", prompt: "/start --auto" }), { dir, now: NOW + 500 });
    const onDisk = JSON.parse(readFileSync(join(dir, "s1.json"), "utf8"));
    assert.deepEqual(onDisk, { sessionId: "s1", auto: "dry", at: new Date(NOW + 500).toISOString() });
    assert.equal(out(runHook("pre-tool-use", JSON.stringify(bash(START)), { dir, now: NOW + 1000 })).permissionDecision, "deny");
    assert.equal(out(runHook("pre-tool-use", JSON.stringify(bash(AUTO)), { dir, now: NOW + 1000 })).permissionDecision, "allow");
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

test("criterion 3: /start then start.mjs is allowed, the hook leaves the grant (#118), and once start.mjs spends it the next run is denied", () => {
  const dir = tmp();
  try {
    runHook("user-prompt-submit", JSON.stringify({ session_id: "s1", prompt: "/start 12 14" }), { dir, now: NOW });
    assert.ok(existsSync(join(dir, "s1.json")));
    const before = readFileSync(join(dir, "s1.json"), "utf8");
    assert.deepEqual(out(runHook("pre-tool-use", JSON.stringify(bash(START)), { dir, now: NOW + 1000 })), { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "owner launch from /start 12 14 in this session" });
    assert.equal(readFileSync(join(dir, "s1.json"), "utf8"), before, "#118: the hook neither deletes nor rewrites the grant");
    rmSync(join(dir, "s1.json")); // what start.mjs does after its launches
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

// --- Heredocs (#86) -----------------------------------------------------------------------------------------------

const COMMIT_HEREDOC = `git add -A && git commit -m "$(cat <<'MSG'
start-guard: read heredocs (#86)

The guard did not read a heredoc (it said "lanes are launched only from /start").
Adds \`decidePreToolUse\` tests; see scripts/lanes/start-guard.mjs, not start.mjs --bg.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"`;

test("#86 criterion 1: a heredoc commit message that runs neither start.mjs nor claude --bg gets no decision", () => {
  for (const cmd of [COMMIT_HEREDOC, `git commit -m "$(cat <<'EOF'\nFix it\n\nCo-Authored-By: x\nEOF\n)"`, `git commit -m "$(cat <<EOF\nFix it\nEOF\n)"`]) {
    assert.equal(decidePreToolUse(bash(cmd), null, NOW), null, cmd);
    assert.deepEqual(findStartInvocations(cmd), [], cmd);
    assert.equal(findBgLaunches(cmd), false, cmd);
  }
});

test("#86 criterion 2: a heredoc that runs start.mjs or claude --bg is still denied", () => {
  for (const [cmd, reason] of [
    ["bash <<'EOF'\nnode scripts/lanes/start.mjs 12\nEOF", DENY_REASON],
    ["cat <<'EOF' | sh\nnode scripts/lanes/start.mjs 12\nEOF", DENY_REASON],
    [`bash -c "$(cat <<'EOF'\nnode scripts/lanes/start.mjs 12\nEOF\n)"`, DENY_REASON],
    ["cat <<EOF\n$(node scripts/lanes/start.mjs 12)\nEOF", DENY_REASON],
    ["bash <<'EOF'\nclaude --bg '/lane 12'\nEOF", BG_DENY_REASON],
    [`sh -c "$(cat <<'EOF'\nclaude --bg x\nEOF\n)"`, BG_DENY_REASON],
  ]) {
    assert.deepEqual(decidePreToolUse(bash(cmd), grant(), NOW), { decision: "deny", reason }, cmd);
  }
});

test("#86 criterion 3: a command that cannot be parsed fails closed with a could-not-parse reason", () => {
  for (const cmd of [`git commit -m "don't run start.mjs"`, `claude --bg "unterminated`, `git commit -m "$(cat <<'EOF'\nit's start.mjs\nEOF\n)"`]) {
    const d = decidePreToolUse(bash(cmd), grant(), NOW);
    assert.deepEqual(d, { decision: "deny", reason: PARSE_DENY_REASON }, cmd);
    assert.match(d.reason, /could not be parsed/);
    assert.doesNotMatch(d.reason, /launched only from \/start/);
  }
});

test("edge: heredoc commit messages that are empty, CRLF, or name Claude and --bg in prose get no decision", () => {
  for (const cmd of [
    `git commit -m "$(cat <<'EOF'\nEOF\n)"`,
    `git commit -m "$(cat <<'EOF'\r\nFix it\r\nEOF\r\n)"`,
    `git commit -m "$(cat <<'EOF'\nCo-Authored-By: Claude\nmentions --bg mode\nEOF\n)"`,
    `git commit -m "$(cat <<-'EOF'\n\tFix it\n\tEOF\n)"`,
    `git commit -m $(cat <<'EOF'\nFix\nEOF\n)`,
    "cat <<'EOF' > notes.txt\nsome notes\nEOF",
    "cat <<-EOF\n\thello\n\tEOF",
    "cat <<EOF\nno delimiter line",
  ]) {
    assert.equal(decidePreToolUse(bash(cmd), null, NOW), null, JSON.stringify(cmd));
  }
});

test("edge: heredoc forms that still run start.mjs are start runs, never standalone", () => {
  for (const cmd of [
    "cat <<-EOF | bash\n\tnode scripts/lanes/start.mjs 12\n\tEOF",
    "bash <<EOF\nnode scripts/lanes/start.mjs 12",
    `bash <<< "node scripts/lanes/start.mjs 12"`,
    "cat <<'EOF' > notes.txt\nhello\nEOF\nnode scripts/lanes/start.mjs 12",
    "cat <<A <<B\nx\nA\nnode scripts/lanes/start.mjs 12\nB",
    `"$(cat <<'E'\nnode\nE\n)" scripts/lanes/start.mjs 12`,
    `git commit -m "$(cat <<EOF\n$(node scripts/lanes/start.mjs 12)\nEOF\n)"`,
    // A quoted heredoc message reads like a single-quoted one: a line that is the start command is still denied.
    `git commit -m "$(cat <<'EOF'\nnode scripts/lanes/start.mjs 12\nEOF\n)"`,
  ]) {
    const found = findStartInvocations(cmd);
    assert.ok(found.length > 0 && found.every((f) => !f.standalone), JSON.stringify(cmd));
    assert.deepEqual(decidePreToolUse(bash(cmd), grant(), NOW), { decision: "deny", reason: DENY_REASON }, JSON.stringify(cmd));
  }
});

test("edge: bit-shift arithmetic (`$((1<<2))`) is not mistaken for a heredoc, and never hides a real start.mjs or claude --bg run on the next line", () => {
  // Found by the test-hunter: `1<<2` inside `$((...))` matches the heredoc opener regex (delimiter "2"), so the
  // lexer treats the rest of the line as a bogus heredoc body. On a single line that body is simply never closed
  // (no trailing newline to read it), so nothing is lost. Across a newline the "body" swallows whatever follows -
  // but that swallowed text is still walked as a nested script, so a real start.mjs/claude --bg run right after the
  // arithmetic must still be caught, and a merely-arithmetic command must still get no decision.
  for (const cmd of [`X=$((1<<2)); echo $X`, "X=$((1<<2))\necho done"]) {
    assert.deepEqual(findStartInvocations(cmd), [], cmd);
    assert.equal(findBgLaunches(cmd), false, cmd);
    assert.equal(decidePreToolUse(bash(cmd), grant(), NOW), null, cmd);
  }
  assert.deepEqual(decidePreToolUse(bash("X=$((1<<2))\nnode scripts/lanes/start.mjs 12"), grant(), NOW), { decision: "deny", reason: DENY_REASON });
  assert.deepEqual(decidePreToolUse(bash("X=$((1<<2))\nclaude --bg x"), grant(), NOW), { decision: "deny", reason: BG_DENY_REASON });
});

test("edge: the hook itself passes a heredoc commit and gives the could-not-parse reason end to end", () => {
  const dir = tmp();
  try {
    assert.equal(runHook("pre-tool-use", JSON.stringify(bash(COMMIT_HEREDOC)), { dir, now: NOW }), "");
    const o = out(runHook("pre-tool-use", JSON.stringify(bash(`git commit -m "don't run start.mjs"`)), { dir, now: NOW }));
    assert.deepEqual(o, { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: PARSE_DENY_REASON });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- queue.mjs (#95, ADR 0005): the owner's own terminal only -------------------------------------------------------

const QUEUE = "node scripts/lanes/queue.mjs 12 14";
const QUEUE_RUNS = [
  QUEUE,
  "node scripts/lanes/queue.mjs",
  "node scripts/lanes/queue.mjs\n",
  "cd /repo && node scripts/lanes/queue.mjs 12",
  "node scripts/lanes/queue.mjs 12; echo done",
  "git fetch origin || node scripts/lanes/queue.mjs 12",
  "(node scripts/lanes/queue.mjs 12)",
  'bash -c "node scripts/lanes/queue.mjs 12"',
  "sh -c 'cd /repo && node scripts/lanes/queue.mjs 12'",
  "env FOO=1 node scripts/lanes/queue.mjs 12",
  "FOO=1 node scripts/lanes/queue.mjs 12",
  "nohup node scripts/lanes/queue.mjs 12 &",
  "timeout 60 node scripts/lanes/queue.mjs 12",
  "bun scripts/lanes/queue.mjs 12",
  "bun run scripts/lanes/queue.mjs 12",
  "deno run -A scripts/lanes/queue.mjs 12",
  "nodejs scripts/lanes/queue.mjs 12",
  "node.exe scripts/lanes/queue.mjs 12",
  '"C:/Program Files/nodejs/node.exe" scripts/lanes/queue.mjs 12',
  "node --no-warnings scripts/lanes/queue.mjs 12",
  "node ./scripts/lanes/queue.mjs 12",
  "node /opt/repo/scripts/lanes/queue.mjs 12",
  "node C:/repo/scripts/lanes/queue.mjs 12",
  '"C:\\repo\\scripts\\lanes\\queue.mjs" 12',
  "node scripts\\lanes\\queue.mjs 12",
  "./scripts/lanes/queue.mjs 12",
  "scripts/lanes/queue.mjs 12",
  "cd scripts/lanes && node queue.mjs 12",
  "node scripts/lanes/QUEUE.MJS 12",
  "Q=scripts/lanes/queue.mjs; node $Q 12",
  "X=queue; node scripts/lanes/$X.mjs 12",
  "bash <<'EOF'\nnode scripts/lanes/queue.mjs 12\nEOF",
  "cat <<EOF | sh\nnode scripts/lanes/queue.mjs 12\nEOF",
];
const AUTO_GO_GRANT = () => grant({ issues: undefined, auto: "go" });

test("#95 criterion 1: every run of queue.mjs, plain, chained, wrapped, through node/bun/deno, relative or absolute, is found", () => {
  for (const c of QUEUE_RUNS) assert.equal(findQueueInvocations(c), true, c);
});

test("#95 criterion 1: every queue.mjs run is denied with a reason naming the owner's terminal, with no grant", () => {
  assert.match(QUEUE_DENY_REASON, /owner's own terminal/);
  for (const c of QUEUE_RUNS) assert.deepEqual(decidePreToolUse(bash(c), null, NOW), { decision: "deny", reason: QUEUE_DENY_REASON }, c);
});

test("#95 criterion 1: every queue.mjs run is denied whatever grant the session holds", () => {
  const grants = [grant(), grant({ issues: [12] }), grant({ issues: undefined, auto: "dry" }), AUTO_GO_GRANT(), { unreadable: true }, null];
  for (const g of grants) {
    for (const c of QUEUE_RUNS) assert.deepEqual(decidePreToolUse(bash(c), g, NOW), { decision: "deny", reason: QUEUE_DENY_REASON }, `${JSON.stringify(g)} ${c}`);
  }
});

test("#95 criterion 2: a /start grant never allows queue.mjs, even chained with the start command it grants", () => {
  for (const c of [QUEUE, `${START} && ${QUEUE}`, `${QUEUE}; ${START}`, `${GO}; node scripts/lanes/queue.mjs`]) {
    assert.deepEqual(decidePreToolUse(bash(c), grant(), NOW), { decision: "deny", reason: QUEUE_DENY_REASON }, c);
    assert.deepEqual(decidePreToolUse(bash(c), AUTO_GO_GRANT(), NOW), { decision: "deny", reason: QUEUE_DENY_REASON }, c);
  }
});

test("#95 criterion 3: commands that only mention queue.mjs, or run its tests, are not denied", () => {
  const mentions = [
    "cat scripts/lanes/queue.mjs",
    "grep -n queue scripts/lanes/queue.mjs",
    "git diff scripts/lanes/queue.mjs",
    "git diff --stat -- scripts/lanes/queue.mjs scripts/lanes/queue.test.mjs",
    "node --test scripts/lanes/queue.test.mjs",
    "node --test scripts/lanes/queue.test.mjs --reporter=dot",
    "sed -n 1,40p scripts/lanes/queue.mjs",
    "git log --oneline -5 -- scripts/lanes/queue.mjs",
    'git commit -m "queue.mjs: owner-run lane queue"',
    'gh pr create --title "start-guard denies queue.mjs" --body "only the owner runs queue.mjs"',
    "gh pr create --title x --body-file .lanes/pr-body.md",
    "wc -l scripts/lanes/queue.mjs",
    "cat < scripts/lanes/queue.mjs",
  ];
  for (const c of mentions) {
    assert.equal(findQueueInvocations(c), false, c);
    assert.equal(decidePreToolUse(bash(c), null, NOW), null, c);
    assert.equal(decidePreToolUse(bash(c), AUTO_GO_GRANT(), NOW), null, c);
  }
});

test("#95 extra: node with queue.mjs redirected onto its stdin is a run too, not just an argument form", () => {
  // Not among the QUEUE_RUNS forms above: no explicit node argument names the file, but `node < queue.mjs` still
  // executes it as node's stdin script, unlike `cat < queue.mjs` (a mention, asserted above) which only reads it.
  assert.equal(findQueueInvocations("node < scripts/lanes/queue.mjs"), true);
  assert.deepEqual(decidePreToolUse(bash("node < scripts/lanes/queue.mjs"), null, NOW), { decision: "deny", reason: QUEUE_DENY_REASON });
  assert.deepEqual(decidePreToolUse(bash("node < scripts/lanes/queue.mjs"), AUTO_GO_GRANT(), NOW), { decision: "deny", reason: QUEUE_DENY_REASON });
});

test("#95 criterion 4: with a /start --auto --go grant written by the hook, queue.mjs is denied and the grant is kept", () => {
  const dir = tmp();
  try {
    runHook("user-prompt-submit", JSON.stringify({ session_id: "s1", prompt: "/start --auto --go" }), { dir, now: NOW });
    for (const c of [QUEUE, "node scripts/lanes/queue.mjs --auto --go", 'bash -c "node scripts/lanes/queue.mjs 12"']) {
      assert.deepEqual(out(runHook("pre-tool-use", JSON.stringify(bash(c)), { dir, now: NOW + 1000 })), { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: QUEUE_DENY_REASON }, c);
    }
    assert.ok(existsSync(join(dir, "s1.json")), "a denied queue.mjs run does not consume the /start grant");
    assert.equal(out(runHook("pre-tool-use", JSON.stringify(bash(GO)), { dir, now: NOW + 2000 })).permissionDecision, "allow");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#95 criterion 4: the hook process Claude Code runs denies queue.mjs end to end", () => {
  const r = spawnSync(process.execPath, ["scripts/lanes/start-guard.mjs", "pre-tool-use"], { input: JSON.stringify(bash(QUEUE, { session_id: "queue-e2e-no-grant" })), encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.deepEqual(out(r.stdout), { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: QUEUE_DENY_REASON });
});

test("#95 edge: a quoted script that cannot be read and names queue.mjs is denied as a queue run", () => {
  for (const c of ['bash -c "node scripts/lanes/queue.mjs 12', "sh -c 'node scripts/lanes/queue.mjs"]) {
    assert.deepEqual(decidePreToolUse(bash(c), grant(), NOW), { decision: "deny", reason: QUEUE_DENY_REASON }, c);
  }
});

test("#95 edge: an unresolved command or script word in a simple command that names queue.mjs is denied as a queue run", () => {
  for (const c of ["node `echo scripts/lanes/queue.mjs` 12", "$NODE scripts/lanes/queue.mjs 12", "node $SCRIPT # queue.mjs"]) {
    assert.deepEqual(decidePreToolUse(bash(c), grant(), NOW), { decision: "deny", reason: QUEUE_DENY_REASON }, c);
  }
});

test("#95 edge: a program named only at run time is denied with a reason naming the owner's terminal, even when the text never says queue.mjs", () => {
  // Found by the security review: an encoded path decoded into a variable never puts queue.mjs in the command text.
  assert.match(UNRESOLVED_DENY_REASON, /owner's own terminal/);
  for (const c of ["X=$(echo c2NyaXB0cy9sYW5lcy9xdWV1ZS5tanM= | base64 -d); node $X 12", "node $(echo scripts/lanes/queue.mjs) 12", "node $SCRIPT 12", "$RUN 12"]) {
    for (const g of [null, grant(), AUTO_GO_GRANT()]) assert.deepEqual(decidePreToolUse(bash(c), g, NOW), { decision: "deny", reason: UNRESOLVED_DENY_REASON }, c);
  }
});

test("#95 edge: an unresolved script after a flag that takes a value is still denied (security review, round 2)", () => {
  const runs = ["X=$(cat /tmp/hidden); node -r dotenv/config $X", "node -r dotenv/config $X", "node --require dotenv/config $X 12", "node --experimental-loader ./x.mjs $X", "node --max-old-space-size 4096 $X", "deno run -A $X", "bun run $X", "node --no-warnings -r a -r b $X"];
  for (const c of runs) {
    for (const g of [null, grant(), AUTO_GO_GRANT()]) assert.deepEqual(decidePreToolUse(bash(c), g, NOW), { decision: "deny", reason: UNRESOLVED_DENY_REASON }, c);
    assert.ok(findStartInvocations(c).length > 0, `start.mjs bypass not caught: ${c}`);
  }
});

test("#95 edge: an argument after a script node plainly runs is not a script candidate", () => {
  for (const c of ["node scripts/lanes/blockers.mjs $N", "node scripts/lanes/post-review.mjs --file $F", "bun run scripts/x.mjs $ARG"]) {
    assert.equal(decidePreToolUse(bash(c), null, NOW), null, c);
  }
});

test("#95 edge: a queue.mjs mention elsewhere does not relabel an unrelated unresolved run as a queue run", () => {
  // Found by the test-hunter: the queue reason is scoped to the simple command, not the whole call's text.
  const c = 'git commit -m "note about queue.mjs" && node $X';
  assert.equal(findQueueInvocations(c), false);
  assert.deepEqual(decidePreToolUse(bash(c), null, NOW), { decision: "deny", reason: UNRESOLVED_DENY_REASON });
});

test("#95 edge: files that merely look like queue.mjs, empty input and non-Bash tools are not queue runs", () => {
  for (const c of ["node scripts/lanes/queue.test.mjs","node scripts/lanes/queue.mjs.bak", "node scripts/lanes/queue.js", "", undefined]) {
    assert.equal(findQueueInvocations(c), false, String(c));
  }
  assert.equal(decidePreToolUse({ tool_name: "Read", tool_input: { file_path: "scripts/lanes/queue.mjs" }, session_id: "s1" }, null, NOW), null);
});

test("#95 edge: quoted text that reads as a queue.mjs command fails closed, as it does for start.mjs", () => {
  // A quoted word holding shell syntax could be run (bash -c, eval), so it is walked; use --body-file for such prose.
  assert.deepEqual(decidePreToolUse(bash('gh pr create --body "node scripts/lanes/queue.mjs is owner-only"'), null, NOW), { decision: "deny", reason: QUEUE_DENY_REASON });
});

test("#95 edge: a background launch keeps its own reason, checked before queue.mjs", () => {
  assert.deepEqual(decidePreToolUse(bash("claude --bg x; node scripts/lanes/queue.mjs 12"), null, NOW), { decision: "deny", reason: BG_DENY_REASON });
});

// --- #89: text that only mentions lane scripts, and arithmetic (#102) ------------------------------------------------

// A reviewer verdict as a lane writes it: prose naming the guard, markdown backticks, parentheses and a `$(`.
const VERDICT = '{"reviewer": "security-reviewer", "summary": "start-guard.mjs still denies `node scripts/lanes/start.mjs 12` (bash -c) and $(which claude) --bg; it\'s fixed"}';
// A regex check on the guard's source, as the security reviewer ran it.
const REGEX_CHECK = `node -e "const s = require('fs').readFileSync('scripts/lanes/start-guard.mjs', 'utf8'); console.log(/scripts\\/lanes\\/start\\.mjs/.test(s), s.match(/\\$\\(/g).length)"`;

test("#89 criterion 1: a command that only writes or prints text mentioning lane scripts gets no decision", () => {
  for (const cmd of [
    `cat > .lanes/verdicts/x.json <<'EOF'\n${VERDICT}\nEOF`,
    `cat <<'EOF' > .lanes/verdicts/x.json\n${VERDICT}\nEOF\n`,
    `mkdir -p .lanes/verdicts && cat > .lanes/verdicts/x.json <<"EOF"\n${VERDICT}\nEOF`,
    `cd .lanes && cat >> verdicts/x.json <<-'EOF'\n\t${VERDICT}\n\tEOF`,
    `echo 'node scripts/lanes/start.mjs 12 (from start-guard.mjs)' > .lanes/verdicts/note.txt`,
    `printf '%s\\n' "the guard (start-guard.mjs) denies \\$(which claude) --bg" > .lanes/notes.md`,
    REGEX_CHECK,
    `node -e 'console.log(/node scripts\\/lanes\\/(start|queue)\\.mjs (\\d+)/.test(process.argv[1]), "$(x)")' x`,
    `node --eval="console.log('scripts/lanes/start-guard.mjs'.split('/'))"`,
  ]) {
    for (const g of [null, grant()]) assert.equal(decidePreToolUse(bash(cmd), g, NOW), null, JSON.stringify(cmd));
    assert.deepEqual(findStartInvocations(cmd), [], JSON.stringify(cmd));
    assert.equal(findQueueInvocations(cmd), false, JSON.stringify(cmd));
    assert.equal(findBgLaunches(cmd), false, JSON.stringify(cmd));
  }
});

test("#89 edge: a written file that names claude --bg or start.mjs is only written, so it gets no decision (architecture review)", () => {
  // Denied before #89 though nothing runs it; running it later is its own Bash call, which the guard reads then.
  for (const cmd of ["mkdir -p x; cat > x/run.sh <<'EOF'\nclaude --bg y\nEOF", "mkdir -p x && cat > x/run.sh <<'EOF'\nnode scripts/lanes/start.mjs 12\nEOF"]) {
    assert.equal(decidePreToolUse(bash(cmd), null, NOW), null, JSON.stringify(cmd));
  }
  assert.deepEqual(decidePreToolUse(bash("bash x/run.sh"), null, NOW), null, "a script file's content is never visible to the guard, as before #89 (ADR 0007)");
});

test("#89 criterion 3: near misses that write or print text and also run it are still refused", () => {
  for (const [cmd, reason] of [
    // The written file is run in the same call.
    ["cat > run.sh <<'EOF'\nnode scripts/lanes/start.mjs 12\nEOF\nbash run.sh", DENY_REASON],
    ["cat > run.sh <<'EOF'\nclaude --bg x\nEOF\n. run.sh", BG_DENY_REASON],
    // The text reaches a shell through a pipe, a process substitution or a function.
    ["echo 'node scripts/lanes/start.mjs 12' | bash", DENY_REASON],
    ["cat > >(bash) <<'EOF'\nnode scripts/lanes/start.mjs 12\nEOF", DENY_REASON],
    ["f() {\necho 'node scripts/lanes/start.mjs 12'\n}\nf | sh", DENY_REASON],
    // Text that is not literal: an unquoted heredoc or a double-quoted word still runs its substitutions.
    ["cat > x.json <<EOF\n$(node scripts/lanes/start.mjs 12)\nEOF", DENY_REASON],
    ['echo "$(node scripts/lanes/start.mjs 12)" > .lanes/verdicts/x.json', DENY_REASON],
    ["cat > x.json <<EOF\n`claude --bg x`\nEOF", BG_DENY_REASON],
    // node -e whose script names start.mjs, queue.mjs or claude --bg, or is built at run time.
    [`node -e "import('./scripts/lanes/start.mjs')"`, DENY_REASON],
    [`node -e "require('child_process').execSync('node scripts/lanes/start.mjs 12')"`, DENY_REASON],
    [`node -e "require('child_process').execSync('claude --bg x')"`, BG_DENY_REASON],
    [`node -p "require('child_process').execSync('node scripts/lanes/queue.mjs')"`, QUEUE_DENY_REASON],
    [`node -e "$(cat /tmp/x.js)"`, UNRESOLVED_DENY_REASON],
    [`node --eval="$(cat /tmp/x.js)"`, UNRESOLVED_DENY_REASON],
  ]) {
    assert.deepEqual(decidePreToolUse(bash(cmd), grant(), NOW), { decision: "deny", reason }, JSON.stringify(cmd));
  }
});

test("#102 criterion 1: a command whose only $((…)) is arithmetic gets no decision", () => {
  for (const cmd of ['echo "$((5<<1))"', "N=$((N+1))"]) {
    assert.equal(decidePreToolUse(bash(cmd), null, NOW), null, cmd);
    assert.equal(decidePreToolUse(bash(cmd), grant(), NOW), null, cmd);
  }
});

test("#102 criterion 2: command substitution still fails closed", () => {
  assert.deepEqual(decidePreToolUse(bash("$(which claude) --bg x"), grant(), NOW), { decision: "deny", reason: BG_DENY_REASON });
  for (const cmd of ["node $(echo scripts/lanes/start.mjs) 12", "$(echo node scripts/lanes/start.mjs 12)"]) {
    assert.ok(findStartInvocations(cmd).length > 0, cmd);
    assert.deepEqual(decidePreToolUse(bash(cmd), grant(), NOW), { decision: "deny", reason: DENY_REASON }, cmd);
  }
});

test("#102 criterion 3: an arithmetic expansion holding a command substitution is still a run", () => {
  for (const cmd of ["$(( $(node scripts/lanes/start.mjs 12) ))", 'echo "$(( $(node scripts/lanes/start.mjs 12) + 1 ))"', "N=$(( $(node scripts/lanes/start.mjs 12) ))"]) {
    assert.ok(findStartInvocations(cmd).length > 0, cmd);
    assert.deepEqual(decidePreToolUse(bash(cmd), grant(), NOW), { decision: "deny", reason: DENY_REASON }, cmd);
  }
  assert.deepEqual(decidePreToolUse(bash('echo "$(( $(node scripts/lanes/queue.mjs) ))"'), grant(), NOW), { decision: "deny", reason: QUEUE_DENY_REASON });
  assert.deepEqual(decidePreToolUse(bash("echo $(( $(claude --bg x) ))"), grant(), NOW), { decision: "deny", reason: BG_DENY_REASON });
});

test("extra (test-hunter): a data-only write (cat/echo/printf with `>`) still has its arithmetic body's command substitution walked, never hidden by isDataOnly", () => {
  // Not covered by #89 or #102's own cases: #89's data-only tests never use `$((…))`, and #102's arithmetic tests
  // never redirect to a file, so nothing exercised the interaction where arithmeticScript bodies are pushed with
  // `literal: false` (always walked) even when the whole call is otherwise data-only (whose *other* non-expanding
  // parts are skipped). A plausible lane pattern, `echo "$((RETRIES+1))" > .lanes/retry-count.txt`, must not become
  // a blind spot for `$(( $(node scripts/lanes/start.mjs 12) ))` smuggled into the same position.
  for (const [cmd, reason] of [
    ['echo "$(( $(node scripts/lanes/start.mjs 12) ))" > out.txt', DENY_REASON],
    ['echo "$(( $(claude --bg x) ))" > out.txt', BG_DENY_REASON],
    ['echo "$(( $(node scripts/lanes/queue.mjs 12) ))" > out.txt', QUEUE_DENY_REASON],
  ]) {
    assert.deepEqual(decidePreToolUse(bash(cmd), grant(), NOW), { decision: "deny", reason }, cmd);
  }
  // The safe counterpart: plain arithmetic written to a file still gets no decision.
  for (const cmd of ['echo "$((5<<1))" > out.txt', "N=$((N+1)); echo $N > out.txt"]) {
    assert.equal(decidePreToolUse(bash(cmd), grant(), NOW), null, cmd);
  }
});

test("#89 criterion 7: every case named in #102 is covered", () => {
  // #102: `echo "$((5<<1))"` was re-lexed as a nested script and the lone `$` left at command position was denied.
  const none = ['echo "$((5<<1))"', "N=$((N+1))"];
  const denied = ["$(which claude) --bg x", "node $(echo scripts/lanes/start.mjs) 12", "$(echo node scripts/lanes/start.mjs 12)", "$(( $(node scripts/lanes/start.mjs 12) ))"];
  for (const cmd of none) assert.equal(decidePreToolUse(bash(cmd), null, NOW), null, cmd);
  for (const cmd of denied) assert.equal(decidePreToolUse(bash(cmd), null, NOW)?.decision, "deny", cmd);
});

test("#89 edge: arithmetic with variables, nested parentheses or a bit shift gets no decision", () => {
  for (const cmd of ['echo "$(( N * 2 ))"', "echo $(($N+1))", 'echo "$(( ${N} + (2 * 3) ))"', 'X=$((1<<2)); echo "$((X<<1))"', 'echo "$(( ))"', "for i in 1 2; do N=$((N+i)); done"]) {
    assert.equal(decidePreToolUse(bash(cmd), null, NOW), null, cmd);
  }
});

test("#89 edge: a subshell substitution or an unterminated arithmetic is not taken for arithmetic", () => {
  for (const cmd of ['echo "$( (node scripts/lanes/start.mjs 12) )"', "echo $((node scripts/lanes/start.mjs 12) )"]) {
    assert.deepEqual(decidePreToolUse(bash(cmd), grant(), NOW), { decision: "deny", reason: DENY_REASON }, cmd);
  }
  // No closing `))`: lexed as before, so the quoted `$((1+` stays unresolved and the start.mjs after it is still seen.
  assert.deepEqual(decidePreToolUse(bash('echo "$((1+" && node scripts/lanes/start.mjs 12'), grant(), NOW), { decision: "deny", reason: DENY_REASON });
  assert.deepEqual(decidePreToolUse(bash('echo "$((1+ node scripts/lanes/start.mjs'), grant(), NOW), { decision: "deny", reason: PARSE_DENY_REASON });
});

test("#89 edge: data commands that are empty, CRLF, appended or hold an apostrophe get no decision", () => {
  for (const cmd of [
    "cat > .lanes/verdicts/x.json <<'EOF'\nEOF",
    "cat <<A <<B > x.txt\nx\nA\nnode scripts/lanes/start.mjs 12\nB",
    "cat > x.json <<'EOF'\r\nit's start.mjs\r\nEOF\r\n",
    "echo '(node scripts/lanes/start.mjs 12)' >> notes.txt && echo done > log.txt",
    `"ca"t > x.json <<'EOF'\nnode scripts/lanes/queue.mjs 12\nEOF`,
    "cat > x.json <<EOF\nno expansion: node scripts/lanes/start.mjs 12\nEOF",
    "echo 'costs $5 (approx) and `x`' > notes.txt",
    "",
  ]) {
    assert.equal(decidePreToolUse(bash(cmd), grant(), NOW), null, JSON.stringify(cmd));
  }
});

test("#89 edge: a data command that only prints, or whose program word is not plainly cat, echo or printf, is walked as before", () => {
  for (const cmd of [
    // Printed rather than written: read as before, as the existing `cat <<A <<B` case expects.
    "cat <<'EOF'\nnode scripts/lanes/start.mjs 12\nEOF",
    "echo 'node scripts/lanes/start.mjs 12 (x)' && echo done > log.txt",
    "C=cat; $C > x <<'EOF'\nnode scripts/lanes/start.mjs 12\nEOF",
    "PATH=/tmp cat > x <<'EOF'\nnode scripts/lanes/start.mjs 12\nEOF",
    "cat > x 2>&1 <<'EOF'\nnode scripts/lanes/start.mjs 12\nEOF",
    "{ echo 'node scripts/lanes/start.mjs 12'; } | sh",
    "tee x <<'EOF'\nnode scripts/lanes/start.mjs 12\nEOF",
  ]) {
    assert.equal(decidePreToolUse(bash(cmd), grant(), NOW)?.decision, "deny", JSON.stringify(cmd));
  }
});

test("#89 edge: node -e that is not the command word, or has a $ escaped in its script, is read as before", () => {
  // Behind a wrapper the script is still read as shell text, as before #89.
  assert.deepEqual(decidePreToolUse(bash(`env node -e "import('./scripts/lanes/start.mjs')"`), grant(), NOW), { decision: "deny", reason: DENY_REASON });
  // An escaped or single-quoted $ is literal text for node, not a substitution.
  for (const cmd of [`node -e "console.log('\\$HOME')"`, `node -e 'console.log("$HOME")'`, `node -p "1 + 1"`]) {
    assert.equal(decidePreToolUse(bash(cmd), null, NOW), null, cmd);
  }
  // An unescaped one in double quotes is still expanded by the shell before node runs.
  assert.deepEqual(decidePreToolUse(bash(`node -e "console.log('$HOME')"`), null, NOW), { decision: "deny", reason: UNRESOLVED_DENY_REASON });
});

// --- #195: lanes are named lane-<N>; the guard's decisions do not change --------------------------------------------

test("#195: a direct claude --bg with --name is still denied, with or without a grant", () => {
  const deny = { decision: "deny", reason: BG_DENY_REASON };
  for (const cmd of [`claude --bg --name lane-12 "/lane 12"`, `claude --name lane-12 --bg "/lane 12"`, `claude --bg -n lane-12 --model sonnet "/lane 12"`, `claude --bg --name=lane-12 "/lane 12"`]) {
    assert.deepEqual(decidePreToolUse(bash(cmd), null, NOW), deny, cmd);
    assert.deepEqual(decidePreToolUse(bash(cmd), grant(), NOW), deny, cmd);
  }
});

test("#195: the plain start command is still allowed with its grant", () => {
  assert.equal(decidePreToolUse(bash(START), grant(), NOW).decision, "allow");
  assert.equal(decidePreToolUse(bash(GO), autoGrant("go"), NOW).decision, "allow");
});

// --- #118: grantRefusal, shared with start.mjs, and the hook leaving the grant in place ------------------------------

test("#118: grantRefusal is null exactly when the hook allows, over every grant shape", () => {
  const grants = [null, { unreadable: true }, grant(), grant({ issues: [12] }), grant({ sessionId: "s2" }), grant({ at: new Date(NOW - GRANT_TTL_MS).toISOString() }), grant({ at: new Date(NOW + 1).toISOString() }), autoGrant("dry"), autoGrant("go"), autoGrant("go", { issues: [12] })];
  const runs = [[START, { issues: [12, 14] }], [AUTO, { auto: "dry" }], [GO, { auto: "go" }]];
  for (const g of grants) {
    for (const [cmd, run] of runs) {
      const allowed = decidePreToolUse(bash(cmd), g, NOW).decision === "allow";
      assert.equal(grantRefusal(g, "s1", run, NOW) === null, allowed, `${JSON.stringify(g)} ${cmd}`);
    }
  }
});

test("#118: grantRefusal names each reason in plain words", () => {
  const cases = [
    [null, "s1", { issues: [12, 14] }, /^no \/start grant in this session$/],
    [grant(), undefined, { issues: [12, 14] }, /^no session id/],
    [grant(), "a/b", { issues: [12, 14] }, /^no session id/],
    [{ unreadable: true }, "s1", { issues: [12, 14] }, /unreadable or malformed/],
    [grant({ sessionId: "s2" }), "s1", { issues: [12, 14] }, /another session/],
    [grant(), "s1", { issues: [12] }, /other issue numbers \(12 14\)/],
    [autoGrant("dry"), "s1", { auto: "go" }, /--auto grant never allows --go/],
    [autoGrant("go"), "s1", { auto: "dry" }, /--auto --go, not a dry run/],
    [grant(), "s1", { auto: "dry" }, /issue numbers, not --auto/],
    [autoGrant("dry"), "s1", { issues: [12] }, /for --auto, not issue numbers/],
    [autoGrant("go"), "s1", { issues: [12] }, /for --auto --go, not issue numbers/],
    [grant({ at: new Date(NOW - GRANT_TTL_MS).toISOString() }), "s1", { issues: [12, 14] }, /older than 15 minutes/],
    [grant({ at: new Date(NOW + 1).toISOString() }), "s1", { issues: [12, 14] }, /dated in the future/],
  ];
  for (const [g, session, run, pattern] of cases) assert.match(grantRefusal(g, session, run, NOW), pattern, JSON.stringify([g, session, run]));
  assert.equal(grantRefusal(grant(), "s1", { issues: [14, 12] }, NOW), null, "order does not matter");
});

test("#118 edge: grantPath refuses a session id unsafe as a file name, and readGrant tells missing from unreadable", () => {
  assert.equal(grantPath("/d", "s1"), join("/d", "s1.json"));
  for (const id of [undefined, "", "../x", "a b", "x".repeat(129)]) assert.equal(grantPath("/d", id), null, String(id));
  const dir = tmp();
  try {
    assert.equal(readGrant(join(dir, "none.json")), null);
    writeFileSync(join(dir, "bad.json"), "{");
    assert.deepEqual(readGrant(join(dir, "bad.json")), { unreadable: true });
    assert.deepEqual(readGrant(dir), { unreadable: true }, "a directory is unreadable, not missing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#118: an allowed pre-tool-use leaves every grant form in place", () => {
  for (const [prompt, cmd] of [["/start 12 14", START], ["/start --auto", AUTO], ["/start --auto --go", GO]]) {
    const dir = tmp();
    try {
      runHook("user-prompt-submit", JSON.stringify({ session_id: "s1", prompt }), { dir, now: NOW });
      assert.equal(out(runHook("pre-tool-use", JSON.stringify(bash(cmd)), { dir, now: NOW + 1000 })).permissionDecision, "allow");
      assert.equal(out(runHook("pre-tool-use", JSON.stringify(bash(cmd)), { dir, now: NOW + 2000 })).permissionDecision, "allow", "still there for start.mjs");
      assert.ok(existsSync(join(dir, "s1.json")), prompt);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

// --- #113: runs through find -exec and xargs, redirection targets (#191), backtick substitutions (#197) -------------

const decide = (cmd) => decidePreToolUse(bash(cmd), grant(), NOW);

test("#113 criterion 1: find -exec/-execdir node runs of queue.mjs and start.mjs are denied with their own reason", () => {
  for (const cmd of ["find scripts -name queue.mjs -exec node {} \\;", "find . -name queue.mjs -execdir node {} +", "find scripts/lanes -name 'queue.mjs' -exec node {} ';'"]) {
    assert.deepEqual(decide(cmd), { decision: "deny", reason: QUEUE_DENY_REASON }, cmd);
    assert.equal(findQueueInvocations(cmd), true, cmd);
  }
  for (const cmd of ["find scripts -name start.mjs -exec node {} \\;", "find . -name start.mjs -execdir node {} 12 +"]) {
    assert.deepEqual(decide(cmd), { decision: "deny", reason: DENY_REASON }, cmd);
    assert.ok(findStartInvocations(cmd).length > 0, cmd);
  }
});

test("#113 criterion 2: xargs node, and xargs -I{} node {}, are denied", () => {
  for (const cmd of ["echo scripts/lanes/queue.mjs | xargs node", "echo scripts/lanes/queue.mjs | xargs -I{} node {}", "echo scripts/lanes/queue.mjs | xargs -I {} node {}", "echo scripts/lanes/queue.mjs | xargs -n 1 node"]) {
    assert.deepEqual(decide(cmd), { decision: "deny", reason: QUEUE_DENY_REASON }, cmd);
  }
  for (const cmd of ["echo scripts/lanes/start.mjs | xargs node", "echo scripts/lanes/start.mjs | xargs -I{} node {} 12"]) {
    assert.deepEqual(decide(cmd), { decision: "deny", reason: DENY_REASON }, cmd);
  }
});

test("extra (test-hunter): a queue.mjs run reached through find -exec or xargs is denied under every grant shape, like every other QUEUE_RUNS form", () => {
  // Not covered by #95's own QUEUE_RUNS list (written before #113 added find/xargs indirection) nor by #113's own
  // tests (which only check the default valid /start grant via the `decide` helper): a /start or /start --auto --go
  // grant, or an unreadable one, must not open a path to queue.mjs through find -exec/xargs any more than the direct
  // forms already covered above.
  const grants = [null, grant(), grant({ issues: [12] }), AUTO_GO_GRANT(), { unreadable: true }];
  for (const cmd of ["find scripts -name queue.mjs -exec node {} \\;", "echo scripts/lanes/queue.mjs | xargs node"]) {
    assert.equal(findQueueInvocations(cmd), true, cmd);
    for (const g of grants) assert.deepEqual(decidePreToolUse(bash(cmd), g, NOW), { decision: "deny", reason: QUEUE_DENY_REASON }, `${JSON.stringify(g)} ${cmd}`);
  }
});

test("#113 criterion 3: find without -exec and xargs running something else stay allowed", () => {
  for (const cmd of ["find . -name queue.mjs", "find scripts -name start.mjs -print", "git ls-files | xargs grep queue", "xargs grep queue < files.txt", "find . -name '*.mjs' -exec grep -l queue {} \\;"]) {
    assert.equal(decide(cmd), null, cmd);
    assert.equal(findQueueInvocations(cmd), false, cmd);
    assert.deepEqual(findStartInvocations(cmd), [], cmd);
  }
});

test("#113 criterion 5 (#191): a node --test run redirected to a path holding a variable gets no decision", () => {
  const cmd = 'node --test a.test.mjs > "$OUTDIR/t.txt" 2>&1';
  assert.deepEqual(findStartInvocations(cmd), []);
  assert.equal(decide(cmd), null);
});

test("#113 criterion 6 (#191): a redirection target and the fd number before it are not words of the command", () => {
  for (const cmd of ["node a.mjs 2>$ERR", "node --test a.test.mjs >> $LOG", "node -r x a.mjs < $IN", 'node --test a.test.mjs 2> "$D/e.txt" 1>&2', "node --test a.test.mjs &> $OUT", "node --test a.test.mjs >| $OUT"]) {
    assert.deepEqual(findStartInvocations(cmd), [], cmd);
    assert.equal(decide(cmd), null, cmd);
  }
  // A fd number with a space before `>` is an argument, and a target that is start.mjs is not a run.
  assert.equal(decide("node --test a.test.mjs 2 > out.txt"), null);
  assert.equal(decide("node a.mjs > scripts/lanes/start.mjs"), null);
  assert.equal(decide("node a.mjs > scripts/lanes/queue.mjs"), null);
});

test("#113 criterion 7 (#191): a substitution in a redirection target still fails closed, and a herestring is a script", () => {
  for (const cmd of ['echo x > "$(node scripts/lanes/start.mjs 12)"', 'echo x > "`node scripts/lanes/start.mjs 12`"', "echo x > `node scripts/lanes/start.mjs 12`", 'bash <<< "node scripts/lanes/start.mjs 12"', 'node a.mjs 2> "$(node scripts/lanes/start.mjs 12)"']) {
    assert.deepEqual(decide(cmd), { decision: "deny", reason: DENY_REASON }, cmd);
  }
});

test("#113 criterion 9 (#197): a backtick queue.mjs run as a printf's redirection target is denied", () => {
  for (const cmd of ["printf x > `node scripts/lanes/queue.mjs 12`", "printf '%s' x > `node scripts/lanes/queue.mjs 12`", "printf x >`node scripts/lanes/queue.mjs 12`"]) {
    assert.equal(findQueueInvocations(cmd), true, cmd);
    assert.deepEqual(decide(cmd), { decision: "deny", reason: QUEUE_DENY_REASON }, cmd);
  }
});

test("#113 criterion 10 (#197): the same backtick target for start.mjs and claude --bg is denied with its reason", () => {
  assert.deepEqual(decide("printf x > `node scripts/lanes/start.mjs 12`"), { decision: "deny", reason: DENY_REASON });
  assert.deepEqual(decide("printf x > `claude --bg -p hi`"), { decision: "deny", reason: BG_DENY_REASON });
  assert.equal(findBgLaunches("printf x > `claude --bg -p hi`"), true);
  // Not only as a target: a backtick run anywhere after the command word.
  assert.deepEqual(decide("ls `node scripts/lanes/queue.mjs 12`"), { decision: "deny", reason: QUEUE_DENY_REASON });
});

test("#113 edge: find with a later -exec, a shell -exec, or no terminator still runs node on what it found", () => {
  for (const cmd of ["find . -name queue.mjs -exec echo {} \\; -exec node {} \\;", "find . -name queue.mjs -exec sh -c 'node {}' \\;", "find . -name queue.mjs -ok node {} \\;"]) {
    assert.deepEqual(decide(cmd), { decision: "deny", reason: QUEUE_DENY_REASON }, cmd);
  }
  // Nothing names a lane script, but the found path is known only at run time: it fails closed, as `node $X` does.
  for (const cmd of ["find . -exec node {}", "find . -name '*.test.mjs' -exec node --test {} +"]) {
    assert.deepEqual(decide(cmd), { decision: "deny", reason: UNRESOLVED_DENY_REASON }, cmd);
  }
});

test("#113 edge: xargs replace-string forms, value options and --, and input run as the command itself", () => {
  for (const cmd of ["echo scripts/lanes/queue.mjs | xargs --replace=X node X", "echo scripts/lanes/queue.mjs | xargs -i node {}", "echo scripts/lanes/queue.mjs | xargs -d x -P 4 -- node", "echo scripts/lanes/queue.mjs | xargs -I{} {}", "echo scripts/lanes/queue.mjs | timeout 5 xargs node"]) {
    assert.deepEqual(decide(cmd), { decision: "deny", reason: QUEUE_DENY_REASON }, cmd);
  }
  assert.deepEqual(decide("git ls-files | xargs node"), { decision: "deny", reason: UNRESOLVED_DENY_REASON });
  assert.deepEqual(decide("echo --bg | xargs claude"), { decision: "deny", reason: BG_DENY_REASON });
});

test("#113 edge: a bare xargs (it runs echo), or one missing its -I value, gets no decision", () => {
  for (const cmd of ["echo scripts/lanes/queue.mjs | xargs", "xargs -I", "xargs -n 1", "xargs -- "]) assert.equal(decide(cmd), null, cmd);
});

test("#113 edge: node reads a stdin target as its script only when no argument is one", () => {
  assert.deepEqual(decide("node < $IN"), { decision: "deny", reason: UNRESOLVED_DENY_REASON });
  assert.deepEqual(decide("node < scripts/lanes/start.mjs"), { decision: "deny", reason: DENY_REASON });
  for (const cmd of ["node a.mjs < $IN", "node a.mjs < scripts/lanes/start.mjs", "cat < scripts/lanes/queue.mjs"]) assert.equal(decide(cmd), null, cmd);
});

test("#113 edge: a redirection with no target, fd duplication into a pipe, and a heredoc after a target", () => {
  for (const cmd of ["node a.mjs >", "node --test x.test.mjs 2>&1 | tail -5", "node --test x.test.mjs 2>/dev/null", "cat > x.txt <<'EOF'\nnode scripts/lanes/start.mjs 12\nEOF"]) {
    assert.equal(decide(cmd), null, JSON.stringify(cmd));
  }
});

test("#113 edge: a literal backtick (single quotes, a quoted heredoc message) is text, a live one in double quotes runs", () => {
  for (const cmd of ["git commit -m 'Fix `start.mjs` parsing'", "git commit -m \"$(cat <<'EOF'\nFix `node scripts/lanes/start.mjs 12` and `queue.mjs`\nEOF\n)\"", "printf '%s' '`node scripts/lanes/queue.mjs 12`' > f"]) {
    assert.equal(decide(cmd), null, JSON.stringify(cmd));
  }
  assert.deepEqual(decide('git commit -m "Fix `start.mjs` parsing"'), { decision: "deny", reason: DENY_REASON });
});

test("#113 edge: a literal backtick in a script a shell runs (-c, eval, a heredoc on its stdin) runs", () => {
  for (const cmd of ["bash -c 'echo `node scripts/lanes/start.mjs 12`'", "sh -lc 'x=`node scripts/lanes/start.mjs 12`'", "eval 'echo `node scripts/lanes/start.mjs 12`'", "bash <<'EOF'\necho `node scripts/lanes/start.mjs 12`\nEOF"]) {
    assert.deepEqual(decide(cmd), { decision: "deny", reason: DENY_REASON }, JSON.stringify(cmd));
  }
  assert.deepEqual(decide("bash -c 'echo `node scripts/lanes/queue.mjs`'"), { decision: "deny", reason: QUEUE_DENY_REASON });
  assert.equal(decide("git commit -F - <<'EOF'\nFix `start.mjs` and `queue.mjs`\nEOF"), null);
});

test("#113 edge (test-hunter): a double-quoted backtick around a bare script path, with no node or argument, runs", () => {
  for (const cmd of ['echo "`scripts/lanes/queue.mjs`"', 'echo x > "`scripts/lanes/queue.mjs`"', "echo `scripts/lanes/queue.mjs`"]) {
    assert.deepEqual(decide(cmd), { decision: "deny", reason: QUEUE_DENY_REASON }, cmd);
  }
  assert.deepEqual(decide('echo "`scripts/lanes/start.mjs`"'), { decision: "deny", reason: DENY_REASON });
  assert.equal(decide('echo "`date`" > log.txt'), null);
});

test("#113 edge: an unterminated backtick that names a lane script fails closed", () => {
  assert.deepEqual(decide("echo `node scripts/lanes/start.mjs 12"), { decision: "deny", reason: PARSE_DENY_REASON });
  assert.equal(findQueueInvocations("echo `node scripts/lanes/queue.mjs"), true);
  assert.equal(decide("echo `date"), null);
});

test("#113 edge (test-hunter): 'eval', 'source' or '.' used as an ordinary word, not the command itself, does not make a later quoted word's backticks live", () => {
  for (const cmd of ["echo eval 'note: `start.mjs` was renamed'", "grep . 'about `start.mjs`' file.txt", "cp source 'note about `start.mjs`'"]) {
    assert.equal(decide(cmd), null, cmd);
  }
  // The real forms (the command word itself is eval, source or .) still run; a shell found anywhere earlier still
  // counts for -c (so a wrapper like `env bash -c` or `timeout 5 bash -c` is still read), even where that costs a
  // false positive on an unrelated command whose own -c flag happens to follow a "bash"-named argument.
  assert.deepEqual(decide("bash -c 'echo `node scripts/lanes/start.mjs 12`'"), { decision: "deny", reason: DENY_REASON });
  assert.deepEqual(decide("env bash -c 'echo `node scripts/lanes/start.mjs 12`'"), { decision: "deny", reason: DENY_REASON });
  assert.deepEqual(decide("eval 'echo `node scripts/lanes/start.mjs 12`'"), { decision: "deny", reason: DENY_REASON });
});

// test-hunter extra: not covered by any #113/#191/#197 criterion or its listed edge cases, which only exercise the
// backtick form of a redirection target (criteria 9-10) or the $(...) form for start.mjs (criterion 7): a $(...)
// redirection target names queue.mjs or claude --bg too, denied with their own reason, the same as the backtick form.
test("#113 edge (test-hunter): a $(...) redirection target naming queue.mjs or claude --bg is denied with its own reason", () => {
  assert.deepEqual(decide('printf x > "$(node scripts/lanes/queue.mjs 12)"'), { decision: "deny", reason: QUEUE_DENY_REASON });
  assert.deepEqual(decide("printf x > $(node scripts/lanes/queue.mjs 12)"), { decision: "deny", reason: QUEUE_DENY_REASON });
  assert.deepEqual(decide('printf x > "$(claude --bg -p hi)"'), { decision: "deny", reason: BG_DENY_REASON });
});

// --- #240: text-only mentions of queue.mjs (#240), backticks piped into a shell (#246), bare backticks (#247) -------

// A comment body as a lane writes it: prose with an apostrophe (an unterminated quote read as shell), markdown
// backticks and the command itself, none of it run.
const PROSE = "The queue script (queue.mjs) isn't run here: the owner runs `node scripts/lanes/queue.mjs` in their own terminal.";
const deny = (reason) => ({ decision: "deny", reason });

test("#240 criterion 1: a heredoc body that mentions queue.mjs, written for gh to send, gets no decision", () => {
  for (const cmd of [
    `cat <<'EOF' > .lanes/comment.md\n${PROSE}\nEOF\ngh issue comment 97 --body-file .lanes/comment.md`,
    `mkdir -p .lanes && cat > .lanes/pr.md <<'EOF'\n${PROSE}\nEOF\nMSYS_NO_PATHCONV=1 gh pr create --title "Queue CLI" --body-file .lanes/pr.md`,
    `gh issue comment 97 --body-file - <<'EOF'\n${PROSE}\nEOF`,
    `cat > .lanes/body.md <<"EOF"\n${PROSE}\nEOF\ngh pr edit 12 --body-file .lanes/body.md && gh issue create --title x --label lane-filed --body-file .lanes/body.md`,
    "git commit -F - <<'EOF'\nDocument queue.mjs in USING.md\nEOF",
  ]) {
    assert.equal(findQueueInvocations(cmd), false, cmd);
    assert.equal(decidePreToolUse(bash(cmd), null, NOW), null, cmd);
  }
});

test("#240 criterion 2: queue.mjs runs, plain, ./-relative, inside bash -c or sh -c, or in a pipeline, are still denied", () => {
  for (const cmd of [
    "node scripts/lanes/queue.mjs",
    "node ./scripts/lanes/queue.mjs",
    "bash -c 'node scripts/lanes/queue.mjs'",
    'bash -c "node ./scripts/lanes/queue.mjs"',
    "sh -c 'node scripts/lanes/queue.mjs'",
    'sh -c "node ./scripts/lanes/queue.mjs 12"',
    "echo 12 | node scripts/lanes/queue.mjs",
    "node ./scripts/lanes/queue.mjs | tee .lanes/queue.log",
    "git fetch origin | bash -c 'node scripts/lanes/queue.mjs'",
  ]) {
    assert.deepEqual(decidePreToolUse(bash(cmd), null, NOW), deny(QUEUE_DENY_REASON), cmd);
  }
});

test("#240 criterion 3: a grep for queue.mjs, and a gh comment whose --body mentions it, get no decision", () => {
  for (const cmd of ["grep -n queue.mjs docs/USING.md", 'gh issue comment 97 --body "the owner runs queue.mjs in their terminal"', 'gh issue comment 97 --body "see queue.mjs: it polls the ready issues"']) {
    assert.equal(decidePreToolUse(bash(cmd), null, NOW), null, cmd);
  }
});

test("#246 criterion 1: a quoted heredoc piped into sh runs its backticks", () => {
  assert.deepEqual(decide("cat <<'EOF' | sh\necho `node scripts/lanes/start.mjs 12`\nEOF"), deny(DENY_REASON));
  assert.deepEqual(decide("cat <<'EOF' | sh\necho `node scripts/lanes/queue.mjs`\nEOF"), deny(QUEUE_DENY_REASON));
});

test("#246 criterion 2: a single-quoted echo piped into bash runs its backticks", () => {
  assert.deepEqual(decide("echo 'echo `node scripts/lanes/start.mjs 12`' | bash"), deny(DENY_REASON));
});

test("#246 criterion 3: a commit message naming start.mjs in backticks still gets no decision", () => {
  for (const cmd of ["git commit -F - <<'EOF'\nFix `start.mjs` parsing\n\nThe guard read `start.mjs` in a message.\nEOF", "git commit -m 'Fix `start.mjs` parsing'"]) {
    assert.equal(decidePreToolUse(bash(cmd), null, NOW), null, cmd);
    assert.equal(decide(cmd), null, cmd);
  }
});

test("#247 criterion 1: a bare double-quoted backtick substitution of a lane script is denied with its reason", () => {
  assert.deepEqual(decide('echo "`scripts/lanes/queue.mjs`"'), deny(QUEUE_DENY_REASON));
  assert.deepEqual(decide('echo "`scripts/lanes/start.mjs`"'), deny(DENY_REASON));
});

test("#247 criterion 2: a bare backtick substitution as a redirection target, unquoted or double-quoted, is denied", () => {
  assert.deepEqual(decide("echo x > `scripts/lanes/queue.mjs`"), deny(QUEUE_DENY_REASON));
  assert.deepEqual(decide('echo x > "`scripts/lanes/queue.mjs`"'), deny(QUEUE_DENY_REASON));
  assert.deepEqual(decide("echo x > `scripts/lanes/start.mjs`"), deny(DENY_REASON));
  assert.deepEqual(decide('echo x > "`scripts/lanes/start.mjs`"'), deny(DENY_REASON));
});

test("#247 criterion 3: a backtick substitution with a node prefix or an argument is still denied as a word and as a target", () => {
  for (const [cmd, reason] of [
    ["echo `node scripts/lanes/queue.mjs`", QUEUE_DENY_REASON],
    ['echo "`node scripts/lanes/queue.mjs`"', QUEUE_DENY_REASON],
    ["echo `scripts/lanes/queue.mjs 12`", QUEUE_DENY_REASON],
    ["echo x > `node scripts/lanes/queue.mjs`", QUEUE_DENY_REASON],
    ['echo x > "`scripts/lanes/queue.mjs 12`"', QUEUE_DENY_REASON],
    ["echo `node scripts/lanes/start.mjs 12`", DENY_REASON],
    ["echo `scripts/lanes/start.mjs 12`", DENY_REASON],
    ["echo x > `node scripts/lanes/start.mjs 12`", DENY_REASON],
    ['echo x > "`scripts/lanes/start.mjs 12`"', DENY_REASON],
  ]) {
    assert.deepEqual(decide(cmd), deny(reason), cmd);
  }
});

test("#240 edge: a written body some other command in the call could run is still read", () => {
  for (const [cmd, reason] of [
    [`cat > .lanes/c.md <<'EOF'\nnode scripts/lanes/queue.mjs\nEOF\ngh issue comment 1 --body-file .lanes/c.md && bash .lanes/c.md`, QUEUE_DENY_REASON],
    [`cat > .lanes/c.md <<'EOF'\nnode scripts/lanes/start.mjs 12\nEOF\ngh issue comment 1 --body-file .lanes/c.md; sh .lanes/c.md`, DENY_REASON],
    // gh commands that open a browser or an editor, echo the body (--dry-run), or are not issue/pr comment, create or edit.
    [`cat > c.md <<'EOF'\nnode scripts/lanes/queue.mjs\nEOF\ngh pr create --dry-run --body-file c.md`, QUEUE_DENY_REASON],
    [`cat > c.md <<'EOF'\nnode scripts/lanes/queue.mjs\nEOF\ngh issue create --web --body-file c.md`, QUEUE_DENY_REASON],
    [`cat > c.md <<'EOF'\nnode scripts/lanes/queue.mjs\nEOF\ngh issue comment 1 -e`, QUEUE_DENY_REASON],
    [`cat > c.md <<'EOF'\nnode scripts/lanes/queue.mjs\nEOF\ngh issue comment 1 --editor`, QUEUE_DENY_REASON],
    [`cat > c.md <<'EOF'\nnode scripts/lanes/queue.mjs\nEOF\ngh api repos/o/r/issues -F body=@c.md`, QUEUE_DENY_REASON],
    [`cat > c.md <<'EOF'\nnode scripts/lanes/queue.mjs\nEOF\ngh issue view 1`, QUEUE_DENY_REASON],
    // An assignment other than MSYS_NO_PATHCONV, or gh reached by a path, is not the plain gh.
    [`cat > c.md <<'EOF'\nnode scripts/lanes/queue.mjs\nEOF\nGH_EDITOR=sh gh issue comment 1 --body-file c.md`, QUEUE_DENY_REASON],
    [`cat > c.md <<'EOF'\nnode scripts/lanes/queue.mjs\nEOF\n./gh issue comment 1 --body-file c.md`, QUEUE_DENY_REASON],
    // A function named gh is defined in the same call.
    [`gh() { bash; }\ngh issue comment 1 --body-file - <<'EOF'\nnode scripts/lanes/queue.mjs\nEOF`, QUEUE_DENY_REASON],
    // A substitution elsewhere in the call runs the written file.
    [`cat > c.md <<'EOF'\nnode scripts/lanes/queue.mjs\nEOF\ngh issue comment 1 --body "\`bash c.md\`"`, QUEUE_DENY_REASON],
    [`cat > c.md <<'EOF'\nnode scripts/lanes/queue.mjs\nEOF\ngh issue comment 1 --title x --body \`sh c.md\``, QUEUE_DENY_REASON],
    [`cat > c.md <<'EOF'\nnode scripts/lanes/start.mjs 12\nEOF\ngh issue comment 1 --body "$(bash c.md)"`, DENY_REASON],
    [`cat > c.md <<'EOF'\nnode scripts/lanes/queue.mjs\nEOF\ncat > d.md <<EOF\n\`bash c.md\`\nEOF\ngh issue comment 1 --body-file d.md`, QUEUE_DENY_REASON],
    [`cat > c.md <<'EOF'\nnode scripts/lanes/queue.mjs\nEOF\ngh issue comment 1 --body-file c.md > "\`bash c.md\`"`, QUEUE_DENY_REASON],
    // The same route with only cat and echo (denied before #240 too, as a program named at run time).
    [`cat > c.sh <<'EOF'\nnode scripts/lanes/queue.mjs\nEOF\necho "\`bash c.sh\`" > out.txt`, QUEUE_DENY_REASON],
    // gh's output piped into a shell.
    [`gh issue comment 1 --body-file - <<'EOF' | sh\necho \`node scripts/lanes/start.mjs 12\`\nEOF`, DENY_REASON],
  ]) {
    assert.deepEqual(decidePreToolUse(bash(cmd), null, NOW), deny(reason), cmd);
  }
});

test("#240 edge (security review): a `<<` inside a # comment opens no heredoc to bash, so the lines after it are read", () => {
  for (const [cmd, reason] of [
    ["gh issue comment 1 -b x # <<'EOF'\nnode scripts/lanes/queue.mjs\nEOF", QUEUE_DENY_REASON],
    ["gh issue comment 1 -b x #<<'EOF'\nnode scripts/lanes/start.mjs 12\nEOF", DENY_REASON],
    ["cat > f.md # <<'EOF'\nnode scripts/lanes/queue.mjs\nEOF", QUEUE_DENY_REASON],
    ["mkdir -p x; # <<'EOF'\nnode scripts/lanes/queue.mjs\nEOF", QUEUE_DENY_REASON],
  ]) {
    assert.deepEqual(decidePreToolUse(bash(cmd), null, NOW), deny(reason), cmd);
  }
});

test("#240 edge: a # inside a quoted word or a heredoc body is no comment and keeps the body skipped", () => {
  for (const cmd of [
    `cat > .lanes/c.md <<'EOF'\n# Heading for #240\n${PROSE}\nEOF\ngh issue comment 240 --body-file .lanes/c.md`,
    `gh issue create --title "Fix it (#240)" --label lane-filed --body-file - <<'EOF'\n${PROSE}\nEOF`,
    `gh issue comment 1 -b x#y --body-file - <<'EOF'\n${PROSE}\nEOF`,
  ]) {
    assert.equal(decidePreToolUse(bash(cmd), null, NOW), null, cmd);
  }
});

test("#240 edge: an empty heredoc, CRLF line ends and an unquoted body with nothing to expand, sent by gh, get no decision", () => {
  for (const cmd of [
    "cat > .lanes/c.md <<'EOF'\nEOF\ngh issue comment 1 --body-file .lanes/c.md",
    "cat > .lanes/c.md <<'EOF'\r\nit's queue.mjs\r\nEOF\r\ngh issue comment 1 --body-file .lanes/c.md\r\n",
    "cat > .lanes/c.md <<EOF\nit's queue.mjs, run by the owner\nEOF\ngh issue comment 1 --body-file .lanes/c.md",
  ]) {
    assert.equal(decidePreToolUse(bash(cmd), null, NOW), null, JSON.stringify(cmd));
  }
});

test("#240 edge: an unquoted body sent by gh still runs its substitutions", () => {
  assert.deepEqual(decidePreToolUse(bash("cat > c.md <<EOF\n$(node scripts/lanes/queue.mjs)\nEOF\ngh issue comment 1 --body-file c.md"), null, NOW), deny(QUEUE_DENY_REASON));
  assert.deepEqual(decidePreToolUse(bash("gh issue comment 1 --body-file - <<EOF\n`node scripts/lanes/start.mjs 12`\nEOF"), null, NOW), deny(DENY_REASON));
});

test("#246 edge: a pipe into a shell anywhere down the pipeline, or behind a wrapper, runs the backticks", () => {
  for (const [cmd, reason] of [
    ["cat <<'EOF' | tee .lanes/x.log | bash\necho `node scripts/lanes/start.mjs 12`\nEOF", DENY_REASON],
    ["cat <<'EOF' |& sh\necho `node scripts/lanes/queue.mjs`\nEOF", QUEUE_DENY_REASON],
    ["cat <<'EOF' | env bash -s\necho `node scripts/lanes/queue.mjs`\nEOF", QUEUE_DENY_REASON],
    ["printf '%s\\n' 'echo `node scripts/lanes/queue.mjs`' | sh", QUEUE_DENY_REASON],
    ["echo 'echo `scripts/lanes/start.mjs`' | bash", DENY_REASON],
    ["echo '`scripts/lanes/queue.mjs`' | sh", QUEUE_DENY_REASON],
    ["echo 'x' 'node scripts/lanes/queue.mjs' | sh", QUEUE_DENY_REASON],
  ]) {
    assert.deepEqual(decide(cmd), deny(reason), cmd);
  }
});

test("#246 edge: backticks in text piped into no shell, or after || (no pipe), stay text", () => {
  for (const cmd of [
    "echo 'Fix `start.mjs` parsing' | grep start",
    "cat <<'EOF' | wc -l\nFix `start.mjs` parsing\nEOF",
    "git commit -F - <<'EOF' || bash scripts/lanes/cleanup.sh\nFix `start.mjs` parsing\nEOF",
    "cat <<'EOF'\nFix `start.mjs` parsing\nEOF",
  ]) {
    assert.equal(decide(cmd), null, cmd);
  }
});

test("#246 edge (test-hunter): text piped into eval, source or . has its backticks read live", () => {
  for (const sink of ["eval", "source /dev/stdin", ". /dev/stdin"]) {
    assert.deepEqual(decide(`echo 'echo \`node scripts/lanes/start.mjs 12\`' | ${sink}`), deny(DENY_REASON), sink);
    assert.deepEqual(decide(`echo 'echo \`node scripts/lanes/queue.mjs\`' | ${sink}`), deny(QUEUE_DENY_REASON), sink);
  }
});

test("#240 edge (test-hunter): a $( substitution in a gh word keeps a literal heredoc body read", () => {
  assert.notEqual(decide("gh issue comment 1 --body \"$(bash c.md)\" <<'EOF'\nnode scripts/lanes/queue.mjs\nEOF"), null);
});
