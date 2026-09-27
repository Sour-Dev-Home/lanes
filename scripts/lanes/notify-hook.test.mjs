import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { laneIssue, notification, deliveryCommand, lookupPr, runHook } from "./notify-hook.mjs";

const LANE = "/home/o/repo/.claude/worktrees/issue-37-notify-hook";
const WIN_LANE = "C:\\Users\\o\\repo\\.claude\\worktrees\\issue-37-notify-hook";
const SID = "abcdef12-3456-7890-abcd-ef1234567890";
const input = (over = {}) => ({ session_id: SID, cwd: LANE, hook_event_name: "Notification", ...over });

// --- criterion 2: which cwd is a lane worktree ---

test("laneIssue reads the issue number from a lane worktree, with either separator", () => {
  assert.equal(laneIssue(LANE), 37);
  assert.equal(laneIssue(WIN_LANE), 37);
  assert.equal(laneIssue(`${LANE}/scripts/lanes`), 37);
});

test("a cwd that is not a lane worktree gives null", () => {
  assert.equal(notification(input({ cwd: "/home/o/repo", notification_type: "permission_prompt" })), null);
  assert.equal(notification(input({ cwd: "/home/o/repo/.claude/worktrees/feature-x", notification_type: "permission_prompt" })), null);
  assert.equal(notification(input({ cwd: "/home/o/issue-37-x", notification_type: "permission_prompt" })), null);
});

// edge: no digits, a zero and a non-string cwd are not lanes
test("edge: malformed lane directories and a missing cwd give null", () => {
  assert.equal(laneIssue("/r/.claude/worktrees/issue--x"), null);
  assert.equal(laneIssue("/r/.claude/worktrees/issue-0-x"), null);
  assert.equal(laneIssue("/r/.claude/worktrees/issue-12"), null);
  assert.equal(laneIssue(undefined), null);
  assert.equal(notification(input({ cwd: undefined, notification_type: "permission_prompt" })), null);
  assert.equal(notification(null), null);
});

// --- criterion 3: the body ---

test("a lane permission prompt names the issue, the type and `claude attach` with the short session id", () => {
  const n = notification(input({ notification_type: "permission_prompt" }));
  assert.equal(n.body, "lanes #37: waiting on a permission prompt — claude attach abcdef12");
  assert.ok(n.title.length > 0);
});

test("a lane needing input (agent_needs_input or elicitation_dialog) says so", () => {
  assert.equal(notification(input({ notification_type: "agent_needs_input" })).body, "lanes #37: needs input — claude attach abcdef12");
  assert.equal(notification(input({ notification_type: "elicitation_dialog" })).body, "lanes #37: needs input — claude attach abcdef12");
});

test("the harness's message replaces the generic text when present", () => {
  const n = notification(input({ notification_type: "permission_prompt", message: "Claude needs your permission to use Bash" }));
  assert.equal(n.body, "lanes #37: Claude needs your permission to use Bash — claude attach abcdef12");
});

test("missing message, type and session id fall back to the generic text", () => {
  assert.equal(notification(input({ notification_type: "permission_prompt", message: undefined })).body, "lanes #37: waiting on a permission prompt — claude attach abcdef12");
  assert.equal(notification(input({ notification_type: undefined })).body, "lanes #37: needs input — claude attach abcdef12");
  assert.equal(notification(input({ notification_type: "permission_prompt", session_id: undefined })).body, "lanes #37: waiting on a permission prompt");
});

