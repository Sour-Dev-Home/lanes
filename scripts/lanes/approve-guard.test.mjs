// scripts/lanes/approve-guard.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DENY_REASON, GRANT_TTL_MS, UNPARSED_REASON, decidePreToolUse, findFreshGrant, findOwnerInvocations, grantDir, isFreshGrant, onUserPromptSubmit, parseApprovePrompt, readGrant, runHook, validGrant } from "./approve-guard.mjs";

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

test("PreToolUse allows the owner command with a fresh grant for the same PR, and leaves consuming it to post-review", () => {
  assert.deepEqual(decidePreToolUse(bash(OWNER), grant(), NOW), { decision: "allow", reason: "owner approval from /approve 16 in this session" });
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

test("hook flow: /approve 16 then the owner command is allowed, and the allow keeps the grant (post-review consumes it)", () => withDir((dir) => {
  runHook("user-prompt-submit", JSON.stringify({ session_id: "s1", prompt: "/approve 16" }), { dir, now: NOW });
  const file = join(dir, "s1.json");
  const written = readFileSync(file, "utf8");
  assert.deepEqual(JSON.parse(written), { sessionId: "s1", pr: 16, at: new Date(NOW).toISOString() });
  const first = JSON.parse(runHook("pre-tool-use", JSON.stringify(bash(OWNER)), { dir, now: NOW + 1000 }));
  assert.deepEqual(first, { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "owner approval from /approve 16 in this session" } });
  assert.equal(readFileSync(file, "utf8"), written);
  // Once post-review has consumed it (deleted the file), the hook denies again.
  rmSync(file);
  assert.equal(decision(runHook("pre-tool-use", JSON.stringify(bash(OWNER)), { dir, now: NOW + 2000 })), "deny");
}));

// --- the grant reader shared with post-review.mjs (#81) ---------------------------------------------------------------

test("grantDir is the repo's .lanes/approve directory, the one the hook writes to", () => {
  assert.match(grantDir().replace(/\\/g, "/"), /\/\.lanes\/approve\/?$/);
});

test("validGrant accepts only { sessionId, pr: positive integer, at: a date }", () => {
  assert.equal(validGrant(grant()), true);
  for (const g of [null, undefined, "x", { unreadable: true }, grant({ pr: "16" }), grant({ pr: 0 }), grant({ pr: 1.5 }), grant({ at: "yesterday" }), grant({ sessionId: 1 })]) {
    assert.equal(validGrant(g), false, JSON.stringify(g));
  }
});

test("isFreshGrant: the same PR and under GRANT_TTL_MS old, nothing else", () => {
  assert.equal(isFreshGrant(grant(), 16, NOW), true);
  assert.equal(isFreshGrant(grant(), 17, NOW), false);
  assert.equal(isFreshGrant(grant({ at: new Date(NOW - GRANT_TTL_MS).toISOString() }), 16, NOW), false);
  assert.equal(isFreshGrant(grant({ at: new Date(NOW - GRANT_TTL_MS + 1).toISOString() }), 16, NOW), true);
  assert.equal(isFreshGrant(grant({ at: new Date(NOW + 60_000).toISOString() }), 16, NOW), false);
  assert.equal(isFreshGrant({ unreadable: true }, 16, NOW), false);
});

test("readGrant: parsed JSON, null for a missing file, { unreadable: true } for bad JSON", () => withDir((dir) => {
  writeFileSync(join(dir, "a.json"), JSON.stringify(grant()));
  writeFileSync(join(dir, "b.json"), "{nope");
  assert.deepEqual(readGrant(join(dir, "a.json")), grant());
  assert.deepEqual(readGrant(join(dir, "b.json")), { unreadable: true });
  assert.equal(readGrant(join(dir, "missing.json")), null);
}));

test("findFreshGrant returns the file of a fresh grant for that PR, skipping the rest", () => withDir((dir) => {
  writeFileSync(join(dir, "other.json"), JSON.stringify(grant({ sessionId: "other", pr: 17 })));
  writeFileSync(join(dir, "old.json"), JSON.stringify(grant({ sessionId: "old", at: new Date(NOW - GRANT_TTL_MS).toISOString() })));
  writeFileSync(join(dir, "bad.json"), "{nope");
  writeFileSync(join(dir, "note.txt"), JSON.stringify(grant()));
  assert.equal(findFreshGrant(dir, 16, NOW), null);
  writeFileSync(join(dir, "s1.json"), JSON.stringify(grant()));
  assert.equal(findFreshGrant(dir, 16, NOW), join(dir, "s1.json"));
}));

test("edge: findFreshGrant is null when the grant directory does not exist yet", () => withDir((dir) => {
  assert.equal(findFreshGrant(join(dir, "never-made"), 16, NOW), null);
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
  // Found by the #62 security-reviewer (round at ae38a05): a script held in a variable and run by eval or sh -c is
  // scanned from its assignment, ambiguous or not, with its own splices failing closed.
  for (const cmd of [
    "true && CMD='node scripts/lanes/post-review.mjs own${E}er --pr 16' || CMD='node scripts/lanes/post-review.mjs security-reviewer --pr 16'; eval $CMD",
    "true && CMD='node scripts/lanes/post-review.mjs own${E}er --pr 16' || CMD=x; bash -c \"$CMD\"",
    "E=; CMD='node scripts/lanes/post-review.mjs own${E}er --pr 16'; eval $CMD",
    "export CMD='node scripts/lanes/post-review.mjs own${E}er'; sh -c \"$CMD\"",
    // Split across two ambiguous names, neither value looks like a script: the eval text itself fails closed.
    "true && A='node scripts/lanes/post-rev' || A=x; true && B='iew.mjs own${E}er --pr 16' || B=y; eval $A$B",
    'eval "$X"',
    'bash -c "$X"',
    'bash -lc "$X"',
    "sudo sh -c \"$X\"",
    'source "$F"',
  ]) {
    assert.notDeepEqual(findOwnerInvocations(cmd), [], `bypass: ${cmd} produced no decision`);
    assert.deepEqual(decidePreToolUse(bash(cmd), grant(), NOW), { decision: "deny", reason: DENY_REASON }, cmd);
  }
  for (const cmd of ['MSG="fix the $X thing"; git commit -m "$MSG"', "OUT='a b'; ls $OUT", "eval ls", 'bash scripts/foo.sh "$PR"', "bash -c 'gh pr view 16'", 'echo eval "$X"']) {
    assert.equal(decidePreToolUse(bash(cmd), null, NOW), null, cmd);
  }
  // A variable resolved to another script is not an owner command. One assigned the same value twice is still resolved.
  assert.deepEqual(findOwnerInvocations("X=gate; X=gate; node scripts/lanes/$X.mjs 16"), []);
  // Found by the #62 security-reviewer: the lexer cannot tell a sequence from exclusive branches, so a name given two
  // different values is ambiguous and stays unresolved (fail closed), whichever comes last in the text.
  for (const cmd of [
    "X=review; X=gate; node scripts/lanes/post-$X.mjs 16",
    "true && R=own || R=xyz; node scripts/lanes/post-review.mjs ${R}er --pr 16",
    "if true; then R=own; else R=xyz; fi; node scripts/lanes/post-review.mjs ${R}er --pr 16",
    "true && X=review || X=gate; node scripts/lanes/post-$X.mjs owner --pr 16",
    "case a in a) S=scripts/lanes/post-review.mjs;; *) S=scripts/lanes/gate.mjs;; esac; node $S owner --pr 16",
  ]) {
    assert.notDeepEqual(findOwnerInvocations(cmd), [], `bypass: ${cmd} produced no decision`);
    assert.deepEqual(decidePreToolUse(bash(cmd), grant(), NOW), { decision: "deny", reason: DENY_REASON }, cmd);
  }
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

const denied = (cmd) => {
  assert.notDeepEqual(findOwnerInvocations(cmd), [], `bypass: ${cmd} produced no decision`);
  assert.deepEqual(decidePreToolUse(bash(cmd), grant(), NOW), { decision: "deny", reason: DENY_REASON }, cmd);
};

test("a glob in the script word, in node's script position or the command position, is an owner command (#70)", () => {
  for (const cmd of [
    "node scripts/lanes/po*-review.mjs owner --pr 16",
    "node scripts/lanes/post-rev??w.mjs owner --pr 16",
    "node scripts/lanes/post-rev[a-z]ew.mjs owner --pr 16",
    "node --no-warnings scripts/lanes/po*-review.mjs owner --pr 16",
    "scripts/lanes/po*-review.mjs owner --pr 16",
    "./scripts/lanes/post-review.m?s owner --pr 16",
  ]) denied(cmd);
});

test("a brace expansion in the script word, list or sequence, is an owner command (#70)", () => {
  for (const cmd of [
    "node scripts/lanes/p{ost-review.mjs,x} owner --pr 16",
    "node scripts/lanes/post-{review,x}{.mjs,} owner --pr 16",
    "node scripts/lanes/post-revie{w..w}.mjs owner --pr 16",
    "node scripts/lanes/post-review.mj{a..z} owner --pr 16",
    "node scripts/lanes/post-review.mj{r..t} owner --pr 16",
    "node scripts/lanes/post-review.mj{a..z..2} owner --pr 16",
    "node scripts/lanes/post-{re{v,x}iew,x}.mjs owner --pr 16",
    "scripts/lanes/post-revie{v..x}.mjs owner --pr 16",
  ]) denied(cmd);
});

test("ordinary commands with glob or brace arguments get no decision (#70)", () => {
  for (const cmd of [
    "ls scripts/*.mjs",
    "git diff -- 'scripts/lanes/*.mjs'",
    "git diff -- scripts/lanes/*.mjs",
    "ls scripts/lanes/post-*.mjs",
    "cat scripts/lanes/{gate,queue}.mjs",
    "node scripts/lanes/gate.mjs {a,b}",
    "node scripts/lanes/post-review.mj{1..3} owner --pr 16",
    "node scripts/lanes/post-revie{a..c}.mjs owner --pr 16",
    "node scripts/lanes/{gate,queue}.mjs --pr 16",
  ]) assert.equal(decidePreToolUse(bash(cmd), null, NOW), null, cmd);
});

test("edge: a malformed or unusual brace in the script word fails closed or reads as bash does (#70)", () => {
  // An unclosed brace is literal to bash, but the guard cannot be sure what follows: fail closed.
  denied("node scripts/lanes/post-review{.mjs owner --pr 16");
  // {w..w..0} and {w..w..-1} still expand in bash (a zero step is taken as one).
  denied("node scripts/lanes/post-revie{w..w..0}.mjs owner --pr 16");
  denied("node scripts/lanes/post-revie{x..v..-1}.mjs owner --pr 16");
  // An empty brace or one without a comma or `..` is literal to bash, so it cannot become post-review.mjs.
  // A nested list inside such a brace still expands, but the outer braces stay: post-{review}.mjs, post-{rexiew}.mjs.
  for (const cmd of ["node scripts/lanes/post-review.mjs{} x", "node scripts/lanes/post-{review}.mjs owner --pr 16", "node scripts/lanes/post-{re{v,x}iew}.mjs owner --pr 16"]) {
    assert.equal(decidePreToolUse(bash(cmd), null, NOW), null, cmd);
  }
});

// #123: bash never expands an unclosed `{`, so a nested re-scan of a quoted jq filter or node -e script, whose text
// after a `|` becomes a command word such as `{r:.a,`, must not fail closed on it.
test("read-only commands whose quoted jq or node -e argument leaves a brace open are not owner commands (#123)", () => {
  for (const cmd of [
    "gh api x --jq '[.[]|{r:.a, m:.b}]'",
    "gh issue list --jq '.[]|select(.body|test(\"x\"))|{n:.number, t:.title}'",
    "claude agents --json | node -e \"process.stdin.on('end',()=>{for(const a of []){console.log(a.id,a.status)}})\"",
  ]) {
    assert.deepEqual(findOwnerInvocations(cmd), [], cmd);
    assert.equal(decidePreToolUse(bash(cmd), null, NOW), null, cmd);
  }
});

test("an unclosed brace in a command word is literal, not a post-review run (#123)", () => {
  for (const cmd of ["{r:.a, m:.b}", "{n:.number x", "sh -c '{x, y'", "echo a | {r:.a,", "{", "x{", "{{", "{a,b", "{1..3", "{a/b", "{lanes/gate.mjs x"]) {
    assert.deepEqual(findOwnerInvocations(cmd), [], cmd);
  }
  // A closed brace still expands, and a word that names post-review.mjs once the stray `{` is dropped still fails
  // closed, since the guard cannot be sure how the rest was quoted.
  denied("node scripts/lanes/post-{review,x}.mjs owner --pr 16");
  denied("post-{review x");
  denied("{post-review.mjs owner --pr 16");
  denied("node scripts/{lanes/post-review.mjs owner --pr 16");
  denied("node scripts/lanes/post-review{.mjs owner --pr 16");
  denied("node scripts/lanes/post-{re{v,x}iew.mjs owner --pr 16");
  denied("node scripts/lanes/p{ost-{review,x}.mjs owner --pr 16");
});

// test-hunter (this round): neither #123's criteria nor the round above named a word with more than one stray
// unclosed `{` before the name, or a trailing stray `{` left over after an already-closed list expands in the same
// word; both still spell post-review.mjs once every unclosed brace is dropped, so both still fail closed.
test("edge: more than one stray unclosed brace in a word still fails closed when the name survives (#123)", () => {
  denied("node scripts/lanes/{{post-review.mjs owner --pr 16");
  denied("node scripts/lanes/{gate,post-review}.mjs{ owner --pr 16");
});

// test-hunter (this round): a bracket expression whose first character is a literal `]` (bash reads `]` right after
// `[` as a set member, not a close) and a brace holding a `/` that spans into the directory part of the path, both
// uncommon enough that neither #70's criteria nor the round above named them.
test("edge: a bracket expression starting with a literal ']', and a brace holding a '/', are still owner commands (#70)", () => {
  // `[]i]` is the set {']', 'i'}: post-rev[]i]ew.mjs matches post-review.mjs with 'i' in that slot.
  denied("node scripts/lanes/post-rev[]i]ew.mjs owner --pr 16");
  // The brace spans a '/', so one branch names a whole path ending in post-review.mjs; the last path segment alone
  // (naive slicing on the final '/') would misread this, so the guard must catch it via the embedded '/' instead.
  denied("node scripts/{lanes/post-review.mjs,x} owner --pr 16");
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

// test-hunter (#62 review): process substitution `<(…)`/`>(…)` is not a case the redirect handling models on
// purpose (skipRedirectTarget stops at the `(`), so its content falls through to the generic `(`/`)` segment
// splitting and is scanned as a command of its own either way. An unrecognized node option that consumes the next
// word as its value must not let that word's true position (the spliced script) fall outside the cumulative range
// nodeScriptEnd feeds into nodeRange.
test("edge: process substitution and an unrecognized valued node flag do not hide an owner command (#62 review)", () => {
  for (const cmd of [
    "diff <(node scripts/lanes/post-review.mjs owner --pr 16) other.txt",
    "diff other.txt <(node scripts/lanes/post-review.mjs owner --pr 16)",
    "tee >(node scripts/lanes/post-review.mjs owner --pr 16) < in.txt",
    "node --not-a-real-flag scripts/lanes/post-$X.mjs owner --pr 16",
    "node --not-a-real-flag scripts/lanes/post-review.mjs owner --pr 16",
  ]) {
    assert.notDeepEqual(findOwnerInvocations(cmd), [], `bypass: ${cmd} produced no decision`);
    assert.deepEqual(decidePreToolUse(bash(cmd), grant(), NOW), { decision: "deny", reason: DENY_REASON }, cmd);
  }
  // Ordinary process substitution and an ordinary unrecognized flag still get no decision.
  for (const cmd of ["diff <(sort a.txt) <(sort b.txt)", "node --not-a-real-flag scripts/lanes/gate.mjs 16"]) {
    assert.deepEqual(findOwnerInvocations(cmd), [], cmd);
    assert.equal(decidePreToolUse(bash(cmd), null, NOW), null, cmd);
  }
});

// --- #140: false positives on harmless commands --------------------------------------------------------------------

const allowed = (cmd) => {
  assert.deepEqual(findOwnerInvocations(cmd), [], cmd);
  assert.equal(decidePreToolUse(bash(cmd), null, NOW), null, cmd);
};

test("an owner word next to a $ is no longer an owner command on its own (#140)", () => {
  allowed('echo "owner $X"');
  allowed("cat > .lanes/verdicts/test-hunter.json <<'EOF'\n{ \"summary\": \"the owner pays $0 for `npm test`\" }\nEOF");
  allowed("gh pr create --title x --body-file - <<'EOF'\n## Needs the owner\n\nnothing; the gate costs $0\nEOF");
});

test("a disguised owner command the hook no longer catches is refused by post-review.mjs without a grant (#140, #81)", async () => {
  // Before #140 the `owner` word plus a `$` failed closed; now only the script's own grant check (#81) stops it.
  const cmd = "python3 -c \"import subprocess,sys; subprocess.run(['node','scripts/lanes/post-review.mjs']+sys.argv[1:])\" owner success x --pr $PR";
  assert.deepEqual(findOwnerInvocations(cmd), []);
  // What that command ends up running: post-review.mjs owner, with no /approve grant anywhere.
  const { main } = await import("./post-review.mjs");
  withDir((dir) => {
    const calls = [];
    const run = (...args) => {
      calls.push(args);
      throw new Error("gh must not be called without a grant");
    };
    assert.throws(() => main(["owner", "success", "x", "--pr", "16"], { run, log: () => {}, warn: () => {}, grantDir: dir, now: NOW }), /no fresh \/approve 16 grant/);
    assert.deepEqual(calls, []);
  });
});

test("a NAME=value argument after the command word is an argument, not an assignment (#152)", () => {
  allowed('echo "n=$n i=$i"');
  allowed('printf "%s\\n" "a=$A b=$B"');
  // Leading NAME=value words are still assignments.
  denied("S=scripts/lanes/post-review.mjs; node $S owner --pr 1");
  denied('A="node scripts/lanes/post-review.mjs owner --pr 1"; eval "$A"');
  // An argument really run as a script is still scanned and fails closed.
  denied('bash -c "x=$y; node \\$x owner --pr 1"');
  denied('eval "x=$y; node \\$x owner --pr 1"');
});

test("an awk program holding backticks and $ is allowed (#148)", () => {
  const cmd = "awk '/^```markdown$/{f=1;next} f&&/^```$/{exit} f' in.md > out.md";
  allowed(cmd);
  withDir((dir) => assert.equal(runHook("pre-tool-use", JSON.stringify(bash(cmd)), { dir, now: NOW }), ""));
});

test("a heredoc that only feeds data gives no decision; one that runs post-review.mjs owner is denied (#100)", () => {
  allowed("git commit -m \"$(cat <<'EOF'\nfix: post-review.mjs owner check reads $PR; `x`\n\nCo-Authored-By: a <b@c>\nEOF\n)\"");
  // A backslash-led delimiter (`$(cat <<\EOF … EOF)`) suppresses expansion exactly like a quoted one (regression,
  // found in review: this word's delimiter regex captured the backslash without recording it as quoting).
  allowed('git commit -m "$(cat <<\\EOF\nfix: mentions $(node scripts/lanes/post-review.mjs owner --pr 16) but is just text\nEOF\n)"');
  denied("bash <<'EOF'\nnode scripts/lanes/post-review.mjs owner --pr 16\nEOF");
  denied("cat <<'EOF' | sh\nnode scripts/lanes/post-review.mjs owner --pr 16\nEOF");
});

test("a command that cannot be parsed is denied with a reason that says so (#100)", () => {
  const d = decidePreToolUse(bash(`node scripts/lanes/post-review.mjs owner "oops --pr 16`), grant(), NOW);
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /could not be parsed/);
});

test("edge: heredocs a data command reads stay data, and every heredoc that can run post-review.mjs owner is denied (#100)", () => {
  allowed("gh pr comment 16 --body-file - <<'EOF'\nrun node scripts/lanes/post-review.mjs owner --pr 16 after /approve 16\nEOF");
  allowed("cat <<'EOF'\nEOF");
  allowed("cat <<-EOF\n\tnode $S owner\n\tEOF");
  allowed("git commit -F - <<EOF\nfix $X handling\nEOF");
  allowed("cat <<'EOF\nnot a delimiter");
  // A backslash before the delimiter (`<<\EOF`) suppresses expansion exactly like a quoted delimiter (regression,
  // found in review: the delimiter regex captured the backslash without recording it, so this body was misread as
  // unquoted and denied even though bash never runs its `$(…)`).
  allowed("git commit -F - <<\\EOF\nfix: mentions $(node scripts/lanes/post-review.mjs owner --pr 16) but is just text\nEOF");
  denied("bash <<\\EOF\nnode scripts/lanes/post-review.mjs owner --pr 16\nEOF");
  // An unquoted body still runs its $(…) and backticks, even when a data command reads it.
  denied("cat <<EOF\n$(node scripts/lanes/post-review.mjs owner --pr 16)\nEOF");
  denied("cat <<EOF > out.txt\n`node scripts/lanes/post-review.mjs owner --pr 16`\nEOF");
  // A shell reading the body, unterminated, tab-stripped, behind a second heredoc on the same line, or piped on.
  denied("bash <<EOF\nnode scripts/lanes/post-review.mjs owner --pr 16");
  denied("sh <<-EOF\n\tnode scripts/lanes/post-review.mjs owner --pr 16\n\tEOF");
  denied("cat <<A; bash <<B\nx\nA\nnode scripts/lanes/post-review.mjs owner --pr 16\nB");
  denied("gh pr view 16 <<'EOF' | bash\nnode scripts/lanes/post-review.mjs owner --pr 16\nEOF");
  denied("bash <<'EOF'\nS=scripts/lanes/post-review.mjs; node $S owner --pr 16\nEOF");
  denied("node <<'EOF'\nrequire('child_process').execSync('node scripts/lanes/post-review.mjs owner --pr 16')\nEOF");
  // A literal $(cat <<'EOF' … EOF) is data for git, a script for a shell or anything piped into one.
  denied("bash -c \"$(cat <<'EOF'\nnode scripts/lanes/post-review.mjs owner --pr 16\nEOF\n)\"");
  denied("git log -1 --format=\"$(cat <<'EOF'\nnode scripts/lanes/post-review.mjs owner --pr 16\nEOF\n)\" | sh");
  // The commands after a heredoc's body are still read as commands.
  denied("cat <<'EOF'\nhello\nEOF\nnode scripts/lanes/post-review.mjs owner --pr 16");
});

// Found by the #140 security-reviewer: origin/main denied these (by misreading the body as commands), and the first
// cut of #100 let them through. awk and sed can run their input, and a body written to a file can be run later.
test("edge: a heredoc fed to awk or sed, or written to a file a later command may run, is still scanned (#140 review)", () => {
  denied("sed 's/.*/&/e' <<'EOF'\nnode scripts/lanes/post-review.mjs owner --pr 16\nEOF");
  denied("awk '{system($0)}' <<'EOF'\nnode scripts/lanes/post-review.mjs owner --pr 16\nEOF");
  denied("tee script.sh <<'EOF'\nnode scripts/lanes/post-review.mjs owner --pr 16\nEOF\nbash script.sh");
  denied("cat > script.sh <<'EOF'\nnode scripts/lanes/post-review.mjs owner --pr 16\nEOF\nchmod +x script.sh && ./script.sh");
  denied("cat <<'EOF' > script.sh; source script.sh\nnode scripts/lanes/post-review.mjs owner --pr 16\nEOF");
  // Written to a file with nothing run after it, or only data commands after it: still data.
  allowed("cat > notes.md <<'EOF'\nrun node scripts/lanes/post-review.mjs owner --pr 16 after /approve 16\nEOF");
  allowed("cat > notes.md <<'EOF'\n$ npm test\nEOF\ngit add notes.md && git commit -m notes");
  allowed("tee notes.md <<'EOF' > /dev/null\n## Needs the owner: $0\nEOF");
  // A verdict written to a file and then posted with --file: `node` after it is no data command, so the body is
  // scanned (#140 review), but an ordinary verdict whose summary mentions the owner and a $ holds nothing that reads
  // as a post-review invocation, so it still gets no decision (round-2 follow-up).
  allowed(
    "cat > .lanes/verdicts/test-hunter.json <<'EOF'\n" +
      '{ "reviewer": "test-hunter", "verdict": "success", "summary": "the owner pays $0, no findings" }\n' +
      "EOF\nnode scripts/lanes/post-review.mjs --file .lanes/verdicts/test-hunter.json",
  );
});

// Found by the #140 security-reviewer (round 2): origin/main denied these, and a heredoc inside a process
// substitution is run by the command around it, whatever reads it inside.
test("edge: a heredoc inside a process substitution is a script (#140 review)", () => {
  const body = "\nnode scripts/lanes/post-review.mjs owner --pr 16\nEOF\n)";
  for (const run of ["bash <(", "bash < <(", "sh <(", "source <(", ". <(", "bash <( true; "]) denied(`${run}cat <<'EOF'${body}`);
  // Round 3: every separator inside the substitution keeps the mark, pipes and || included.
  for (const sep of ["|", "||", "&&", "|&", "&"]) denied(`bash <(true ${sep} cat <<'EOF'${body}`);
  // The segments after the substitution closes are outside it again.
  allowed("diff <(sort a.txt) b.txt; cat > notes.md <<'EOF'\n$ npm test\nEOF");
});

test("edge: assignment words are only the leading ones and export's; the rest are arguments (#152)", () => {
  allowed('git commit -m "a=$A; b=$B"');
  allowed("make X=$Y all");
  // export, local, declare and readonly still assign.
  denied("export S=scripts/lanes/post-review.mjs; node $S owner --pr 16");
  denied("local S=scripts/lanes/post-review.mjs; node $S owner --pr 16");
  denied("declare -x S=scripts/lanes/post-review.mjs; node $S owner --pr 16");
  // env's NAME=value is no shell assignment, so $S stays unresolved in node's script position: still denied.
  denied("env S=scripts/lanes/post-review.mjs node $S owner --pr 16");
  // A NAME=value argument that is a script of its own, or holds a substitution, is still scanned.
  denied('env FOO="x; node $S owner" true');
  denied("echo x=$(node scripts/lanes/post-review.mjs owner --pr 16)");
});

test("edge: an awk, sed or jq program is scanned only when it names post-review, or when its output is run (#148)", () => {
  allowed("sed -n '/^```$/,/^$/p; s/`x`/$y/' in.md");
  allowed("jq -r '.[] | \"\\(.a) $\\(.b) `c`\"' in.json");
  allowed("awk '{ print $1; x = `y` }' in.txt | head -5");
  denied("awk 'BEGIN { system(\"node scripts/lanes/post-review.mjs owner --pr 16\") }'");
  denied("awk 'BEGIN { print \"x; node $S owner\" }' | sh");
});

test("edge: only a part that names post-review and cannot be parsed gets the parse reason (#100)", () => {
  allowed('echo "oops');
  const nested = decidePreToolUse(bash(`bash -c 'node scripts/lanes/post-review.mjs owner "x --pr 16'`), grant(), NOW);
  assert.deepEqual(nested, { decision: "deny", reason: UNPARSED_REASON });
  assert.match(UNPARSED_REASON, /could not be parsed/);
  assert.ok(UNPARSED_REASON.endsWith(DENY_REASON));
  // A parseable owner command keeps the ordinary reason.
  assert.deepEqual(decidePreToolUse(bash(OWNER), null, NOW), { decision: "deny", reason: DENY_REASON });
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

// --- #142: escaped and quoted brace characters, nested braces (#167) ----------------------------------------------

test("a backslash-escaped close brace inside a brace alternative does not end the group (#142 reproduction)", () => {
  denied("node scripts/lanes/{post-review.mjs,a\\}b} owner --pr 16");
});

test("escaped or quoted brace characters parse as bash parses them (#142)", () => {
  // An escaped `{`, `}` or `,` neither opens, ends nor splits the group; the other alternative still expands.
  denied("node scripts/lanes/{post-review.mjs,a\\{b} owner --pr 16");
  denied("node scripts/lanes/{x\\},post-review.mjs} owner --pr 16");
  denied("node scripts/lanes/{a\\,b,post-review.mjs} owner --pr 16");
  denied('node scripts/lanes/{post-review.mjs,"a}b"} owner --pr 16');
  denied("node scripts/lanes/{post-review.mjs,'a,}'} owner --pr 16");
  // An escaped comma leaves one alternative, and an escaped open brace opens nothing: the brace is literal text
  // with the backslash dropped, so the word is {post-review.mjs,x}, not post-review.mjs.
  allowed("node scripts/lanes/{post-review.mjs\\,x} owner --pr 16");
  allowed("node scripts/lanes/{post-review.mjs','x} owner --pr 16");
  allowed("node scripts/lanes/\\{post-review.mjs,x} owner --pr 16");
  allowed("node scripts/lanes/{post-review.mjs,x\\} owner --pr 16");
});

test("a nested brace before a slash-carrying alternative that spells the owner script path is an owner command (#167)", () => {
  denied("node {{a,b},scripts/lanes/post-review.mjs} owner --pr 16");
  denied("node scripts/{{a,b},lanes/post-review.mjs} owner --pr 16");
  denied("node {x,{a,scripts/lanes/post-review.mjs}} owner --pr 16");
  // The same shapes naming another script are ordinary arguments.
  allowed("node scripts/{{a,b},lanes/gate.mjs} 16");
  allowed("node {{a,b},scripts/lanes/gate.mjs} 16");
});

test("edge: brace words that expand to very many alternatives fail closed in the script position (#142)", () => {
  denied(`node ${"{a,b}".repeat(14)}x owner --pr 16`);
  // A long integer sequence is no match for the name, however long.
  allowed("node scripts/lanes/post-review.mj{1..99999999} owner --pr 16");
});

// --- #193: a quoted heredoc written to a file that a later command runs ----------------------------------------------

test("a quoted heredoc written by tee or cat to a file a later command runs is denied (#193, fixed by #140's review)", () => {
  denied("tee script.sh <<'EOF'\nnode scripts/lanes/post-review.mjs owner --pr 16\nEOF\nbash script.sh");
  denied("cat > script.sh <<'EOF'\nnode scripts/lanes/post-review.mjs owner --pr 16\nEOF\nbash script.sh");
  // The non-heredoc form was never an exception: echo's argument text is scanned whatever reads it.
  denied('echo "node scripts/lanes/post-review.mjs owner --pr 16" > script.sh; bash script.sh');
});

test("post-review.mjs itself refuses the owner post a written script would make, without a fresh grant (#193, #81)", async () => {
  const { main } = await import("./post-review.mjs");
  withDir((dir) => {
    const calls = [];
    const run = (...args) => {
      calls.push(args);
      throw new Error("gh must not be called without a grant");
    };
    assert.throws(() => main(["owner", "success", "x", "--pr", "16"], { run, log: () => {}, warn: () => {}, grantDir: dir, now: NOW }), /no fresh \/approve 16 grant/);
    assert.deepEqual(calls, []);
  });
});

// --- #119: powershell, pwsh, cmd and fish run a string as a command too --------------------------------------------

const encoded = (text) => Buffer.from(text, "utf16le").toString("base64");

test("the owner command run by powershell, pwsh, cmd or fish is denied (#119)", () => {
  for (const cmd of [
    'powershell.exe -Command "node scripts/lanes/post-review.mjs owner --pr 16"',
    "powershell -NoProfile node scripts/lanes/post-review.mjs owner --pr 16",
    "pwsh -c 'node scripts/lanes/post-review.mjs owner --pr 16'",
    "pwsh.exe -NoLogo -Command node scripts/lanes/post-review.mjs owner --pr 16",
    'cmd.exe /c "node scripts/lanes/post-review.mjs owner --pr 16"',
    "cmd //c node scripts/lanes/post-review.mjs owner --pr 16",
    "fish -c 'node scripts/lanes/post-review.mjs owner --pr 16'",
    "fish --command='node scripts/lanes/post-review.mjs owner --pr 16'",
  ]) denied(cmd);
});

test("a spliced or substituted script or reviewer word run by powershell, pwsh, cmd or fish is denied (#119)", () => {
  for (const cmd of [
    // powershell / pwsh: variables, concatenation, the backtick escape, an encoded command
    "powershell.exe -Command '$s=\"post-re\"+\"view.mjs\"; node scripts/lanes/$s owner --pr 16'",
    "pwsh -c 'node scripts/lanes/post-re`view.mjs owner --pr 16'",
    "pwsh -c 'node scripts/lanes/post-review.mjs (\"ow\"+\"ner\") --pr 16'",
    `powershell -EncodedCommand ${encoded("node scripts/lanes/post-review.mjs owner --pr 16")}`,
    `pwsh -e ${encoded("node scripts/lanes/post-review.mjs owner --pr 16")}`,
    // cmd: %VAR% and delayed !VAR! expansion, the ^ escape
    'cmd.exe /c "set S=scripts/lanes/post-review.mjs&& node %S% owner --pr 16"',
    'cmd /v:on /c "node scripts/lanes/post-review.mjs !R! --pr 16"',
    "cmd //c node scripts/lanes/post-rev^iew.mjs owner --pr 16",
    "cmd.exe /c node scripts/lanes/post-review.mjs %R% --pr 16",
    // fish: command substitution with ( ), variables
    "fish -c 'node scripts/lanes/post-(echo review).mjs owner --pr 16'",
    "fish -c 'node scripts/lanes/post-review.mjs (echo owner) --pr 16'",
    "fish -c 'set s post-review.mjs; node scripts/lanes/$s owner --pr 16'",
  ]) denied(cmd);
});

test("ordinary powershell, pwsh, cmd and fish commands get no decision (#119)", () => {
  for (const cmd of [
    "pwsh -c Get-ChildItem",
    "powershell -NoProfile -Command Get-Date",
    "cmd //c dir",
    "cmd.exe /c echo hello",
    "fish -c 'ls -la'",
    `powershell -EncodedCommand ${encoded("Get-Date")}`,
  ]) allowed(cmd);
});

// --- owner session, 2026-09-28: a regex literal in quoted interpreter code is no shell glob ------------------------

test("a regex literal inside quoted node -e code is not a post-review run, while a real glob still counts", () => {
  allowed('node -e "s.match(/a\\n([^\\n]*)/)"');
  allowed("node -e '/([^x]*)/.test(s)'");
  allowed("node -e \"console.log('post-*.mjs'.length)\"");
  denied("node scripts/lanes/post-rev*.mjs owner --pr 16");
  denied("bash -c 'node scripts/lanes/post-rev*.mjs owner --pr 16'");
});

// --- #219: backticks and $ made literal by quoting ------------------------------------------------------------------

test("#219 goal: echo '`x` foo' is allowed (single-quoted: bash runs nothing)", () => allowed("echo '`x` foo'"));
test('#219 goal: echo "\\`x\\` foo" is allowed (escaped: bash runs nothing)', () => allowed('echo "\\`x\\` foo"'));
test('#219 goal: gh issue comment 1 --body "\\`a.mjs\\` is fine" is allowed', () => allowed('gh issue comment 1 --body "\\`a.mjs\\` is fine"'));
test('#219 goal: gh issue comment 1 --body "see \\`a.mjs\\` here" is allowed', () => allowed('gh issue comment 1 --body "see \\`a.mjs\\` here"'));
test("#219 goal: grep -n '` x' file.mjs is allowed", () => allowed("grep -n '` x' file.mjs"));

test("a quoted $ or backtick still counts where the command runs its arguments as shell text (#219)", () => {
  denied("bash -c '`echo node` scripts/lanes/post-review.mjs owner --pr 1'");
  denied("bash -c 'node scripts/lanes/post-review.mjs `echo owner` --pr 1'");
  denied("sh -c 'node $S owner --pr 1'");
  denied("eval 'node scripts/lanes/post-$X.mjs owner --pr 1'");
  denied('eval "node scripts/lanes/post-review.mjs owner --pr 1"');
  denied("sudo bash -c 'node $S owner --pr 1'");
  denied("xargs sh -c 'node $S owner --pr 1'");
  denied("echo 'node $S owner --pr 1' | bash");
  denied("echo 'node $S owner --pr 1' > s.sh; bash s.sh");
  denied("A='node $S owner --pr 1'; eval \"$A\"");
  denied('echo "$(node scripts/lanes/post-review.mjs owner --pr 1)"');
  denied('echo "`node scripts/lanes/post-review.mjs owner --pr 1`"');
});

test("edge: quoting found while implementing #142/#219 reads as bash reads it", () => {
  // A "${NAME}" reference inside double quotes still resolves, braces and all.
  denied('S=scripts/lanes/post-review.mjs; node "${S}" owner --pr 16');
  denied('S=post-review; node "scripts/lanes/${S}.mjs" owner --pr 16');
  // An empty alternative still expands: post-review.mjs{,} is post-review.mjs twice.
  denied("node scripts/lanes/post-review.mjs{,} owner --pr 16");
  // A character sequence across Z..a holds `[` and a backtick; they are plain text, not a glob or a substitution.
  denied("node scripts/lanes/post-revie{Z..w}.mjs owner --pr 16");
  // A single-quoted $ or glob in node's script position is a literal file name bash never expands.
  allowed("node '$S' owner --pr 16");
  allowed("node 'scripts/lanes/post-rev*.mjs' owner --pr 16");
  // What echo prints into a shell is read afresh: the quoted reviewer word comes alive there.
  denied("echo node scripts/lanes/post-review.mjs '$R' --pr 16 | bash");
  // Wrappers that hand their arguments to a shell as text.
  for (const w of ["watch", "ssh localhost", "su -c", "sudo -s", "sudo -i", "flock /tmp/l -c", "script -q -c"]) denied(`${w} 'node $S owner --pr 16'`);
  allowed("sudo -u node node scripts/lanes/gate.mjs '$x y'");
  // A -EncodedCommand value that is no base64 is read as it stands.
  allowed("pwsh -EncodedCommand not_base64");
  // A raw private-use character (the guard's own stand-in for a quoted one) cannot be parsed: fail closed on the name.
  assert.equal(decidePreToolUse(bash("node scripts/lanes/post-review.mjs owner --pr 16 X"), grant(), NOW).decision, "deny");
  allowed("echo ");
  denied("pwsh -ec 'node $S owner --pr 16'");
});

test("edge: literal backticks and $ in data arguments are allowed; live ones in double quotes are still scanned (#219)", () => {
  allowed("git commit -m 'fix `x` in $HOME handling'");
  allowed("gh pr comment 1 --body '`$x` is `y`'");
  allowed("echo \\`x\\` foo");
  allowed("printf '%s\\n' '`a` $b'");
  denied('echo "`node scripts/lanes/post-review.mjs owner --pr 1` x"');
});
