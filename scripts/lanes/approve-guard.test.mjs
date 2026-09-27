// scripts/lanes/approve-guard.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DENY_REASON, GRANT_TTL_MS, decidePreToolUse, findOwnerInvocations, onUserPromptSubmit, parseApprovePrompt, runHook } from "./approve-guard.mjs";

const NOW = Date.parse("2026-09-27T12:00:00Z");
const SHA = "a".repeat(40);
const OWNER = `node scripts/lanes/post-review.mjs owner success "approved by owner" --pr 16 --sha ${SHA}`;
const grant = (over = {}) => ({ sessionId: "s1", pr: 16, at: new Date(NOW - 60_000).toISOString(), ...over });
const bash = (command, over = {}) => ({ hook_event_name: "PreToolUse", session_id: "s1", tool_name: "Bash", tool_input: { command }, ...over });

// --- UserPromptSubmit ---------------------------------------------------------------------------------------------

test("only a prompt that is exactly /approve <digits> names a PR", () => {
  assert.equal(parseApprovePrompt("/approve 16"), 16);
  assert.equal(parseApprovePrompt("/approve 16\n"), 16);
  for (const p of ["/approve", "/approve 16 now", "/approve #16", "/approve abc", "please /approve 16", "/approve 16; rm", "/approve -1", "/approve 1e3", "/approve 0", "/approve 99999999999999999999", undefined, 16]) {
    assert.equal(parseApprovePrompt(p), null, JSON.stringify(p));
  }
});

test("UserPromptSubmit /approve N grants { sessionId, pr: N, at }", () => {
  assert.deepEqual(onUserPromptSubmit({ session_id: "s1", prompt: "/approve 16" }, NOW), { action: "grant", sessionId: "s1", grant: { sessionId: "s1", pr: 16, at: new Date(NOW).toISOString() } });
});

test("UserPromptSubmit of any other prompt clears the session's grant", () => {
  assert.deepEqual(onUserPromptSubmit({ session_id: "s1", prompt: "thanks" }, NOW), { action: "clear", sessionId: "s1" });
  assert.deepEqual(onUserPromptSubmit({ session_id: "s1", prompt: "/approve 17 please" }, NOW), { action: "clear", sessionId: "s1" });
});

test("UserPromptSubmit with an unsafe or missing session id does nothing", () => {
  for (const id of ["../x", "a/b", "", undefined, "a".repeat(200)]) assert.deepEqual(onUserPromptSubmit({ session_id: id, prompt: "/approve 16" }, NOW), { action: "none" });
});

// --- detection ----------------------------------------------------------------------------------------------------

test("the plain owner command is detected with its --pr", () => {
  assert.deepEqual(findOwnerInvocations(OWNER), [{ pr: "16", standalone: true }]);
});

test("wrappers do not hide an owner command", () => {
  for (const cmd of [
    `bash -c "${OWNER.replace(/"/g, '\\"')}"`,
    `bash -c '${OWNER}'`,
    `env X=1 ${OWNER}`,
    `echo hi; ${OWNER}`,
    `true && ${OWNER}`,
    `false || ${OWNER}`,
    `${OWNER} | cat`,
    `node ./scripts/lanes/../lanes/post-review.mjs owner success x --pr 16`,
    `node scripts\\lanes\\post-review.mjs owner success x --pr 16`,
    `node "scripts/lanes/post-review.mjs" 'owner' success x --pr 16`,
    `node scripts/lanes/post-review.mjs --pr 16 owner success x`,
    `node scripts/lanes/post-review.mjs ow""ner success x --pr 16`,
    `node scripts/lanes/post-review.mjs $WHO success x --pr 16`,
    `sh -c "cd . && node scripts/lanes/post-review.mjs owner success x --pr 16"`,
    `(node scripts/lanes/post-review.mjs owner success x --pr 16)`,
    `node scripts/lanes/post-review.mjs owner success x --pr 16 > out.txt`,
    `node scripts/lanes/post-review.mjs owner success x --pr 16\nnode -v`,
    `node C:/repo/scripts/lanes/POST-REVIEW.MJS owner success x --pr 16`,
  ]) {
    const found = findOwnerInvocations(cmd);
    assert.ok(found.length >= 1, `not detected: ${cmd}`);
    assert.ok(!found.every((f) => f.standalone) || cmd === OWNER, `wrapped form counted as standalone: ${cmd}`);
  }
});

test("unbalanced quotes around a post-review command are treated as an owner command", () => {
  assert.equal(findOwnerInvocations(`node scripts/lanes/post-review.mjs owner "oops`).length, 1);
});

test("reviewer forms and unrelated commands are not owner commands", () => {
  for (const cmd of [
    "node scripts/lanes/post-review.mjs --file .lanes/verdicts/test-hunter.json",
    "node scripts/lanes/post-review.mjs --file .lanes/verdicts/owner.json --pr 16",
    'node scripts/lanes/post-review.mjs test-hunter skipped "the owner said no tests"',
    "node scripts/lanes/post-review.mjs ui-reviewer skipped owner",
    "grep -n owner scripts/lanes/post-review.mjs",
    "git diff -- scripts/lanes/post-review.mjs scripts/lanes/post-review.test.mjs",
    "node --test scripts/lanes/post-review.test.mjs",
    "gh pr view 16",
    "echo owner",
    "",
  ]) assert.deepEqual(findOwnerInvocations(cmd), [], cmd);
});

