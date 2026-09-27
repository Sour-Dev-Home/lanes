import { test } from "node:test";
import assert from "node:assert/strict";
import { gateDescriptions, issuePaths, laneSessions, loadSessions, mergeQueueEntries, pathsOverlap, render, summarize } from "./status.mjs";

const body = (needs = "nothing") => `Closes #1\n## What changed\nx\n## Contract changes\nnone\n## Tests added\nx\n## Reviewer results\nx\n## Needs the owner\n${needs}\n## Not done\nnothing`;
const gate = (state, description) => ({ __typename: "StatusContext", context: "lanes/gate", state, description });
const pr = (number, rollup, extra = {}) => ({ number, title: `pr ${number}`, body: body(), statusCheckRollup: rollup, autoMergeRequest: null, closingIssuesReferences: [], ...extra });

test("stages come from lanes/gate and failing checks", () => {
  const s = summarize({
    prs: [
      pr(1, [gate("PENDING", "waiting on owner (/approve)")]),
      pr(2, [gate("PENDING", "waiting for review/test-hunter")]),
      pr(3, [gate("SUCCESS", "ok")], { autoMergeRequest: {} }),
      pr(4, [{ __typename: "CheckRun", name: "verify", status: "COMPLETED", conclusion: "FAILURE" }]),
      pr(5, []),
    ],
    issues: [],
    merged: [],
  });
  assert.deepEqual(s.waitingOnOwner.map((i) => i.number), [1]);
  assert.deepEqual(s.inFlight.map((i) => [i.number, i.stage]), [[2, "review"], [3, "queued"], [4, "failing"], [5, "starting"]]);
  assert.match(s.inFlight.find((i) => i.number === 4).note, /verify/);
});

const stageOf = (s, n) => s.inFlight.find((i) => i.number === n);

test("a PR in the merge queue is queued with its position, even with autoMergeRequest null", () => {
  const s = summarize({ prs: [pr(8, [gate("SUCCESS", "ok")])], issues: [], merged: [], mergeQueue: [{ number: 9, position: 1 }, { number: 8, position: 2 }] });
  assert.deepEqual(stageOf(s, 8), { number: 8, title: "pr 8", stage: "queued", note: "in merge queue, position 2" });
});

test("auto-merge on and not yet in the queue still reads as queued, auto-merge on", () => {
  const s = summarize({ prs: [pr(8, [gate("SUCCESS", "ok")], { autoMergeRequest: {} })], issues: [], merged: [], mergeQueue: [{ number: 9, position: 1 }] });
  assert.deepEqual([stageOf(s, 8).stage, stageOf(s, 8).note], ["queued", "auto-merge on"]);
});

test("a green PR neither queued nor on auto-merge is ready, auto-merge is off", () => {
  const s = summarize({ prs: [pr(8, [gate("SUCCESS", "ok")])], issues: [], merged: [], mergeQueue: [] });
  assert.deepEqual([stageOf(s, 8).stage, stageOf(s, 8).note], ["ready", "auto-merge is off"]);
});

test("no merge queue on the branch behaves as before", () => {
  const prs = [pr(8, [gate("SUCCESS", "ok")]), pr(9, [gate("SUCCESS", "ok")], { autoMergeRequest: {} })];
  for (const mergeQueue of [undefined, null]) {
    const s = summarize({ prs, issues: [], merged: [], mergeQueue });
    assert.deepEqual(s.inFlight.map((i) => [i.number, i.stage, i.note]), [[8, "ready", "auto-merge is off"], [9, "queued", "auto-merge on"]]);
  }
});

test("mergeQueueEntries reads PR numbers and positions from the GraphQL reply, [] when the branch has no queue", () => {
  const reply = { data: { repository: { mergeQueue: { entries: { nodes: [{ state: "QUEUED", position: 1, pullRequest: { number: 7 } }] } } } } };
  assert.deepEqual(mergeQueueEntries(reply), [{ number: 7, position: 1 }]);
  assert.deepEqual(mergeQueueEntries({ data: { repository: { mergeQueue: null } } }), []);
});

