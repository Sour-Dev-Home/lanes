// scripts/lanes/approve-guard.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
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

test("a trailing or leading whitespace on the plain owner command does not deny it (regression)", () => {
  for (const cmd of [`${OWNER}\n`, `${OWNER} `, ` ${OWNER}`, `\n${OWNER}\n`]) {
    assert.deepEqual(findOwnerInvocations(cmd), [{ pr: "16", standalone: true }], JSON.stringify(cmd));
  }
  // an embedded newline is still a chain, not trailing whitespace, and must still be denied
  assert.equal(findOwnerInvocations(`${OWNER}\nnode -v`)[0].standalone, false);
});

test("unbalanced quotes around a post-review command are treated as an owner command", () => {
  assert.equal(findOwnerInvocations(`node scripts/lanes/post-review.mjs owner "oops`).length, 1);
});

test("a same-command variable indirection does not hide an owner command (regression)", () => {
  for (const cmd of [
    "S=scripts/lanes/post-review.mjs; node $S owner success x --pr 16",
    "S=scripts/lanes/post-review.mjs && node $S owner success x --pr 16",
    'export S=scripts/lanes/post-review.mjs; node $S owner success x --pr 16',
    'S="scripts/lanes/post-review.mjs"; node ${S} owner success x --pr 16',
  ]) {
    const found = findOwnerInvocations(cmd);
    assert.ok(found.length >= 1, `not detected: ${cmd}`);
    assert.ok(!found[0].standalone, `variable-indirected form counted as standalone: ${cmd}`);
  }
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
    ["a same-command variable indirection", bash(`S=scripts/lanes/post-review.mjs; node $S owner success x --pr 16`), grant()],
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

test("deeper indirection with an owner word fails closed as an owner command", () => {
  for (const cmd of [
    "A=post-review.mjs; S=scripts/lanes/$A; node $S owner success x --pr 16",
    "node $(echo scripts/lanes/post-review.mjs) owner success x --pr 16",
    "node `echo scripts/lanes/post-review.mjs` owner success x --pr 16",
  ]) assert.deepEqual(findOwnerInvocations(cmd), [{ pr: undefined, standalone: false }], cmd);
});

test("a variable spliced into the script name or the reviewer word does not hide an owner command (#62)", () => {
  for (const cmd of [
    "X=review; node scripts/lanes/post-$X.mjs owner success x --pr 16",
    "X=review && node scripts/lanes/post-${X}.mjs owner success x --pr 16",
    'D=scripts/lanes; node "$D/post-review.mjs" owner success x --pr 16',
    "R=own; node scripts/lanes/post-review.mjs ${R}er success x --pr 16",
    "R=own; node scripts/lanes/post-review.mjs \"$R\"er success x --pr 16",
    "X=review; bash -c \"node scripts/lanes/post-$X.mjs owner success x --pr 16\"",
    "bash -c 'X=review; node scripts/lanes/post-$X.mjs owner success x --pr 16'",
  ]) {
    const found = findOwnerInvocations(cmd);
    assert.equal(found.length, 1, `not detected: ${cmd}`);
    assert.equal(found[0].standalone, false, cmd);
    assert.deepEqual(decidePreToolUse(bash(cmd), grant(), NOW), { decision: "deny", reason: DENY_REASON }, cmd);
  }
  // Resolved fully, the spliced form is read like the plain one: its --pr is known.
  assert.deepEqual(findOwnerInvocations("X=review; node scripts/lanes/post-$X.mjs owner success x --pr 16"), [{ pr: "16", standalone: false }]);
});

test("a script word still holding $ or a backtick after substitution counts as an owner command (#62)", () => {
  for (const cmd of [
    "node scripts/lanes/post-$X.mjs owner success x --pr 16",
    "node scripts/lanes/post-$X.mjs test-hunter success x",
    "node $SCRIPT success x --pr 16",
    'node "${S}" --file v.json',
    "node --no-warnings $S owner",
    "node `echo s.mjs` success",
    "$RUN success x --pr 16",
    "cd x && ${NODE_SCRIPT} --pr 16",
    "X=$Y; node scripts/lanes/post-$X.mjs owner",
    "node scripts/lanes/post-$1.mjs owner",
  ]) {
    assert.deepEqual(findOwnerInvocations(cmd), [{ pr: undefined, standalone: false }], cmd);
    assert.deepEqual(decidePreToolUse(bash(cmd), grant(), NOW), { decision: "deny", reason: DENY_REASON }, cmd);
  }
});

test("edge: spliced and unresolved forms behind wrappers, empty values and odd references (#62)", () => {
  const denied = [
    "env node $S owner",
    "time node \"$S\" --pr 16",
    "X=review; env FOO=1 node scripts/lanes/post-$X.mjs owner --pr 16",
    "X=; node scripts/lanes/post-review$X.mjs owner --pr 16",
    "X=review; Y=post-$X.mjs; node scripts/lanes/$Y owner --pr 16",
    "node scripts/lanes/post-${X.mjs owner",
    "(X=review; node scripts/lanes/post-$X.mjs owner --pr 16)",
    "X=review; sh -c 'sh -c \"node scripts/lanes/post-$X.mjs owner\"'",
  ];
  for (const cmd of denied) assert.deepEqual(decidePreToolUse(bash(cmd), grant(), NOW), { decision: "deny", reason: DENY_REASON }, cmd);
  // A later assignment overrides an earlier one, and a variable resolved to another script is not an owner command.
  assert.deepEqual(findOwnerInvocations("X=review; X=gate; node scripts/lanes/post-$X.mjs 16"), []);
  assert.deepEqual(findOwnerInvocations("X=review; node scripts/lanes/post-$X.mjs test-hunter skipped x"), []);
  // The plain owner command with a grant is still allowed: in-word substitution does not touch it.
  assert.equal(decidePreToolUse(bash(OWNER), grant(), NOW).decision, "allow");
});

test("ordinary $ arguments get no decision (#62)", () => {
  for (const cmd of [
    'gh pr view "$PR"',
    "gh pr view $PR --json state",
    'node scripts/lanes/post-review.mjs --file "$F"',
    "node scripts/lanes/gate.mjs $PR",
    "node --test scripts/lanes/approve-guard.test.mjs $FILTER",
    'X=review; echo "post-$X"',
    'git commit -m "post-review: fix $X handling"',
    'PR=16; gh pr checks "$PR" --watch',
    "echo $HOME",
    "npm test -- $ARGS",
  ]) {
    assert.deepEqual(findOwnerInvocations(cmd), [], cmd);
    assert.equal(decidePreToolUse(bash(cmd), null, NOW), null, cmd);
  }
});

// Found by the #62 test-hunter: a node flag that takes its value from the next word (--require/-r, --loader, …) must
// not shift the script position onto that value and leave the spliced script word unchecked.
test("edge: a node flag that takes a value does not hide a spliced script word (#62 review)", () => {
  for (const cmd of [
    "node --require ./setup.js scripts/lanes/post-$X.mjs $R --pr 16",
    "node -r ./setup.js scripts/lanes/post-$X.mjs $R --pr 16",
    "node --loader ./l.mjs scripts/lanes/post-$X.mjs $R --pr 16",
    "node --import ./i.mjs --no-warnings $S owner --pr 16",
    "node --require $M scripts/lanes/gate.mjs 16",
    "node --env-file=.env $S owner",
    // Found by the #62 security review: an option missing from any list must fail closed, not shift the script.
    "node --allow-fs-read /tmp scripts/lanes/post-$X.mjs $R --pr 16",
    "node --some-future-flag v scripts/lanes/post-$X.mjs",
    "node --allow-fs-read /tmp --allow-net x scripts/lanes/post-$X.mjs",
    "node -- $S",
  ]) {
    assert.deepEqual(findOwnerInvocations(cmd), [{ pr: undefined, standalone: false }], cmd);
    assert.deepEqual(decidePreToolUse(bash(cmd), grant(), NOW), { decision: "deny", reason: DENY_REASON }, cmd);
  }
  // A literal script behind a value flag is still an ordinary run, $ arguments after it included.
  assert.deepEqual(findOwnerInvocations("node -r ./setup.js scripts/lanes/gate.mjs $PR"), []);
});

// Found by the #62 test-hunter (round 2): an earlier word equal to "node" (a `sudo -u node` or `chown node` target)
// must not stand in for the real interpreter and leave the spliced script word after it unchecked.
test("edge: a wrapper argument that itself looks like the node binary must not hide a spliced script/reviewer word (#62 finding)", () => {
  for (const cmd of [
    "sudo -u node node scripts/lanes/post-$X.mjs $R --pr 16",
    "chown node node scripts/lanes/post-$X.mjs $R --pr 16",
  ]) {
    assert.equal(findOwnerInvocations(cmd).length, 1, `not detected: ${cmd}`);
    assert.deepEqual(decidePreToolUse(bash(cmd), grant(), NOW), { decision: "deny", reason: DENY_REASON }, cmd);
  }
});

// Found by the #62 test-hunter (final verification): a command that only prints or searches its arguments never runs
// the "node" it mentions, so a later `$` word is not denied. Any other command word still fails closed.
test("edge: the word 'node' as an argument of a command that never runs it is not a false deny (#62 review)", () => {
  for (const cmd of [
    "grep -n node $FILE",
    "echo node $VAR",
    "ls /opt/node $DIR",
    "which node $X",
    "rg -l node $DIR",
  ]) {
    assert.deepEqual(findOwnerInvocations(cmd), [], cmd);
    assert.equal(decidePreToolUse(bash(cmd), null, NOW), null, cmd);
  }
  // An unknown command word may be a wrapper that runs node: still denied.
  for (const cmd of ["mywrap node scripts/lanes/post-$X.mjs $R", "docker run node $IMAGE"]) {
    assert.deepEqual(decidePreToolUse(bash(cmd), grant(), NOW), { decision: "deny", reason: DENY_REASON }, cmd);
  }
  // A nested script inside a non-running command is still scanned as a command of its own.
  assert.deepEqual(decidePreToolUse(bash('echo "x; node $S owner"'), grant(), NOW), { decision: "deny", reason: DENY_REASON });
});

// Found by the #62 test-hunter (recheck): echo or grep output piped into a shell is run, so the exemption for
// commands that never run their arguments does not apply once the command has a pipe.
test("edge: a non-running command piped into a shell still counts its spliced node script (#62 review)", () => {
  for (const cmd of [
    "echo node scripts/lanes/post-$X.mjs $R --pr 16 | bash",
    "echo node scripts/lanes/post-$X.mjs $R --pr 16 | sh",
    "bash -c 'echo node scripts/lanes/post-$X.mjs $R | sh'",
  ]) {
    assert.notDeepEqual(findOwnerInvocations(cmd), [], `bypass: ${cmd} produced no decision`);
    assert.deepEqual(decidePreToolUse(bash(cmd), grant(), NOW), { decision: "deny", reason: DENY_REASON }, cmd);
  }
  // Anything downstream that is not itself a non-running command may run what it reads.
  for (const cmd of [
    "echo node $VAR | cat | bash",
    "(echo node $VAR) | bash",
    "echo node $VAR |& bash",
    "echo node $VAR | env bash",
    "echo node $VAR | xargs node",
  ]) {
    assert.deepEqual(decidePreToolUse(bash(cmd), grant(), NOW), { decision: "deny", reason: DENY_REASON }, cmd);
  }
});

// Found by the #62 test-hunter (round 3): the pipe check voided the exemption for any pipe anywhere in the command.
test("edge: a pipe into another non-running command, or elsewhere in the command, keeps the exemption (#62 review)", () => {
  for (const cmd of [
    "grep -n node $FILE | wc -l",
    "echo node $VAR | cat",
    "grep node $F | head -5 | wc -l",
    "gh pr list | head; echo node $VAR",
    "echo node $VAR || echo failed",
  ]) {
    assert.deepEqual(findOwnerInvocations(cmd), [], cmd);
    assert.equal(decidePreToolUse(bash(cmd), null, NOW), null, cmd);
  }
});

// Found by the #62 test-hunter (round 3): the raw-text pre-filter ran before quotes were resolved, so a quote or a
// backslash inside the literal name hid it. A glob matches the name without spelling it at all.
test("edge: a quote, backslash or glob inside the script name does not hide an owner command (#62 review)", () => {
  for (const cmd of [
    `node scripts/lanes/pos"t-review.mjs" owner success ok --pr 16 --sha ${SHA}`,
    `node scripts/lanes/"post-revi""ew".mjs owner success ok --pr 16 --sha ${SHA}`,
    `node scripts/lanes/p"o"s"t"-review.mjs owner success ok --pr 16 --sha ${SHA}`,
    `node scripts/lanes/pos't-rev'iew.mjs owner success ok --pr 16 --sha ${SHA}`,
    `node scripts/lanes/pos\\t-review.mjs owner success ok --pr 16 --sha ${SHA}`,
    `bash -c 'node scripts/lanes/pos"t-review.mjs" owner --pr 16'`,
    `node scripts/lanes/post-revie?.mjs owner success ok --pr 16 --sha ${SHA}`,
    `node scripts/lanes/p*.mjs owner success ok --pr 16 --sha ${SHA}`,
    `node scripts/lanes/post-[r]eview.mjs owner success ok --pr 16 --sha ${SHA}`,
    `node scripts/lanes/* owner success ok --pr 16 --sha ${SHA}`,
    `node scripts/lanes/post-{review,x}.mjs owner --pr 16`,
    `node {scripts/lanes/post-review.mjs,} owner --pr 16`,
    `node scripts/lanes/post-review.mjs o{wner,} success ok --pr 16 --sha ${SHA}`,
    `node scripts/lanes/pos"t-review.mjs" o"wn"er --pr 16`,
  ]) {
    assert.notDeepEqual(findOwnerInvocations(cmd), [], `bypass: ${cmd} produced no decision`);
    assert.deepEqual(decidePreToolUse(bash(cmd), grant(), NOW), { decision: "deny", reason: DENY_REASON }, cmd);
  }
  // Found by the #62 security-reviewer: bun and deno run the script too (start-guard.mjs already counts them).
  for (const cmd of [
    "bun scripts/lanes/post-review.* owner ok x --pr 16",
    "bun run scripts/lanes/p*.mjs owner ok x --pr 16",
    "deno run -A scripts/lanes/post-revie?.mjs owner ok x --pr 16",
    "deno.exe run scripts/lanes/post-$X.mjs $R --pr 16",
  ]) {
    assert.notDeepEqual(findOwnerInvocations(cmd), [], `bypass: ${cmd} produced no decision`);
    assert.deepEqual(decidePreToolUse(bash(cmd), grant(), NOW), { decision: "deny", reason: DENY_REASON }, cmd);
  }
  // A glob that cannot match post-review.mjs is an ordinary argument, as in the project's own test command.
  for (const cmd of ['node --test "scripts/**/*.test.mjs"', "node --test scripts/*.test.mjs", "ls scripts/*.mjs", "node scripts/lanes/gate.mjs *"]) {
    assert.equal(decidePreToolUse(bash(cmd), null, NOW), null, cmd);
  }
});

// Found by the test-hunter (this round): NODE_RE only matched node/nodejs, so `bun`/`deno` running post-review.mjs
// owner got no decision at all (a full bypass), and bun/deno's own `run` subcommand needed skipping to still find
// the real script and reviewer behind it, mirroring start-guard.mjs's existing bun/deno coverage.
test("edge: bun and deno run the owner command too, run subcommand included", () => {
  for (const cmd of [
    "bun scripts/lanes/post-review.mjs owner success x --pr 16",
    "bun run scripts/lanes/post-review.mjs owner success x --pr 16",
    "deno run scripts/lanes/post-review.mjs owner success x --pr 16",
    "deno.exe run -A scripts/lanes/post-review.mjs owner success x --pr 16",
    "bun run scripts/lanes/post-$X.mjs owner --pr 16",
  ]) {
    assert.ok(findOwnerInvocations(cmd).length >= 1, `not detected: ${cmd}`);
    assert.deepEqual(decidePreToolUse(bash(cmd), grant(), NOW), { decision: "deny", reason: DENY_REASON }, cmd);
  }
  assert.deepEqual(findOwnerInvocations("bun run scripts/lanes/post-review.mjs owner success x --pr 16"), [{ pr: "16", standalone: false }]);
  // Ordinary bun/deno commands, including its own `run` subcommand and flags, still get no decision.
  for (const cmd of ["bun install", "bun run build", "bun run scripts/lanes/gate.mjs 16", "deno run --allow-read scripts/lanes/gate.mjs 16"]) {
    assert.deepEqual(findOwnerInvocations(cmd), [], cmd);
    assert.equal(decidePreToolUse(bash(cmd), null, NOW), null, cmd);
  }
});

// Found by the test-hunter (this round): bash drops a `<`/`>` redirection target (and a bare fd number right before
// it, as in `2>file`) from the program's argv. Before the fix, the lexer kept it as an ordinary word, so a target
// placed before the reviewer word displaced "owner" out of the reviewer slot and the command got no decision at all.
test("edge: a redirection target does not steal the reviewer slot and hide an owner command", () => {
  for (const cmd of [
    "node scripts/lanes/post-review.mjs > out.txt owner --pr 16",
    "node scripts/lanes/post-review.mjs>out.txt owner --pr 16",
    "node scripts/lanes/post-review.mjs 1> out.txt owner --pr 16",
    "node scripts/lanes/post-review.mjs 2>/dev/null owner --pr 16",
    "node scripts/lanes/post-review.mjs < in.txt owner --pr 16",
    "node scripts/lanes/post-review.mjs >> out.txt owner --pr 16",
    'node scripts/lanes/post-review.mjs > "out with space.txt" owner --pr 16',
  ]) {
    assert.deepEqual(findOwnerInvocations(cmd), [{ pr: "16", standalone: false }], cmd);
    assert.deepEqual(decidePreToolUse(bash(cmd), grant(), NOW), { decision: "deny", reason: DENY_REASON }, cmd);
  }
  // The target is dropped from the arguments but not from the scan: a command substitution in it runs, and a
  // herestring feeds a shell its script.
  for (const cmd of [
    'echo x > "$(node scripts/lanes/post-review.mjs owner --pr 16)"',
    "echo x > \"`node scripts/lanes/post-review.mjs owner --pr 16`\"",
    'bash <<< "node scripts/lanes/post-review.mjs owner --pr 16"',
    'bash <<< "node scripts/lanes/p*.mjs owner --pr 16"',
  ]) {
    assert.notDeepEqual(findOwnerInvocations(cmd), [], `bypass: ${cmd} produced no decision`);
    assert.deepEqual(decidePreToolUse(bash(cmd), grant(), NOW), { decision: "deny", reason: DENY_REASON }, cmd);
  }
  for (const cmd of ['echo x > "$OUT"', "gh pr list > $LOG 2>&1", "node scripts/lanes/gate.mjs 16 > \"$TMP/out file.txt\""]) {
    assert.equal(decidePreToolUse(bash(cmd), null, NOW), null, cmd);
  }
  // A redirection after the reviewer word already worked, and must keep working.
  assert.deepEqual(findOwnerInvocations("node scripts/lanes/post-review.mjs owner --pr 16 > out.txt"), [{ pr: "16", standalone: false }]);
  // Ordinary commands with a redirection (including a lone digit right before it, the fd-number form) still get no decision.
  for (const cmd of ["gh pr view 2 > out.txt", "echo 2 > out.txt", "node scripts/lanes/gate.mjs --file a.json > out.txt"]) {
    assert.deepEqual(findOwnerInvocations(cmd), [], cmd);
    assert.equal(decidePreToolUse(bash(cmd), null, NOW), null, cmd);
  }
});

test("the CLI answers deny, never crashes, when it cannot evaluate a PreToolUse call", () => {
  const cli = (event, input) => spawnSync(process.execPath, ["scripts/lanes/approve-guard.mjs", event], { input, encoding: "utf8" });
  for (const [event, input] of [["pre-tool-use", "{oops"], ["bogus-event", JSON.stringify(bash(OWNER))]]) {
    const r = cli(event, input);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "deny");
  }
  const ok = cli("user-prompt-submit", "{oops");
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout, "");
});
