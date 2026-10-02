// scripts/lanes/start.test.mjs
// start.mjs keeps what the queue and the token refresher use (ADR 0030): launchLane and its helpers, the team steps,
// the config readers and the refresher. `/start` is retired, so there is no `main`; the tests that used to reach a
// helper through it call launchLane (through `launchIssues` below) or the helper itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BUDGET_DEFAULTS, LAUNCH_REFUSAL, REFRESH_MS, START_DEFAULTS, appendStarts, classifySkip, startDecisions, budgetConfig, deadLaneSession, inFlightIssues, isEntryScript, launchArgs, isLaneGhDir, launchEnv, launchRefusal, makeRemint, markRunning, parseSessionId, refreshArgs, refreshLoop, startConfig as strictStartConfig, teamLaneEnv, teamLaneSettings, TEAM_SCRUBBED_NAMES, botCommitIdentity } from "./start.mjs";
import * as startModule from "./start.mjs";
import { TEAM_REQUIRED_MESSAGE, parseIssueForm } from "./lib.mjs";
import { issuePaths } from "./paths.mjs";
import { launchLane, resolveKeyFile, scopeNamesWorkflows, teamSteps } from "./start.mjs";

const START_FILE = fileURLToPath(new URL("./start.mjs", import.meta.url));
const SCRIPTS_DIR = fileURLToPath(new URL("./", import.meta.url));

// #612: the App key defaults to ~/.lanes/<slug>.pem; an explicit LANES_APP_KEY_FILE wins.
const BOT = { app: { botLogin: "my-lanes[bot]" } };
test("resolveKeyFile defaults to ~/.lanes/<slug>.pem with the slug from botLogin", () => {
  assert.equal(resolveKeyFile({ env: {}, identity: BOT, home: "/h" }), join("/h", ".lanes", "my-lanes.pem"));
});
test("resolveKeyFile: an explicit LANES_APP_KEY_FILE wins", () => {
  assert.equal(resolveKeyFile({ env: { LANES_APP_KEY_FILE: "/k.pem" }, identity: BOT, home: "/h" }), "/k.pem");
});
test("edge: resolveKeyFile with an empty override, no identity or no botLogin", () => {
  assert.equal(resolveKeyFile({ env: { LANES_APP_KEY_FILE: "" }, identity: BOT, home: "/h" }), join("/h", ".lanes", "my-lanes.pem"));
  assert.equal(resolveKeyFile({ env: {}, identity: undefined, home: "/h" }), undefined);
  assert.equal(resolveKeyFile({ env: {}, identity: { app: { id: 1 } }, home: "/h" }), undefined);
  assert.equal(resolveKeyFile({ env: {}, identity: { app: { botLogin: "[bot]" } }, home: "/h" }), undefined);
  for (const bad of ["../x[bot]", "a/b[bot]", "a\\b[bot]", "-x[bot]", "a b[bot]"]) assert.equal(resolveKeyFile({ env: {}, identity: { app: { botLogin: bad } }, home: "/h" }), undefined, bad);
});

// ADR 0030 parts 1 and 3: the one refusal, shared by the queue and this file's command line (#675).
test("launchRefusal: CLAUDECODE or CLAUDE_CODE_CHILD_SESSION refuses, each on its own", () => {
  assert.equal(LAUNCH_REFUSAL, "lanes are launched only by the owner's queue in their own terminal (ADR 0030)");
  assert.equal(launchRefusal({ CLAUDECODE: "1" }, "/repo/scripts/lanes/start.mjs"), LAUNCH_REFUSAL);
  assert.equal(launchRefusal({ CLAUDE_CODE_CHILD_SESSION: "1" }, "/repo/scripts/lanes/start.mjs"), LAUNCH_REFUSAL);
  assert.equal(launchRefusal({ CLAUDECODE: "1", CLAUDE_CODE_CHILD_SESSION: "1" }, undefined), LAUNCH_REFUSAL);
});

test("launchRefusal: a script under a .claude/worktrees directory refuses, by its own file and not the working directory", () => {
  for (const file of ["/repo/.claude/worktrees/issue-5-x/scripts/lanes/start.mjs", "C:\\repo\\.claude\\worktrees\\issue-5-x\\scripts\\lanes\\queue.mjs", "file:///repo/.claude/worktrees/issue-5-x/scripts/lanes/start.mjs", pathToFileURL("/a/.claude/worktrees/x/y.mjs").href]) {
    assert.equal(launchRefusal({}, file), LAUNCH_REFUSAL, file);
  }
  assert.equal(launchRefusal({}, "/repo/.Claude/Worktrees/issue-5-x/scripts/lanes/start.mjs"), LAUNCH_REFUSAL, "a re-cased path");
  // `process.cwd()` is never consulted: a plain checkout's script refuses nothing, wherever the shell stands.
  assert.equal(launchRefusal({}, "/repo/scripts/lanes/start.mjs"), null);
  assert.equal(launchRefusal({}, pathToFileURL("/repo/scripts/lanes/start.mjs").href), null);
});

test("edge: launchRefusal ignores look-alike directories and empty variables, and checks only the environment with no file", () => {
  for (const file of ["/repo/.claude/worktrees-old/x.mjs", "/repo/claude/worktrees/x.mjs", "/repo/x.claude/worktrees/y.mjs", "/repo/.claude/worktree/x.mjs"]) assert.equal(launchRefusal({}, file), null, file);
  assert.equal(launchRefusal({ CLAUDECODE: "", CLAUDE_CODE_CHILD_SESSION: "" }, "/repo/scripts/lanes/start.mjs"), null);
  assert.equal(launchRefusal({}, undefined), null);
});

// The command line: a Claude session or a copy under .claude/worktrees exits 2 before any work; a plain run of the
// refresher (the one thing the queue spawns) is untouched.
const cleanEnv = () => {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_CHILD_SESSION;
  return env;
};
const runStart = (file, args, env) => spawnSync(process.execPath, [file, ...args], { env, encoding: "utf8", timeout: 30_000 });

test("start.mjs at the command line exits 2 with the refusal inside a Claude session, for each variable", () => {
  for (const name of ["CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION"]) {
    for (const args of [[], ["--refresh-token"], ["12"], ["--auto", "--go"]]) {
      const r = runStart(START_FILE, args, { ...cleanEnv(), [name]: "1" });
      assert.equal(r.status, 2, `${name} ${args.join(" ")}`);
      assert.equal(r.stderr.trim(), LAUNCH_REFUSAL);
      assert.equal(r.stdout, "");
    }
  }
});

