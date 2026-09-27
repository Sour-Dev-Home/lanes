// scripts/lanes/start.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CAP, inFlightIssues, launchArgs, main, parseSessionId, planStart } from "./start.mjs";

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
  assert.match(frontMatter, new RegExp(`caps at ${CAP}\\b`));
  assert.match(bodyParts.join(""), new RegExp(`past ${CAP} lanes in flight`));
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

test("CAP is 8", () => assert.equal(CAP, 8));

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

test("parseSessionId returns null when no id is printed", () => {
  assert.equal(parseSessionId(""), null);
  assert.equal(parseSessionId("backgrounded · "), null);
  assert.equal(parseSessionId("error: not logged in"), null);
  assert.equal(parseSessionId(undefined), null);
});

// main, with fakes for gh, claude and git.
const form = ({ scope = "In: `a.mjs`.", blockedBy = "none" } = {}) =>
  ["### Goal", "g", "### Acceptance criteria", "- [ ] a", "### Interface contract", "none", "### Scope", scope, "### Blocked by", blockedBy, "### Tier", "quick"].join("\n\n");

function fakes({ issues = {}, prs = [], sessions = [], launchOut = {}, launchFail = [], agentsFail = false } = {}) {
  const launches = [];
  const gh = (args) => {
    if (args[0] === "issue" && args[1] === "view") {
      const n = Number(args[2]);
      if (!(n in issues)) throw new Error("gh: Could not resolve to an issue");
      const i = issues[n];
      return JSON.stringify({ number: n, state: i.state ?? "OPEN", labels: (i.labels ?? ["ready", "tier:quick"]).map((name) => ({ name })), body: i.body ?? form() });
    }
    if (args[0] === "api") return JSON.stringify({ state: "closed" });
    if (args[0] === "pr" && args[1] === "list") return JSON.stringify(prs);
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
  return { deps: { gh, claude, root: () => "/repo" }, launches };
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