// `gh pr list --json statusCheckRollup` returns a StatusContext without its description.
const bareGate = (state) => ({ __typename: "StatusContext", context: "lanes/gate", state, targetUrl: "" });
const gateReply = (nodes) => ({ data: { repository: { mergeQueue: null, pullRequests: { nodes } } } });
const gateNode = (number, status) => ({ number, commits: { nodes: [{ commit: { status } }] } });

test("a PR whose gate says waiting on owner is WAITING ON YOU even though the rollup omits the description", () => {
  const reply = gateReply([gateNode(8, { context: { state: "PENDING", description: "waiting on owner (/approve)" } }), gateNode(9, { context: { state: "PENDING", description: "waiting for review/test-hunter" } })]);
  const s = summarize({ prs: [pr(8, [bareGate("PENDING")]), pr(9, [bareGate("PENDING")])], issues: [], merged: [], gateDescriptions: gateDescriptions(reply) });
  assert.deepEqual(s.waitingOnOwner, [{ number: 8, title: "pr 8", stage: "owner", note: "waiting on owner (/approve)" }]);
  assert.deepEqual(s.inFlight, [{ number: 9, title: "pr 9", stage: "review", note: "waiting for review/test-hunter" }]);
});

test("gateDescriptions maps each PR to its head's lanes/gate description, skipping PRs with no gate status", () => {
  const reply = gateReply([gateNode(8, { context: { state: "FAILURE", description: "contract check failed" } }), gateNode(9, { context: null }), gateNode(10, null), { number: 11, commits: { nodes: [] } }]);
  assert.deepEqual(gateDescriptions(reply), new Map([[8, "contract check failed"]]));
  assert.deepEqual(gateDescriptions({ data: { repository: null } }), new Map());
});

test("a gate with no fetched description notes empty, not undefined", () => {
  const s = summarize({ prs: [pr(8, [bareGate("PENDING")]), pr(9, [bareGate("FAILURE")])], issues: [], merged: [] });
  assert.deepEqual(s.inFlight.map((i) => [i.stage, i.note]), [["review", ""], ["contract", ""]]);
});

// edge: queue membership is checked before the gate, so a PR already in the queue reads as queued even if its
// gate is failing or a check is red (GitHub would not have queued it in that state, but the code should not trust that).
test("a PR in the merge queue is queued even when its gate reports a contract failure or a check is red", () => {
  const s = summarize({
    prs: [pr(8, [gate("FAILURE", "contract check failed")]), pr(9, [{ __typename: "CheckRun", name: "verify", status: "COMPLETED", conclusion: "FAILURE" }])],
    issues: [],
    merged: [],
    mergeQueue: [{ number: 8, position: 1 }, { number: 9, position: 2 }],
  });
  assert.deepEqual(s.inFlight.map((i) => [i.number, i.stage, i.note]), [
    [8, "queued", "in merge queue, position 1"],
    [9, "queued", "in merge queue, position 2"],
  ]);
});

// edge: position 0 must not be mistaken for "not queued" (prStage checks `!== undefined`, not truthiness).
test("a merge queue position of 0 is still queued, not read as absent", () => {
  const s = summarize({ prs: [pr(8, [gate("SUCCESS", "ok")])], issues: [], merged: [], mergeQueue: [{ number: 8, position: 0 }] });
  assert.deepEqual([stageOf(s, 8).stage, stageOf(s, 8).note], ["queued", "in merge queue, position 0"]);
});

// edge: a stray queue entry for a PR outside the open PR list (already merged, or listed by a different `gh pr
// list` snapshot) is ignored rather than crashing summarize.
test("a merge queue entry for a PR not in the open PR list does not crash and does not appear", () => {
  const s = summarize({ prs: [pr(8, [gate("SUCCESS", "ok")])], issues: [], merged: [], mergeQueue: [{ number: 999, position: 1 }] });
  assert.deepEqual([stageOf(s, 8).stage, stageOf(s, 8).note], ["ready", "auto-merge is off"]);
  assert.equal(s.inFlight.length, 1);
});