// --- PreToolUse ---------------------------------------------------------------------------------------------------

test("PreToolUse allows the owner command with a fresh grant for the same PR, and consumes it", () => {
  assert.deepEqual(decidePreToolUse(bash(OWNER), grant(), NOW), { decision: "allow", reason: "owner approval from /approve 16 in this session", consumeGrant: true });
});

test("PreToolUse denies every other owner command with the reason", () => {
  const cases = [
    ["no grant", bash(OWNER), null],
    ["another session's grant", bash(OWNER), grant({ sessionId: "s2" })],
    ["a different --pr", bash(OWNER.replace("--pr 16", "--pr 17")), grant()],
    ["a missing --pr", bash(OWNER.replace("--pr 16 ", "")), grant()],
    ["--pr=16 form", bash(OWNER.replace("--pr 16", "--pr=16")), grant()],
    ["an expired grant", bash(OWNER), grant({ at: new Date(NOW - GRANT_TTL_MS - 1).toISOString() })],
    ["a grant from the future", bash(OWNER), grant({ at: new Date(NOW + 60_000).toISOString() })],
    ["a grant with a bad date", bash(OWNER), grant({ at: "yesterday" })],
    ["an unreadable grant file", bash(OWNER), { unreadable: true }],
    ["a malformed grant", bash(OWNER), { sessionId: "s1", pr: "16" }],
    ["two owner commands in one", bash(`${OWNER} && ${OWNER}`), grant()],
    ["a wrapped owner command", bash(`bash -c '${OWNER}'`), grant()],
    ["a chained owner command", bash(`${OWNER}; rm -rf .`), grant()],
    ["no session id", bash(OWNER, { session_id: undefined }), grant()],
  ];
  for (const [name, input, g] of cases) assert.deepEqual(decidePreToolUse(input, g, NOW), { decision: "deny", reason: DENY_REASON }, name);
  assert.equal(DENY_REASON, "owner approval only from /approve <N> in this session");
});

test("PreToolUse gives no decision for anything that is not an owner command", () => {
  assert.equal(decidePreToolUse(bash("node scripts/lanes/post-review.mjs --file .lanes/verdicts/test-hunter.json"), null, NOW), null);
  assert.equal(decidePreToolUse(bash("npm test"), grant(), NOW), null);
  assert.equal(decidePreToolUse({ ...bash(OWNER), tool_name: "Read" }, null, NOW), null);
});

// --- the hook entry point (reads and writes grant files) ---------------------------------------------------------

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "approve-guard-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const decision = (out) => (out ? JSON.parse(out).hookSpecificOutput.permissionDecision : null);

test("hook flow: /approve 16 then the owner command is allowed once, then denied", () => withDir((dir) => {
  runHook("user-prompt-submit", JSON.stringify({ session_id: "s1", prompt: "/approve 16" }), { dir, now: NOW });
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "s1.json"), "utf8")), { sessionId: "s1", pr: 16, at: new Date(NOW).toISOString() });
  const first = JSON.parse(runHook("pre-tool-use", JSON.stringify(bash(OWNER)), { dir, now: NOW + 1000 }));
  assert.deepEqual(first, { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "owner approval from /approve 16 in this session" } });
  assert.equal(existsSync(join(dir, "s1.json")), false);
  assert.equal(decision(runHook("pre-tool-use", JSON.stringify(bash(OWNER)), { dir, now: NOW + 2000 })), "deny");
}));

test("hook flow: another prompt clears the grant", () => withDir((dir) => {
  runHook("user-prompt-submit", JSON.stringify({ session_id: "s1", prompt: "/approve 16" }), { dir, now: NOW });
  runHook("user-prompt-submit", JSON.stringify({ session_id: "s1", prompt: "go on" }), { dir, now: NOW });
  assert.equal(existsSync(join(dir, "s1.json")), false);
  assert.equal(decision(runHook("pre-tool-use", JSON.stringify(bash(OWNER)), { dir, now: NOW })), "deny");
}));

test("hook flow: another session's grant does not allow", () => withDir((dir) => {
  runHook("user-prompt-submit", JSON.stringify({ session_id: "s2", prompt: "/approve 16" }), { dir, now: NOW });
  assert.equal(decision(runHook("pre-tool-use", JSON.stringify(bash(OWNER)), { dir, now: NOW })), "deny");
}));

test("hook flow: an unreadable grant file denies", () => withDir((dir) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "s1.json"), "{not json");
  assert.equal(decision(runHook("pre-tool-use", JSON.stringify(bash(OWNER)), { dir, now: NOW })), "deny");
}));

test("hook flow: input that is not valid JSON denies, and a non-owner command passes silently", () => withDir((dir) => {
  assert.equal(decision(runHook("pre-tool-use", "{oops", { dir, now: NOW })), "deny");
  assert.equal(runHook("pre-tool-use", JSON.stringify(bash("npm test")), { dir, now: NOW }), "");
  assert.equal(runHook("user-prompt-submit", "{oops", { dir, now: NOW }), "");
}));