test("start.mjs at the command line exits 2 with the refusal from a copy under .claude/worktrees, and not from a plain checkout", () => {
  const dir = mkdtempSync(join(tmpdir(), "start-cli-"));
  try {
    const lane = join(dir, ".claude", "worktrees", "issue-9-x", "scripts", "lanes");
    const plain = join(dir, "repo", "scripts", "lanes");
    for (const target of [lane, plain]) {
      mkdirSync(target, { recursive: true });
      cpSync(SCRIPTS_DIR, target, { recursive: true, filter: (src) => !src.endsWith(".test.mjs") });
    }
    // The working directory is the plain checkout in both runs: only the script's own location decides.
    const refused = spawnSync(process.execPath, [join(lane, "start.mjs"), "--refresh-token"], { cwd: join(dir, "repo"), env: cleanEnv(), encoding: "utf8", timeout: 30_000 });
    assert.equal(refused.status, 2);
    assert.equal(refused.stderr.trim(), LAUNCH_REFUSAL);
    const ran = spawnSync(process.execPath, [join(plain, "start.mjs"), "--refresh-token"], { cwd: join(dir, "repo"), env: cleanEnv(), encoding: "utf8", timeout: 30_000 });
    assert.equal(ran.status, 2);
    assert.match(ran.stderr, /^usage: start\.mjs --refresh-token /, "the refresher ran and printed its own usage");
    assert.ok(!ran.stderr.includes(LAUNCH_REFUSAL));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// macOS's tmpdir (/var/folders) is a symlink to /private/var, and Node resolves import.meta.url through it while
// process.argv[1] keeps the path as typed: both entries compare real paths, so the CLI still runs.
test("isEntryScript compares real paths, and is false for no argv[1] or an unresolvable path", () => {
  assert.equal(isEntryScript(START_FILE, import.meta.resolve("./start.mjs")), true);
  assert.equal(isEntryScript(join(SCRIPTS_DIR, "queue.mjs"), import.meta.resolve("./start.mjs")), false);
  assert.equal(isEntryScript(undefined, import.meta.resolve("./start.mjs")), false);
  assert.equal(isEntryScript("", import.meta.resolve("./start.mjs")), false);
  assert.equal(isEntryScript(join(SCRIPTS_DIR, "no-such-file.mjs"), import.meta.resolve("./start.mjs")), false);
});

test("start.mjs and queue.mjs reach their command line when started through a symlinked directory", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "start-link-"));
  try {
    const real = join(dir, "real", "scripts", "lanes");
    mkdirSync(real, { recursive: true });
    cpSync(SCRIPTS_DIR, real, { recursive: true, filter: (src) => !src.endsWith(".test.mjs") });
    const link = join(dir, "link");
    try {
      symlinkSync(join(dir, "real"), link, "junction");
    } catch (err) {
      if (err.code === "EPERM" || err.code === "EACCES") return t.skip("cannot create a symlink here");
      throw err;
    }
    const env = { ...cleanEnv(), CLAUDECODE: "1" };
    for (const name of ["start.mjs", "queue.mjs"]) {
      const r = spawnSync(process.execPath, [join(link, "scripts", "lanes", name)], { env, encoding: "utf8", timeout: 30_000 });
      assert.equal(r.status, 2, `${name}: ${r.stdout}${r.stderr}`);
      assert.equal(`${r.stdout}${r.stderr}`.trim(), LAUNCH_REFUSAL, name);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("start.mjs has no /start entry: no main, no grant, no session helpers", () => {
  const src = readFileSync(START_FILE, "utf8");
  assert.equal("main" in startModule, false);
  assert.equal(existsSync(new URL("../../.claude/commands/start.md", import.meta.url)), false);
  assert.doesNotMatch(src, /start-guard|grantPath|grantRefusal|readGrant|grantDir|CLAUDE_CODE_SESSION_ID/);
});

const CAP = START_DEFAULTS.maxLanes;

// docs/USING.md tells the owner how many lanes run at once.
test("docs/USING.md says how many lanes to start", () => {
  const doc = readFileSync(new URL("../../docs/USING.md", import.meta.url), "utf8");
  assert.match(doc, new RegExp(`Start up to ${CAP} lanes`));
});

test("the default start.maxLanes is 8", () => assert.equal(CAP, 8));

test("inFlightIssues counts open issue-* PRs and background sessions in issue worktrees once per issue", () => {
  const prs = [{ headRefName: "issue-5-foo" }, { headRefName: "feature-x" }, { headRefName: "issue-6-bar" }];
  const sessions = [
    { kind: "background", cwd: "C:\\repo\\.claude\\worktrees\\issue-5-foo" },
    { kind: "background", cwd: "/repo/.claude/worktrees/issue-8-baz/src" },
    { kind: "interactive", cwd: "/repo/.claude/worktrees/issue-9-qux" },
    { kind: "background", cwd: "/repo/.claude/worktrees/not-issue-10-x" },
    { kind: "background", cwd: "/repo" },
  ];
  assert.deepEqual(inFlightIssues({ prs, sessions }), [5, 6, 8]);
  // #341: a lane named lane-<N> counts whatever cwd it reports; a session with neither name nor folder is ignored.
  const named = [{ kind: "background", name: "lane-338", cwd: "/repo" }, { kind: "background", name: "reactapps-dc", cwd: "/repo" }, { kind: "interactive", name: "lane-40", cwd: "/repo" }];
  assert.deepEqual(inFlightIssues({ prs: [], sessions: named }), [338]);
  assert.deepEqual(inFlightIssues({ prs: [], sessions: named, finished: [338] }), []);
  assert.deepEqual(inFlightIssues({ prs: [], sessions: [{ kind: "background", name: "lane-5", cwd: "/repo/.claude/worktrees/issue-6-x" }] }), [5]);
});

test("inFlightIssues ignores a leftover session whose issue is finished (PR merged or issue closed)", () => {
  const sessions = [
    { kind: "background", cwd: "/repo/.claude/worktrees/issue-20-cleanup" },
    { kind: "background", cwd: "/repo/.claude/worktrees/issue-21-live" },
  ];
  assert.deepEqual(inFlightIssues({ prs: [], sessions, finished: [20] }), [21]);
  // An open PR still counts: finished only drops sessions.
  assert.deepEqual(inFlightIssues({ prs: [{ headRefName: "issue-20-again" }], sessions, finished: [20] }), [20, 21]);
  assert.deepEqual(inFlightIssues({ prs: [], sessions }), [20, 21]);
});

// #134: a lane whose worktree folder is `issue-<N>` with no slug is still that issue's lane.
test("inFlightIssues maps a session in an issue-<N> or issue-<N>-<slug> folder to N, never a look-alike number", () => {
  const sessions = [
    { kind: "background", cwd: "C:\\repo\\.claude\\worktrees\\issue-104" },
    { kind: "background", cwd: "/repo/.claude/worktrees/issue-106/scripts/lanes" },
    { kind: "background", cwd: "/repo/.claude/worktrees/issue-7-slug" },
    { kind: "background", cwd: "/repo/.claude/worktrees/issue-5x" },
    { kind: "background", cwd: "/repo/.claude/worktrees/issue-5x-slug" },
    { kind: "background", cwd: "/repo/.claude/worktrees/issue-" },
    { kind: "background", cwd: "/repo/.claude/worktrees/issue-9-" },
    { kind: "background", cwd: "/repo/.claude/worktrees/issue-50" },
  ];
  // `issue-9-` (an empty slug) still counts: a false "in flight" only delays a launch, a miss runs two lanes.
  assert.deepEqual(inFlightIssues({ prs: [], sessions }), [7, 9, 50, 104, 106]);
});

test("edge: a session in a bare issue-60 folder does not put #6 in flight", () => {
  assert.deepEqual(inFlightIssues({ prs: [], sessions: [{ kind: "background", cwd: "/repo/.claude/worktrees/issue-60" }] }), [60]);
});

// #444: the queue resumes a lane whose session is gone or idle with no prompt pending; a busy or blocked one is alive.
test("deadLaneSession: no session, or an idle one that is not blocked, is dead; the newest session decides", () => {
  const live = { kind: "background", name: "lane-6", status: "busy", startedAt: 2 };
  const idle = { kind: "background", name: "lane-6", status: "idle", state: "done", startedAt: 3 };
  const blocked = { kind: "background", name: "lane-6", status: "idle", state: "blocked", startedAt: 4 };
  assert.deepEqual(deadLaneSession([], 6), { dead: true, session: null });
  assert.equal(deadLaneSession([live], 6).dead, false);
  assert.equal(deadLaneSession([live, idle], 6).dead, true);
  assert.equal(deadLaneSession([idle, blocked], 6).dead, false);
  assert.equal(deadLaneSession([{ ...idle, name: "lane-7" }], 6).dead, true, "another issue's session is not this lane's");
});

// Exact launch arguments.
// #195: every lane is named lane-<N>, so `claude agents` shows which issue a session works.
const NAMED = (n) => ["--bg", "--name", `lane-${n}`];

test("launch arguments are exactly --bg, --name lane-N and /lane N, with no permission flags", () => {
  assert.deepEqual(launchArgs(18), [...NAMED(18), "/lane 18"]);
});

// #153 criterion 2: --model <name> goes before /lane N when the tier has a model, and nothing is added otherwise.
// #195: --name lane-N sits next to it.
test("launch arguments add --model before /lane N for a tier with a model, per tier, next to --name lane-N", () => {
  const models = { skip: "haiku", quick: "sonnet", full: "opus" };
  for (const tier of ["skip", "quick", "full"]) {
    assert.deepEqual(launchArgs(18, { tier, models }), [...NAMED(18), "--model", models[tier], "/lane 18"], tier);
  }
});

test("launch arguments carry --name lane-N but no --model when the tier has none", () => {
  for (const tier of ["skip", "quick", "full"]) {
    assert.deepEqual(launchArgs(18, { tier, models: {} }), [...NAMED(18), "/lane 18"], tier);
    assert.deepEqual(launchArgs(18, { tier }), [...NAMED(18), "/lane 18"], tier);
  }
  assert.deepEqual(launchArgs(18, { tier: "full", models: { skip: "sonnet", quick: "sonnet" } }), [...NAMED(18), "/lane 18"]);
});

test("edge: launch arguments ignore an unknown or missing tier", () => {
  const models = { quick: "sonnet" };
  assert.deepEqual(launchArgs(18, { models }), [...NAMED(18), "/lane 18"]);
  assert.deepEqual(launchArgs(18, { tier: "toString", models }), [...NAMED(18), "/lane 18"]);
  assert.deepEqual(launchArgs(18, { tier: "__proto__", models }), [...NAMED(18), "/lane 18"]);
});

test("edge: each lane's name carries its own issue number, one word with no leading dash", () => {
  for (const n of [1, 7, 118, 999999999]) {
    const args = launchArgs(n, { tier: "quick", models: { quick: "sonnet" } });
    assert.equal(args[args.indexOf("--name") + 1], `lane-${n}`);
    assert.equal(args.filter((a) => a === "--name").length, 1);
  }
});

// Id parsing.
test("parseSessionId reads the id after 'backgrounded ·'", () => {
  assert.equal(parseSessionId("Started.\nbackgrounded · 81ddaf76\n"), "81ddaf76");
  assert.equal(parseSessionId("backgrounded · a1b2-c3"), "a1b2-c3");
});

test("parseSessionId strips ANSI colour codes before reading the id", () => {
  assert.equal(parseSessionId("\x1b[2mbackgrounded · \x1b[0m\x1b[1m81ddaf76\x1b[22m\n"), "81ddaf76");
  assert.equal(parseSessionId("\x1b[32mbackgrounded\x1b[39m \x1b[90m·\x1b[39m \x1b[36ma1b2-c3\x1b[39m"), "a1b2-c3");
});

test("edge: parseSessionId strips OSC hyperlinks and 256-colour codes, and still finds no id in colour alone", () => {
  assert.equal(parseSessionId("\x1b]8;;https://x\x07backgrounded · \x1b[38;5;208mdeadbeef\x1b[0m\x1b]8;;\x07"), "deadbeef");
  assert.equal(parseSessionId("\x1b[1mbackgrounded · \x1b[0m"), null);
});

test("parseSessionId returns null when no id is printed", () => {
  assert.equal(parseSessionId(""), null);
  assert.equal(parseSessionId("backgrounded · "), null);
  assert.equal(parseSessionId("error: not logged in"), null);
  assert.equal(parseSessionId(undefined), null);
});

// launchIssues: what `main` did for each requested issue once it had planned the launch, through launchLane, the one
// launcher the queue calls: read the issue, then launch it from the repository root with the config's models.
const form = ({ scope = "In: `a.mjs`.", blockedBy = "none", contract = "none" } = {}) =>
  ["### Goal", "g", "### Acceptance criteria", "- [ ] a", "### Interface contract", contract, "### Scope", scope, "### Blocked by", blockedBy, "### Tier", "quick"].join("\n\n");

const TEAM = { profile: "team", app: { id: 11, installationId: 22, botLogin: "sour-dev-lanes[bot]" } };
// ADR 0025: startConfig refuses a config with no team identity, so the tests of its other keys read one that has it;
// the refusal tests call strictStartConfig.
const startConfig = (raw) => strictStartConfig({ identity: TEAM, ...raw });

function launchIssues(numbers, deps) {
  let config;
  try {
    config = strictStartConfig(deps.config());
  } catch (err) {
    return { code: 2, lines: [`nothing launched: ${err.message}`] };
  }
  const root = deps.root();
  const { env, note: envNote } = deps.launchEnv ? deps.launchEnv() : { env: undefined, note: null };
  const lines = [];
  let failed = false;
  for (const n of numbers) {
    const view = JSON.parse(deps.gh(["issue", "view", String(n), "--json", "number,state,labels,body,assignees"]));
    const labels = view.labels.map((l) => l.name);
    const tier = labels.find((l) => l.startsWith("tier:"))?.slice("tier:".length);
    const scope = issuePaths(parseIssueForm(view.body ?? "").fields);
    const launched = launchLane(n, deps, { tier, models: config.models, labels, identity: config.identity, root, env, envNote, scope });
    lines.push(...launched.lines);
    if (launched.failed) failed = true;
  }
  return { code: failed ? 1 : 0, lines };
}
const main = launchIssues;

function fakes({ issues = {}, launchOut = {}, launchFail = [], config, spawnChild, labelFail = null, labelMissing = false, keepRefresher = false } = {}) {
  const launches = [];
  const labeled = [];
  let labelCreated = false;
  // Every reaper spawn and log open/close, in order; spawnChild(cmd, args, options) overrides the fake child.
  const reapers = [];
  const logs = [];
  // ADR 0025: every launch is a team launch, which also starts the token refresher. It is kept apart (`refreshers`), with
  // its log, so the reaper tests keep reading the reapers alone; `spawnChild` overrides the reaper's child only.
  const refreshers = [];
  const spawn = (cmd, args, options) => {
    if (args.includes("--refresh-token") && !keepRefresher) {
      logs.pop();
      const child = { pid: 4243, on() {}, unref() {} };
      refreshers.push({ cmd, args, options, child });
      return child;
    }
    const child = spawnChild ? spawnChild(cmd, args, options) : { pid: 4242, on() {}, unref() { this.unrefed = true; } };
    reapers.push({ cmd, args, options, child });
    return child;
  };
  const reaperLog = (root, n) => {
    const log = { root, n, fd: 100 + n, closed: false };
    logs.push(log);
    return { fd: log.fd, close: () => (log.closed = true) };
  };
  const view = (n) => {
    const i = issues[n];
    return { number: n, state: i.state ?? "OPEN", labels: (i.labels ?? ["ready", "tier:quick"]).map((name) => ({ name })), assignees: i.assignees ?? [], body: i.body ?? form() };
  };
  const gh = (args) => {
    if (args[0] === "issue" && args[1] === "view") {
      const n = Number(args[2]);
      if (!(n in issues)) throw new Error("gh: Could not resolve to an issue");
      return JSON.stringify(view(n));
    }
    // #361: the lane:running label; `labelFail` is the error text of a failing edit, `labelMissing` a repository without the label.
    if (args[0] === "issue" && args[1] === "edit") {
      if (labelFail) throw new Error(labelFail);
      if (labelMissing && !labelCreated) throw new Error("gh: 'lane:running' not found");
      labeled.push(Number(args[2]));
      return "";
    }
    if (args[0] === "label" && args[1] === "create") {
      labelCreated = true;
      return "";
    }
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
  const claude = (args, opts) => {
    // The team-only flags are left out of the recorded args (the team tests read them from their own wrapper).
    launches.push({ args: args.filter((a, i) => a !== "--strict-mcp-config" && a !== "--settings" && args[i - 1] !== "--settings"), cwd: opts?.cwd });
    const n = Number(args.at(-1).split(" ")[1]);
    if (launchFail.includes(n)) throw new Error("claude: spawn failed");
    return launchOut[n] ?? `backgrounded · id${n}`;
  };
  // ADR 0025: team is the only profile, so a config without an `identity` key gets the team identity, and every launch
  // runs through the faked team steps. A test of the refusal passes `identity` itself (even as undefined).
  const withIdentity = config === undefined ? { identity: TEAM } : "identity" in config ? config : { ...config, identity: TEAM };
  const team = {
    keyFile: () => "/keys/app.pem",
    readable: () => {},
    repo: () => "lanes",
    makeDir: (n) => ({ dir: `/tmp/lane-${n}`, emptyConfig: `/tmp/lane-${n}/empty` }),
    removeDir: () => {},
    writeSettings: () => {},
    mintInto: () => {},
    botUserId: () => "336249257",
  };
  return { deps: { gh, claude, root: () => "/repo", config: () => withIdentity, spawn, reaperLog, team }, launches, reapers, refreshers, logs, labeled };
}

// #164: one detached reaper per launched lane (ADR 0010).
const reapScript = join("/repo", "scripts", "lanes", "reap.mjs");

// #164 criterion 1: after a launch with a session id, reap.mjs is spawned detached, logging to its own log, and unref'd.
test("launchLane spawns one detached, unref'd reaper per launched lane, logging to the reaper's log", () => {
  const { deps, reapers, logs } = fakes({ issues: { 1: {}, 2: { body: form({ scope: "In: `b.mjs`." }) } } });
  const { code, lines } = main([1, 2], deps);
  assert.equal(code, 0);
  assert.deepEqual(lines, ["#1 → id1", "#2 → id2"]);
  assert.deepEqual(
    reapers.map((r) => [r.cmd, r.args]),
    [
      [process.execPath, [reapScript, "--issue", "1", "--session", "id1"]],
      [process.execPath, [reapScript, "--issue", "2", "--session", "id2"]],
    ],
  );
  for (const [i, r] of reapers.entries()) {
    assert.equal(r.options.detached, true);
    assert.equal(r.options.cwd, "/repo");
    assert.deepEqual(r.options.stdio, ["ignore", logs[i].fd, logs[i].fd]);
    assert.equal(r.child.unrefed, true);
  }
  assert.deepEqual(logs.map((l) => [l.root, l.n, l.closed]), [["/repo", 1, true], ["/repo", 2, true]]);
});

// #164 criterion 1 and 4: a launch with no session id (or a failed launch) spawns no reaper.
test("launchLane spawns no reaper for a launch that printed no session id or failed", () => {
  const { deps, reapers, logs } = fakes({ issues: { 1: {}, 2: { body: form({ scope: "In: `b.mjs`." }) }, 3: { body: form({ scope: "In: `c.mjs`." }) } }, launchOut: { 1: "something went wrong" }, launchFail: [2] });
  const { code } = main([1, 2, 3], deps);
  assert.equal(code, 1);
  assert.deepEqual(reapers.map((r) => r.args[2]), ["3"]);
  assert.equal(logs.length, 1);
});

// A failed launch interleaved between two successful ones must not shift which issue or session id a reaper is
// attributed to (unlike the run above, where every failure comes first).
test("edge: a failed launch between two successes does not misattribute either reaper's issue or session id", () => {
  const { deps, reapers, logs } = fakes({
    issues: { 1: {}, 2: { body: form({ scope: "In: `b.mjs`." }) }, 3: { body: form({ scope: "In: `c.mjs`." }) } },
    launchFail: [2],
  });
  const { code, lines } = main([1, 2, 3], deps);
  assert.equal(code, 1);
  assert.deepEqual(lines, ["#1 → id1", "#2: launch failed: claude: spawn failed, not retried", "#3 → id3"]);
  assert.deepEqual(
    reapers.map((r) => r.args.slice(1)),
    [
      ["--issue", "1", "--session", "id1"],
      ["--issue", "3", "--session", "id3"],
    ],
  );
  assert.deepEqual(logs.map((l) => l.n), [1, 3]);
});

// #164 criterion 2 and 4: a spawn that throws is reported and does not fail the launch.
test("a reaper spawn that throws prints #N: reaper not started and keeps the launch", () => {
  const { deps, logs } = fakes({ issues: { 1: {} }, spawnChild: () => { throw new Error("spawn EACCES"); } });
  const { code, lines } = main([1], deps);
  assert.equal(code, 0);
  assert.deepEqual(lines, ["#1 → id1", "#1: reaper not started: spawn EACCES"]);
  assert.equal(logs[0].closed, true);
});

test("edge: a spawn that returns no pid (its error comes later) is reported, and the later error is swallowed", () => {
  const handlers = {};
  const { deps } = fakes({ issues: { 1: {} }, spawnChild: () => ({ pid: undefined, on(event, fn) { handlers[event] = fn; }, unref() {} }) });
  const { code, lines } = main([1], deps);
  assert.equal(code, 0);
  assert.deepEqual(lines, ["#1 → id1", "#1: reaper not started: no process started"]);
  assert.equal(typeof handlers.error, "function");
  assert.doesNotThrow(() => handlers.error(new Error("spawn ENOENT")));
});

test("edge: a reaper log that cannot be opened is reported, spawns nothing, and keeps the launch", () => {
  const { deps, reapers } = fakes({ issues: { 1: {} } });
  deps.reaperLog = () => { throw new Error("EACCES: permission denied, open '.lanes/reap/1.log'"); };
  const { code, lines } = main([1], deps);
  assert.equal(code, 0);
  // the team launch's token refresher logs to the same file, so it is not started either
  assert.deepEqual(lines, ["#1 → id1", "#1: reaper not started: EACCES: permission denied, open '.lanes/reap/1.log'", "#1: token refresher not started: EACCES: permission denied, open '.lanes/reap/1.log'"]);
  assert.equal(reapers.length, 0);
});

test("edge: a spawn error on one lane does not stop the next lane's reaper", () => {
  let first = true;
  const { deps, reapers } = fakes({
    issues: { 1: {}, 2: { body: form({ scope: "In: `b.mjs`." }) } },
    spawnChild: () => {
      if (first) {
        first = false;
        throw new Error("spawn EAGAIN");
      }
      return { pid: 7, on() {}, unref() {} };
    },
  });
  const { code, lines } = main([1, 2], deps);
  assert.equal(code, 0);
  assert.deepEqual(lines, ["#1 → id1", "#1: reaper not started: spawn EAGAIN", "#2 → id2"]);
  assert.equal(reapers.length, 1);
});

test("edge: a multi-line spawn error is reported as its first line only", () => {
  const { deps } = fakes({ issues: { 1: {} }, spawnChild: () => { throw new Error("spawn failed\nstack line"); } });
  assert.deepEqual(main([1], deps).lines, ["#1 → id1", "#1: reaper not started: spawn failed"]);
});

test("launchLane launches from the repository root and prints #N → id", () => {
  const { deps, launches } = fakes({ issues: { 1: {}, 2: { body: form({ scope: "In: `b.mjs`." }) } } });
  const { code, lines } = main([1, 2], deps);
  assert.equal(code, 0);
  assert.deepEqual(lines, ["#1 → id1", "#2 → id2"]);
  assert.deepEqual(launches, [
    { args: [...NAMED(1), "/lane 1"], cwd: "/repo" },
    { args: [...NAMED(2), "/lane 2"], cwd: "/repo" },
  ]);
});

test("launchLane reports a launch with no id as failed and does not retry it", () => {
  const { deps, launches } = fakes({ issues: { 1: {}, 2: { body: form({ scope: "In: `b.mjs`." }) } }, launchOut: { 1: "something went wrong" }, launchFail: [2] });
  const { code, lines } = main([1, 2], deps);
  assert.equal(code, 1);
  assert.equal(launches.length, 2);
  assert.match(lines[0], /^#1: launch failed: no session id/);
  assert.match(lines[1], /^#2: launch failed: claude: spawn failed/);
});

test("launchLane reads a coloured `backgrounded · <id>` line as launched", () => {
  const { deps } = fakes({ issues: { 1: {} }, launchOut: { 1: "\x1b[2mbackgrounded · \x1b[0m\x1b[1mabc123\x1b[22m\n" } });
  assert.deepEqual(main([1], deps).lines, ["#1 → abc123"]);
});

test("lanes.config.json has the start block with maxLanes 8 and the two soft paths", () => {
  const raw = JSON.parse(readFileSync(new URL("../../lanes.config.json", import.meta.url), "utf8"));
  assert.equal(raw.start.maxLanes, 8);
  assert.deepEqual(raw.start.softPaths, ["^docs/USING\\.md$", "^README\\.md$", "^lanes\\.config\\.json$"]);
  const { identity: _team, ...start } = startConfig(raw); // identity is pinned by the #537 test
  assert.deepEqual(start, raw.start);
});

test("startConfig falls back to the defaults when the start block or a key is missing", () => {
  const defaults = { maxLanes: 8, softPaths: ["^docs/USING\\.md$", "^README\\.md$", "^lanes\\.config\\.json$"], models: {} };
  assert.deepEqual(START_DEFAULTS, defaults);
  const team = { ...defaults, identity: TEAM };
  assert.deepEqual(startConfig(undefined), team);
  assert.deepEqual(startConfig({}), team);
  assert.deepEqual(startConfig({ start: {} }), team);
  assert.deepEqual(startConfig({ start: { maxLanes: 3 } }), { ...team, maxLanes: 3 });
  assert.deepEqual(startConfig({ start: { softPaths: [] } }), { ...team, softPaths: [] });
});

// #153 criterion 1: start.models maps tiers to model names; no models by default.
test("startConfig takes start.models, a model name per tier, and defaults to no models", () => {
  assert.deepEqual(startConfig({ start: {} }).models, {});
  assert.deepEqual(startConfig({ start: { models: {} } }).models, {});
  const models = { skip: "haiku", quick: "sonnet", full: "claude-opus-5-5" };
  assert.deepEqual(startConfig({ start: { models } }).models, models);
  assert.deepEqual(startConfig({ start: { models: { quick: "sonnet" } } }).models, { quick: "sonnet" });
});

test("startConfig refuses an unknown tier key in start.models", () => {
  for (const key of ["medium", "tier:quick", "Quick", ""]) {
    assert.throws(() => startConfig({ start: { models: { [key]: "sonnet" } } }), /start\.models: unknown tier/, key);
  }
});

test("edge: startConfig refuses a start.models that is not an object of model names", () => {
  for (const bad of [null, "sonnet", ["sonnet"], 1]) {
    assert.throws(() => startConfig({ start: { models: bad } }), /start\.models must be an object/, JSON.stringify(bad));
  }
  // Empty, non-string, whitespace, and a leading dash (which claude would read as a flag) are not model names.
  for (const bad of ["", "   ", 1, null, true, "--dangerously-skip-permissions", "-m", "son net", "sonnet\n"]) {
    assert.throws(() => startConfig({ start: { models: { quick: bad } } }), /start\.models\.quick must be a model name/, JSON.stringify(bad));
  }
});

test("edge: startConfig copies start.models, so the parsed config cannot change it later", () => {
  const raw = { start: { models: { quick: "sonnet" } } };
  const { models } = startConfig(raw);
  raw.start.models.quick = "opus";
  assert.equal(models.quick, "sonnet");
});

// #153 criterion 3: this repository runs skip and quick lanes on sonnet and full lanes on the default model.
// #259: full lanes run on sonnet too.
test("lanes.config.json runs skip, quick and full lanes on sonnet", () => {
  const raw = JSON.parse(readFileSync(new URL("../../lanes.config.json", import.meta.url), "utf8"));
  assert.deepEqual(raw.start.models, { skip: "sonnet", quick: "sonnet", full: "sonnet" });
  assert.deepEqual(startConfig(raw).models, { skip: "sonnet", quick: "sonnet", full: "sonnet" });
});

// #153 criterion 4: docs/USING.md documents start.models.
test("docs/USING.md documents start.models", () => {
  const doc = readFileSync(new URL("../../docs/USING.md", import.meta.url), "utf8");
  assert.match(doc, /`start\.models`/);
  assert.match(doc, /--model/);
});

// This repository's actual lanes.config.json, run through launchLane end to end (not a hand-built fixture), launches
// each tier on the model criterion 3 requires.
test("edge: launchLane launches on the models from this repository's own lanes.config.json", () => {
  // The repo's team identity (#537) is left out: this test is about models, and the team launch has its own tests.
  const { identity: _team, ...config } = JSON.parse(readFileSync(new URL("../../lanes.config.json", import.meta.url), "utf8"));
  const issues = {
    1: { labels: ["ready", "tier:skip"], body: form({ scope: "In: `a.mjs`." }) },
    2: { labels: ["ready", "tier:quick"], body: form({ scope: "In: `b.mjs`." }) },
    3: { labels: ["ready", "tier:full"], body: form({ scope: "In: `c.mjs`." }) },
  };
  const { deps, launches } = fakes({ issues, config });
  const { code } = main([1, 2, 3], deps);
  assert.equal(code, 0);
  assert.deepEqual(launches, [
    { args: [...NAMED(1), "--model", "sonnet", "/lane 1"], cwd: "/repo" },
    { args: [...NAMED(2), "--model", "sonnet", "/lane 2"], cwd: "/repo" },
    { args: [...NAMED(3), "--model", "sonnet", "/lane 3"], cwd: "/repo" },
  ]);
});

test("startConfig accepts maxLanes 1 and 10 and refuses anything outside 1 to 10", () => {
  assert.equal(startConfig({ start: { maxLanes: 1 } }).maxLanes, 1);
  assert.equal(startConfig({ start: { maxLanes: 10 } }).maxLanes, 10);
  for (const bad of [0, 11, -1, 2.5, "8", null, Number.NaN, Infinity]) {
    assert.throws(() => startConfig({ start: { maxLanes: bad } }), /start\.maxLanes must be a whole number from 1 to 10/, String(bad));
  }
});

test("edge: startConfig refuses a malformed start block or softPaths", () => {
  assert.throws(() => startConfig({ start: 8 }), /start must be an object/);
  assert.throws(() => startConfig({ start: null }), /start must be an object/);
  assert.throws(() => startConfig({ start: [] }), /start must be an object/);
  assert.throws(() => startConfig({ start: { softPaths: "^README\\.md$" } }), /start\.softPaths must be an array of regex strings/);
  assert.throws(() => startConfig({ start: { softPaths: [1] } }), /start\.softPaths must be an array of regex strings/);
  assert.throws(() => startConfig({ start: { softPaths: ["("] } }), /start\.softPaths: invalid regex/);
});

// #153 criterion 2, end to end: each lane launches on its own issue's tier model.
test("launchLane launches each issue on its tier's model from start.models", () => {
  const config = { start: { models: { skip: "haiku", quick: "sonnet" } } };
  const issues = {
    1: { labels: ["ready", "tier:skip"], body: form({ scope: "In: `a.mjs`." }) },
    2: { labels: ["ready", "tier:quick"], body: form({ scope: "In: `b.mjs`." }) },
    3: { labels: ["ready", "tier:full"], body: form({ scope: "In: `c.mjs`." }) },
  };
  const { deps, launches } = fakes({ issues, config });
  const { code } = main([1, 2, 3], deps);
  assert.equal(code, 0);
  assert.deepEqual(launches, [
    { args: [...NAMED(1), "--model", "haiku", "/lane 1"], cwd: "/repo" },
    { args: [...NAMED(2), "--model", "sonnet", "/lane 2"], cwd: "/repo" },
    { args: [...NAMED(3), "/lane 3"], cwd: "/repo" },
  ]);
});

// #260: a model:opus label launches the lane on Opus over its tier's model; any other model:* label is ignored.
test("launchLane launches a model:opus issue on opus over its tier's model", () => {
  const config = { start: { models: { quick: "sonnet", full: "sonnet" } } };
  const issues = {
    1: { labels: ["ready", "tier:full", "model:opus"], body: form({ scope: "In: `a.mjs`." }) },
    2: { labels: ["ready", "tier:quick", "model:opus"], body: form({ scope: "In: `b.mjs`." }) },
    3: { labels: ["ready", "tier:full"], body: form({ scope: "In: `c.mjs`." }) },
  };
  const { deps, launches } = fakes({ issues, config });
  assert.equal(main([1, 2, 3], deps).code, 0);
  assert.deepEqual(launches, [
    { args: [...NAMED(1), "--model", "opus", "/lane 1"], cwd: "/repo" },
    { args: [...NAMED(2), "--model", "opus", "/lane 2"], cwd: "/repo" },
    { args: [...NAMED(3), "--model", "sonnet", "/lane 3"], cwd: "/repo" },
  ]);
});

test("model:opus launches on opus even when start.models sets no model", () => {
  const { deps, launches } = fakes({ issues: { 1: { labels: ["ready", "tier:full", "model:opus"] } } });
  assert.equal(main([1], deps).code, 0);
  assert.deepEqual(launches, [{ args: [...NAMED(1), "--model", "opus", "/lane 1"], cwd: "/repo" }]);
});

test("an unknown model:* label is ignored, logged once, and never reaches claude --model", () => {
  const config = { start: { models: { full: "sonnet" } } };
  const issues = { 1: { labels: ["ready", "tier:full", "model:--dangerously", "model:haiku"] } };
  const { deps, launches } = fakes({ issues, config });
  const { code, lines } = main([1], deps);
  assert.equal(code, 0);
  assert.deepEqual(launches, [{ args: [...NAMED(1), "--model", "sonnet", "/lane 1"], cwd: "/repo" }]);
  assert.deepEqual(lines, ["#1: ignored label model:--dangerously", "#1: ignored label model:haiku", "#1 → id1"]);
});

test("edge: model:opus beside an unknown model:* label still launches on opus and logs the unknown one", () => {
  const { deps, launches } = fakes({ issues: { 1: { labels: ["ready", "tier:full", "model:opus", "model:x"] } } });
  const { lines } = main([1], deps);
  assert.deepEqual(launches, [{ args: [...NAMED(1), "--model", "opus", "/lane 1"], cwd: "/repo" }]);
  assert.deepEqual(lines, ["#1: ignored label model:x", "#1 → id1"]);
});

test("edge: an ignored model:* label's control characters cannot reach the log line", () => {
  const { deps } = fakes({ issues: { 1: { labels: ["ready", "tier:full", "model:x\x1b[2J\nfake"] } } });
  const { lines } = main([1], deps);
  assert.deepEqual(lines, ["#1: ignored label model:x?[2J?fake", "#1 → id1"]);
});

test("launchArgs puts --model opus first when opus is set, over the tier's model", () => {
  assert.deepEqual(launchArgs(18, { tier: "full", models: { full: "sonnet" }, opus: true }), [...NAMED(18), "--model", "opus", "/lane 18"]);
  assert.deepEqual(launchArgs(18, { tier: "full", models: { full: "sonnet" }, opus: false }), [...NAMED(18), "--model", "sonnet", "/lane 18"]);
});

test("launchLane launches with no --model when lanes.config.json sets no models", () => {
  const { deps, launches } = fakes({ issues: { 1: { labels: ["ready", "tier:full"] } } });
  assert.equal(main([1], deps).code, 0);
  assert.deepEqual(launches, [{ args: [...NAMED(1), "/lane 1"], cwd: "/repo" }]);
});

test("edge: a malformed start.models launches nothing", () => {
  const { deps, launches } = fakes({ issues: { 1: {} }, config: { start: { models: { medium: "sonnet" } } } });
  const { code, lines } = main([1], deps);
  assert.equal(code, 2);
  assert.match(lines[0], /nothing launched: .*start\.models: unknown tier/);
  assert.equal(launches.length, 0);
});

test("edge: start.maxLanes out of bounds launches nothing", () => {
  const { deps, launches } = fakes({ issues: { 1: {} }, config: { start: { maxLanes: 11 } } });
  const { code, lines } = main([1], deps);
  assert.equal(code, 2);
  assert.match(lines[0], /nothing launched: lanes\.config\.json: start\.maxLanes/);
  assert.equal(launches.length, 0);
});

// #337: on Windows a lane's PATH gets Git's POSIX tools first; elsewhere the environment is untouched.
const GIT_EXEC = "C:/Program Files/Git/mingw64/libexec/git-core";
test("launchEnv: Windows puts Git's usr\\bin and mingw64\\bin ahead of the inherited PATH", () => {
  const inherited = { Path: "C:\\Windows;C:\\Tools", OTHER: "x" };
  const { env, note } = launchEnv(inherited, "win32", GIT_EXEC);
  assert.equal(env.Path, "C:\\Program Files\\Git\\usr\\bin;C:\\Program Files\\Git\\mingw64\\bin;C:\\Windows;C:\\Tools");
  assert.equal(env.OTHER, "x");
  assert.equal(note, null);
  assert.equal(inherited.Path, "C:\\Windows;C:\\Tools", "input is not mutated");
});
test("launchEnv: Windows with an upper-case PATH key keeps that key, and with no PATH sets one", () => {
  assert.match(launchEnv({ PATH: "C:\\a" }, "win32", GIT_EXEC).env.PATH, /^C:\\Program Files\\Git\\usr\\bin;.*;C:\\a$/);
  assert.equal(launchEnv({}, "win32", GIT_EXEC).env.Path, "C:\\Program Files\\Git\\usr\\bin;C:\\Program Files\\Git\\mingw64\\bin");
});
test("launchEnv: Windows without Git found launches with the inherited env and says why", () => {
  const inherited = { Path: "C:\\a" };
  for (const [exec, why] of [[null, "git not found"], ["", "git not found"], ["/weird", "unexpected git --exec-path: /weird"]]) {
    const { env, note } = launchEnv(inherited, "win32", exec);
    assert.equal(env, inherited);
    assert.equal(note, `PATH not adjusted: ${why}`);
  }
});
test("launchEnv: edge: trailing newline, MinGW64 casing, Git at a drive root, and a ';' in the root", () => {
  assert.match(launchEnv({ Path: "x" }, "win32", `${GIT_EXEC}\r\n`).env.Path, /^C:\\Program Files\\Git\\usr\\bin;/);
  assert.match(launchEnv({ Path: "x" }, "win32", "C:/Git/MinGW64/libexec/git-core").env.Path, /^C:\\Git\\usr\\bin;/);
  assert.match(launchEnv({ Path: "x" }, "win32", "C:/mingw64/libexec/git-core").env.Path, /^C:\\usr\\bin;C:\\mingw64\\bin;x$/);
  const semi = launchEnv({ Path: "x" }, "win32", "C:/a;b/Git/mingw64/libexec/git-core");
  assert.equal(semi.env.Path, "x");
  assert.match(semi.note, /^PATH not adjusted: unexpected git --exec-path/);
});
test("launchEnv: Linux and macOS pass the environment through unchanged", () => {
  const inherited = { PATH: "/usr/bin" };
  for (const platform of ["linux", "darwin"]) {
    const { env, note } = launchEnv(inherited, platform, GIT_EXEC);
    assert.equal(env, inherited);
    assert.equal(note, null);
  }
});
test("launch: the adjusted env goes to the background launch and the note is printed", () => {
  const f = fakes({ issues: { 1: {} } });
  const seen = [];
  const launchClaude = f.deps.claude;
  f.deps.claude = (args, opts) => (seen.push(opts?.env), launchClaude(args, opts));
  f.deps.launchEnv = () => ({ env: { PATH: "adjusted" }, note: "PATH not adjusted: because" });
  const { lines } = main([1], f.deps);
  // under team the lane's environment is the launcher's PATH plus the lane's own gh directory
  assert.deepEqual(seen.filter(Boolean).map((e) => [e.PATH, e.GH_CONFIG_DIR]), [["adjusted", "/tmp/lane-1"]]);
  assert.ok(lines.includes("#1: PATH not adjusted: because"), lines.join("|"));
});

// #361 (ADR 0014): lane:running is added by the owner-side launch, only after a launch whose session id parsed.
test("markRunning adds lane:running and returns one line", () => {
  const f = fakes({ issues: { 5: {} } });
  assert.equal(markRunning(5, f.deps), "#5: lane:running set");
  assert.deepEqual(f.labeled, [5]);
});

test("edge: markRunning creates the label once when the repository has none, then adds it", () => {
  const f = fakes({ issues: { 5: {} }, labelMissing: true });
  assert.equal(markRunning(5, f.deps), "#5: lane:running set");
  assert.deepEqual(f.labeled, [5]);
});

test("markRunning returns `#N: label not set: <reason>` and never throws", () => {
  const f = fakes({ issues: { 5: {} }, labelFail: "gh: rate limited\nmore" });
  assert.equal(markRunning(5, f.deps), "#5: label not set: gh: rate limited");
});

test("launchLane labels the issue after a good launch and prints nothing extra", () => {
  const f = fakes({ issues: { 1: {} } });
  const { code, lines } = main([1], f.deps);
  assert.equal(code, 0);
  assert.deepEqual(lines, ["#1 → id1"]);
  assert.deepEqual(f.labeled, [1]);
});

test("launchLane does not label an issue whose launch failed or printed no session id", () => {
  const f = fakes({ issues: { 1: {}, 2: { body: form({ scope: "In: `b.mjs`." }) } }, launchFail: [1], launchOut: { 2: "no id here" } });
  main([1, 2], f.deps);
  assert.deepEqual(f.labeled, []);
});

test("a label failure leaves the launch and exit code intact and prints the failure line", () => {
  const f = fakes({ issues: { 1: {} }, labelFail: "gh: rate limited" });
  const { code, lines } = main([1], f.deps);
  assert.equal(code, 0);
  assert.deepEqual(lines, ["#1 → id1", "#1: label not set: gh: rate limited"]);
  assert.equal(f.reapers.length, 1);
});

test("edge: markRunning reports a failed label creation and does not create for an unrelated edit failure", () => {
  const calls = [];
  const gh = (args) => {
    calls.push(args.slice(0, 2).join(" "));
    if (args[0] === "label") throw new Error("gh: create denied\nmore");
    throw new Error("gh: 'lane:running' not found");
  };
  assert.equal(markRunning(5, { gh }), "#5: label not set: gh: create denied");
  assert.deepEqual(calls, ["issue edit", "label create"]);
  const other = [];
  const gh2 = (args) => {
    other.push(args[0]);
    throw new Error("HTTP 502");
  };
  assert.equal(markRunning(5, { gh: gh2 }), "#5: label not set: HTTP 502");
  assert.deepEqual(other, ["issue"]);
});

// #416: a lane PATH is deduplicated (first kept, order kept) and a long one is reported.
test("launchEnv: exact duplicate PATH entries are dropped case-insensitively, first kept, order kept", () => {
  const { env, note } = launchEnv({ Path: "C:\\Windows;c:\\windows;C:\\Tools;C:\\Program Files\\Git\\usr\\bin;C:\\Windows" }, "win32", GIT_EXEC);
  assert.equal(env.Path, "C:\\Program Files\\Git\\usr\\bin;C:\\Program Files\\Git\\mingw64\\bin;C:\\Windows;C:\\Tools");
  assert.equal(note, null);
});
test("launchEnv: a PATH over 60 entries is reported with its entry and unique counts", () => {
  const many = Array.from({ length: 70 }, (_, i) => `C:\\d${i}`).join(";");
  const { env, note } = launchEnv({ Path: many }, "win32", GIT_EXEC);
  assert.equal(env.Path.split(";").length, 72);
  assert.equal(note, "PATH has 72 entries (72 unique)");
});
test("launchEnv: a normal PATH gets no note and only the Git tools in front", () => {
  const { env, note } = launchEnv({ Path: "C:\\a;C:\\b" }, "win32", GIT_EXEC);
  assert.equal(env.Path, "C:\\Program Files\\Git\\usr\\bin;C:\\Program Files\\Git\\mingw64\\bin;C:\\a;C:\\b");
  assert.equal(note, null);
});
test("edge: empty PATH entries survive deduplication", () => {
  assert.equal(launchEnv({ Path: "C:\\a;;C:\\a;" }, "win32", GIT_EXEC).env.Path, "C:\\Program Files\\Git\\usr\\bin;C:\\Program Files\\Git\\mingw64\\bin;C:\\a;;");
});

// #416: the note threshold is exactly 60 entries (the two Git tool entries count).
test("edge: launchEnv reports a PATH of 61 entries but not one of exactly 60", () => {
  const path = (n) => Array.from({ length: n }, (_, i) => `C:\d${i}`).join(";");
  assert.equal(launchEnv({ Path: path(58) }, "win32", GIT_EXEC).note, null);
  assert.equal(launchEnv({ Path: path(59) }, "win32", GIT_EXEC).note, "PATH has 61 entries (61 unique)");
});
test("edge: launchEnv counts unique entries after dropping duplicates in a long PATH", () => {
  const path = Array.from({ length: 80 }, (_, i) => `C:\d${i % 65}`).join(";");
  assert.equal(launchEnv({ Path: path }, "win32", GIT_EXEC).note, "PATH has 67 entries (67 unique)");
});

// #390 criterion 1
test("budgetConfig returns the defaults when the block or a key is absent", () => {
  const defaults = { perNightTokens: 100_000_000, perLaneTokens: 15_000_000 };
  assert.deepEqual(budgetConfig(undefined), defaults);
  assert.deepEqual(budgetConfig({}), defaults);
  assert.deepEqual(budgetConfig({ budget: { perLaneTokens: 5 } }), { ...defaults, perLaneTokens: 5 });
  assert.deepEqual(budgetConfig({ budget: { perNightTokens: 7, perLaneTokens: 3 } }), { perNightTokens: 7, perLaneTokens: 3 });
});

test("edge: budgetConfig names the key for a non-positive, non-integer or non-number value, and a non-object block", () => {
  for (const bad of [0, -5, 1.5, "10", null, NaN]) {
    assert.throws(() => budgetConfig({ budget: { perNightTokens: bad } }), /budget\.perNightTokens must be a positive whole number/);
    assert.throws(() => budgetConfig({ budget: { perLaneTokens: bad } }), /budget\.perLaneTokens must be a positive whole number/);
  }
  for (const bad of [null, [], "x", 3]) assert.throws(() => budgetConfig({ budget: bad }), /budget must be an object/);
});

test("the repo's own lanes.config.json carries its budget: a 300M 24-hour cap (#490) and the default per-lane cap", () => {
  const raw = JSON.parse(readFileSync(new URL("../../lanes.config.json", import.meta.url), "utf8"));
  assert.deepEqual(raw.budget, { perNightTokens: 300000000, perLaneTokens: BUDGET_DEFAULTS.perLaneTokens });
  assert.deepEqual(budgetConfig(raw), raw.budget);
});

// #550: the team profile again for trial run 2 (#500), after #540 (PR #543) and #544 (PR #545).
test("the repo's own lanes.config.json runs the team profile with the lanes App (#550)", () => {
  const raw = JSON.parse(readFileSync(new URL("../../lanes.config.json", import.meta.url), "utf8"));
  const identity = { profile: "team", app: { id: 5140388, installationId: 166641484, botLogin: "sour-dev-lanes[bot]" } };
  assert.deepEqual(raw.identity, identity);
  assert.deepEqual(startConfig(raw).identity, identity);
});

// #483: the queue records each decision as a line of .lanes/starts.jsonl with only `at`, `issue`, `outcome`, `reason` and `with`.
test("edge: classifySkip maps every skip text to one reason and only overlaps carry `with`", () => {
  const cases = [
    ["overlaps running #12 on src/a.mjs", { reason: "overlap", with: 12 }],
    ["overlaps #3, #4", { reason: "overlap", with: 3 }],
    ["overlaps #7 on src/a.mjs", { reason: "overlap", with: 7 }],
    ["cap of 8 lanes reached", { reason: "cap" }],
    ["cap of 8 lanes in flight", { reason: "cap" }],
    ["blocked by #2 (open)", { reason: "blocked" }],
    ["already in flight: dead lane", { reason: "in-flight" }],
    ["lacks ready", { reason: "not-ready" }],
    ["needs-owner", { reason: "not-ready" }],
    ["no single tier:* label", { reason: "not-ready" }],
    ["scope names no paths", { reason: "other" }],
    ["not found or unreadable", { reason: "other" }],
    ["", { reason: "other" }],
  ];
  for (const [text, want] of cases) assert.deepEqual(classifySkip(text), want, text);
  assert.deepEqual(startDecisions({ at: "t" }), []);
});

test("startDecisions writes a started and a skipped line per decided issue with exactly the documented fields", () => {
  const lines = startDecisions({ started: [1], skipped: [{ number: 3, reason: "overlaps #1 on a.mjs" }, { number: 5, reason: "lacks ready" }], at: "t" });
  assert.deepEqual(lines, [
    { at: "t", issue: 1, outcome: "started" },
    { at: "t", issue: 3, outcome: "skipped", reason: "overlap", with: 1 },
    { at: "t", issue: 5, outcome: "skipped", reason: "not-ready" },
  ]);
});

test("appendStarts appends JSON lines to .lanes/starts.jsonl, writes nothing for no lines, and throws when it cannot write", () => {
  const root = mkdtempSync(join(tmpdir(), "starts-"));
  const blocked = mkdtempSync(join(tmpdir(), "starts-"));
  try {
    appendStarts(root, []);
    assert.equal(existsSync(join(root, ".lanes")), false);
    appendStarts(root, [{ at: "a", issue: 1, outcome: "started" }]);
    appendStarts(root, [{ at: "b", issue: 2, outcome: "skipped", reason: "cap" }]);
    assert.deepEqual(readFileSync(join(root, ".lanes", "starts.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l).issue), [1, 2]);
    writeFileSync(join(blocked, ".lanes"), "a file where the directory should be");
    assert.throws(() => appendStarts(blocked, [{ at: "a", issue: 1, outcome: "started" }]));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(blocked, { recursive: true, force: true });
  }
});

// #499: the team profile (ADR 0019 parts 1, 3 and 4).

test("startConfig accepts a team identity with numeric app ids", () => {
  assert.deepEqual(startConfig({ identity: TEAM }).identity, TEAM);
});

// #613 (ADR 0025): a config whose identity is not team is refused first, with the one message.
test("startConfig refuses a missing config, a missing identity or profile, solo and an unknown profile with the one message", () => {
  for (const raw of [undefined, null, {}, { start: { maxLanes: 3 } }, { identity: {} }, { identity: { profile: "solo" } }, { identity: { profile: "solo", app: TEAM.app } }, { identity: { profile: "other" } }, { identity: { profile: "Team", app: TEAM.app } }]) {
    assert.throws(() => strictStartConfig(raw), (e) => e.message.startsWith(TEAM_REQUIRED_MESSAGE) && e.message.includes("lanes.config.json"), JSON.stringify(raw));
  }
  // the identity is checked before the rest of the config: a bad start block does not hide the refusal
  assert.throws(() => strictStartConfig({ start: { maxLanes: 0 } }), (e) => e.message.startsWith(TEAM_REQUIRED_MESSAGE));
  assert.throws(() => strictStartConfig({ identity: { profile: "solo" } }), /profile "solo"/);
});

test("a config that is not team launches nothing with the one message, and reads nothing from gh", () => {
  for (const config of [undefined, { identity: undefined }, { identity: { profile: "solo" } }, { identity: { profile: "other" } }]) {
    const f = fakes({ issues: { 1: {} }, config: config ?? { identity: undefined } });
    if (config === undefined) f.deps.config = () => undefined;
    const { code, lines } = main([1], f.deps);
    assert.equal(code, 2, JSON.stringify(config));
    assert.equal(lines.length, 1);
    assert.ok(lines[0].startsWith(`nothing launched: ${TEAM_REQUIRED_MESSAGE}`), lines[0]);
    assert.deepEqual(f.launches, []);
  }
});

test("this repository's lanes.config.json passes startConfig's identity check", () => {
  const raw = JSON.parse(readFileSync("lanes.config.json", "utf8"));
  assert.equal(strictStartConfig(raw).identity.profile, "team");
});

test("startConfig requires a valid botLogin under team (#528)", () => {
  const app = { id: 1, installationId: 2 };
  assert.throws(() => startConfig({ identity: { profile: "team", app } }), /lanes\.config\.json: identity .*botLogin/);
  for (const botLogin of ["", "sour", "a[bot]x", "-a[bot]", "a b[bot]", 5, null]) {
    assert.throws(() => startConfig({ identity: { profile: "team", app: { ...app, botLogin } } }), /lanes\.config\.json: identity .*botLogin/, JSON.stringify(botLogin));
  }
  const ok = { profile: "team", app: { ...app, botLogin: "a[bot]" } };
  assert.deepEqual(startConfig({ identity: ok }).identity, ok);
});

test("startConfig refuses any other identity shape with a clear error", () => {
  for (const identity of [null, "team", [], { profile: "team" }, { profile: "team", app: { id: 1 } }, { profile: "team", app: { id: "1", installationId: 2 } }, { profile: "team", app: { id: 0, installationId: 2 } }, { profile: "team", app: { id: 1, installationId: 2, key: "x" } }, { profile: "team", app: null }, { profile: "team", x: 1 }]) {
    assert.throws(() => startConfig({ identity }), /lanes\.config\.json: identity /, JSON.stringify(identity));
  }
});

test("teamLaneEnv removes the credentials and points gh and git at the lane's own files", () => {
  const env = { PATH: "/bin", HOME: "/h", LANES_APP_KEY_FILE: "/k", GH_TOKEN: "t", GITHUB_TOKEN: "t", GH_ENTERPRISE_TOKEN: "t", GH_CONFIG_DIR: "/owner", github_token: "t", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "credential.helper", GIT_CONFIG_VALUE_0: "store", GIT_CONFIG_PARAMETERS: "'a=b'", GIT_ASKPASS: "x", SSH_ASKPASS: "x", GCM_INTERACTIVE: "1" };
  const out = teamLaneEnv(env, { ghDir: "/lane/gh", emptyConfig: "/lane/empty" });
  assert.deepEqual(out, { PATH: "/bin", HOME: "/h", GH_CONFIG_DIR: "/lane/gh", GIT_CONFIG_GLOBAL: "/lane/empty", GIT_CONFIG_SYSTEM: "/lane/empty", GIT_CONFIG_COUNT: "4", GIT_CONFIG_KEY_0: "credential.helper", GIT_CONFIG_VALUE_0: "", GIT_CONFIG_KEY_1: "credential.helper", GIT_CONFIG_VALUE_1: "!gh auth git-credential", GIT_CONFIG_KEY_2: "url.https://github.com/.insteadOf", GIT_CONFIG_VALUE_2: "git@github.com:", GIT_CONFIG_KEY_3: "url.https://github.com/.insteadOf", GIT_CONFIG_VALUE_3: "ssh://git@github.com/", GIT_SSH_COMMAND: out.GIT_SSH_COMMAND, GIT_TERMINAL_PROMPT: "0" });
  assert.match(out.GIT_SSH_COMMAND, /exit 1$/, "ssh is made to fail");
  assert.equal(env.GH_TOKEN, "t", "the input is not mutated");
});

// A team launch with every side effect faked: what was minted, where, what claude got, what the refresher was given.
function teamRun({ env = {}, key = "/keys/app.pem", unreadable = false, mintFail = null, dirFail = false, noRepo = false, settingsFail = false, botId = "336249257", botIdFail = false, identity = TEAM, launchFail = [], spawnChild } = {}) {
  const f = fakes({ issues: { 1: {}, 2: { body: form({ scope: "In: `b.mjs`." }) } }, launchFail, config: { identity }, spawnChild, keepRefresher: true });
  const made = [];
  const removed = [];
  const minted = [];
  const claudeEnvs = [];
  const claudeArgs = [];
  const settingsWritten = [];
  const botLookups = [];
  const team = {
    keyFile: () => key,
    readable: () => {
      if (unreadable) throw new Error("EACCES: /keys/app.pem");
    },
    repo: () => {
      if (noRepo) throw new Error("gh: not a repo");
      return "lanes";
    },
    makeDir: (n) => {
      if (dirFail) throw new Error("EACCES: /tmp/x");
      made.push(n);
      return { dir: `/tmp/lane-${n}`, emptyConfig: `/tmp/lane-${n}/empty` };
    },
    removeDir: (dir) => removed.push(dir),
    writeSettings: (file, settings) => {
      if (settingsFail) throw new Error("EACCES: /tmp/x/settings.json");
      settingsWritten.push({ file, settings });
    },
    mintInto: (args) => {
      minted.push(args);
      if (mintFail) throw new Error(mintFail);
    },
    botUserId: (args) => {
      botLookups.push(args);
      if (botIdFail) throw new Error("HTTP 401");
      return botId;
    },
  };
  const claude = (args, opts) => {
    claudeEnvs.push(opts.env);
    claudeArgs.push(args);
    return f.deps.claude(args, opts);
  };
  const deps = { ...f.deps, claude, team, launchEnv: () => ({ env: { PATH: "/bin", ...env }, note: null }) };
  return { ...f, deps, made, removed, minted, claudeEnvs, claudeArgs, settingsWritten, botLookups };
}

const BOT_EMAIL = "336249257+sour-dev-lanes[bot]@users.noreply.github.com";

test("team (#553): a team lane commits as the App bot, through both the settings file and the launch env", () => {
  const t = teamRun({ env: { GIT_AUTHOR_NAME: "Owner", GIT_COMMITTER_EMAIL: "owner@example.com" } });
  assert.equal(main([1], t.deps).code, 0);
  assert.deepEqual(t.botLookups, [{ dir: "/tmp/lane-1", login: "sour-dev-lanes[bot]" }]);
  for (const env of [t.settingsWritten[0].settings.env, t.claudeEnvs[0]]) {
    assert.equal(env.GIT_AUTHOR_NAME, "sour-dev-lanes[bot]");
    assert.equal(env.GIT_COMMITTER_NAME, "sour-dev-lanes[bot]");
    assert.equal(env.GIT_AUTHOR_EMAIL, BOT_EMAIL);
    assert.equal(env.GIT_COMMITTER_EMAIL, BOT_EMAIL);
    assert.equal(JSON.stringify(env).includes("owner@example.com"), false);
  }
});

test("team (#553): a failed or malformed bot user id lookup refuses the launch and removes the directory", () => {
  for (const opts of [{ botIdFail: true }, { botId: "not-a-number" }, { botId: "0" }, { botId: "" }, { botId: "12.5" }]) {
    const t = teamRun(opts);
    const { code, lines } = main([1], t.deps);
    assert.equal(code, 1, JSON.stringify(opts));
    assert.equal(t.claudeArgs.length, 0, "nothing launched");
    assert.deepEqual(t.settingsWritten, [], "no settings written");
    assert.deepEqual(t.removed, ["/tmp/lane-1"]);
    assert.ok(lines.some((l) => /bot's user id/.test(l)), lines.join("\n"));
  }
});

test("edge (#553): botCommitIdentity builds GitHub's noreply address and rejects a bad id or login", () => {
  assert.deepEqual(botCommitIdentity("sour-dev-lanes[bot]", "336249257\n"), { name: "sour-dev-lanes[bot]", email: BOT_EMAIL });
  assert.deepEqual(botCommitIdentity("x[bot]", 7), { name: "x[bot]", email: "7+x[bot]@users.noreply.github.com" });
  for (const id of [0, -1, "1e3", "12a", null, undefined, Number.MAX_SAFE_INTEGER + 2]) assert.equal(botCommitIdentity("x[bot]", id), null, String(id));
  assert.equal(botCommitIdentity("", 7), null);
  // Without a commit identity (solo helpers, older callers) the four names are blanked, never left to the host.
  const { env } = teamLaneSettings({ ghDir: "/g", emptyConfig: "/e" });
  for (const k of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"]) assert.equal(env[k], "", k);
});

test("team: each lane gets a scrubbed environment and its own minted config directory", () => {
  const t = teamRun({ env: { GH_TOKEN: "owner", LANES_APP_KEY_FILE: "/keys/app.pem", GITHUB_TOKEN: "owner" } });
  const { code, lines } = main([1, 2], t.deps);
  assert.equal(code, 0);
  assert.deepEqual(lines, ["#1 → id1", "#2 → id2"]);
  assert.deepEqual(t.minted, [1, 2].map((n) => ({ issue: n, appId: 11, installationId: 22, repo: "lanes", dir: `/tmp/lane-${n}` })));
  assert.equal(t.claudeEnvs.length, 2);
  for (const [i, env] of t.claudeEnvs.entries()) {
    assert.equal(env.GH_CONFIG_DIR, `/tmp/lane-${i + 1}`);
    assert.equal(env.GIT_CONFIG_GLOBAL, `/tmp/lane-${i + 1}/empty`);
    assert.equal(env.GIT_TERMINAL_PROMPT, "0");
    assert.equal(env.GIT_CONFIG_VALUE_1, "!gh auth git-credential");
    for (const k of ["LANES_APP_KEY_FILE", "GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN"]) assert.equal(k in env, false, k);
    assert.equal(JSON.stringify(env).includes("/keys/app.pem"), false);
  }
});

test("team (#540): the team environment is delivered by a settings file the lane launches with", () => {
  const t = teamRun({ env: { GH_TOKEN: "owner" } });
  assert.equal(main([1], t.deps).code, 0);
  const file = join("/tmp/lane-1", "settings.json");
  assert.deepEqual(t.settingsWritten.map((w) => w.file), [file]);
  const i = t.claudeArgs[0].indexOf("--settings");
  assert.equal(t.claudeArgs[0][i + 1], file);
  assert.ok(i > t.claudeArgs[0].indexOf("--bg") && i < t.claudeArgs[0].indexOf("/lane 1"));
  const { env } = t.settingsWritten[0].settings;
  assert.equal(env.GH_CONFIG_DIR, "/tmp/lane-1");
  assert.equal(env.GIT_CONFIG_GLOBAL, "/tmp/lane-1/empty");
  assert.equal(env.GIT_CONFIG_SYSTEM, "/tmp/lane-1/empty");
  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(env.GIT_CONFIG_VALUE_1, "!gh auth git-credential");
  for (const k of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]) assert.equal(env[k], "", k);
  // The SSH rewrite and the failing ssh command.
  assert.equal(env.GIT_CONFIG_COUNT, "4");
  assert.deepEqual([env.GIT_CONFIG_KEY_2, env.GIT_CONFIG_VALUE_2, env.GIT_CONFIG_KEY_3, env.GIT_CONFIG_VALUE_3], ["url.https://github.com/.insteadOf", "git@github.com:", "url.https://github.com/.insteadOf", "ssh://git@github.com/"]);
  assert.match(env.GIT_SSH_COMMAND, /exit 1$/);
  assert.equal(JSON.stringify(env).includes("owner"), false, "no owner value and no token in the file");
});

test("edge (#540): the settings env blanks or sets every exact name the launcher scrub removes, and the known prefixed ones", () => {
  const { env } = teamLaneSettings({ ghDir: "/g", emptyConfig: "/e" });
  for (const k of TEAM_SCRUBBED_NAMES) assert.ok(k in env, k);
  for (const k of ["GIT_CONFIG_PARAMETERS", "GIT_CONFIG_NOSYSTEM", "GIT_CREDENTIAL_HELPER", "GCM_INTERACTIVE", "GCM_CREDENTIAL_STORE", "GIT_SSH"]) assert.equal(env[k], "", k);
  assert.equal(env.GH_CONFIG_DIR, "/g");
  assert.notEqual(env.GIT_SSH_COMMAND, "", "set, not blanked");
  // Everything the launcher env drops is covered by the settings env too.
  const dropped = ["GIT_CONFIG_PARAMETERS", "GCM_INTERACTIVE", ...TEAM_SCRUBBED_NAMES];
  const out = teamLaneEnv(Object.fromEntries(dropped.map((k) => [k, "x"])), { ghDir: "/g", emptyConfig: "/e" });
  for (const k of dropped) assert.ok(k in env, `${k} in settings`);
  assert.equal("GIT_CONFIG_PARAMETERS" in out, false);
});

test("team (#544): a team launch passes --strict-mcp-config, never --mcp-config, and the settings deny MCP tools", () => {
  const t = teamRun({ env: { GH_TOKEN: "owner" } });
  assert.equal(main([1], t.deps).code, 0);
  const args = t.claudeArgs[0];
  const i = args.indexOf("--strict-mcp-config");
  assert.ok(i > args.indexOf("--bg") && i < args.indexOf("/lane 1"));
  assert.equal(args.includes("--mcp-config"), false);
  assert.deepEqual(t.settingsWritten[0].settings.permissions.deny, ["mcp__github", "mcp__*"]);
});

test("team (#544): the settings deny MCP tools, and launchArgs adds --strict-mcp-config only when asked", () => {
  assert.deepEqual(teamLaneSettings({ ghDir: "/g", emptyConfig: "/e" }).permissions, { deny: ["mcp__github", "mcp__*"] });
  assert.ok(teamLaneSettings({ ghDir: "/g", emptyConfig: "/e" }).permissions.deny.includes("mcp__github"), "the documented mcp__<server> form is denied");
  assert.deepEqual(launchArgs(18, { strictMcp: true }), [...NAMED(18), "--strict-mcp-config", "/lane 18"]);
  assert.deepEqual(launchArgs(18, { strictMcp: true, tier: "full", models: { full: "sonnet" } }), [...NAMED(18), "--strict-mcp-config", "--model", "sonnet", "/lane 18"]);
  assert.deepEqual(launchArgs(18), [...NAMED(18), "/lane 18"]);
});

test("edge (#540): undeliverable settings remove the lane's directory and launch nothing", () => {
  const t = teamRun({ settingsFail: true });
  assert.equal(main([1], t.deps).code, 1);
  assert.deepEqual(t.removed, ["/tmp/lane-1"]);
  assert.equal(t.claudeArgs.length, 0);
});

test("team: a refresher is spawned beside each lane, detached, with the app ids and the lane's directory and no key", () => {
  const t = teamRun();
  main([1], t.deps);
  const refresher = t.reapers.filter((r) => r.args.includes("--refresh-token"));
  assert.equal(refresher.length, 1);
  assert.deepEqual(refresher[0].args, [join("/repo", "scripts", "lanes", "start.mjs"), "--refresh-token", "--issue", "1", "--session", "id1", "--dir", "/tmp/lane-1", "--app", "11", "--installation", "22", "--repo", "lanes"]);
  assert.equal(refresher[0].options.detached, true);
  assert.equal(refresher[0].child.unrefed, true);
  assert.equal(JSON.stringify(refresher[0].args).includes("app.pem"), false);
  assert.equal(t.reapers.filter((r) => r.args.includes("--session") && !r.args.includes("--refresh-token")).length, 1, "the reaper still starts too");
});

test("team: a refresher that cannot start is reported and keeps the launch", () => {
  const t = teamRun({
    spawnChild: (cmd, args) => {
      if (args.includes("--refresh-token")) throw new Error("spawn EPERM");
      return { pid: 1, on() {}, unref() {} };
    },
  });
  const { code, lines } = main([1], t.deps);
  assert.equal(code, 0);
  assert.deepEqual(lines, ["#1 → id1", "#1: token refresher not started: spawn EPERM"]);
});

for (const [name, opts, step] of [
  ["no key file configured", { key: null }, "LANES_APP_KEY_FILE is not set"],
  ["an unreadable key file", { unreadable: true }, "key file unreadable: /keys/app.pem"],
  ["an unknown repository", { noRepo: true }, "repository name unknown"],
  ["a config directory that cannot be made", { dirFail: true }, "could not create the lane's config directory"],
  ["settings that cannot be delivered", { settingsFail: true }, "could not deliver the team settings to the lane"],
  ["a failed mint", { mintFail: "app-token: request to GitHub failed with status 401" }, "token mint failed: app-token: request to GitHub failed with status 401"],
]) {
  test(`team fails closed on ${name}: nothing launches and the owner's environment is never used`, () => {
    const t = teamRun({ ...opts, env: { GH_TOKEN: "owner" } });
    const { code, lines } = main([1], t.deps);
    assert.equal(code, 1);
    assert.deepEqual(lines, [`#1: launch failed: team profile: ${step}`]);
    assert.equal(t.launches.length, 0);
    assert.equal(t.claudeEnvs.length, 0);
    assert.equal(t.reapers.length, 0);
    assert.equal(t.labeled.length, 0);
  });
}

test("edge: a failed mint removes the lane's directory, and a failing lane does not stop the next", () => {
  const t = teamRun();
  let calls = 0;
  const mintInto = (a) => {
    t.minted.push(a);
    if (++calls === 1) throw new Error("app-token: request to GitHub failed");
  };
  const { code, lines } = main([1, 2], { ...t.deps, team: { ...t.deps.team, mintInto } });
  assert.equal(code, 1);
  assert.deepEqual(lines, ["#1: launch failed: team profile: token mint failed: app-token: request to GitHub failed", "#2 → id2"]);
  assert.deepEqual(t.removed, ["/tmp/lane-1"]);
});

test("edge: a claude launch that fails under team removes the lane's directory and starts no refresher", () => {
  const t = teamRun({ launchFail: [1] });
  const { code } = main([1], t.deps);
  assert.equal(code, 1);
  assert.deepEqual(t.removed, ["/tmp/lane-1"]);
  assert.equal(t.reapers.length, 0);
});

test("edge: team with no team support in deps fails closed", () => {
  const t = teamRun();
  const { team, ...rest } = t.deps;
  const { code, lines } = main([1], rest);
  assert.equal(code, 1);
  assert.deepEqual(lines, ["#1: launch failed: team profile: not supported here"]);
  assert.equal(t.launches.length, 0);
});

test("a solo identity launches nothing, mints nothing and keeps the owner's environment out of it (ADR 0025)", () => {
  const t = teamRun({ identity: { profile: "solo" }, env: { GH_TOKEN: "owner" } });
  const { code, lines } = main([1], t.deps);
  assert.equal(code, 2);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].startsWith(`nothing launched: ${TEAM_REQUIRED_MESSAGE}`), lines[0]);
  assert.equal(t.claudeEnvs.length, 0);
  assert.equal(t.minted.length + t.made.length, 0);
  assert.equal(t.reapers.length, 0);
});

// The refresher loop: re-mints each interval and exits once the lane's session is gone or idle.
function loopRun({ sessionsSeq, remintFail = [] }) {
  const events = [];
  let tick = 0;
  return {
    events,
    run: () =>
      refreshLoop({
        session: "s1",
        intervalMs: REFRESH_MS,
        sessions: () => {
          const s = sessionsSeq[Math.min(tick - 1, sessionsSeq.length - 1)];
          if (s instanceof Error) throw s;
          return s;
        },
        remint: async () => {
          events.push("remint");
          if (remintFail.includes(tick - 1)) throw new Error("app-token: request to GitHub failed");
        },
        sleep: async (ms) => {
          events.push(`sleep ${ms}`);
          tick += 1;
        },
        log: (line) => events.push(`log ${line}`),
      }),
  };
}

test("refresher: waits an interval, re-mints while the session lives, and exits when it is gone", async () => {
  const busy = [{ id: "s1", status: "busy" }];
  const { events, run } = loopRun({ sessionsSeq: [busy, busy, []] });
  assert.equal(await run(), "session ended");
  const every = `sleep ${REFRESH_MS}`;
  assert.deepEqual(events, [every, "remint", every, "remint", every]);
  assert.equal(REFRESH_MS, 45 * 60 * 1000);
});

test("refresher: an idle session (not blocked) counts as ended, a blocked one as alive", async () => {
  assert.equal(await loopRun({ sessionsSeq: [[{ id: "s1", status: "idle" }]] }).run(), "session ended");
  const { events, run } = loopRun({ sessionsSeq: [[{ id: "s1", status: "idle", state: "blocked" }], []] });
  await run();
  assert.deepEqual(events.filter((e) => e === "remint"), ["remint"]);
});

test("edge: a session list that cannot be read keeps the refresher alive and re-minting", async () => {
  const { events, run } = loopRun({ sessionsSeq: [new Error("claude: agents failed"), []] });
  assert.equal(await run(), "session ended");
  assert.equal(events.filter((e) => e === "remint").length, 1);
});

test("edge: a failed re-mint is logged without secrets and the next interval tries again", async () => {
  const busy = [{ id: "s1", status: "busy" }];
  const { events, run } = loopRun({ sessionsSeq: [busy, busy, []], remintFail: [0] });
  await run();
  assert.deepEqual(events.filter((e) => e.startsWith("log")), ["log token refresh failed: app-token: request to GitHub failed"]);
  assert.equal(events.filter((e) => e === "remint").length, 2);
});

test("the refresher rewrites the lane's hosts.yml through the injected app-token functions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "refresh-"));
  try {
    const written = [];
    const remint = makeRemint({
      args: { app: 11, installation: 22, repo: "lanes", dir },
      keyFile: () => "/keys/app.pem",
      readFile: () => "PEM",
      mint: async (a) => {
        written.push(a);
        return { token: "ghs_new", expiresAt: "2026-10-01T00:00:00Z" };
      },
      writeHosts: (d, token) => written.push([d, token]),
    });
    await remint();
    assert.deepEqual(written, [{ appId: 11, installationId: 22, keyPem: "PEM", repo: "lanes" }, [dir, "ghs_new"]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("edge: a re-mint with no key file set or an unreadable one fails by step and never mints or writes", async () => {
  for (const [keyFile, readFile, step] of [
    [() => undefined, () => "PEM", /LANES_APP_KEY_FILE is not set/],
    [() => "/k", () => { throw new Error("EACCES: /k"); }, /^Error: key file unreadable: \/k$/],
  ]) {
    const calls = [];
    const remint = makeRemint({ args: { app: 1, installation: 2, repo: "r", dir: "/d" }, keyFile, readFile, mint: async () => calls.push("mint"), writeHosts: () => calls.push("write") });
    await assert.rejects(remint(), (err) => step.test(err.message) || step.test(String(err)));
    assert.deepEqual(calls, []);
  }
});

test("edge: team with a throwing step outside the named ones, or a failing cleanup, still fails closed", () => {
  const t = teamRun();
  const boom = main([1], { ...t.deps, team: { ...t.deps.team, keyFile: () => { throw new Error("secret /keys/app.pem"); } } });
  assert.equal(boom.code, 1);
  assert.deepEqual(boom.lines, ["#1: launch failed: team profile: unexpected error"]);
  const t2 = teamRun({ mintFail: "app-token: nope" });
  const r = main([1], { ...t2.deps, team: { ...t2.deps.team, removeDir: () => { throw new Error("EBUSY"); } } });
  assert.equal(r.code, 1);
  assert.deepEqual(r.lines, ["#1: launch failed: team profile: token mint failed: app-token: nope"]);
});

test("edge: a refresher whose process never started (no pid) is reported and keeps the launch", () => {
  const t = teamRun({
    spawnChild: (cmd, args) => (args.includes("--refresh-token") ? { pid: undefined, on() {}, unref() {} } : { pid: 1, on() {}, unref() {} }),
  });
  const { code, lines } = main([1], t.deps);
  assert.equal(code, 0);
  assert.deepEqual(lines, ["#1 → id1", "#1: token refresher not started: no process started"]);
});

test("isLaneGhDir accepts only lanes-gh-<issue>-* directly under the temp folder, and never a link", () => {
  assert.equal(isLaneGhDir("/tmp/lanes-gh-7-AbC123", "/tmp"), true);
  assert.equal(isLaneGhDir("C:\\Temp\\lanes-gh-7-AbC123", "c:/temp/"), true);
  for (const dir of ["/tmp/lanes-gh-7-", "/tmp/other", "/srv/other/gh", "/tmp/x/lanes-gh-7-AbC123", "/tmp/lanes-gh-x-AbC123", "/tmp/lanes-gh-7-../gh", ""]) assert.equal(isLaneGhDir(dir, "/tmp"), false, dir);
  assert.equal(isLaneGhDir("/tmp/lanes-gh-7-AbC123", "/tmp", () => true), false);
});

test("teamLaneEnv also drops ssh agent, ssh command and other token and host variables", () => {
  const out = teamLaneEnv({ PATH: "p", SSH_AUTH_SOCK: "s", GIT_SSH: "a", GIT_SSH_COMMAND: "b", GITHUB_PERSONAL_ACCESS_TOKEN: "t", GH_HOST: "h", GH_REPO: "r" }, { ghDir: "/g", emptyConfig: "/e" });
  for (const k of ["SSH_AUTH_SOCK", "GIT_SSH", "GITHUB_PERSONAL_ACCESS_TOKEN", "GH_HOST", "GH_REPO"]) assert.equal(k in out, false, k);
  assert.notEqual(out.GIT_SSH_COMMAND, "b", "the owner's ssh command is replaced by the failing one");
  assert.equal(out.PATH, "p");
});

test("refreshArgs parses the refresher's command line and refuses anything malformed", () => {
  const ok = ["--issue", "1", "--session", "s1", "--dir", "/d", "--app", "11", "--installation", "22", "--repo", "lanes"];
  assert.deepEqual(refreshArgs(ok), { issue: 1, session: "s1", dir: "/d", app: 11, installation: 22, repo: "lanes", once: false });
  assert.equal(refreshArgs([...ok, "--once"]).once, true);
  assert.equal(refreshArgs(ok.slice(2)), null);
  assert.equal(refreshArgs(ok.map((a) => (a === "11" ? "x" : a))), null);
  assert.equal(refreshArgs([...ok, "--bogus", "1"]), null);
});

// #556: launchLane is the one-lane launcher the queue calls.
function laneDeps({ team = null, output = "backgrounded · s-1\n", throws = null } = {}) {
  const launches = [];
  const spawned = [];
  const labels = [];
  const deps = {
    claude: (args, opts) => {
      launches.push({ args, opts });
      if (throws) throw Object.assign(new Error("spawn failed"), { stderr: throws });
      return output;
    },
    spawn: (cmd, args) => {
      spawned.push(args);
      return { pid: 1, on() {}, unref() {} };
    },
    reaperLog: () => ({ fd: 9, close() {} }),
    gh: (args) => {
      labels.push(args);
      return "";
    },
    ...(team ? { team } : {}),
  };
  return { deps, launches, spawned, labels };
}

const laneTeam = (over = {}) => ({
  keyFile: () => "/keys/app.pem",
  readable: () => {},
  repo: () => "lanes",
  makeDir: (n) => ({ dir: `/tmp/lane-${n}`, emptyConfig: `/tmp/lane-${n}/empty` }),
  removeDir: () => {},
  writeSettings: () => {},
  mintInto: () => {},
  botUserId: () => "336249257",
  ...over,
});

test("launchLane (#556): team launches once from root, starts the reaper and the refresher and marks the issue", () => {
  const t = laneDeps({ team: laneTeam() });
  const r = launchLane(4, t.deps, { tier: "full", models: { full: "sonnet" }, labels: [], identity: TEAM, root: "/repo", env: { PATH: "/bin" } });
  assert.deepEqual(r, { id: "s-1", failed: false, lines: ["#4 → s-1"] });
  assert.equal(t.launches.length, 1);
  assert.equal(t.launches[0].opts.cwd, "/repo");
  assert.deepEqual(t.spawned.map((a) => a[0]).filter((p) => p.endsWith("reap.mjs")), [join("/repo", "scripts", "lanes", "reap.mjs")]);
  assert.deepEqual(t.labels, [["issue", "edit", "4", "--add-label", "lane:running"]]);
});

test("launchLane (#556): team prepares the lane, passes --settings and --strict-mcp-config and starts the refresher", () => {
  const t = laneDeps({ team: laneTeam() });
  const r = launchLane(4, t.deps, { tier: "quick", models: {}, labels: ["model:opus"], identity: TEAM, root: "/repo", env: { PATH: "/bin", GH_TOKEN: "owner" } });
  assert.equal(r.failed, false);
  const { args, opts } = t.launches[0];
  assert.deepEqual(args, launchArgs(4, { tier: "quick", models: {}, opus: true, settings: join("/tmp/lane-4", "settings.json"), strictMcp: true }));
  assert.equal(opts.env.GH_TOKEN, undefined);
  assert.equal(opts.env.GH_CONFIG_DIR, "/tmp/lane-4");
  assert.equal(t.spawned.filter((a) => a.includes("--refresh-token")).length, 1);
});

test("launchLane (#556): a team preparation failure launches nothing and returns the reason", () => {
  const t = laneDeps({ team: laneTeam({ keyFile: () => undefined }) });
  const r = launchLane(4, t.deps, { labels: [], identity: TEAM, root: "/repo", env: { GH_TOKEN: "owner" } });
  assert.deepEqual(r, { id: null, failed: true, lines: ["#4: launch failed: team profile: LANES_APP_KEY_FILE is not set"] });
  assert.deepEqual(t.launches, []);
  assert.deepEqual(t.spawned, []);
});

test("launchLane (#556): edge: cwd launches the session elsewhere while the reaper and refresher run from root", () => {
  const t = laneDeps({ team: laneTeam() });
  launchLane(4, t.deps, { labels: [], identity: TEAM, root: "/repo", cwd: "/repo/.claude/worktrees/issue-4-x", env: {} });
  assert.equal(t.launches[0].opts.cwd, "/repo/.claude/worktrees/issue-4-x");
  assert.equal(t.spawned.length, 2);
  for (const args of t.spawned) assert.ok(args[0].startsWith(join("/repo", "scripts", "lanes")), args[0]);
});

test("launchLane (#556): edge: with no env the lane still launches from the process environment; ignored labels and the env note lead the lines", () => {
  const t = laneDeps({ team: laneTeam() });
  const r = launchLane(4, t.deps, { labels: ["model:haiku"], identity: TEAM, root: "/repo", envNote: "PATH note" });
  assert.equal(t.launches[0].opts.cwd, "/repo");
  assert.deepEqual(r.lines, ["#4: ignored label model:haiku", "#4: PATH note", "#4 → s-1"]);
});

test("launchLane (#556): edge: a failed launch under team removes the lane's directory and is not retried", () => {
  const removed = [];
  const t = laneDeps({ team: laneTeam({ removeDir: (d) => removed.push(d) }), throws: "claude: not logged in" });
  const r = launchLane(4, t.deps, { labels: [], identity: TEAM, root: "/repo", env: {} });
  assert.deepEqual(r, { id: null, failed: true, lines: ["#4: launch failed: claude: not logged in, not retried"] });
  assert.equal(t.launches.length, 1);
  assert.deepEqual(removed, ["/tmp/lane-4"]);
  assert.deepEqual(t.spawned, []);
});

test("teamSteps (#556): the real team steps are exported for the queue", () => {
  assert.deepEqual(Object.keys(teamSteps).sort(), ["botUserId", "keyFile", "makeDir", "mintInto", "readable", "removeDir", "repo", "writeSettings"]);
});

// #595 (ADR 0023 part 5): under team, a Scope naming .github/workflows/ prints one informational note and still launches.
const WF_NOTE = "#4: Scope names .github/workflows/: the lane opens its PR without the workflow change and hands it over in a PR comment";
test("launchLane (#595): team with a workflow scope path prints the note first and still launches", () => {
  const t = laneDeps({ team: laneTeam() });
  const r = launchLane(4, t.deps, { tier: "full", models: {}, labels: [], identity: TEAM, root: "/repo", env: {}, scope: ["scripts/lanes/x.mjs", ".github/workflows/ci.yml"] });
  assert.equal(r.failed, false);
  assert.equal(r.lines[0], WF_NOTE);
  assert.ok(r.lines.includes("#4 → s-1"));
  assert.equal(t.launches.length, 1);
});

test("launchLane (#595): team without a workflow path prints no note", () => {
  const a = laneDeps({ team: laneTeam() });
  assert.deepEqual(launchLane(4, a.deps, { labels: [], identity: TEAM, root: "/repo", env: {}, scope: ["scripts/lanes/x.mjs"] }).lines, ["#4 → s-1"]);
});

test("launchLane (#595): edge: no scope, a bare workflows directory and a look-alike path", () => {
  assert.equal(scopeNamesWorkflows(undefined), false);
  assert.equal(scopeNamesWorkflows([]), false);
  assert.equal(scopeNamesWorkflows([".github/workflows/"]), true);
  assert.equal(scopeNamesWorkflows([".github/workflows"]), true);
  assert.equal(scopeNamesWorkflows([".github/workflows-old/x.yml", "docs/.github/workflows/x.yml"]), false);
});

test("#595: the issue's Scope paths reach launchLane, so a workflow path in Scope prints the note", () => {
  const body = "### Goal\ng\n### Acceptance criteria\n- [ ] a\n### Interface contract\nnone\n### Scope\nIn: `.github/workflows/ci.yml`.\n### Blocked by\nnone\n### Tier\nquick\n";
  const { deps, launches } = fakes({ issues: { 1: { body } }, config: { identity: TEAM } });
  deps.team = laneTeam();
  const { lines } = main([1], deps);
  assert.ok(lines.includes("#1: Scope names .github/workflows/: the lane opens its PR without the workflow change and hands it over in a PR comment"), lines.join("\n"));
  assert.equal(launches.length, 1);
});