// edge: a malformed or empty GraphQL reply (repository null, or the reply missing entirely) must not throw.
test("mergeQueueEntries and gateDescriptions tolerate a missing or malformed GraphQL reply", () => {
  assert.deepEqual(mergeQueueEntries(undefined), []);
  assert.deepEqual(mergeQueueEntries({}), []);
  assert.deepEqual(mergeQueueEntries({ data: { repository: null } }), []);
  assert.deepEqual(gateDescriptions(undefined), new Map());
  assert.deepEqual(gateDescriptions({}), new Map());
});

test("a PR whose body needs the owner is waiting on him even mid-review", () => {
  const s = summarize({ prs: [pr(6, [gate("PENDING", "waiting for review/test-hunter")], { body: body("pick a name for the package") })], issues: [], merged: [] });
  assert.deepEqual(s.waitingOnOwner.map((i) => [i.number, i.note]), [[6, "needs: pick a name for the package"]]);
});

const issueBody = (blockedBy = "none", scope = "s", contract = "none") =>
  `### Goal\ng\n### Acceptance criteria\n- [ ] a\n### Interface contract\n${contract}\n### Scope\n${scope}\n### Blocked by\n${blockedBy}\n### Tier\nquick`;
const issue = (number, blockedBy, { ready = true, tier = "quick", scope, contract } = {}) => ({
  number,
  title: `issue ${number}`,
  body: issueBody(blockedBy, scope, contract),
  labels: [{ name: `tier:${tier}` }, ...(ready ? [{ name: "ready" }] : [])],
});
const sections = (s) => ({ ready: s.ready.map((i) => i.number), blocked: s.blocked.map((i) => [i.number, i.blockedBy]) });

test("ready issues exclude ones an open PR already closes", () => {
  const s = summarize({
    prs: [pr(7, [], { closingIssuesReferences: [{ number: 10 }, { number: 12 }] })],
    issues: [issue(10), issue(11, "none", { tier: "skip" }), issue(12, "#13"), issue(13, "none", { ready: false })],
    merged: [],
  });
  assert.deepEqual(s.ready.map((i) => [i.number, i.stage]), [[11, "skip"]]);
  assert.deepEqual(s.blocked, []);
});

test("only issues labelled ready are listed; open unlabelled issues still count as blockers", () => {
  const s = summarize({ prs: [], issues: [issue(20, "none", { ready: false }), issue(21, "#20")], merged: [] });
  assert.deepEqual(sections(s), { ready: [], blocked: [[21, [20]]] });
});

test("an issue whose blockers are all closed is ready", () => {
  const s = summarize({ prs: [], issues: [issue(30, "#1, #2"), issue(31)], merged: [] });
  assert.deepEqual(sections(s), { ready: [30, 31], blocked: [] });
});

test("an issue with one open blocker is blocked, with a note naming it", () => {
  const s = summarize({ prs: [], issues: [issue(3), issue(4, "#2, #3", { tier: "full" })], merged: [] });
  assert.deepEqual(sections(s), { ready: [3], blocked: [[4, [3]]] });
  assert.deepEqual(s.blocked[0], { number: 4, title: "issue 4", stage: "full", note: "blocked by #3", blockedBy: [3] });
});

test("blockers are followed transitively, direct blockers first", () => {
  const s = summarize({ prs: [], issues: [issue(40), issue(41, "#40"), issue(42, "#41"), issue(43, "#42, #40")], merged: [] });
  assert.deepEqual(sections(s), { ready: [40], blocked: [[41, [40]], [42, [41, 40]], [43, [42, 40, 41]]] });
  assert.equal(s.blocked[1].note, "blocked by #41, #40");
});

test("a cycle terminates and lists both issues as blocked, the issue itself naming the cycle", () => {
  const s = summarize({ prs: [], issues: [issue(50, "#51"), issue(51, "#50"), issue(52, "#52"), issue(53, "#50")], merged: [] });
  assert.deepEqual(sections(s), { ready: [], blocked: [[50, [51, 50]], [51, [50, 51]], [52, [52]], [53, [50, 51]]] });
});

test("a blocker that is not an open issue (closed, a PR, nonexistent) counts as closed", () => {
  const s = summarize({ prs: [pr(60, [])], issues: [issue(61, "#60"), issue(62, "#999"), issue(63, "#61")], merged: [] });
  assert.deepEqual(sections(s), { ready: [61, 62], blocked: [[63, [61]]] });
});