test("an overlong message is truncated so the body stays under 200 characters", () => {
  const n = notification(input({ notification_type: "permission_prompt", message: "x".repeat(500) }));
  assert.ok(n.body.length < 200, `${n.body.length}`);
  assert.match(n.body, /^lanes #37: x+… — claude attach abcdef12$/);
});

// edge: exactly-at-the-limit, blank and whitespace-laden messages
test("edge: a message that just fits is kept whole; one character more is truncated", () => {
  const room = 199 - "lanes #37: ".length - " — claude attach abcdef12".length;
  assert.equal(notification(input({ message: "y".repeat(room) })).body.length, 199);
  assert.match(notification(input({ message: "y".repeat(room) })).body, /y — claude/);
  const over = notification(input({ message: "y".repeat(room + 1) })).body;
  assert.equal(over.length, 199);
  assert.match(over, /y… — claude/);
});

test("edge: a blank message falls back; newlines and control characters collapse to single spaces", () => {
  assert.equal(notification(input({ notification_type: "permission_prompt", message: "   " })).body, "lanes #37: waiting on a permission prompt — claude attach abcdef12");
  assert.equal(notification(input({ message: "a\n\nb\u0007\tc" })).body, "lanes #37: a b c — claude attach abcdef12");
  assert.equal(notification(input({ message: 42 })).body, "lanes #37: needs input — claude attach abcdef12");
});

test("edge: a session id with unexpected characters is not echoed", () => {
  assert.equal(notification(input({ session_id: "$(rm -rf x)" })).body, "lanes #37: needs input");
  assert.equal(notification(input({ session_id: "" })).body, "lanes #37: needs input");
});

// --- criterion 4: nothing but the issue number, type, short id and the harness's message ---

test("the notification carries no path, transcript or tool input from the hook input", () => {
  const n = notification(input({ notification_type: "permission_prompt", transcript_path: "/home/o/.claude/secret.jsonl", tool_input: { command: "cat .env" } }));
  const text = `${n.title}\n${n.body}`;
  assert.doesNotMatch(text, /home|worktrees|secret|\.env|notify-hook|abcdef12-/);
});

// --- criterion 5 and 7: delivery through execFileSync with no shell, text only in env ---

test("delivery: Windows uses powershell with a WinRT toast, macOS osascript, Linux notify-send", () => {
  const win = deliveryCommand("win32");
  assert.equal(win.file, "powershell.exe");
  assert.deepEqual(win.args.slice(0, 2), ["-NoProfile", "-NonInteractive"]);
  const script = Buffer.from(win.args[win.args.indexOf("-EncodedCommand") + 1], "base64").toString("utf16le");
  assert.match(script, /Windows\.UI\.Notifications\.ToastNotificationManager/);
  assert.match(script, /\$env:LANES_NOTIFY_BODY/);
  assert.equal(deliveryCommand("darwin").file, "osascript");
  assert.match(deliveryCommand("darwin").args.join(" "), /system attribute "LANES_NOTIFY_BODY"/);
  assert.equal(deliveryCommand("linux").file, "notify-send");
});

test("delivery arguments hold no notification text; it travels in the environment", () => {
  const n = { title: "lanes: issue #37", body: "lanes #37: needs input — claude attach abcdef12" };
  for (const platform of ["win32", "darwin"]) {
    const d = deliveryCommand(platform, n);
    const args = d.args.join("\n");
    const decoded = d.args.map((a) => Buffer.from(a, "base64").toString("utf16le")).join("\n");
    for (const needle of ["needs input", "abcdef12", "issue #37"]) {
      assert.ok(!args.includes(needle) && !decoded.includes(needle), `${platform}: ${needle}`);
    }
    assert.equal(d.env.LANES_NOTIFY_TITLE, n.title);
    assert.equal(d.env.LANES_NOTIFY_BODY, n.body);
  }
});

// notify-send cannot read its text from the environment, so on Linux the text is two whole argv entries after `--`:
// never spliced into a script or command string, and never read as an option.
test("Linux: the text is only the last two discrete arguments, after `--`", () => {
  const n = { title: "-u critical", body: "lanes #37: $(x) `y` needs input" };
  const d = deliveryCommand("linux", n);
  assert.deepEqual(d.args.slice(-3), ["--", n.title, n.body]);
  assert.ok(!d.args.slice(0, -2).some((a) => a.includes("needs input") || a.includes("critical")));
});

test("an unknown platform has no delivery command", () => {
  assert.throws(() => deliveryCommand("aix"), /aix/);
});

test("runHook delivers through execFileSync with no shell option", () => {
  const calls = [];
  runHook(JSON.stringify(input({ notification_type: "permission_prompt" })), { platform: "linux", exec: (file, args, opts) => calls.push({ file, args, opts }), log: () => {} });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "notify-send");
  assert.ok(!calls[0].opts.shell);
  assert.equal(calls[0].opts.env.LANES_NOTIFY_BODY, "lanes #37: waiting on a permission prompt — claude attach abcdef12");
});

test("runHook stays silent outside a lane", () => {
  const calls = [];
  runHook(JSON.stringify(input({ cwd: "/home/o/repo", notification_type: "permission_prompt" })), { platform: "linux", exec: (...a) => calls.push(a), log: (l) => calls.push(l) });
  assert.equal(calls.length, 0);
});

// --- criterion 6: every error exits 0, prints nothing and logs one line ---

const script = fileURLToPath(new URL("./notify-hook.mjs", import.meta.url));

test("malformed stdin exits 0 with nothing on stdout and logs one line", () => {
  const dir = mkdtempSync(join(tmpdir(), "notify-hook-"));
  const out = execFileSync(process.execPath, [script], { input: "{not json", encoding: "utf8", env: { ...process.env, LANES_NOTIFY_LOG_DIR: dir } });
  assert.equal(out, "");
  const log = readFileSync(join(dir, "notify-hook.log"), "utf8");
  assert.equal(log.trim().split("\n").length, 1);
});

