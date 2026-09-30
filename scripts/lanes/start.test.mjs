// scripts/lanes/start.test.mjs
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUDGET_DEFAULTS, START_DEFAULTS, budgetConfig, inFlightIssues, launchArgs, launchEnv, main as runStart, markRunning, parseSessionId, planStart, startConfig } from "./start.mjs";
import { GRANT_TTL_MS, runHook } from "./start-guard.mjs";

const CAP = START_DEFAULTS.maxLanes;

// #118: start.mjs needs this session's fresh /start grant. Unless a test gives its own `session`, main runs as the
// owner who just typed the matching /start: a grant for exactly these arguments is written before each call.
const GRANT_DIR = mkdtempSync(join(tmpdir(), "start-grant-"));
after(() => rmSync(GRANT_DIR, { recursive: true, force: true }));
const OWNER = "owner-session";
function matchingGrant(argv, at = Date.now()) {
  const args = argv.map((a) => String(a).replace(/^#/, ""));
  if (args[0] === "--auto") return { sessionId: OWNER, auto: args[1] === "--go" ? "go" : "dry", at: new Date(at).toISOString() };
  return { sessionId: OWNER, issues: [...new Set(args.map(Number))], at: new Date(at).toISOString() };
}
function main(argv, deps) {
  if (!deps || "session" in deps) return runStart(argv, deps);
  writeFileSync(join(GRANT_DIR, `${OWNER}.json`), `${JSON.stringify(matchingGrant(argv))}\n`);
  return runStart(argv, { ...deps, session: () => OWNER, grantDir: () => GRANT_DIR, now: () => Date.now() });
}

const ok = { code: 0, message: "no open blockers" };
const issue = (number, over = {}) => ({ number, state: "OPEN", labels: ["ready", "tier:quick"], blockers: ok, ...over });
const never = () => false;
const plan = (issues, inFlight = [], overlaps = never) => planStart({ issues, inFlight, overlaps });

// Criterion 1: the command stops when a lane or a schedule runs it, like /approve.
test("start.md stops when run by a lane or a schedule", () => {
  const md = readFileSync(new URL("../../.claude/commands/start.md", import.meta.url), "utf8");
  const body = md.replace(/^---[\s\S]*?---\s*/, "");
  assert.match(body.split("\n")[0], /If you are a lane or were started by a schedule, stop now\./);
});

// #64 criterion 2: the command's description and step 1 name the current cap.
test("start.md's description and step 1 name the cap", () => {
  const md = readFileSync(new URL("../../.claude/commands/start.md", import.meta.url), "utf8");
  const [frontMatter, ...bodyParts] = md.split(/^---\s*$/m).filter(Boolean);
  assert.match(frontMatter, new RegExp(`caps at ${CAP} by default\\b`));
  assert.match(bodyParts.join(""), new RegExp(`past \`start\\.maxLanes\` lanes in flight \\(from\\s+\`lanes\\.config\\.json\`, ${CAP} by default`));
});

// #64 criterion 3: docs/USING.md tells the owner how many lanes /start allows.
test("docs/USING.md says how many lanes to start", () => {
  const doc = readFileSync(new URL("../../docs/USING.md", import.meta.url), "utf8");
  assert.match(doc, new RegExp(`Start up to ${CAP} lanes`));
});

// Criterion 2: planStart is pure and returns { launch, refused }.
test("planStart launches ready issues and returns the documented shape", () => {
  const input = [issue(1), issue(2)];
  const copy = structuredClone(input);
  assert.deepEqual(plan(input), { launch: [1, 2], refused: [] });
  assert.deepEqual(input, copy);
});

// Criterion 3: each refusal reason names what failed.
test("refuses an issue that is not open", () => {
  assert.deepEqual(plan([issue(1, { state: "CLOSED" })]).refused, [{ number: 1, reason: "not open" }]);
});

test("refuses an issue without the ready label", () => {
  assert.deepEqual(plan([issue(1, { labels: ["tier:full"] })]).refused, [{ number: 1, reason: "lacks ready" }]);
});

test("refuses an issue with no tier label or with two", () => {
  const { refused } = plan([issue(1, { labels: ["ready"] }), issue(2, { labels: ["ready", "tier:quick", "tier:full"] })]);
  assert.deepEqual(refused, [
    { number: 1, reason: "no single tier:* label" },
    { number: 2, reason: "no single tier:* label" },
  ]);
});

test("refuses an issue with an open blocker, naming it", () => {
  const blockers = { code: 1, message: "#1: blocked by #9 (open)" };
  assert.deepEqual(plan([issue(1, { blockers })]).refused, [{ number: 1, reason: "blocked by #9 (open)" }]);
});

test("refuses an issue whose blockers cannot be checked", () => {
  const blockers = { code: 2, message: "#1: cannot check blockers: #9 not found or unreadable" };
  assert.deepEqual(plan([issue(1, { blockers })]).refused, [{ number: 1, reason: "cannot check blockers: #9 not found or unreadable" }]);
});

test("refuses an issue that could not be read", () => {
  assert.deepEqual(plan([{ number: 4, error: "not found or unreadable" }]).refused, [{ number: 4, reason: "not found or unreadable" }]);
});

// Criterion 4: overlapping requested issues are refused together.
test("refuses both issues of an overlapping pair", () => {
  const overlaps = (a, b) => (a === 1 && b === 2) || (a === 2 && b === 1);
  assert.deepEqual(plan([issue(1), issue(2), issue(3)], [], overlaps), {
    launch: [3],
    refused: [
      { number: 1, reason: "overlaps #2" },
      { number: 2, reason: "overlaps #1" },
    ],
  });
});

// Extra edge case: an issue overlapping more than one other lists all of them, in request order.
test("an issue that overlaps two others names both, joined with a comma", () => {
  const overlaps = () => true; // all three mutually overlap
  assert.deepEqual(plan([issue(1), issue(2), issue(3)], [], overlaps).refused, [
    { number: 1, reason: "overlaps #2, #3" },
    { number: 2, reason: "overlaps #1, #3" },
    { number: 3, reason: "overlaps #1, #2" },
  ]);
});

test("an issue refused for another reason does not make its overlap partner refused", () => {
  const overlaps = () => true;
  assert.deepEqual(plan([issue(1, { state: "CLOSED" }), issue(2)], [], overlaps), {
    launch: [2],
    refused: [{ number: 1, reason: "not open" }],
  });
});

// Criterion 5: the cap counts lanes already in flight.
const busy = (n) => Array.from({ length: n }, (_, i) => 101 + i);

test("the default start.maxLanes is 8", () => assert.equal(CAP, 8));

test("refuses requests beyond a total of 8 lanes in flight", () => {
  const { launch, refused } = plan([issue(1), issue(2), issue(3)], busy(6));
  assert.deepEqual(launch, [1, 2]);
  assert.deepEqual(refused, [{ number: 3, reason: "cap of 8 lanes in flight" }]);
});

test("launches one more when 7 lanes are in flight", () => {
  assert.deepEqual(plan([issue(1)], busy(7)), { launch: [1], refused: [] });
});

test("refuses everything when 8 lanes are already in flight", () => {
  assert.deepEqual(plan([issue(1)], busy(8)).refused, [{ number: 1, reason: "cap of 8 lanes in flight" }]);
});

test("edge: more than 8 lanes already in flight refuses without launching", () => {
  assert.deepEqual(plan([issue(1), issue(2)], busy(9)), {
    launch: [],
    refused: [
      { number: 1, reason: "cap of 8 lanes in flight" },
      { number: 2, reason: "cap of 8 lanes in flight" },
    ],
  });
});

test("edge: 8 requests with nothing in flight all launch, a 9th is refused", () => {
  const issues = Array.from({ length: 9 }, (_, i) => issue(i + 1));
  const { launch, refused } = plan(issues, []);
  assert.deepEqual(launch, [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(refused, [{ number: 9, reason: "cap of 8 lanes in flight" }]);
});

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

// Criterion 6: an issue already in flight is refused.
test("refuses an issue that is already in flight", () => {
  assert.deepEqual(plan([issue(5)], [5]).refused, [{ number: 5, reason: "already in flight" }]);
});

// Criterion 9: a mixed batch.
test("a mixed batch launches only what passes, in request order", () => {
  const overlaps = (a, b) => [a, b].sort().join() === "3,4";
  const issues = [issue(1), issue(2, { labels: ["tier:full"] }), issue(3), issue(4), issue(5), issue(6), issue(7)];
  assert.deepEqual(plan(issues, [7, ...busy(5)], overlaps), {
    launch: [1, 5],
    refused: [
      { number: 2, reason: "lacks ready" },
      { number: 3, reason: "overlaps #4" },
      { number: 4, reason: "overlaps #3" },
      { number: 6, reason: "cap of 8 lanes in flight" },
      { number: 7, reason: "already in flight" },
    ],
  });
});

// Criterion 8: exact launch arguments.
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

// Criterion 7 and 9: id parsing.
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

test("parseSessionId returns null when no id is printed", () => {
  assert.equal(parseSessionId(""), null);
  assert.equal(parseSessionId("backgrounded · "), null);
  assert.equal(parseSessionId("error: not logged in"), null);
  assert.equal(parseSessionId(undefined), null);
});

// main, with fakes for gh, claude and git.
const form = ({ scope = "In: `a.mjs`.", blockedBy = "none", contract = "none" } = {}) =>
  ["### Goal", "g", "### Acceptance criteria", "- [ ] a", "### Interface contract", contract, "### Scope", scope, "### Blocked by", blockedBy, "### Tier", "quick"].join("\n\n");

function fakes({ issues = {}, prs = [], mergedPrs = [], sessions = [], launchOut = {}, launchFail = [], agentsFail = false, config, cleanup = () => [], spawnChild, labelFail = null, labelMissing = false } = {}) {
  const launches = [];
  const labeled = [];
  let labelCreated = false;
  const calls = [];
  // Every reaper spawn and log open/close, in order; spawnChild(cmd, args, options) overrides the fake child.
  const reapers = [];
  const logs = [];
  const spawn = (cmd, args, options) => {
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
    return { number: n, state: i.state ?? "OPEN", labels: (i.labels ?? ["ready", "tier:quick"]).map((name) => ({ name })), body: i.body ?? form() };
  };
  const gh = (args) => {
    calls.push(`gh ${args[0]} ${args[1]}`);
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
    if (args[0] === "issue" && args[1] === "list") return JSON.stringify(Object.keys(issues).map(Number).map(view).filter((i) => i.state === "OPEN"));
    if (args[0] === "api") return JSON.stringify({ state: "closed" });
    if (args[0] === "pr" && args[1] === "list") return JSON.stringify(args[args.indexOf("--state") + 1] === "merged" ? mergedPrs : prs);
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
  const claude = (args, opts) => {
    if (args[0] === "agents") {
      if (agentsFail) throw new Error("claude: agents failed");
      return JSON.stringify(sessions);
    }
    launches.push({ args, cwd: opts?.cwd });
    const n = Number(args.at(-1).split(" ")[1]);
    if (launchFail.includes(n)) throw new Error("claude: spawn failed");
    return launchOut[n] ?? `backgrounded · id${n}`;
  };
  const cleanupFake = (options) => {
    calls.push(`cleanup ${JSON.stringify(options)}`);
    return cleanup(options);
  };
  return { deps: { gh, claude, root: () => "/repo", config: () => config, cleanup: cleanupFake, spawn, reaperLog }, launches, calls, reapers, logs, labeled };
}

// #164: one detached reaper per launched lane (ADR 0010).
const reapScript = join("/repo", "scripts", "lanes", "reap.mjs");

// #164 criterion 1: after a launch with a session id, reap.mjs is spawned detached, logging to its own log, and unref'd.
test("main spawns one detached, unref'd reaper per launched lane, logging to the reaper's log", () => {
  const { deps, reapers, logs } = fakes({ issues: { 1: {}, 2: { body: form({ scope: "In: `b.mjs`." }) } } });
  const { code, lines } = main(["1", "2"], deps);
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
test("main spawns no reaper for a launch that printed no session id or failed", () => {
  const { deps, reapers, logs } = fakes({ issues: { 1: {}, 2: { body: form({ scope: "In: `b.mjs`." }) }, 3: { body: form({ scope: "In: `c.mjs`." }) } }, launchOut: { 1: "something went wrong" }, launchFail: [2] });
  const { code } = main(["1", "2", "3"], deps);
  assert.equal(code, 1);
  assert.deepEqual(reapers.map((r) => r.args[2]), ["3"]);
  assert.equal(logs.length, 1);
});

// Extra, not from criteria or a listed edge case: a failed launch interleaved between two successful ones must not
// shift which issue or session id a reaper is attributed to (unlike the run above, where every failure comes first).
test("edge: a failed launch between two successes does not misattribute either reaper's issue or session id", () => {
  const { deps, reapers, logs } = fakes({
    issues: { 1: {}, 2: { body: form({ scope: "In: `b.mjs`." }) }, 3: { body: form({ scope: "In: `c.mjs`." }) } },
    launchFail: [2],
  });
  const { code, lines } = main(["1", "2", "3"], deps);
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

// #164 criterion 3 and 4: the --auto dry run spawns nothing; --auto --go spawns one per launch.
test("--auto (dry run) spawns no reaper, and --auto --go spawns one per launched lane", () => {
  const dry = fakes({ issues: autoIssues(), sessions: [{ kind: "background", cwd: "/repo/.claude/worktrees/issue-6-y" }] });
  main(["--auto"], dry.deps);
  assert.equal(dry.reapers.length, 0);
  assert.equal(dry.logs.length, 0);
  const go = fakes({ issues: autoIssues(), sessions: [{ kind: "background", cwd: "/repo/.claude/worktrees/issue-6-y" }] });
  const { code } = main(["--auto", "--go"], go.deps);
  assert.equal(code, 0);
  assert.deepEqual(go.reapers.map((r) => r.args.slice(1)), [["--issue", "1", "--session", "id1"], ["--issue", "2", "--session", "id2"]]);
});

// #164 criterion 2 and 4: a spawn that throws is reported and does not fail the launch.
test("a reaper spawn that throws prints #N: reaper not started and keeps the launch", () => {
  const { deps, logs } = fakes({ issues: { 1: {} }, spawnChild: () => { throw new Error("spawn EACCES"); } });
  const { code, lines } = main(["1"], deps);
  assert.equal(code, 0);
  assert.deepEqual(lines, ["#1 → id1", "#1: reaper not started: spawn EACCES"]);
  assert.equal(logs[0].closed, true);
});

test("edge: a spawn that returns no pid (its error comes later) is reported, and the later error is swallowed", () => {
  const handlers = {};
  const { deps } = fakes({ issues: { 1: {} }, spawnChild: () => ({ pid: undefined, on(event, fn) { handlers[event] = fn; }, unref() {} }) });
  const { code, lines } = main(["1"], deps);
  assert.equal(code, 0);
  assert.deepEqual(lines, ["#1 → id1", "#1: reaper not started: no process started"]);
  assert.equal(typeof handlers.error, "function");
  assert.doesNotThrow(() => handlers.error(new Error("spawn ENOENT")));
});

test("edge: a reaper log that cannot be opened is reported, spawns nothing, and keeps the launch", () => {
  const { deps, reapers } = fakes({ issues: { 1: {} } });
  deps.reaperLog = () => { throw new Error("EACCES: permission denied, open '.lanes/reap/1.log'"); };
  const { code, lines } = main(["1"], deps);
  assert.equal(code, 0);
  assert.deepEqual(lines, ["#1 → id1", "#1: reaper not started: EACCES: permission denied, open '.lanes/reap/1.log'"]);
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
  const { code, lines } = main(["1", "2"], deps);
  assert.equal(code, 0);
  assert.deepEqual(lines, ["#1 → id1", "#1: reaper not started: spawn EAGAIN", "#2 → id2"]);
  assert.equal(reapers.length, 1);
});

test("edge: a multi-line spawn error is reported as its first line only", () => {
  const { deps } = fakes({ issues: { 1: {} }, spawnChild: () => { throw new Error("spawn failed\nstack line"); } });
  assert.deepEqual(main(["1"], deps).lines, ["#1 → id1", "#1: reaper not started: spawn failed"]);
});

test("main launches from the repository root and prints #N → id", () => {
  const { deps, launches } = fakes({ issues: { 1: {}, 2: { body: form({ scope: "In: `b.mjs`." }) } } });
  const { code, lines } = main(["1", "#2"], deps);
  assert.equal(code, 0);
  assert.deepEqual(lines, ["#1 → id1", "#2 → id2"]);
  assert.deepEqual(launches, [
    { args: [...NAMED(1), "/lane 1"], cwd: "/repo" },
    { args: [...NAMED(2), "/lane 2"], cwd: "/repo" },
  ]);
});

test("main reports a launch with no id as failed and does not retry it", () => {
  const { deps, launches } = fakes({ issues: { 1: {}, 2: { body: form({ scope: "In: `b.mjs`." }) } }, launchOut: { 1: "something went wrong" }, launchFail: [2] });
  const { code, lines } = main(["1", "2"], deps);
  assert.equal(code, 1);
  assert.equal(launches.length, 2);
  assert.match(lines[0], /^#1: launch failed: no session id/);
  assert.match(lines[1], /^#2: launch failed: claude: spawn failed/);
});

test("main launches two issues whose only shared path is a soft path", () => {
  const scope = "In: `docs/USING.md`.";
  const { deps, launches } = fakes({ issues: { 1: { body: form({ scope: "In: `a.mjs`, `docs/USING.md`." }) }, 2: { body: form({ scope: "In: `b.mjs`, `docs/USING.md`." }) }, 3: { body: form({ scope }) } } });
  const { code, lines } = main(["1", "2", "3"], deps);
  assert.equal(code, 0);
  assert.deepEqual(lines, ["#1 → id1", "#2 → id2", "#3 → id3"]);
  assert.equal(launches.length, 3);
});

test("main still refuses a pair sharing a hard path alongside a soft one", () => {
  const { deps, launches } = fakes({ issues: { 1: { body: form({ scope: "In: `a.mjs`, `docs/USING.md`." }) }, 2: { body: form({ scope: "In: `a.mjs`, `docs/USING.md`." }) } } });
  assert.deepEqual(main(["1", "2"], deps).lines, ["#1: refused: overlaps #2", "#2: refused: overlaps #1"]);
  assert.equal(launches.length, 0);
});

test("edge: an issue whose only path is soft does not overlap and a custom softPaths applies", () => {
  const { deps } = fakes({ issues: { 1: { body: form({ scope: "In: `x/notes.md`." }) }, 2: { body: form({ scope: "In: `x/notes.md`." }) } }, config: { start: { softPaths: ["notes\\.md$"] } } });
  assert.equal(main(["1", "2"], deps).code, 0);
});

test("main refuses overlapping issues using the /status overlap check", () => {
  const { deps, launches } = fakes({ issues: { 1: {}, 2: {} } });
  const { lines } = main(["1", "2"], deps);
  assert.deepEqual(lines, ["#1: refused: overlaps #2", "#2: refused: overlaps #1"]);
  assert.equal(launches.length, 0);
});

test("main counts in-flight lanes from PRs and sessions", () => {
  const { deps } = fakes({
    issues: { 1: {}, 2: { body: form({ scope: "In: `b.mjs`." }) } },
    prs: [8, 10, 11, 12, 13, 14].map((n) => ({ headRefName: `issue-${n}-x` })),
    sessions: [{ kind: "background", cwd: "/repo/.claude/worktrees/issue-9-y" }, { kind: "background", cwd: "/repo/.claude/worktrees/issue-1-z" }],
  });
  const { lines } = main(["1", "2"], deps);
  assert.deepEqual(lines, ["#1: refused: already in flight", "#2: refused: cap of 8 lanes in flight"]);
});

test("main reads a coloured `backgrounded · <id>` line as launched", () => {
  const { deps } = fakes({ issues: { 62: {} }, launchOut: { 62: "\x1b[2mbackgrounded · \x1b[0m\x1b[1mc0ffee12\x1b[22m\n" } });
  const { code, lines } = main(["62"], deps);
  assert.equal(code, 0);
  assert.deepEqual(lines, ["#62 → c0ffee12"]);
});

test("main does not count a merged lane's leftover session, or one whose issue is closed", () => {
  const leftovers = [20, 21, 22, 23, 24, 25, 26, 27].map((n) => ({ kind: "background", cwd: `/repo/.claude/worktrees/issue-${n}-done` }));
  const { deps, launches } = fakes({
    issues: { 1: {}, 24: { state: "CLOSED" }, 25: { state: "CLOSED" }, 26: { state: "CLOSED" }, 27: { state: "CLOSED" } },
    mergedPrs: [20, 21, 22, 23].map((n) => ({ headRefName: `issue-${n}-done` })),
    prs: [{ headRefName: "issue-30-open" }],
    sessions: [...leftovers, { kind: "background", cwd: "/repo/.claude/worktrees/issue-31-running" }],
  });
  const { code, lines } = main(["1"], deps);
  assert.equal(code, 0);
  assert.deepEqual(lines, ["#1 → id1"]);
  assert.equal(launches.length, 1);
});

test("edge: a session whose issue cannot be read still counts, so an unknown state never frees a slot", () => {
  const sessions = [9, 10, 11, 12, 13, 14, 15, 16].map((n) => ({ kind: "background", cwd: `/repo/.claude/worktrees/issue-${n}-x` }));
  const { deps, launches } = fakes({ issues: { 1: {} }, sessions });
  assert.deepEqual(main(["1"], deps).lines, ["#1: refused: cap of 8 lanes in flight"]);
  assert.equal(launches.length, 0);
});

test("edge: an open issue with no merged PR keeps its session in flight", () => {
  const { deps } = fakes({ issues: { 1: {}, 5: {} }, mergedPrs: [{ headRefName: "issue-50-other" }], sessions: [{ kind: "background", cwd: "/repo/.claude/worktrees/issue-5-x" }] });
  assert.deepEqual(main(["5"], deps).lines, ["#5: refused: already in flight"]);
});

test("edge: main launches nothing when the merged-PR list cannot be read", () => {
  const { deps, launches } = fakes({ issues: { 1: {} }, sessions: [{ kind: "background", cwd: "/repo/.claude/worktrees/issue-5-x" }] });
  const gh = deps.gh;
  deps.gh = (args) => {
    if (args[0] === "pr" && args.includes("merged")) throw new Error("gh: rate limited");
    return gh(args);
  };
  const { code, lines } = main(["1"], deps);
  assert.equal(code, 2);
  assert.match(lines[0], /cannot count lanes in flight.*gh: rate limited/);
  assert.equal(launches.length, 0);
});

test("main does not refuse two issues whose contracts only read the same file", () => {
  const contract = "none (reads `contracts/adr-template.md` from #44)";
  const { deps } = fakes({ issues: { 45: { body: form({ contract, scope: "In: `a.mjs`." }) }, 46: { body: form({ contract, scope: "In: `b.mjs`." }) } } });
  assert.deepEqual(main(["45", "46"], deps).lines, ["#45 → id45", "#46 → id46"]);
});

test("main refuses an unreadable issue and an open blocker", () => {
  const { deps } = fakes({ issues: { 3: { body: form({ blockedBy: "#9" }) } } });
  deps.gh = ((inner) => (args) => (args[0] === "api" ? JSON.stringify({ state: "open" }) : inner(args)))(deps.gh);
  const { lines } = main(["4", "3"], deps);
  assert.deepEqual(lines, ["#4: refused: not found or unreadable", "#3: refused: blocked by #9 (open)"]);
});

test("main launches nothing when it cannot count lanes in flight", () => {
  const { deps, launches } = fakes({ issues: { 1: {} }, agentsFail: true });
  const { code, lines } = main(["1"], deps);
  assert.equal(code, 2);
  assert.match(lines[0], /cannot count lanes in flight/);
  assert.equal(launches.length, 0);
});

// Edge case: the earlier gh pr list call can fail too, not just the claude agents call.
test("main launches nothing when the open-PR list may be truncated", () => {
  const prs = Array.from({ length: 1000 }, (_, i) => ({ headRefName: `feature-${i}` }));
  const { deps, launches } = fakes({ issues: { 1: {} }, prs });
  const { code, lines } = main(["1"], deps);
  assert.equal(code, 2);
  assert.match(lines[0], /cannot count lanes in flight.*1000\+ open PRs/);
  assert.equal(launches.length, 0);
});

test("main launches nothing when the open-PR list cannot be read", () => {
  const { deps, launches } = fakes({ issues: { 1: {} } });
  const gh = deps.gh;
  deps.gh = (args) => {
    if (args[0] === "pr" && args[1] === "list") throw new Error("gh: rate limited");
    return gh(args);
  };
  const { code, lines } = main(["1"], deps);
  assert.equal(code, 2);
  assert.match(lines[0], /cannot count lanes in flight.*gh: rate limited/);
  assert.equal(launches.length, 0);
});

test("main rejects bad arguments and ignores duplicates", () => {
  assert.equal(main([], fakes().deps).code, 2);
  assert.equal(main(["abc"], fakes().deps).code, 2);
  assert.equal(main(["0"], fakes().deps).code, 2);
  const { deps, launches } = fakes({ issues: { 1: {} } });
  assert.deepEqual(main(["1", "#1"], deps).lines, ["#1 → id1"]);
  assert.equal(launches.length, 1);
});

// #149: explicit numbers are also checked against open lane PRs and running lanes, as --auto does.
const runningSession = (n) => ({ kind: "background", cwd: `/repo/.claude/worktrees/issue-${n}-x` });
const prFor = (n, ...files) => ({ number: n + 100, headRefName: `issue-${n}-x`, files: files.map((path) => ({ path })) });

test("planStart refuses an issue whose running overlap reason is given, and does not compare it further", () => {
  const running = (n) => (n === 1 ? "overlaps running #7 on a.mjs" : null);
  const { launch, refused } = planStart({ issues: [issue(1), issue(2)], inFlight: [], overlaps: (a, b) => a + b === 3, running });
  assert.deepEqual(launch, [2]);
  assert.deepEqual(refused, [{ number: 1, reason: "overlaps running #7 on a.mjs" }]);
});

test("main refuses an issue that overlaps the files an open lane PR changes", () => {
  const { deps, launches } = fakes({ issues: { 1: { body: form({ scope: "In: `a.mjs`." }) } }, prs: [prFor(7, "a.mjs", "z.mjs")] });
  const { code, lines } = main(["1"], deps);
  assert.equal(code, 1);
  assert.deepEqual(lines, ["#1: refused: overlaps running #107 on a.mjs"]);
  assert.equal(launches.length, 0);
});

test("main refuses an issue that overlaps the Scope of a running lane with no PR", () => {
  const { deps, launches } = fakes({
    issues: { 1: { body: form({ scope: "In: `a.mjs`." }) }, 9: { body: form({ scope: "In: `a.mjs`, `b.mjs`." }) } },
    sessions: [runningSession(9)],
  });
  const { code, lines } = main(["1"], deps);
  assert.equal(code, 1);
  assert.deepEqual(lines, ["#1: refused: overlaps running #9 on a.mjs"]);
  assert.equal(launches.length, 0);
});

test("main ignores a soft path shared with running work", () => {
  const { deps } = fakes({
    issues: { 1: { body: form({ scope: "In: `docs/USING.md`." }) }, 9: { body: form({ scope: "In: `docs/USING.md`." }) } },
    prs: [prFor(7, "README.md", "docs/USING.md")],
    sessions: [runningSession(9)],
  });
  const { code, lines } = main(["1"], deps);
  assert.equal(code, 0);
  assert.deepEqual(lines, ["#1 → id1"]);
});

test("main launches an issue that overlaps no running work", () => {
  const { deps } = fakes({
    issues: { 1: { body: form({ scope: "In: `a.mjs`." }) }, 9: { body: form({ scope: "In: `b.mjs`." }) } },
    prs: [prFor(7, "c.mjs")],
    sessions: [runningSession(9)],
  });
  assert.deepEqual(main(["1"], deps).lines, ["#1 → id1"]);
});

test("edge: a running lane's Scope directory overlaps a requested file under it", () => {
  const { deps } = fakes({ issues: { 1: { body: form({ scope: "In: `src/x.mjs`." }) } }, prs: [prFor(7, "src/y.mjs")] });
  assert.deepEqual(main(["1"], deps).lines, ["#1 → id1"]);
  const dir = fakes({ issues: { 1: { body: form({ scope: "In: `src/`." }) } }, prs: [prFor(7, "src/y.mjs")] });
  assert.deepEqual(main(["1"], dir.deps).lines, ["#1: refused: overlaps running #107 on src/"]);
});

test("edge: only the overlapping requested issue is refused, the others launch", () => {
  const { deps, launches } = fakes({
    issues: { 1: { body: form({ scope: "In: `a.mjs`." }) }, 2: { body: form({ scope: "In: `b.mjs`." }) } },
    prs: [prFor(7, "a.mjs")],
  });
  const { code, lines } = main(["1", "2"], deps);
  assert.equal(code, 1);
  assert.deepEqual(lines, ["#1: refused: overlaps running #107 on a.mjs", "#2 → id2"]);
  assert.equal(launches.length, 1);
});

test("edge: a requested issue refused for running overlap does not refuse its requested partner", () => {
  const { deps } = fakes({
    issues: { 1: { body: form({ scope: "In: `a.mjs`, `c.mjs`." }) }, 2: { body: form({ scope: "In: `c.mjs`." }) } },
    prs: [prFor(7, "a.mjs")],
  });
  assert.deepEqual(main(["1", "2"], deps).lines, ["#1: refused: overlaps running #107 on a.mjs", "#2 → id2"]);
});

test("edge: an issue whose Scope names no paths is not refused for running overlap", () => {
  const { deps } = fakes({ issues: { 1: { body: form({ scope: "the whole repo" }) } }, prs: [prFor(7, "a.mjs")] });
  assert.deepEqual(main(["1"], deps).lines, ["#1 → id1"]);
});

test("edge: a contract path (not in Scope) overlaps an open PR's files and a running lane's contract", () => {
  const viaPr = fakes({ issues: { 1: { body: form({ scope: "In: `b.mjs`.", contract: "Exports in `a.mjs`." }) } }, prs: [prFor(7, "a.mjs")] });
  assert.deepEqual(main(["1"], viaPr.deps).lines, ["#1: refused: overlaps running #107 on a.mjs"]);
  const viaRunning = fakes({
    issues: { 1: { body: form({ scope: "In: `b.mjs`." }) }, 9: { body: form({ scope: "In: `c.mjs`.", contract: "Exports in `b.mjs`." }) } },
    sessions: [runningSession(9)],
  });
  assert.deepEqual(main(["1"], viaRunning.deps).lines, ["#1: refused: overlaps running #9 on b.mjs"]);
});

// #444: an open PR with no live session is a dead lane, and /start says how to resume it.
test("#444: an issue with an open PR and no session is refused as a dead lane, naming the queue", () => {
  const { deps, launches } = fakes({ issues: { 1: { body: form({ scope: "In: `a.mjs`." }) } }, prs: [prFor(1, "a.mjs")] });
  const { code, lines } = main(["1"], deps);
  assert.equal(code, 1);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^#1: refused: already in flight: dead lane with open PR #\d+ and no live session; run the queue \(node scripts\/lanes\/queue\.mjs\)/);
  assert.equal(launches.length, 0);
});

test("#444: edge: an open PR whose newest session is idle is a dead lane, and a blocked one is not", () => {
  const base = { issues: { 1: { body: form({ scope: "In: `a.mjs`." }) } }, prs: [prFor(1, "a.mjs")] };
  const cwd = "/repo/.claude/worktrees/issue-1-x";
  const idle = fakes({ ...base, sessions: [{ kind: "background", status: "idle", cwd }] });
  assert.match(main(["1"], idle.deps).lines[0], /dead lane with open PR/);
  const blocked = fakes({ ...base, sessions: [{ kind: "background", status: "idle", state: "blocked", cwd }] });
  assert.deepEqual(main(["1"], blocked.deps).lines, ["#1: refused: already in flight"]);
});

// #448: --auto names a dead lane with the same text /start <N> prints.
test("#448: --auto skips a dead lane with the same text /start <N> prints", () => {
  const base = { issues: { 1: { body: form({ scope: "In: `a.mjs`." }) } }, prs: [prFor(1, "a.mjs")] };
  const viaAuto = main(["--auto"], fakes(base).deps).lines[0];
  const viaStart = main(["1"], fakes(base).deps).lines[0];
  assert.match(viaAuto, /^#1: skipped: already in flight: dead lane with open PR #\d+ and no live session; run the queue/);
  assert.equal(viaAuto.replace(": skipped: ", ": refused: "), viaStart);
});

test("#448: --auto still prints plain already in flight for a live lane", () => {
  const { deps } = fakes({
    issues: { 1: { body: form({ scope: "In: `a.mjs`." }) } },
    prs: [prFor(1, "a.mjs")],
    sessions: [{ kind: "background", status: "busy", cwd: "/repo/.claude/worktrees/issue-1-x" }],
  });
  assert.equal(main(["--auto"], deps).lines[0], "#1: skipped: already in flight");
});

test("#448: edge: --auto --go names a dead lane too and launches nothing for it", () => {
  const { deps, launches } = fakes({ issues: { 1: { body: form({ scope: "In: `a.mjs`." }) } }, prs: [prFor(1, "a.mjs")] });
  const { lines } = main(["--auto", "--go"], deps);
  assert.match(lines[0], /^#1: skipped: already in flight: dead lane with open PR/);
  assert.equal(launches.length, 0);
});

test("edge: a requested issue that already has an open PR is refused as in flight, not as overlapping its own PR", () => {
  const { deps, launches } = fakes({ issues: { 1: { body: form({ scope: "In: `a.mjs`." }) } }, prs: [prFor(1, "a.mjs")], sessions: [{ kind: "background", status: "busy", cwd: "/repo/.claude/worktrees/issue-1-x" }] });
  const { code, lines } = main(["1"], deps);
  assert.equal(code, 1);
  assert.deepEqual(lines, ["#1: refused: already in flight"]);
  assert.equal(launches.length, 0);
});

test("edge: a soft path is ignored but a hard path shared with the same PR still refuses", () => {
  const { deps } = fakes({
    issues: { 1: { body: form({ scope: "In: `docs/USING.md`, `a.mjs`." }) } },
    prs: [prFor(7, "docs/USING.md", "a.mjs")],
  });
  assert.deepEqual(main(["1"], deps).lines, ["#1: refused: overlaps running #107 on a.mjs"]);
});

test("edge: main launches nothing when the open issues cannot be read", () => {
  const { deps, launches } = fakes({ issues: { 1: {} } });
  const gh = deps.gh;
  deps.gh = (args) => {
    if (args[0] === "issue" && args[1] === "list") throw new Error("gh: rate limited");
    return gh(args);
  };
  const { code, lines } = main(["1"], deps);
  assert.equal(code, 2);
  assert.match(lines[0], /cannot check running lanes, nothing launched.*gh: rate limited/);
  assert.equal(launches.length, 0);
});

test("edge: main launches nothing when the open-issue list may be truncated", () => {
  const { deps, launches } = fakes({ issues: { 1: {} } });
  const gh = deps.gh;
  deps.gh = (args) => (args[0] === "issue" && args[1] === "list" ? JSON.stringify(Array.from({ length: 1000 }, (_, i) => ({ number: 5000 + i }))) : gh(args));
  const { code, lines } = main(["1"], deps);
  assert.equal(code, 2);
  assert.match(lines[0], /cannot check running lanes.*1000\+ open issues/);
  assert.equal(launches.length, 0);
});

test("start.md step 1 says running lanes and open PRs are compared too", () => {
  const md = readFileSync(new URL("../../.claude/commands/start.md", import.meta.url), "utf8");
  const step1 = md.split(/^2\. /m)[0].replace(/\s+/g, " ");
  assert.match(step1, /running lanes and open PRs/);
});

// Criterion 10.
test("docs/USING.md describes /start", () => {
  const doc = readFileSync(new URL("../../docs/USING.md", import.meta.url), "utf8");
  assert.match(doc, /`\/start/);
});

// #54 criterion 1: the start block in lanes.config.json, its defaults and its bounds.
test("lanes.config.json has the start block with maxLanes 8 and the two soft paths", () => {
  const raw = JSON.parse(readFileSync(new URL("../../lanes.config.json", import.meta.url), "utf8"));
  assert.equal(raw.start.maxLanes, 8);
  assert.deepEqual(raw.start.softPaths, ["^docs/USING\\.md$", "^README\\.md$", "^lanes\\.config\\.json$"]);
  assert.deepEqual(startConfig(raw), raw.start);
});

test("startConfig falls back to the defaults when the start block or a key is missing", () => {
  const defaults = { maxLanes: 8, softPaths: ["^docs/USING\\.md$", "^README\\.md$", "^lanes\\.config\\.json$"], models: {} };
  assert.deepEqual(START_DEFAULTS, defaults);
  assert.deepEqual(startConfig(undefined), defaults);
  assert.deepEqual(startConfig({}), defaults);
  assert.deepEqual(startConfig({ start: {} }), defaults);
  assert.deepEqual(startConfig({ start: { maxLanes: 3 } }), { ...defaults, maxLanes: 3 });
  assert.deepEqual(startConfig({ start: { softPaths: [] } }), { ...defaults, softPaths: [] });
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

// Extra, not from criteria or a listed edge case: this repository's actual lanes.config.json, run through main()
// end to end (not a hand-built fixture), launches each tier on the model criterion 3 requires.
test("edge: main launches on the models from this repository's own lanes.config.json", () => {
  const config = JSON.parse(readFileSync(new URL("../../lanes.config.json", import.meta.url), "utf8"));
  const issues = {
    1: { labels: ["ready", "tier:skip"], body: form({ scope: "In: `a.mjs`." }) },
    2: { labels: ["ready", "tier:quick"], body: form({ scope: "In: `b.mjs`." }) },
    3: { labels: ["ready", "tier:full"], body: form({ scope: "In: `c.mjs`." }) },
  };
  const { deps, launches } = fakes({ issues, config });
  const { code } = main(["1", "2", "3"], deps);
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

test("main launches nothing when start.maxLanes is out of bounds, in either mode", () => {
  for (const argv of [["1"], ["--auto"], ["--auto", "--go"]]) {
    const { deps, launches } = fakes({ issues: { 1: {} }, config: { start: { maxLanes: 11 } } });
    const { code, lines } = main(argv, deps);
    assert.equal(code, 2, argv.join(" "));
    assert.match(lines[0], /nothing launched: lanes\.config\.json: start\.maxLanes/);
    assert.equal(launches.length, 0);
  }
});

test("edge: main launches nothing when lanes.config.json cannot be read", () => {
  const { deps, launches } = fakes({ issues: { 1: {} } });
  deps.config = () => {
    throw new Error("Unexpected token } in JSON");
  };
  const { code, lines } = main(["1"], deps);
  assert.equal(code, 2);
  assert.match(lines[0], /cannot read lanes\.config\.json, nothing launched: Unexpected token/);
  assert.equal(launches.length, 0);
});

// #54 criterion 2: the cap comes from start.maxLanes, for explicit /start and --auto.
test("planStart takes its cap from maxLanes", () => {
  const { launch, refused } = planStart({ issues: [issue(1), issue(2), issue(3)], inFlight: [101], overlaps: never, maxLanes: 3 });
  assert.deepEqual(launch, [1, 2]);
  assert.deepEqual(refused, [{ number: 3, reason: "cap of 3 lanes in flight" }]);
});

test("explicit /start uses start.maxLanes from the config", () => {
  const { deps, launches } = fakes({
    issues: { 1: {}, 2: { body: form({ scope: "In: `b.mjs`." }) } },
    prs: [{ number: 50, headRefName: "issue-9-x" }],
    config: { start: { maxLanes: 2 } },
  });
  const { code, lines } = main(["1", "2"], deps);
  assert.equal(code, 1);
  assert.deepEqual(lines, ["#1 → id1", "#2: refused: cap of 2 lanes in flight"]);
  assert.equal(launches.length, 1);
});

test("--auto uses start.maxLanes from the config", () => {
  const { deps } = fakes({
    issues: { 1: {}, 2: { body: form({ scope: "In: `b.mjs`." }) }, 3: { body: form({ scope: "In: `c.mjs`." }) } },
    config: { start: { maxLanes: 1 } },
  });
  const { lines } = main(["--auto"], deps);
  assert.deepEqual(lines.slice(0, 3), ["#1: would start", "#2: skipped: cap of 1 lanes reached", "#3: skipped: cap of 1 lanes reached"]);
});

// #54 criterion 3: --auto is a dry run that prints the plan and launches nothing.
const autoIssues = () => ({
  1: {},
  2: { body: form({ scope: "In: `b.mjs`." }) },
  3: {}, // overlaps #1 on a.mjs
  4: { labels: ["tier:quick"], body: form({ scope: "In: `d.mjs`." }) }, // not ready: not a candidate at all
  5: { labels: ["ready"], body: form({ scope: "In: `e.mjs`." }) },
  6: { body: form({ scope: "In: `f.mjs`." }) }, // in flight
  7: { body: form({ scope: "Nothing here." }) },
});

test("--auto prints one line per pick and per skipped ready issue, and launches nothing", () => {
  const { deps, launches } = fakes({ issues: autoIssues(), sessions: [{ kind: "background", cwd: "/repo/.claude/worktrees/issue-6-y" }] });
  const { code, lines } = main(["--auto"], deps);
  assert.equal(code, 0);
  assert.equal(launches.length, 0);
  assert.deepEqual(lines, [
    "#1: would start",
    "#2: would start",
    "#3: skipped: overlaps #1 on a.mjs",
    "#5: skipped: no single tier:* label",
    "#6: skipped: already in flight",
    "#7: skipped: scope names no paths",
    "dry run, nothing launched: /start --auto --go launches the 2 marked would start",
  ]);
});

// Not named by the issue's criteria or its listed edge cases: --auto shares readInFlight with explicit /start, so a
// merged lane's leftover session must free the issue there too, not only when the issue number is requested directly.
test("--auto ignores a merged lane's leftover session too, so that issue is a candidate instead of already in flight", () => {
  const { deps, launches } = fakes({
    issues: autoIssues(),
    mergedPrs: [{ headRefName: "issue-6-done" }],
    sessions: [{ kind: "background", cwd: "/repo/.claude/worktrees/issue-6-y" }],
  });
  const { code, lines } = main(["--auto"], deps);
  assert.equal(code, 0);
  assert.equal(launches.length, 0);
  assert.ok(lines.includes("#6: would start"), lines.join("\n"));
  assert.ok(!lines.some((l) => l.startsWith("#6: skipped")), lines.join("\n"));
});

test("--auto skips a ready issue with an open blocker", () => {
  const { deps } = fakes({ issues: { 1: { body: form({ blockedBy: "#9" }) } } });
  deps.gh = ((inner) => (args) => (args[0] === "api" ? JSON.stringify({ state: "open" }) : inner(args)))(deps.gh);
  assert.deepEqual(main(["--auto"], deps).lines[0], "#1: skipped: blocked by #9 (open)");
});

test("--auto skips an issue whose paths an open PR already changes", () => {
  const { deps } = fakes({
    issues: { 1: {}, 2: { body: form({ scope: "In: `b.mjs`." }) } },
    prs: [{ number: 40, headRefName: "issue-9-x", files: [{ path: "a.mjs" }] }],
  });
  assert.deepEqual(main(["--auto"], deps).lines.slice(0, 2), ["#2: would start", "#1: skipped: overlaps running #40 on a.mjs"]);
});

test("--auto skips an issue that overlaps a running lane with no PR yet", () => {
  const { deps } = fakes({
    issues: { 1: {}, 9: { body: form({ scope: "In: `a.mjs`, `z.mjs`." }) } },
    sessions: [{ kind: "background", cwd: "/repo/.claude/worktrees/issue-9-y" }],
  });
  assert.deepEqual(main(["--auto"], deps).lines.slice(0, 2), ["#1: skipped: overlaps running #9 on a.mjs", "#9: skipped: already in flight"]);
});

test("--auto does not count a soft path from the config as an overlap", () => {
  const issues = { 1: { body: form({ scope: "In: `a.mjs`, `docs/USING.md`." }) }, 2: { body: form({ scope: "In: `b.mjs`, `docs/USING.md`." }) } };
  assert.deepEqual(main(["--auto"], fakes({ issues }).deps).lines.slice(0, 2), ["#1: would start", "#2: would start"]);
  const strict = fakes({ issues, config: { start: { softPaths: [] } } });
  assert.deepEqual(main(["--auto"], strict.deps).lines.slice(0, 2), ["#1: would start", "#2: skipped: overlaps #1 on docs/USING.md"]);
});

test("edge: --auto with no ready issues says so and launches nothing", () => {
  const { deps, launches } = fakes({ issues: { 4: { labels: ["tier:quick"] } } });
  const { code, lines } = main(["--auto", "--go"], deps);
  assert.equal(code, 0);
  assert.deepEqual(lines, ["no ready issues to start"]);
  assert.equal(launches.length, 0);
});

// Extra case: not in the criteria or the edge cases above. Ready issues exist but every one of them is skipped
// (none reach pickStartable as a candidate), so nothing is picked; the dry run must still say so explicitly rather
// than printing only the skip lines, and --go must launch nothing without printing a stray trailer.
test("edge: --auto is a dry run that says so when every ready issue is skipped", () => {
  const { deps, launches } = fakes({ issues: { 1: { body: form({ blockedBy: "#9" }) } } });
  deps.gh = ((inner) => (args) => (args[0] === "api" ? JSON.stringify({ state: "open" }) : inner(args)))(deps.gh);
  const { code, lines } = main(["--auto"], deps);
  assert.equal(code, 0);
  assert.deepEqual(lines, ["#1: skipped: blocked by #9 (open)", "dry run: nothing to start"]);
  assert.equal(launches.length, 0);
});

test("edge: --auto --go launches nothing when every ready issue is skipped", () => {
  const { deps, launches } = fakes({ issues: { 1: { body: form({ blockedBy: "#9" }) } } });
  deps.gh = ((inner) => (args) => (args[0] === "api" ? JSON.stringify({ state: "open" }) : inner(args)))(deps.gh);
  const { code, lines } = main(["--auto", "--go"], deps);
  assert.equal(code, 0);
  assert.deepEqual(lines, ["#1: skipped: blocked by #9 (open)"]);
  assert.equal(launches.length, 0);
});

test("edge: --auto launches nothing when it cannot gather the plan", () => {
  for (const failing of ["agents", "issue list", "pr list"]) {
    const { deps, launches } = fakes({ issues: { 1: {} }, agentsFail: failing === "agents" });
    const gh = deps.gh;
    deps.gh = (args) => {
      if (`${args[0]} ${args[1]}` === failing) throw new Error("gh: rate limited");
      return gh(args);
    };
    const { code, lines } = main(["--auto", "--go"], deps);
    assert.equal(code, 2, failing);
    assert.match(lines[0], /cannot gather the plan, nothing launched/);
    assert.equal(launches.length, 0);
  }
});

test("edge: --auto launches nothing when the open-issue list may be truncated", () => {
  const { deps, launches } = fakes();
  const gh = deps.gh;
  deps.gh = (args) => (args[0] === "issue" && args[1] === "list" ? JSON.stringify(Array.from({ length: 1000 }, (_, i) => ({ number: i + 1, state: "OPEN", labels: [], body: "" }))) : gh(args));
  const { code, lines } = main(["--auto", "--go"], deps);
  assert.equal(code, 2);
  assert.match(lines[0], /1000\+ open issues/);
  assert.equal(launches.length, 0);
});

test("edge: --auto and --go take no other arguments", () => {
  for (const argv of [["--go"], ["--auto", "1"], ["1", "--auto"], ["--auto", "--go", "--go"], ["--auto", "--bogus"], ["--go", "--auto"]]) {
    const { deps, launches } = fakes({ issues: { 1: {} } });
    const { code, lines } = main(argv, deps);
    assert.equal(code, 2, argv.join(" "));
    assert.match(lines[0], /^usage:/);
    assert.equal(launches.length, 0);
  }
});

// #54 criterion 4: --go recomputes the plan and launches exactly its picks, as explicit /start does.
test("--auto --go launches exactly the dry run's picks, from the repository root, and prints #N → id", () => {
  const sessions = [{ kind: "background", cwd: "/repo/.claude/worktrees/issue-6-y" }];
  const dry = main(["--auto"], fakes({ issues: autoIssues(), sessions }).deps);
  const picks = dry.lines.filter((l) => l.endsWith(": would start")).map((l) => Number(l.slice(1, l.indexOf(":"))));
  assert.deepEqual(picks, [1, 2]);
  const { deps, launches } = fakes({ issues: autoIssues(), sessions });
  const { code, lines } = main(["--auto", "--go"], deps);
  assert.equal(code, 0);
  assert.deepEqual(launches, picks.map((n) => ({ args: launchArgs(n), cwd: "/repo" })));
  assert.deepEqual(lines, [...picks.map((n) => `#${n} → id${n}`), ...dry.lines.filter((l) => l.includes(": skipped: "))]);
});

// #153 criterion 2, end to end: each lane launches on its own issue's tier model.
test("main launches each issue on its tier's model from start.models, in both modes", () => {
  const config = { start: { models: { skip: "haiku", quick: "sonnet" } } };
  const issues = {
    1: { labels: ["ready", "tier:skip"], body: form({ scope: "In: `a.mjs`." }) },
    2: { labels: ["ready", "tier:quick"], body: form({ scope: "In: `b.mjs`." }) },
    3: { labels: ["ready", "tier:full"], body: form({ scope: "In: `c.mjs`." }) },
  };
  const expected = [
    { args: [...NAMED(1), "--model", "haiku", "/lane 1"], cwd: "/repo" },
    { args: [...NAMED(2), "--model", "sonnet", "/lane 2"], cwd: "/repo" },
    { args: [...NAMED(3), "/lane 3"], cwd: "/repo" },
  ];
  for (const argv of [["1", "2", "3"], ["--auto", "--go"]]) {
    const { deps, launches } = fakes({ issues, config });
    const { code } = main(argv, deps);
    assert.equal(code, 0, argv.join(" "));
    assert.deepEqual(launches, expected, argv.join(" "));
  }
});

// #260: a model:opus label launches the lane on Opus over its tier's model; any other model:* label is ignored.
test("main launches a model:opus issue on opus over its tier's model, in both modes", () => {
  const config = { start: { models: { quick: "sonnet", full: "sonnet" } } };
  const issues = {
    1: { labels: ["ready", "tier:full", "model:opus"], body: form({ scope: "In: `a.mjs`." }) },
    2: { labels: ["ready", "tier:quick", "model:opus"], body: form({ scope: "In: `b.mjs`." }) },
    3: { labels: ["ready", "tier:full"], body: form({ scope: "In: `c.mjs`." }) },
  };
  const expected = [
    { args: [...NAMED(1), "--model", "opus", "/lane 1"], cwd: "/repo" },
    { args: [...NAMED(2), "--model", "opus", "/lane 2"], cwd: "/repo" },
    { args: [...NAMED(3), "--model", "sonnet", "/lane 3"], cwd: "/repo" },
  ];
  for (const argv of [["1", "2", "3"], ["--auto", "--go"]]) {
    const { deps, launches } = fakes({ issues, config });
    assert.equal(main(argv, deps).code, 0, argv.join(" "));
    assert.deepEqual(launches, expected, argv.join(" "));
  }
});

test("model:opus launches on opus even when start.models sets no model", () => {
  const { deps, launches } = fakes({ issues: { 1: { labels: ["ready", "tier:full", "model:opus"] } } });
  assert.equal(main(["1"], deps).code, 0);
  assert.deepEqual(launches, [{ args: [...NAMED(1), "--model", "opus", "/lane 1"], cwd: "/repo" }]);
});

test("an unknown model:* label is ignored, logged once, and never reaches claude --model", () => {
  const config = { start: { models: { full: "sonnet" } } };
  const issues = { 1: { labels: ["ready", "tier:full", "model:--dangerously", "model:haiku"] } };
  for (const argv of [["1"], ["--auto", "--go"]]) {
    const { deps, launches } = fakes({ issues, config });
    const { code, lines } = main(argv, deps);
    assert.equal(code, 0, argv.join(" "));
    assert.deepEqual(launches, [{ args: [...NAMED(1), "--model", "sonnet", "/lane 1"], cwd: "/repo" }], argv.join(" "));
    assert.deepEqual(lines, ["#1: ignored label model:--dangerously", "#1: ignored label model:haiku", "#1 → id1"], argv.join(" "));
  }
});

test("edge: model:opus beside an unknown model:* label still launches on opus and logs the unknown one", () => {
  const { deps, launches } = fakes({ issues: { 1: { labels: ["ready", "tier:full", "model:opus", "model:x"] } } });
  const { lines } = main(["1"], deps);
  assert.deepEqual(launches, [{ args: [...NAMED(1), "--model", "opus", "/lane 1"], cwd: "/repo" }]);
  assert.deepEqual(lines, ["#1: ignored label model:x", "#1 → id1"]);
});

test("edge: an ignored model:* label's control characters cannot reach the log line", () => {
  const { deps } = fakes({ issues: { 1: { labels: ["ready", "tier:full", "model:x\x1b[2J\nfake"] } } });
  const { lines } = main(["1"], deps);
  assert.deepEqual(lines, ["#1: ignored label model:x?[2J?fake", "#1 → id1"]);
});

test("launchArgs puts --model opus first when opus is set, over the tier's model", () => {
  assert.deepEqual(launchArgs(18, { tier: "full", models: { full: "sonnet" }, opus: true }), [...NAMED(18), "--model", "opus", "/lane 18"]);
  assert.deepEqual(launchArgs(18, { tier: "full", models: { full: "sonnet" }, opus: false }), [...NAMED(18), "--model", "sonnet", "/lane 18"]);
});

test("main launches with no --model when lanes.config.json sets no models", () => {
  const { deps, launches } = fakes({ issues: { 1: { labels: ["ready", "tier:full"] } } });
  assert.equal(main(["1"], deps).code, 0);
  assert.deepEqual(launches, [{ args: [...NAMED(1), "/lane 1"], cwd: "/repo" }]);
});

test("edge: main launches nothing when start.models is malformed, in either mode", () => {
  for (const argv of [["1"], ["--auto", "--go"]]) {
    const { deps, launches } = fakes({ issues: { 1: {} }, config: { start: { models: { medium: "sonnet" } } } });
    const { code, lines } = main(argv, deps);
    assert.equal(code, 2, argv.join(" "));
    assert.match(lines[0], /nothing launched: .*start\.models: unknown tier/);
    assert.equal(launches.length, 0);
  }
});

test("edge: --auto --go reports a failed launch, does not retry it, and exits 1", () => {
  const { deps, launches } = fakes({ issues: { 1: {}, 2: { body: form({ scope: "In: `b.mjs`." }) } }, launchFail: [1] });
  const { code, lines } = main(["--auto", "--go"], deps);
  assert.equal(code, 1);
  assert.equal(launches.length, 2);
  assert.deepEqual(lines, ["#1: launch failed: claude: spawn failed, not retried", "#2 → id2"]);
});

// #54 criterion 5: start.md documents --auto and --go and stays owner-only.
test("start.md documents --auto and --go and still stops for a lane or a schedule", () => {
  const md = readFileSync(new URL("../../.claude/commands/start.md", import.meta.url), "utf8");
  const [frontMatter, ...bodyParts] = md.split(/^---\s*$/m).filter(Boolean);
  const body = bodyParts.join("");
  assert.match(frontMatter, /argument-hint: .*--auto \[--go\]/);
  assert.match(body, /node scripts\/lanes\/start\.mjs --auto`/);
  assert.match(body, /node scripts\/lanes\/start\.mjs --auto --go`/);
  assert.match(body.trimStart().split("\n")[0], /If you are a lane or were started by a schedule, stop now\./);
});

// #54 criterion 8.
test("docs/USING.md's /start paragraph describes --auto", () => {
  const doc = readFileSync(new URL("../../docs/USING.md", import.meta.url), "utf8");
  const paragraph = doc.slice(doc.indexOf("Faster: `/start"), doc.indexOf("\n3. "));
  assert.match(paragraph, /`\/start --auto`/);
  assert.match(paragraph, /`\/start --auto --go`/);
});

// #94: every /start (issue numbers or --auto) runs cleanupMerged first and prints its lines first.
const REMOVED = "removed issue-7-x (PR #90): claude rm s7; git worktree remove /repo/.claude/worktrees/issue-7-x; git branch -D issue-7-x";

test("cleanup with nothing to clean prints its line first, then the start run's lines", () => {
  const { deps } = fakes({ issues: { 1: {} }, cleanup: () => ["no lanes to clean up"] });
  const { code, lines } = main(["1"], deps);
  assert.equal(code, 0);
  assert.deepEqual(lines, ["no lanes to clean up", "#1 → id1"]);
});

test("cleanup runs before planning, for <N...>, --auto and --auto --go alike", () => {
  for (const argv of [["1"], ["--auto"], ["--auto", "--go"]]) {
    const { deps, calls } = fakes({ issues: { 1: {} } });
    main(argv, deps);
    assert.match(calls[0], /^cleanup /, `${argv.join(" ")}: ${calls.join(", ")}`);
    assert.equal(calls.filter((c) => c.startsWith("cleanup ")).length, 1);
  }
});

test("one merged lane cleaned: its removed line comes first, and the session count sees it gone", () => {
  const sessions = [{ kind: "background", cwd: "/repo/.claude/worktrees/issue-7-x" }];
  const cleanup = () => {
    sessions.length = 0;
    return [REMOVED];
  };
  const { deps } = fakes({ issues: { 1: {} }, sessions, config: { start: { maxLanes: 1 } }, cleanup });
  const { code, lines } = main(["1"], deps);
  assert.equal(code, 0);
  assert.deepEqual(lines, [REMOVED, "#1 → id1"]);
});

test("--auto --go and <N...> clean up for real (dryRun: false)", () => {
  for (const argv of [["--auto", "--go"], ["1"]]) {
    const { deps, calls } = fakes({ issues: { 1: {} }, cleanup: () => [REMOVED] });
    const { lines } = main(argv, deps);
    assert.equal(calls[0], 'cleanup {"dryRun":false}');
    assert.equal(lines[0], REMOVED);
  }
});

test("--auto (dry run) runs cleanup with dryRun: true, so it removes nothing", () => {
  const would = "would remove issue-7-x (PR #90): git branch -D issue-7-x";
  const { deps, calls } = fakes({ issues: { 1: {} }, cleanup: ({ dryRun }) => [dryRun ? would : REMOVED] });
  const { code, lines } = main(["--auto"], deps);
  assert.equal(code, 0);
  assert.equal(calls[0], 'cleanup {"dryRun":true}');
  assert.equal(lines[0], would);
  assert.equal(lines.at(-1), "dry run, nothing launched: /start --auto --go launches the 1 marked would start");
});

test("cleanup throwing prints cleanup failed: <reason>, and the run continues with the same plan and exit code", () => {
  for (const argv of [["1", "2"], ["--auto"], ["--auto", "--go"]]) {
    const issues = { 1: {}, 2: { labels: ["ready"] } };
    const plain = main(argv, fakes({ issues }).deps);
    const cleanup = () => {
      throw new Error("gh: not logged in\nmore detail");
    };
    const { code, lines } = main(argv, fakes({ issues, cleanup }).deps);
    assert.deepEqual(lines, ["cleanup failed: gh: not logged in", ...plain.lines], argv.join(" "));
    assert.equal(code, plain.code);
  }
});

test("a failed cleanup step is printed as cleanup failed: <reason>, other cleanup lines as they are", () => {
  const failedLine = "failed issue-7-x (PR #90) at git worktree remove /w: fatal: cannot remove";
  const { deps } = fakes({ issues: { 1: {} }, cleanup: () => [failedLine, "skipped issue-8-y: not merged"] });
  const { code, lines } = main(["1"], deps);
  assert.equal(code, 0);
  assert.deepEqual(lines, ["cleanup failed: issue-7-x (PR #90) at git worktree remove /w: fatal: cannot remove", "skipped issue-8-y: not merged", "#1 → id1"]);
});

test("edge: two failed cleanup lanes are each rewritten independently, and a removed one is untouched", () => {
  const failedA = "failed issue-7-x (PR #90) at git worktree remove /w7: fatal: cannot remove";
  const failedB = "failed issue-9-z (PR #91) at claude rm s9: session has unpushed commits";
  const removed = "removed issue-8-y (PR #92): git branch -D issue-8-y";
  const { deps } = fakes({ issues: { 1: {} }, cleanup: () => [failedA, removed, failedB] });
  const { lines } = main(["1"], deps);
  assert.deepEqual(lines, [
    "cleanup failed: issue-7-x (PR #90) at git worktree remove /w7: fatal: cannot remove",
    removed,
    "cleanup failed: issue-9-z (PR #91) at claude rm s9: session has unpushed commits",
    "#1 → id1",
  ]);
});

test("edge: a cleanup throw with a stderr uses its first line as the reason", () => {
  const cleanup = () => {
    throw Object.assign(new Error("Command failed"), { stderr: "claude: agents failed\n" });
  };
  assert.equal(main(["1"], fakes({ issues: { 1: {} }, cleanup }).deps).lines[0], "cleanup failed: claude: agents failed");
});

test("edge: cleanup returning a non-array is reported as a cleanup failure, not a crash", () => {
  const { deps } = fakes({ issues: { 1: {} }, cleanup: () => undefined });
  const { code, lines } = main(["1"], deps);
  assert.equal(code, 0);
  assert.match(lines[0], /^cleanup failed: /);
  assert.equal(lines[1], "#1 → id1");
});

test("edge: bad arguments or a bad config run no cleanup", () => {
  for (const [argv, config] of [[["x"]], [[]], [["--auto", "--now"]], [["1"], { start: { maxLanes: 0 } }]]) {
    const { deps, calls } = fakes({ issues: { 1: {} }, config });
    const { code } = main(argv, deps);
    assert.equal(code, 2);
    assert.deepEqual(calls.filter((c) => c.startsWith("cleanup ")), [], argv.join(" "));
  }
});

test("edge: the in-flight count failing after cleanup still prints the cleanup lines first", () => {
  const { deps, launches } = fakes({ issues: { 1: {} }, agentsFail: true, cleanup: () => [REMOVED] });
  const { code, lines } = main(["1"], deps);
  assert.equal(code, 2);
  assert.equal(lines[0], REMOVED);
  assert.match(lines[1], /^cannot count lanes in flight, nothing launched: /);
  assert.deepEqual(launches, []);
});

test("start.mjs's default deps clean up with cleanupMerged", () => {
  const src = readFileSync(new URL("./start.mjs", import.meta.url), "utf8");
  assert.match(src, /import \{ cleanupMerged \} from "\.\/cleanup\.mjs";/);
  assert.match(src, /deps = \{[^}]*cleanup: cleanupMerged[^}]*\}/);
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

for (const status of ["idle", "busy"]) {
  test(`start <N> and --auto treat an ${status} session in a bare issue-<N> folder as already in flight`, () => {
    const sessions = [{ kind: "background", status, cwd: "C:\\repo\\.claude\\worktrees\\issue-6" }];
    const one = fakes({ issues: { 6: { body: form({ scope: "In: `f.mjs`." }) } }, sessions });
    assert.deepEqual(main(["6"], one.deps).lines, ["#6: refused: already in flight"]);
    assert.equal(one.launches.length, 0);
    const auto = fakes({ issues: autoIssues(), sessions });
    const lines = main(["--auto"], auto.deps).lines;
    assert.ok(lines.includes("#6: skipped: already in flight"), lines.join("\n"));
    assert.equal(auto.launches.length, 0);
  });
}

test("edge: a session in a bare issue-60 folder does not put #6 in flight", () => {
  const { deps } = fakes({ issues: autoIssues(), sessions: [{ kind: "background", cwd: "/repo/.claude/worktrees/issue-60" }] });
  const lines = main(["--auto"], deps).lines;
  assert.ok(lines.includes("#6: would start"), lines.join("\n"));
});

// --- #118: start.mjs checks the /start grant itself (ADR 0007 part 2) ----------------------------------------------

const NOW = Date.parse("2026-09-28T12:00:00Z");
// A fresh grant directory and deps running as session `session`, with grant `grant` on disk (none when null).
function granted(grant, { session = OWNER, now = NOW, issues = { 1: {}, 2: { body: form({ scope: "In: `b.mjs`." }) } } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "start-grant-"));
  if (grant !== null) writeFileSync(join(dir, `${session}.json`), typeof grant === "string" ? grant : `${JSON.stringify(grant)}\n`);
  const f = fakes({ issues });
  const deps = { ...f.deps, session: () => session, grantDir: () => dir, now: () => now };
  return { ...f, deps, dir, file: join(dir, `${session}.json`), done: () => rmSync(dir, { recursive: true, force: true }) };
}
const numbered = (issues, at = NOW, over = {}) => ({ sessionId: OWNER, issues, at: new Date(at).toISOString(), ...over });
const autoForm = (auto, at = NOW) => ({ sessionId: OWNER, auto, at: new Date(at).toISOString() });

// Refused: exit 2, one line, nothing read, cleaned or launched, and the grant (if any) left as it was.
function assertRefused(g, argv, pattern) {
  const before = existsSync(g.file) ? readFileSync(g.file, "utf8") : null;
  const { code, lines } = runStart(argv, g.deps);
  assert.equal(code, 2, lines.join("\n"));
  assert.equal(lines.length, 1, lines.join("\n"));
  assert.match(lines[0], /^nothing launched: /);
  assert.match(lines[0], pattern);
  assert.deepEqual(g.launches, []);
  assert.deepEqual(g.calls, [], "nothing is read or cleaned before the grant is checked");
  assert.equal(existsSync(g.file) ? readFileSync(g.file, "utf8") : null, before, "a refused run leaves the grant as it was");
}

test("#118 criterion 1: no grant for this session refuses <N...>, --auto and --auto --go", () => {
  for (const argv of [["1"], ["--auto"], ["--auto", "--go"]]) {
    const g = granted(null);
    try {
      assertRefused(g, argv, /no \/start grant/);
    } finally {
      g.done();
    }
  }
});

test("#118 criterion 1: a grant older than GRANT_TTL_MS refuses; one just under it runs", () => {
  const stale = granted(numbered([1], NOW - GRANT_TTL_MS));
  try {
    assertRefused(stale, ["1"], /older than 15 minutes/);
  } finally {
    stale.done();
  }
  const fresh = granted(numbered([1], NOW - GRANT_TTL_MS + 1));
  try {
    assert.equal(runStart(["1"], fresh.deps).code, 0);
  } finally {
    fresh.done();
  }
});

test("#118 criterion 1: a grant for other issue numbers refuses", () => {
  for (const [grant, argv] of [[[1], ["2"]], [[1, 2], ["1"]], [[1], ["1", "2"]], [[2], ["1"]]]) {
    const g = granted(numbered(grant));
    try {
      assertRefused(g, argv, /other issue numbers/);
    } finally {
      g.done();
    }
  }
});

test("#118 criterion 1: a dry-run grant with --go refuses", () => {
  const g = granted(autoForm("dry"));
  try {
    assertRefused(g, ["--auto", "--go"], /--auto grant never allows --go/);
  } finally {
    g.done();
  }
});

test("#118 criterion 1: by default the grant is .lanes/start/<CLAUDE_CODE_SESSION_ID>.json, beside the scripts", () => {
  const src = readFileSync(new URL("./start.mjs", import.meta.url), "utf8");
  assert.match(src, /process\.env\.CLAUDE_CODE_SESSION_ID/);
  assert.match(src, /new URL\("\.\.\/\.\.\/\.lanes\/start\/", import\.meta\.url\)/);
});

test("#118 criterion 2: after its launches start.mjs deletes the grant, and a second run in the same turn is refused", () => {
  const g = granted(numbered([1, 2]));
  try {
    const first = runStart(["1", "2"], g.deps);
    assert.equal(first.code, 0, first.lines.join("\n"));
    assert.equal(g.launches.length, 2);
    assert.ok(!existsSync(g.file), "the grant is used up");
    g.launches.length = 0;
    g.calls.length = 0;
    assertRefused(g, ["1", "2"], /no \/start grant/);
  } finally {
    g.done();
  }
});

test("#118 criterion 2: a --auto --go run uses up its go grant", () => {
  const g = granted(autoForm("go"), { issues: autoIssues() });
  try {
    assert.equal(runStart(["--auto", "--go"], g.deps).code, 0);
    assert.ok(g.launches.length > 0);
    assert.ok(!existsSync(g.file));
  } finally {
    g.done();
  }
});

test("#118 criterion 4: a dry run needs a grant, and uses up only a dry-run grant", () => {
  const dry = granted(autoForm("dry"), { issues: autoIssues() });
  try {
    const { code, lines } = runStart(["--auto"], dry.deps);
    assert.equal(code, 0, lines.join("\n"));
    assert.deepEqual(dry.launches, []);
    assert.ok(!existsSync(dry.file), "the dry-run grant is used up");
  } finally {
    dry.done();
  }
  // A go grant is not spent on a dry run: it stays for the --auto --go it was typed for.
  const go = granted(autoForm("go"), { issues: autoIssues() });
  try {
    assertRefused(go, ["--auto"], /--auto --go/);
    assert.ok(existsSync(go.file), "a go grant survives a refused dry run");
  } finally {
    go.done();
  }
  const numberedGrant = granted(numbered([1]), { issues: autoIssues() });
  try {
    assertRefused(numberedGrant, ["--auto"], /issue numbers/);
  } finally {
    numberedGrant.done();
  }
});

test("#118 edge: an auto grant never allows a numbered run", () => {
  for (const auto of ["dry", "go"]) {
    const g = granted(autoForm(auto));
    try {
      assertRefused(g, ["1"], /--auto/);
    } finally {
      g.done();
    }
  }
});

test("#118 edge: another session's grant, a missing or unsafe session id, or a malformed grant file refuses", () => {
  const at = new Date(NOW).toISOString();
  const cases = [
    [numbered([1], NOW, { sessionId: "someone-else" }), OWNER, /another session/],
    [numbered([1]), undefined, /no session id/],
    [numbered([1]), "", /no session id/],
    [numbered([1]), "../../etc", /no session id/],
    ["{not json", OWNER, /unreadable or malformed/],
    [JSON.stringify({ sessionId: OWNER, issues: [1], at: "yesterday" }), OWNER, /unreadable or malformed/],
    [JSON.stringify({ sessionId: OWNER, issues: [1, 1], at }), OWNER, /unreadable or malformed/],
    [JSON.stringify({ sessionId: OWNER, issues: [1], auto: "go", at }), OWNER, /unreadable or malformed/],
    [JSON.stringify(null), OWNER, /no \/start grant/],
    [JSON.stringify([1]), OWNER, /unreadable or malformed/],
    ["", OWNER, /unreadable or malformed/],
  ];
  for (const [grant, session, pattern] of cases) {
    const g = granted(grant);
    g.deps.session = () => session;
    try {
      assertRefused(g, ["1"], pattern);
    } finally {
      g.done();
    }
  }
});

test("#118 edge: a grant dated in the future refuses", () => {
  const g = granted(numbered([1], NOW + 60_000));
  try {
    assertRefused(g, ["1"], /dated in the future/);
  } finally {
    g.done();
  }
});

test("#118 edge: bad arguments are refused as usage before the grant is read or spent", () => {
  const g = granted(numbered([1]));
  try {
    const { code, lines } = runStart(["1", "x"], g.deps);
    assert.equal(code, 2);
    assert.match(lines[0], /^usage: /);
    assert.ok(existsSync(g.file));
  } finally {
    g.done();
  }
});

test("#118 edge: a run that stops after the grant check still uses up the grant", () => {
  const g = granted(numbered([1]));
  g.deps.config = () => ({ start: { maxLanes: 0 } });
  try {
    assert.equal(runStart(["1"], g.deps).code, 2);
    assert.ok(!existsSync(g.file), "a grant is single use even when the run stops early");
  } finally {
    g.done();
  }
});

test("#118 edge: a grant that cannot be removed is reported and fails the run", () => {
  const g = granted(numbered([1]));
  g.deps.removeGrant = () => {
    throw new Error("EPERM: operation not permitted");
  };
  try {
    const { code, lines } = runStart(["1"], g.deps);
    assert.equal(code, 1, lines.join("\n"));
    assert.deepEqual(g.launches.length, 1);
    assert.equal(lines.at(-1), "the /start grant could not be removed: EPERM: operation not permitted");
  } finally {
    g.done();
  }
});

// Extra case (not in the criteria or the lane's edge: list): Math.max(result.code, 1) must not downgrade a worse
// exit code (2, from a run that never got to launch anything) to 1 just because the grant also failed to clear.
test("#118 edge: a grant that cannot be removed does not downgrade a worse exit code", () => {
  const g = granted(numbered([1]));
  g.deps.config = () => ({ start: { maxLanes: 0 } });
  g.deps.removeGrant = () => {
    throw new Error("EPERM: operation not permitted");
  };
  try {
    const { code, lines } = runStart(["1"], g.deps);
    assert.equal(code, 2, lines.join("\n"));
    assert.equal(lines.at(-1), "the /start grant could not be removed: EPERM: operation not permitted");
    assert.deepEqual(g.launches, []);
  } finally {
    g.done();
  }
});

test("#118 edge (#217): an overlapping run on the same grant is refused, because the first run claims it up front", () => {
  const g = granted(numbered([1]));
  let inner;
  const config = g.deps.config;
  g.deps.config = () => {
    // A second start.mjs 1 arriving while the first is mid-run.
    inner = runStart(["1"], { ...g.deps, config });
    return config();
  };
  try {
    const outer = runStart(["1"], g.deps);
    assert.equal(outer.code, 0, outer.lines.join("\n"));
    assert.deepEqual(inner, { code: 2, lines: ["nothing launched: no /start grant in this session"] });
    assert.equal(g.launches.length, 1, "only one run launched");
    assert.deepEqual(readdirSync(g.dir), [], "no grant or claimed copy is left behind");
  } finally {
    g.done();
  }
});

test("#118 edge: a grant that stops matching between the check and the claim is refused and put back", () => {
  const g = granted(numbered([1], NOW - GRANT_TTL_MS + 1));
  let calls = 0;
  g.deps.now = () => (calls++ === 0 ? NOW : NOW + 1);
  try {
    const before = readFileSync(g.file, "utf8");
    const { code, lines } = runStart(["1"], g.deps);
    assert.equal(code, 2);
    assert.deepEqual(lines, ["nothing launched: the /start grant is older than 15 minutes"]);
    assert.deepEqual(g.launches, []);
    assert.deepEqual(readdirSync(g.dir), [`${OWNER}.json`]);
    assert.equal(readFileSync(g.file, "utf8"), before);
  } finally {
    g.done();
  }
});

// Extra case (not in the criteria or the lane's edge: list): the rename that claims the grant can itself race a
// second run's own claim attempt (as opposed to the #217 test above, where the second run's *initial* check already
// sees no file). Here the initial check still sees the still-present grant, but the file is gone by the time this
// run tries to rename it away, exercising the renameSync catch block itself.
test("#118 edge: a grant claimed by another run between the check and the rename is refused, not silently reused", () => {
  const g = granted(numbered([1]));
  g.deps.now = () => {
    rmSync(g.file, { force: true });
    return NOW;
  };
  try {
    const { code, lines } = runStart(["1"], g.deps);
    assert.equal(code, 2, lines.join("\n"));
    assert.deepEqual(lines, ["nothing launched: the /start grant was already used by another run"]);
    assert.deepEqual(g.launches, []);
    assert.deepEqual(readdirSync(g.dir), [], "no grant or claimed copy left behind");
  } finally {
    g.done();
  }
});

// Extra case: a fresh grant can be written to the session's path (by a new /start prompt) while the old one sits
// claimed under review. If the claimed copy then turns out stale, the run must not clobber the fresh grant that has
// since appeared at the original path, even though that leaves its own claimed copy behind unused.
test("#118 edge: a fresh grant written while the old one is claimed is not clobbered when the claim turns out stale", () => {
  const g = granted(numbered([1], NOW - GRANT_TTL_MS + 1));
  const freshGrant = `${JSON.stringify(numbered([1], NOW))}\n`;
  let calls = 0;
  g.deps.now = () => {
    calls++;
    if (calls === 2) writeFileSync(g.file, freshGrant);
    return calls === 1 ? NOW : NOW + GRANT_TTL_MS;
  };
  try {
    const { code, lines } = runStart(["1"], g.deps);
    assert.equal(code, 2, lines.join("\n"));
    assert.deepEqual(lines, ["nothing launched: the /start grant is older than 15 minutes"]);
    assert.deepEqual(g.launches, []);
    const entries = readdirSync(g.dir);
    assert.ok(entries.includes(`${OWNER}.json`), entries.join(", "));
    assert.ok(entries.some((e) => e.includes(".claimed-")), entries.join(", "));
    assert.equal(entries.length, 2, entries.join(", "));
    assert.equal(readFileSync(g.file, "utf8"), freshGrant, "the fresh grant on disk is untouched");
  } finally {
    g.done();
  }
});

test("#118 criterion 3, end to end: the hook allows start.mjs and leaves the grant; start.mjs then spends it", () => {
  const g = granted(null);
  try {
    runHook("user-prompt-submit", JSON.stringify({ session_id: OWNER, prompt: "/start 1 2" }), { dir: g.dir, now: NOW });
    const hook = JSON.parse(runHook("pre-tool-use", JSON.stringify({ tool_name: "Bash", session_id: OWNER, tool_input: { command: "node scripts/lanes/start.mjs 1 2" } }), { dir: g.dir, now: NOW + 1000 }));
    assert.equal(hook.hookSpecificOutput.permissionDecision, "allow");
    assert.ok(existsSync(g.file), "the hook no longer deletes the grant");
    g.deps.now = () => NOW + 2000;
    assert.equal(runStart(["1", "2"], g.deps).code, 0);
    assert.ok(!existsSync(g.file));
  } finally {
    g.done();
  }
});

// --- #185: an issue carrying needs-owner is refused -----------------------------------------------------------------

test("#185: planStart refuses an issue carrying needs-owner, with the reason needs-owner", () => {
  assert.deepEqual(plan([issue(1, { labels: ["ready", "tier:quick", "needs-owner"] }), issue(2)]), {
    launch: [2],
    refused: [{ number: 1, reason: "needs-owner" }],
  });
});

test("#185: start <N> and --auto both refuse a needs-owner issue", () => {
  const one = fakes({ issues: { 1: { labels: ["ready", "tier:quick", "needs-owner"] } } });
  assert.deepEqual(main(["1"], one.deps), { code: 1, lines: ["#1: refused: needs-owner"] });
  assert.equal(one.launches.length, 0);
  const issues = autoIssues();
  const n = Number(Object.keys(issues)[0]);
  issues[n] = { ...issues[n], labels: ["ready", "tier:quick", "needs-owner"] };
  const auto = fakes({ issues });
  const lines = main(["--auto"], auto.deps).lines;
  assert.ok(lines.includes(`#${n}: skipped: needs-owner`), lines.join("\n"));
});

test("#185 edge: needs-owner is checked after the issue's state, so a closed issue still says not open", () => {
  assert.deepEqual(plan([issue(1, { state: "CLOSED", labels: ["ready", "tier:quick", "needs-owner"] })]).refused, [{ number: 1, reason: "not open" }]);
});

// --- #111: the docs say every /start runs the cleanup first --------------------------------------------------------

test("#111: USING.md step 7 and start.md say /start runs the merged-lane cleanup first", () => {
  const using = readFileSync(new URL("../../docs/USING.md", import.meta.url), "utf8");
  const step7 = using.slice(using.indexOf("7. **Clean up merged lanes**"), using.indexOf("## What merges without you"));
  assert.match(step7, /`\/start`/);
  assert.match(step7, /issue numbers/);
  assert.match(step7, /`--auto`/);
  assert.match(step7, /same cleanup first/);
  assert.match(step7, /`--auto` without `--go` only prints what it would remove/);
  const start = readFileSync(new URL("../../.claude/commands/start.md", import.meta.url), "utf8");
  assert.match(start, /prints cleanup lines first/);
  assert.match(start, /`cleanup failed: <reason>` line never changes the plan/);
});

// --- #260: the docs name the model:opus label, the reuse wording (#165) and the cleanup exclusions (#266) -----------

test("#260: USING.md and start.md document model:opus, review reuse and what cleanup never touches", () => {
  const using = readFileSync(new URL("../../docs/USING.md", import.meta.url), "utf8");
  const start = readFileSync(new URL("../../.claude/commands/start.md", import.meta.url), "utf8");
  for (const doc of [using, start]) assert.match(doc, /`model:opus`/);
  assert.match(using, /ignored label model:<x>/);
  assert.match(using, /`reused <reviewer> from <sha7>`/);
  assert.match(using, /`reused <a>\+<b> from <sha7>`/);
  assert.match(using, /300 or more files/);
  assert.doesNotMatch(using, /test-hunter reused from/);
  assert.match(using, /lanes with an open PR or unpushed commits are never touched/);
  assert.doesNotMatch(using, /closed-unmerged lanes are never touched/);
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
  const { lines } = main(["1"], f.deps);
  assert.deepEqual(seen.filter(Boolean), [{ PATH: "adjusted" }]);
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

test("main labels the issue after a good launch and prints nothing extra", () => {
  const f = fakes({ issues: { 1: {} } });
  const { code, lines } = main(["1"], f.deps);
  assert.equal(code, 0);
  assert.deepEqual(lines, ["#1 → id1"]);
  assert.deepEqual(f.labeled, [1]);
});

test("main does not label an issue whose launch failed or printed no session id", () => {
  const f = fakes({ issues: { 1: {}, 2: { body: form({ scope: "In: `b.mjs`." }) } }, launchFail: [1], launchOut: { 2: "no id here" } });
  main(["1", "2"], f.deps);
  assert.deepEqual(f.labeled, []);
});

test("a label failure leaves the launch and exit code intact and prints the failure line", () => {
  const f = fakes({ issues: { 1: {} }, labelFail: "gh: rate limited" });
  const { code, lines } = main(["1"], f.deps);
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

// #416: issues that each add a line to lanes.config.json run together.
test("main launches two issues whose only shared path is lanes.config.json", () => {
  const { deps, launches } = fakes({ issues: { 1: { body: form({ scope: "In: `a.mjs`, `lanes.config.json`." }) }, 2: { body: form({ scope: "In: `b.mjs`, `lanes.config.json`." }) } } });
  const { code, lines } = main(["1", "2"], deps);
  assert.equal(code, 0);
  assert.deepEqual(lines, ["#1 → id1", "#2 → id2"]);
  assert.equal(launches.length, 2);
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