test("an issue with no body or no Blocked by field is ready", () => {
  const s = summarize({ prs: [], issues: [{ number: 70, title: "t", labels: [{ name: "ready" }] }, { number: 71, title: "u", body: "free text #70", labels: [{ name: "ready" }] }], merged: [] });
  assert.deepEqual(sections(s), { ready: [70, 71], blocked: [] });
});

test("an issue with a null body is ready, same as no body", () => {
  const s = summarize({ prs: [], issues: [{ number: 72, title: "t", body: null, labels: [{ name: "ready" }] }], merged: [] });
  assert.deepEqual(sections(s), { ready: [72], blocked: [] });
});

test("an issue closed by an open PR still counts as an open blocker for others", () => {
  const s = summarize({
    prs: [pr(80, [], { closingIssuesReferences: [{ number: 81 }] })],
    issues: [issue(81), issue(82, "#81")],
    merged: [],
  });
  // #81 itself stays out of both sections (its PR is open), but it still blocks #82 until that PR merges.
  assert.deepEqual(sections(s), { ready: [], blocked: [[82, [81]]] });
});

test("render prints the five sections with counts, BLOCKED after READY TO START", () => {
  const text = render(
    {
      waitingOnOwner: [],
      inFlight: [{ number: 2, title: "t", stage: "review", note: "waiting for review/test-hunter" }],
      ready: [],
      blocked: [{ number: 4, title: "One-command setup", stage: "full", note: "blocked by #3", blockedBy: [3] }],
      merged: [],
    },
    "24h",
  );
  assert.match(text, /WAITING ON YOU \(0\)/);
  assert.match(text, /IN FLIGHT \(1\)\n  #2 \[review\] t — waiting for review\/test-hunter/);
  assert.match(text, /READY TO START \(0\)\n\nBLOCKED \(1\)\n  #4 \[full\] One-command setup — blocked by #3\n\nMERGED, last 24h \(0\)/);
});

test("issuePaths reads backticked and bare paths from the contract and Scope's In: part, ignoring Out:", () => {
  const paths = issuePaths({
    contract: "none (additive `--json` fields on `ready` items), see docs/contract.md",
    scope: "In: `scripts/lanes/status.mjs`, scripts/lanes/status.test.mjs.\nOut: the 3-lane cap, `lib.mjs`, `.claude/commands/*`.",
  });
  assert.deepEqual(paths, ["docs/contract.md", "scripts/lanes/status.mjs", "scripts/lanes/status.test.mjs"]);
  assert.deepEqual(issuePaths({ contract: "none", scope: "tidy up the wording" }), []);
  assert.deepEqual(issuePaths({ contract: "", scope: "In: `src/ui/` and ./README.md" }), ["src/ui/", "README.md"]);
  // "Built-in:" and "Opt-out:" are not the In:/Out: labels.
  assert.deepEqual(issuePaths({ scope: "Built-in: `x.mjs`. In: `a.mjs`, opt-out: `b.mjs`\nOut: `c.mjs`" }), ["a.mjs", "b.mjs"]);
});

test("paths overlap when equal or when one is a directory containing the other", () => {
  assert.equal(pathsOverlap(["a/b.mjs"], ["a/b.mjs"]), true);
  assert.equal(pathsOverlap(["a/"], ["a/b/c.mjs"]), true);
  assert.equal(pathsOverlap(["a/b/c.mjs"], ["a/"]), true);
  assert.equal(pathsOverlap(["a/b.mjs"], ["a/c.mjs"]), false);
  assert.equal(pathsOverlap(["ab/"], ["a/b.mjs", "abc/d.mjs"]), false);
});

const hints = (s) => s.ready.map((i) => [i.number, i.parallel, i.overlapsWith, i.note]);
const scoped = (number, scope, extra = {}) => issue(number, "none", { scope, ...extra });

test("disjoint scopes run in parallel", () => {
  const s = summarize({ prs: [], issues: [scoped(90, "In: `a/x.mjs`"), scoped(91, "In: `b/y.mjs`")], merged: [] });
  assert.deepEqual(hints(s), [[90, true, [], "parallel"], [91, true, [], "parallel"]]);
});

test("a shared file makes both one at a time, naming each other", () => {
  const s = summarize({ prs: [], issues: [scoped(92, "In: `a/x.mjs`"), scoped(93, "In: a/x.mjs, `c.md`"), scoped(94, "In: `c.md`")], merged: [] });
  assert.deepEqual(hints(s), [
    [92, false, [93], "one at a time with #93"],
    [93, false, [92, 94], "one at a time with #92, #94"],
    [94, false, [93], "one at a time with #93"],
  ]);
});

test("a directory containing another issue's file overlaps", () => {
  const s = summarize({ prs: [], issues: [scoped(95, "In: `src/`"), scoped(96, "In: `src/app/main.ts`")], merged: [] });
  assert.deepEqual(hints(s), [[95, false, [96], "one at a time with #96"], [96, false, [95], "one at a time with #95"]]);
});

test("a shared contract file overlaps even when the Scope files differ", () => {
  const s = summarize({
    prs: [],
    issues: [scoped(97, "In: `a.mjs`", { contract: "`contracts/api.ts`" }), scoped(98, "In: `b.mjs`", { contract: "`contracts/api.ts`" })],
    merged: [],
  });
  assert.deepEqual(hints(s).map((h) => h.slice(0, 3)), [[97, false, [98]], [98, false, [97]]]);
});

test("an issue whose Scope names no paths is one at a time", () => {
  const s = summarize({ prs: [], issues: [scoped(99, "tidy the docs", { contract: "`x/y.ts`" }), scoped(100, "In: `z.mjs`")], merged: [] });
  assert.deepEqual(hints(s), [[99, false, [], "one at a time (scope names no paths)"], [100, true, [], "parallel"]]);
});

test("a scopeless issue's Interface contract path never leaks into another issue's overlapsWith", () => {
  const s = summarize({
    prs: [],
    issues: [scoped(110, "tidy the docs", { contract: "`shared/thing.mjs`" }), scoped(111, "In: `shared/thing.mjs`")],
    merged: [],
  });
  assert.deepEqual(hints(s), [
    [110, false, [], "one at a time (scope names no paths)"],
    [111, true, [], "parallel"],
  ]);
});

test("paths after Out: never cause an overlap", () => {
  const s = summarize({ prs: [], issues: [scoped(101, "In: `a.mjs`\nOut: `b.mjs`"), scoped(102, "In: `b.mjs`")], merged: [] });
  assert.deepEqual(hints(s).map((h) => h[1]), [true, true]);
});

test("only startable issues are compared; blocked ones get no parallel note", () => {
  const s = summarize({
    prs: [],
    issues: [scoped(103, "In: `a.mjs`"), issue(104, "#103", { scope: "In: `a.mjs`" }), scoped(105, "In: `a.mjs`", { ready: false })],
    merged: [],
  });
  assert.deepEqual(hints(s), [[103, true, [], "parallel"]]);
  assert.equal(s.blocked[0].note, "blocked by #103");
  assert.equal("parallel" in s.blocked[0], false);
});

test("render puts a heuristic disclaimer under READY TO START", () => {
  const text = render(summarize({ prs: [], issues: [scoped(106, "In: `a.mjs`")], merged: [] }), "24h");
  assert.match(text, /READY TO START \(1\)\n  [^\n]*heuristic[^\n]*not a guarantee[^\n]*\n  #106 \[quick\] issue 106 — parallel\n/);
});

// `claude agents --json`, as recorded on a real background session waiting on a permission prompt:
// { kind: "background", status: "waiting", waitingFor: "permission prompt", state: "blocked" }.
const ROOT = "C:\\repo\\lanes";
const agent = (id, cwd, extra = {}) => ({ id, cwd, kind: "background", startedAt: 1, sessionId: `${id}-uuid`, name: "lane", status: "busy", state: "working", ...extra });
const waitingAgent = (id, cwd) => agent(id, cwd, { status: "waiting", waitingFor: "permission prompt", state: "blocked" });
const wt = (name) => `${ROOT}\\.claude\\worktrees\\${name}`;

test("laneSessions keeps background sessions in this repo's issue-<N>- worktrees and maps them to issue N", () => {
  const sessions = laneSessions(
    [
      agent("aaaa0001", wt("issue-19-status-sessions")),
      agent("aaaa0002", "C:\\other\\.claude\\worktrees\\issue-20-x"), // outside this repo
      agent("aaaa0003", wt("adr25-signin")), // not a lane worktree
      agent("aaaa0004", ROOT), // the main checkout
      { ...agent("aaaa0005", wt("issue-21-y")), kind: "interactive" },
      waitingAgent("aaaa0006", wt("issue-22-z")),
    ],
    ROOT,
  );
  assert.deepEqual([...sessions], [
    [19, { id: "aaaa0001", state: "working", waiting: false }],
    [22, { id: "aaaa0006", state: "blocked", waiting: true }],
  ]);
});

test("an IN FLIGHT PR whose issue has a session shows the id in its note", () => {
  const sessions = laneSessions([agent("42c93c57", wt("issue-10-x"))], ROOT);
  const s = summarize({ prs: [pr(7, [gate("PENDING", "waiting for review/test-hunter")], { closingIssuesReferences: [{ number: 10 }] })], issues: [issue(10)], merged: [], sessions });
  assert.deepEqual(s.inFlight, [{ number: 7, title: "pr 7", stage: "review", note: "waiting for review/test-hunter — session 42c93c57", session: { id: "42c93c57", state: "working" } }]);
  assert.match(render(s, "24h"), /#7 \[review\] pr 7 — waiting for review\/test-hunter — session 42c93c57/);
});

test("a lane with a session and no PR is IN FLIGHT as running, not READY TO START", () => {
  const sessions = laneSessions([agent("42c93c57", wt("issue-10-x"))], ROOT);
  const s = summarize({ prs: [], issues: [issue(10), issue(11)], merged: [], sessions });
  assert.deepEqual(s.ready.map((i) => i.number), [11]);
  assert.deepEqual(s.inFlight, [{ number: 10, title: "issue 10", stage: "running", note: "session 42c93c57", session: { id: "42c93c57", state: "working" } }]);
  assert.match(render(s, "24h"), /IN FLIGHT \(1\)\n  #10 \[running\] issue 10 — session 42c93c57/);
});

test("a session waiting on a permission prompt is listed under WAITING ON YOU with its attach command", () => {
  const sessions = laneSessions([waitingAgent("42c93c57", wt("issue-10-x")), waitingAgent("5555aaaa", wt("issue-12-y"))], ROOT);
  const s = summarize({ prs: [pr(7, [gate("PENDING", "waiting for review/test-hunter")], { closingIssuesReferences: [{ number: 12 }] })], issues: [issue(10), issue(12)], merged: [], sessions });
  assert.deepEqual(s.inFlight, []);
  assert.deepEqual(s.waitingOnOwner.map((i) => [i.number, i.note, i.session]), [
    [7, "waiting on a prompt: claude attach 5555aaaa", { id: "5555aaaa", state: "blocked" }],
    [10, "waiting on a prompt: claude attach 42c93c57", { id: "42c93c57", state: "blocked" }],
  ]);
  assert.match(render(s, "24h"), /#10 \[running\] issue 10 — waiting on a prompt: claude attach 42c93c57/);
});

test("a blocked session not on a permission prompt is running, not waiting on you", () => {
  const sessions = laneSessions([agent("42c93c57", wt("issue-10-x"), { status: "idle", state: "blocked" })], ROOT);
  const s = summarize({ prs: [], issues: [issue(10)], merged: [], sessions });
  assert.deepEqual([s.waitingOnOwner.length, s.inFlight[0].note], [0, "session 42c93c57"]);
});

test("sessions outside this repo or outside a lane worktree are ignored", () => {
  const sessions = laneSessions([agent("aaaa0002", "C:\\other\\.claude\\worktrees\\issue-10-x"), agent("aaaa0003", `${ROOT}\\scripts`), agent("aaaa0004", "C:\\repo\\lanes-other\\issue-10-x")], ROOT);
  assert.equal(sessions.size, 0);
  const s = summarize({ prs: [], issues: [issue(10)], merged: [], sessions });
  assert.deepEqual([s.ready.map((i) => i.number), s.inFlight], [[10], []]);
});

test("claude unavailable: /status prints everything else plus one line", () => {
  const enoent = Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
  const failing = Object.assign(new Error("Command failed"), { status: 2 });
  const cases = [
    [() => { throw enoent; }, "claude not found"],
    [() => { throw failing; }, "claude agents --json exited 2"],
    [() => "not json", "claude agents --json printed invalid JSON"],
    [() => '{"a":1}', "claude agents --json printed invalid JSON"],
  ];
  for (const [run, reason] of cases) {
    const loaded = loadSessions(ROOT, run);
    assert.deepEqual(loaded, { sessions: new Map(), sessionsUnavailable: reason });
    const text = render(summarize({ prs: [], issues: [issue(10)], merged: [], ...loaded }), "24h");
    assert.match(text, /READY TO START \(1\)/);
    assert.ok(text.endsWith(`\n\n(background sessions unavailable: ${reason})`), text);
  }
  const ok = loadSessions(ROOT, () => JSON.stringify([agent("42c93c57", wt("issue-10-x"))]));
  assert.deepEqual(ok, { sessions: new Map([[10, { id: "42c93c57", state: "working", waiting: false }]]) });
  assert.doesNotMatch(render(summarize({ prs: [], issues: [], merged: [], ...ok }), "24h"), /unavailable/);
});

test("edge: two sessions on one issue, the most recently started wins", () => {
  const sessions = laneSessions([agent("new00001", wt("issue-10-b"), { startedAt: 5 }), agent("old00001", wt("issue-10-a"), { startedAt: 2 })], ROOT);
  assert.equal(sessions.get(10).id, "new00001");
});

test("edge: malformed entries, a missing id, and a bare issue-<N> folder are skipped", () => {
  const sessions = laneSessions([null, "x", { kind: "background" }, agent(undefined, wt("issue-10-x")), agent("aaaa0001", wt("issue-11")), agent("aaaa0002", `${wt("issue-12-y")}\\scripts`)], ROOT);
  assert.deepEqual([...sessions.keys()], [12]);
});

test("edge: Windows paths match case-insensitively with either slash; POSIX paths match exactly", () => {
  assert.equal(laneSessions([agent("aaaa0001", "c:/REPO/Lanes/.claude/worktrees/issue-10-x")], `${ROOT}\\`).size, 1);
  assert.equal(laneSessions([agent("aaaa0001", "/home/u/lanes/.claude/worktrees/issue-10-x")], "/home/u/lanes").size, 1);
  assert.equal(laneSessions([agent("aaaa0001", "/home/u/Lanes/.claude/worktrees/issue-10-x")], "/home/u/lanes").size, 0);
});

test("edge: a session whose issue is closed (not in the open list) is not listed", () => {
  const s = summarize({ prs: [], issues: [], merged: [], sessions: laneSessions([agent("aaaa0001", wt("issue-10-x"))], ROOT) });
  assert.deepEqual([s.inFlight, s.waitingOnOwner], [[], []]);
});

test("edge: a running session on an issue without the ready label is still in flight, and never blocked", () => {
  const s = summarize({ prs: [], issues: [issue(10, "#11", { ready: false }), issue(11)], merged: [], sessions: laneSessions([agent("aaaa0001", wt("issue-10-x"))], ROOT) });
  assert.deepEqual([s.inFlight.map((i) => i.number), s.blocked], [[10], []]);
});

test("edge: a timed-out claude agents --json is reported by its error code", () => {
  const timeout = Object.assign(new Error("spawnSync claude ETIMEDOUT"), { code: "ETIMEDOUT", status: null });
  assert.equal(loadSessions(ROOT, () => { throw timeout; }).sessionsUnavailable, "claude agents --json failed: ETIMEDOUT");
});

test("--json items carry session only when their issue has one", () => {
  const s = summarize({ prs: [pr(7, [])], issues: [issue(11)], merged: [], sessions: new Map() });
  assert.equal("session" in s.inFlight[0], false);
  assert.equal("session" in s.ready[0], false);
  assert.equal("sessionsUnavailable" in s, false);
});