test("an unknown platform and a failed notifier each log one line and do not throw", () => {
  const lines = [];
  const log = (l) => lines.push(l);
  runHook(JSON.stringify(input()), { platform: "aix", exec: () => {}, log });
  runHook(JSON.stringify(input()), { platform: "linux", exec: () => { throw new Error("notify-send: not found"); }, log });
  runHook("", { platform: "linux", exec: () => {}, log });
  assert.equal(lines.length, 3);
  for (const l of lines) assert.doesNotMatch(l, /\n/);
});

// edge: Node's error messages quote the failed command line (on Linux, the notification text) and bad JSON input,
// so a log line keeps only a fixed stage name, the error code and the exit status
test("edge: a log line never repeats stdin, the notifier's command line or its stderr", () => {
  const lines = [];
  const log = (l) => lines.push(l);
  runHook('{"cwd": "SECRET-STDIN', { platform: "linux", exec: () => {}, log });
  const failed = Object.assign(new Error("Command failed: notify-send -- lanes SECRET-BODY\nSECRET-STDERR"), { status: 1 });
  runHook(JSON.stringify(input({ message: "SECRET-BODY" })), { platform: "linux", exec: () => { throw failed; }, log });
  const missing = Object.assign(new Error("spawnSync notify-send ENOENT"), { code: "ENOENT" });
  runHook(JSON.stringify(input()), { platform: "linux", exec: () => { throw missing; }, log });
  assert.equal(lines.length, 3);
  for (const l of lines) assert.doesNotMatch(l, /SECRET|notify-send|Command failed/);
  assert.match(lines[0], /reading hook input/);
  assert.match(lines[1], /notifier failed.*exit 1/);
  assert.match(lines[2], /notifier failed.*ENOENT/);
});

