// scripts/lanes/start.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { START_DEFAULTS, inFlightIssues, launchArgs, main, parseSessionId, planStart, startConfig } from "./start.mjs";

const CAP = START_DEFAULTS.maxLanes;

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
test("launch arguments are exactly --bg and /lane N, with no permission flags", () => {
  assert.deepEqual(launchArgs(18), ["--bg", "/lane 18"]);
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

function fakes({ issues = {}, prs = [], mergedPrs = [], sessions = [], launchOut = {}, launchFail = [], agentsFail = false, config } = {}) {
  const launches = [];
  const view = (n) => {
    const i = issues[n];
    return { number: n, state: i.state ?? "OPEN", labels: (i.labels ?? ["ready", "tier:quick"]).map((name) => ({ name })), body: i.body ?? form() };
  };
  const gh = (args) => {
    if (args[0] === "issue" && args[1] === "view") {
      const n = Number(args[2]);
      if (!(n in issues)) throw new Error("gh: Could not resolve to an issue");
      return JSON.stringify(view(n));
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
    const n = Number(args[1].split(" ")[1]);
    if (launchFail.includes(n)) throw new Error("claude: spawn failed");
    return launchOut[n] ?? `backgrounded · id${n}`;
  };
  return { deps: { gh, claude, root: () => "/repo", config: () => config }, launches };
}

test("main launches from the repository root and prints #N → id", () => {
  const { deps, launches } = fakes({ issues: { 1: {}, 2: { body: form({ scope: "In: `b.mjs`." }) } } });
  const { code, lines } = main(["1", "#2"], deps);
  assert.equal(code, 0);
  assert.deepEqual(lines, ["#1 → id1", "#2 → id2"]);
  assert.deepEqual(launches, [
    { args: ["--bg", "/lane 1"], cwd: "/repo" },
    { args: ["--bg", "/lane 2"], cwd: "/repo" },
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

// Criterion 10.
test("docs/USING.md describes /start", () => {
  const doc = readFileSync(new URL("../../docs/USING.md", import.meta.url), "utf8");
  assert.match(doc, /`\/start/);
});

// #54 criterion 1: the start block in lanes.config.json, its defaults and its bounds.
test("lanes.config.json has the start block with maxLanes 8 and the two soft paths", () => {
  const raw = JSON.parse(readFileSync(new URL("../../lanes.config.json", import.meta.url), "utf8"));
  assert.deepEqual(raw.start, { maxLanes: 8, softPaths: ["^docs/USING\\.md$", "^README\\.md$"] });
  assert.deepEqual(startConfig(raw), raw.start);
});

test("startConfig falls back to the defaults when the start block or a key is missing", () => {
  const defaults = { maxLanes: 8, softPaths: ["^docs/USING\\.md$", "^README\\.md$"] };
  assert.deepEqual(START_DEFAULTS, defaults);
  assert.deepEqual(startConfig(undefined), defaults);
  assert.deepEqual(startConfig({}), defaults);
  assert.deepEqual(startConfig({ start: {} }), defaults);
  assert.deepEqual(startConfig({ start: { maxLanes: 3 } }), { maxLanes: 3, softPaths: defaults.softPaths });
  assert.deepEqual(startConfig({ start: { softPaths: [] } }), { maxLanes: 8, softPaths: [] });
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