test("the log lives in .lanes/, which git ignores", () => {
  assert.match(readFileSync(".gitignore", "utf8"), /^\.lanes\/$/m);
  assert.match(readFileSync(script, "utf8"), /\.lanes\//);
});

// edge: a non-object JSON value on stdin
test("edge: JSON that is not an object is ignored quietly", () => {
  const lines = [];
  for (const raw of ["null", "42", "[]", '"x"']) runHook(raw, { platform: "linux", exec: () => lines.push("sent"), log: (l) => lines.push(l) });
  assert.ok(!lines.includes("sent"));
});

// --- criteria 8, 9 and 11: agent_completed reads the lane's PR ---

const done = (over = {}) => input({ notification_type: "agent_completed", ...over });
const openPr = (rollup, gate) => ({ pr: { number: 52, state: "OPEN", statusCheckRollup: rollup }, gate });
const OK = [{ name: "verify", conclusion: "SUCCESS" }];

test("agent_completed: a PR waiting on the owner notifies `waiting on /approve: <reason>`", () => {
  const n = notification(done(), openPr(OK, { state: "pending", description: "waiting on owner (/approve) (touches a contract file)" }));
  assert.equal(n.body, "lanes #52: waiting on /approve: touches a contract file");
});

test("agent_completed: a failed check notifies `failing: <check>`", () => {
  const n = notification(done(), openPr([{ name: "verify", conclusion: "FAILURE" }, { context: "security", state: "ERROR" }], { state: "pending", description: "waiting for review/test-hunter" }));
  assert.equal(n.body, "lanes #52: failing: verify, security");
  const gateFailed = notification(done(), openPr(OK, { state: "failure", description: "PR body lacks Closes #N" }));
  assert.equal(gateFailed.body, "lanes #52: failing: lanes/gate");
});

// extra: a failing check takes priority over an owner-wait reason when both are present on the same PR
test("agent_completed: a failing check outranks a simultaneous owner-wait reason", () => {
  const n = notification(
    done(),
    openPr([{ name: "verify", conclusion: "FAILURE" }], { state: "pending", description: "waiting on owner (/approve) (touches a contract file)" }),
  );
  assert.equal(n.body, "lanes #52: failing: verify");
});

test("agent_completed: queued, merged and unattended-eligible PRs stay silent", () => {
  assert.equal(notification(done(), openPr(OK, { state: "success", description: "approved by owner" })), null);
  assert.equal(notification(done(), openPr(OK, { state: "success", description: "unattended-eligible (tier:quick), reviews in" })), null);
  assert.equal(notification(done(), { pr: { number: 52, state: "MERGED", statusCheckRollup: [] }, gate: null }), null);
});

test("agent_completed: a lane with no PR stays silent", () => {
  assert.equal(notification(done(), { pr: null, gate: null }), null);
});

test("agent_completed: a gh error falls back to `lane finished, check /status`", () => {
  assert.equal(notification(done(), { error: true }).body, "lanes #37: lane finished, check /status");
  assert.equal(notification(done()).body, "lanes #37: lane finished, check /status");
});

// edge: a waiting-on-owner description without the reason parentheses, an empty rollup, a closed PR
test("edge: odd gate descriptions and PR states", () => {
  assert.equal(notification(done(), openPr([], { state: "pending", description: "waiting on owner (/approve)" })).body, "lanes #52: waiting on /approve: see #52");
  assert.equal(notification(done(), openPr(undefined, { state: "pending", description: "waiting for review/test-hunter" })), null);
  assert.equal(notification(done(), openPr(OK, null)), null);
  assert.equal(notification(done(), { pr: { number: 52, state: "CLOSED" }, gate: null }), null);
  const long = notification(done(), openPr(OK, { state: "pending", description: `waiting on owner (/approve) (${"r".repeat(300)})` }));
  assert.ok(long.body.length < 200);
});

// --- criterion 9: gh failing or slow ---

test("lookupPr asks gh for the lane's PR by branch, then the gate status on its head", () => {
  const calls = [];
  const exec = (file, args, opts) => {
    calls.push({ file, args, opts });
    if (file === "git") return "issue-37-notify-hook\n";
    if (args[0] === "pr") return JSON.stringify([{ number: 52, state: "OPEN", headRefOid: "4802947aaa259b8a6aea1ec1da8071f4729a7da0", statusCheckRollup: OK }]);
    return JSON.stringify({ statuses: [{ context: "review/test-hunter", state: "success" }, { context: "lanes/gate", state: "pending", description: "waiting on owner (/approve) (x)" }] });
  };
  const r = lookupPr(LANE, exec, Date.now());
  assert.equal(r.pr.number, 52);
  assert.equal(r.gate.description, "waiting on owner (/approve) (x)");
  const prCall = calls.find((c) => c.args[0] === "pr");
  assert.deepEqual(prCall.args.slice(0, 4), ["pr", "list", "--head", "issue-37-notify-hook"]);
  assert.equal(prCall.opts.cwd, LANE);
  assert.equal(calls.at(-1).args[1], "repos/{owner}/{repo}/commits/4802947aaa259b8a6aea1ec1da8071f4729a7da0/status");
  for (const c of calls) {
    assert.ok(c.opts.timeout > 0 && c.opts.timeout <= 5000, `${c.file} timeout ${c.opts.timeout}`);
    assert.ok(!c.opts.shell);
  }
});

// edge: a head that is not a sha must not reach the API path
test("edge: lookupPr refuses a PR head that is not a commit sha", () => {
  const exec = (file, args) => (file === "git" ? "b\n" : JSON.stringify([{ number: 52, state: "OPEN", headRefOid: "../../x" }]));
  assert.throws(() => lookupPr(LANE, exec, Date.now()), /sha/);
});

test("lookupPr: no PR means no gate lookup; git failing falls back to the directory name", () => {
  const calls = [];
  const exec = (file, args) => {
    calls.push(file);
    if (file === "git") throw new Error("not a repo");
    return "[]";
  };
  assert.deepEqual(lookupPr(LANE, exec, Date.now()), { pr: null, gate: null });
  assert.deepEqual(calls, ["git", "gh"]);
});

test("runHook: gh failing or timing out on agent_completed sends the fallback", () => {
  for (const error of [new Error("gh: not logged in"), Object.assign(new Error("spawnSync gh ETIMEDOUT"), { code: "ETIMEDOUT" })]) {
    const sent = [];
    const exec = (file, args, opts) => {
      if (file === "gh") throw error;
      if (file === "git") return "issue-37-notify-hook\n";
      sent.push(opts.env.LANES_NOTIFY_BODY);
    };
    runHook(JSON.stringify(done()), { platform: "linux", exec, log: () => {} });
    assert.deepEqual(sent, ["lanes #37: lane finished, check /status"]);
  }
});

test("runHook: the 5-second budget is shared, so a slow first call leaves the next one out of time", () => {
  let t = 0;
  const sent = [];
  const exec = (file, args, opts) => {
    if (file === "git") { t += 6000; return "b\n"; }
    if (file === "gh") throw new Error("should not be called past the deadline");
    sent.push(opts.env.LANES_NOTIFY_BODY);
  };
  runHook(JSON.stringify(done()), { platform: "linux", exec, log: () => {}, now: () => t });
  assert.deepEqual(sent, ["lanes #37: lane finished, check /status"]);
});

test("the script never writes the log when nothing went wrong", () => {
  const dir = mkdtempSync(join(tmpdir(), "notify-hook-"));
  execFileSync(process.execPath, [script], { input: JSON.stringify(input({ cwd: "/home/o/repo" })), encoding: "utf8", env: { ...process.env, LANES_NOTIFY_LOG_DIR: dir } });
  assert.equal(existsSync(join(dir, "notify-hook.log")), false);
});
