import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { TEAM_REQUIRED_MESSAGE } from "./lib.mjs";
import { cleanableCount, planCleanup } from "./cleanup.mjs";
import { prStage, formatAge, gateDescriptions, gateSince, idleLaneSession, laneBranches, laneSessions, laneWorktree, worktreeUnsaved, liveLanes, loadLaneBranches, loadSessions, mergeQueueEntries, idleLanes, readBudget, render, renderWaiting, stalledItems, startsReport, stalledLanes, summarize, trustedRollups, waitingApprovals } from "./status.mjs";

const body = (needs = "nothing") => `Closes #1\n## What changed\nx\n## Contract changes\nnone\n## Tests added\nx\n## Reviewer results\nx\n## Needs the owner\n${needs}\n## Not done\nnothing`;
const gate = (state, description) => ({ __typename: "StatusContext", context: "lanes/gate", state, description });
const pr = (number, rollup, extra = {}) => ({ number, title: `pr ${number}`, body: body(), statusCheckRollup: rollup, autoMergeRequest: null, closingIssuesReferences: [], ...extra });

test("stages come from lanes/gate and failing checks", () => {
  const s = summarize({
    prs: [
      pr(1, [gate("PENDING", "waiting for a code-owner review in GitHub")]),
      pr(2, [gate("PENDING", "waiting for review/test-hunter")]),
      pr(3, [gate("SUCCESS", "ok")], { autoMergeRequest: {} }),
      pr(4, [{ __typename: "CheckRun", name: "verify", status: "COMPLETED", conclusion: "FAILURE" }]),
      pr(5, []),
    ],
    issues: [],
    merged: [],
  });
  assert.deepEqual(s.waitingOnOwner.map((i) => i.number), [1]);
  assert.deepEqual(s.inFlight.map((i) => [i.number, i.stage]), [[2, "gate"], [3, "queued"], [4, "failing"], [5, "starting"]]);
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
  const reply = gateReply([gateNode(8, { context: { state: "PENDING", description: "waiting for a code-owner review in GitHub" } }), gateNode(9, { context: { state: "PENDING", description: "waiting for review/test-hunter" } })]);
  const s = summarize({ prs: [pr(8, [bareGate("PENDING")]), pr(9, [bareGate("PENDING")])], issues: [], merged: [], gateDescriptions: gateDescriptions(reply) });
  assert.deepEqual(s.waitingOnOwner, [{ number: 8, title: "pr 8", stage: "owner", note: "waiting for a code-owner review in GitHub" }]);
  assert.deepEqual(s.inFlight, [{ number: 9, title: "pr 9", stage: "gate", note: "waiting for review/test-hunter" }]);
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

const ownerApproved = (state = "SUCCESS") => ({ __typename: "StatusContext", context: "review/owner", state });
const placement = (s, number) => (s.waitingOnOwner.some((i) => i.number === number) ? "owner" : s.inFlight.some((i) => i.number === number) ? "inFlight" : "absent");
const itemOf = (s, number) => [...s.waitingOnOwner, ...s.inFlight].find((i) => i.number === number);

test("a PR whose gate waits for a reviewer is IN FLIGHT as [gate], even when its body asks for /approve", () => {
  const s = summarize({ prs: [pr(6, [gate("PENDING", "waiting for review/architecture-advisor")], { body: body("/approve once the reviewers are in") })], issues: [], merged: [] });
  assert.equal(placement(s, 6), "inFlight");
  assert.deepEqual(itemOf(s, 6), { number: 6, title: "pr 6", stage: "gate", note: "waiting for review/architecture-advisor" });
  assert.match(render(s, "24h"), /IN FLIGHT \(1\)\n  #6 \[gate\] pr 6 — waiting for review\/architecture-advisor/);
});

test("a PR whose gate waits for a reviewer after the owner approved is IN FLIGHT as [gate]", () => {
  const s = summarize({ prs: [pr(7, [gate("PENDING", "waiting for review/architecture-advisor"), ownerApproved()], { body: body("/approve") })], issues: [], merged: [] });
  assert.equal(placement(s, 7), "inFlight");
  assert.deepEqual(itemOf(s, 7), { number: 7, title: "pr 7", stage: "gate", note: "waiting for review/architecture-advisor" });
});

test("a PR that genuinely waits on /approve is still WAITING ON YOU", () => {
  const prs = [
    pr(11, [gate("PENDING", "waiting for a code-owner review in GitHub (tier:full)")]),
    pr(12, [gate("PENDING", "waiting for blocker #3 (open)")], { body: body("pick a name for the package") }),
  ];
  const s = summarize({ prs, issues: [], merged: [] });
  assert.deepEqual(s.waitingOnOwner.map((i) => [i.number, i.stage, i.note]), [[11, "owner", "waiting for a code-owner review in GitHub (tier:full)"], [12, "review", "needs: pick a name for the package"]]);
});

test("status --json carries the gate stage and reason", () => {
  const reply = gateReply([gateNode(13, { context: { state: "PENDING", description: "waiting for review/security-reviewer" } })]);
  const s = summarize({ prs: [pr(13, [bareGate("PENDING")], { body: body("/approve") })], issues: [], merged: [], gateDescriptions: gateDescriptions(reply) });
  const json = JSON.parse(JSON.stringify({ version: 0, ...s }));
  assert.deepEqual(json.inFlight, [{ number: 13, title: "pr 13", stage: "gate", note: "waiting for review/security-reviewer" }]);
  assert.deepEqual(json.waitingOnOwner, []);
});

test("edge: a review/owner status that is not success does not count as an approval", () => {
  for (const state of ["PENDING", "EXPECTED"]) {
    const s = summarize({ prs: [pr(14, [gate("PENDING", "waiting for a code-owner review in GitHub"), ownerApproved(state)])], issues: [], merged: [] });
    assert.equal(placement(s, 14), "owner", state);
  }
});

test("edge: an owner approval does not hide a lane stuck on a permission prompt", () => {
  const sessions = new Map([[1, { id: "abc", state: "blocked", waiting: true }]]);
  const s = summarize({ prs: [pr(15, [gate("PENDING", "waiting for review/test-hunter"), ownerApproved()], { closingIssuesReferences: [{ number: 1 }] })], issues: [], merged: [], sessions });
  assert.equal(placement(s, 15), "owner");
});

test("edge: a description only near 'waiting for review/' (no name, other prefix) stays [review]", () => {
  const prs = [pr(16, [gate("PENDING", "waiting for review/")]), pr(17, [gate("PENDING", "not waiting for review/test-hunter")])];
  const s = summarize({ prs, issues: [], merged: [] });
  assert.deepEqual(s.inFlight.map((i) => [i.number, i.stage]), [[16, "review"], [17, "review"]]);
});

test("edge: a failing gate that names a reviewer is still [contract], not [gate]", () => {
  const s = summarize({ prs: [pr(18, [gate("FAILURE", "review/test-hunter is failure")])], issues: [], merged: [] });
  assert.deepEqual(s.inFlight.map((i) => [i.number, i.stage]), [[18, "contract"]]);
});

test("edge: an owner approval does not hide an unrelated 'needs the owner' note", () => {
  const s = summarize({ prs: [pr(19, [gate("PENDING", "waiting for blocker #3 (open)"), ownerApproved()], { body: body("pick a name for the package") })], issues: [], merged: [] });
  assert.equal(placement(s, 19), "owner");
  assert.deepEqual(itemOf(s, 19), { number: 19, title: "pr 19", stage: "review", note: "needs: pick a name for the package" });
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

test("render prints one hint line when lanes or folders wait for cleanup, and none otherwise", () => {
  const empty = { waitingOnOwner: [], inFlight: [], ready: [], blocked: [], merged: [] };
  assert.match(render({ ...empty, toCleanUp: 2 }, "24h"), /\n\n2 lanes or folders to clean up: node scripts\/lanes\/cleanup\.mjs$/);
  assert.match(render({ ...empty, toCleanUp: 1 }, "24h"), /\n\n1 lane or folder to clean up: node scripts\/lanes\/cleanup\.mjs$/);
  assert.doesNotMatch(render({ ...empty, toCleanUp: 0 }, "24h"), /clean up/);
  assert.doesNotMatch(render(empty, "24h"), /clean up/);
});

test("the cleanup hint counts a merged lane, a closed-issue lane and an empty orphan folder without calling them all merged lanes", () => {
  const empty = { waitingOnOwner: [], inFlight: [], ready: [], blocked: [], merged: [] };
  const HEAD = "a".repeat(40);
  const wt = (branch) => ({ path: `C:/repo/.claude/worktrees/${branch}`, branch, head: HEAD, dirty: false, unpushed: 0 });
  const plan = planCleanup({
    worktrees: [{ path: "C:/repo", branch: "main", head: "f".repeat(40), dirty: false, main: true }, wt("issue-7-x"), wt("issue-8-y")],
    prs: [{ number: 90, state: "MERGED", headRefName: "issue-7-x", headRefOid: HEAD }],
    issues: [{ number: 8, state: "CLOSED" }],
    orphans: [{ path: "C:/repo/.claude/worktrees/gone", files: 0 }],
  });
  const line = render({ ...empty, toCleanUp: cleanableCount(plan) }, "24h").split("\n\n").pop();
  assert.equal(line, "3 lanes or folders to clean up: node scripts/lanes/cleanup.mjs");
  assert.doesNotMatch(line, /merged/);
  // each kind alone is one thing to clean up, not "1 merged lane"
  for (const only of [
    { worktrees: [wt("issue-7-x")], prs: [{ number: 90, state: "MERGED", headRefName: "issue-7-x", headRefOid: HEAD }] },
    { worktrees: [wt("issue-8-y")], issues: [{ number: 8, state: "CLOSED" }] },
    { orphans: [{ path: "C:/repo/.claude/worktrees/gone", files: 0 }] },
  ]) {
    assert.equal(render({ ...empty, toCleanUp: cleanableCount(planCleanup(only)) }, "24h").split("\n\n").pop(), "1 lane or folder to clean up: node scripts/lanes/cleanup.mjs");
  }
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

// #54 criterion 6: a ready issue that overlaps claimed work (claimedPaths) is one at a time with that running work.
const running = (s) => s.ready.map((i) => [i.number, i.parallel, i.overlapsRunning, i.note]);

test("a ready issue overlapping an open PR's changed files is one at a time with running #PR", () => {
  const s = summarize({
    prs: [pr(40, [], { headRefName: "issue-9-x", files: [{ path: "a/x.mjs" }] })],
    issues: [scoped(120, "In: `a/x.mjs`"), scoped(121, "In: `b/y.mjs`")],
    merged: [],
  });
  assert.deepEqual(running(s), [
    [120, false, [40], "one at a time with running #40"],
    [121, true, [], "parallel"],
  ]);
});

test("laneSessions finds a session by its lane-<N> name even when it reports the repository root (#341)", () => {
  const sessions = laneSessions([agent("aaaa0338", ROOT, { name: "lane-338" }), agent("bbbb0001", ROOT, { name: "reactapps-dc" }), agent("cccc0002", ROOT)], ROOT);
  assert.deepEqual([...sessions.keys()], [338]);
  assert.equal(sessions.get(338).id, "aaaa0338");
});

test("edge: laneSessions lets the name win over the cwd folder, and ignores a lane name in another repository", () => {
  const sessions = laneSessions([agent("aaaa0001", wt("issue-10-x"), { name: "lane-11" }), agent("bbbb0002", "C:\\other", { name: "lane-12" })], ROOT);
  assert.deepEqual([...sessions.keys()], [11]);
});

test("a ready issue overlapping a running lane with no PR yet is one at a time with running #N", () => {
  const s = summarize({
    prs: [],
    issues: [scoped(10, "In: `src/`"), scoped(122, "In: `src/app/main.ts`")],
    merged: [],
    sessions: laneSessions([agent("aaaa0001", wt("issue-10-x"))], ROOT),
  });
  assert.deepEqual(running(s), [[122, false, [10], "one at a time with running #10"]]);
});

test("a running overlap is noted next to today's ready-vs-ready note", () => {
  const s = summarize({
    prs: [pr(41, [], { headRefName: "issue-8-x", files: ["c.md"] })],
    issues: [scoped(123, "In: `a.mjs`, `c.md`"), scoped(124, "In: `a.mjs`")],
    merged: [],
  });
  assert.deepEqual(running(s), [
    [123, false, [41], "one at a time with running #41; one at a time with #124"],
    [124, false, [], "one at a time with #123"],
  ]);
});

test("edge: a running issue with an open PR claims the PR's files, not its own Scope", () => {
  const s = summarize({
    prs: [pr(42, [], { headRefName: "issue-10-x", files: [{ path: "other.mjs" }] })],
    issues: [scoped(10, "In: `a.mjs`"), scoped(125, "In: `a.mjs`")],
    merged: [],
    sessions: laneSessions([agent("aaaa0001", wt("issue-10-x"))], ROOT),
  });
  assert.deepEqual(running(s), [[125, true, [], "parallel"]]);
});

test("edge: a PR without files claims nothing, and a scopeless ready issue is never flagged running", () => {
  const s = summarize({
    prs: [pr(43, [], { headRefName: "issue-7-x" }), pr(44, [], { headRefName: "issue-6-x", files: [{ path: "x/y.ts" }] })],
    issues: [scoped(126, "tidy the docs", { contract: "`x/y.ts`" }), scoped(127, "In: `q.mjs`")],
    merged: [],
  });
  assert.deepEqual(running(s), [
    [126, false, [], "one at a time (scope names no paths)"],
    [127, true, [], "parallel"],
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
const agent = (id, cwd, extra = {}) => ({ id, cwd, kind: "background", startedAt: 1, sessionId: `${id}-uuid`, status: "busy", state: "working", ...extra });
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
    [19, { id: "aaaa0001", state: "working", waiting: false, stopped: false }],
    [22, { id: "aaaa0006", state: "blocked", waiting: true, stopped: false }],
  ]);
});

test("an IN FLIGHT PR whose issue has a session shows the id in its note", () => {
  const sessions = laneSessions([agent("42c93c57", wt("issue-10-x"))], ROOT);
  const s = summarize({ prs: [pr(7, [gate("PENDING", "waiting for review/test-hunter")], { closingIssuesReferences: [{ number: 10 }] })], issues: [issue(10)], merged: [], sessions });
  assert.deepEqual(s.inFlight, [{ number: 7, title: "pr 7", stage: "gate", note: "waiting for review/test-hunter — session 42c93c57", session: { id: "42c93c57", state: "working" } }]);
  assert.match(render(s, "24h"), /#7 \[gate\] pr 7 — waiting for review\/test-hunter — session 42c93c57/);
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
  assert.deepEqual(ok, { sessions: new Map([[10, { id: "42c93c57", state: "working", waiting: false, stopped: false }]]) });
  assert.doesNotMatch(render(summarize({ prs: [], issues: [], merged: [], ...ok }), "24h"), /unavailable/);
});

test("edge: two sessions on one issue, the most recently started wins", () => {
  const sessions = laneSessions([agent("new00001", wt("issue-10-b"), { startedAt: 5 }), agent("old00001", wt("issue-10-a"), { startedAt: 2 })], ROOT);
  assert.equal(sessions.get(10).id, "new00001");
});

test("edge: malformed entries and a missing id are skipped; a bare issue-<N> folder is a lane (#134)", () => {
  const sessions = laneSessions([null, "x", { kind: "background" }, agent(undefined, wt("issue-10-x")), agent("aaaa0001", wt("issue-11")), agent("aaaa0002", `${wt("issue-12-y")}\\scripts`)], ROOT);
  assert.deepEqual([...sessions.keys()], [11, 12]);
});

test("edge: Windows paths match case-insensitively with either slash; POSIX paths match exactly", () => {
  assert.equal(laneSessions([agent("aaaa0001", "c:/REPO/Lanes/.claude/worktrees/issue-10-x")], `${ROOT}\\`).size, 1);
  assert.equal(laneSessions([agent("aaaa0001", "/srv/lanes/.claude/worktrees/issue-10-x")], "/srv/lanes").size, 1);
  assert.equal(laneSessions([agent("aaaa0001", "/srv/Lanes/.claude/worktrees/issue-10-x")], "/srv/lanes").size, 0);
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

test("edge: a PR needing the owner that also has a running session keeps the session id in its needs: note", () => {
  const sessions = laneSessions([agent("42c93c57", wt("issue-10-x"))], ROOT);
  const s = summarize({ prs: [pr(7, [], { closingIssuesReferences: [{ number: 10 }], body: body("approve please") })], issues: [issue(10)], merged: [], sessions });
  assert.deepEqual(s.waitingOnOwner, [{ number: 7, title: "pr 7", stage: "starting", note: "needs: approve please — session 42c93c57", session: { id: "42c93c57", state: "working" } }]);
});

// #134: a lane whose worktree folder is `issue-<N>` with no slug is still that issue's lane.
test("laneSessions maps both issue-<N> and issue-<N>-<slug> folders to N, and never a look-alike number", () => {
  const sessions = laneSessions(
    ["issue-104", "issue-106\\scripts\\lanes", "issue-7-slug", "issue-5x", "issue-5x-slug", "issue-", "issue-9-", "issue-80"].map((dir, i) => agent(`aaaa000${i}`, wt(dir))),
    ROOT,
  );
  assert.deepEqual([...sessions.keys()], [104, 106, 7, 9, 80]);
  assert.equal(sessions.get(104).id, "aaaa0000");
});

// #121: a lane that stopped before opening its PR (a pushed or local issue-<N>-* branch, no PR, no busy session).
const idleAgent = (id, cwd) => agent(id, cwd, { status: "idle", state: "blocked" });
const RESTART = (n) => `no PR yet: restart with /start ${n}`;
const branches = (n, ...names) => new Map([[n, names.length ? names : [`issue-${n}-x`]]]);

test("a pushed branch with no PR and no busy session is WAITING ON YOU as stopped", () => {
  const s = summarize({ prs: [], issues: [issue(10), issue(11)], merged: [], sessions: new Map(), laneBranches: branches(10) });
  assert.deepEqual(s.waitingOnOwner.map((i) => [i.number, i.stage, i.note]), [[10, "stopped", RESTART(10)]]);
  assert.deepEqual([s.inFlight, s.ready.map((i) => i.number)], [[], [11]]);
  assert.match(render(s, "24h"), /WAITING ON YOU \(1\)\n  #10 \[stopped\] issue 10 — no PR yet: restart with \/start 10\n/);
});

// #571: with a session the note names it and gives the recovery /start gives; "restart with /start" only with no session.
const RECOVER = (id, n) => `no PR yet: session ${id} is idle; message it to continue, or stop it (claude stop ${id}) and run /start ${n} again`;

test("#571: a stopped lane with an idle session names the session and both recoveries, never 'restart with /start'", () => {
  for (const state of ["blocked", "prompt", "done"]) {
    const sessions = laneSessions([agent("42c93c57", wt("issue-10-x"), { status: "idle", state })], ROOT);
    const s = summarize({ prs: [], issues: [issue(10), issue(11)], merged: [], sessions, laneBranches: branches(10) });
    assert.deepEqual(s.waitingOnOwner.map((i) => [i.number, i.stage, i.note]), [[10, "stopped", RECOVER("42c93c57", 10)]], state);
    assert.doesNotMatch(render(s, "24h"), /restart with/, state);
  }
});

test("#571: a busy session is running, not stopped, and a prompt wait stays a prompt", () => {
  const busy = laneSessions([agent("42c93c57", wt("issue-10-x"))], ROOT);
  const s = summarize({ prs: [], issues: [issue(10)], merged: [], sessions: busy, laneBranches: branches(10) });
  assert.deepEqual([s.waitingOnOwner, s.inFlight.map((i) => i.stage)], [[], ["running"]]);
  const prompt = laneSessions([waitingAgent("42c93c57", wt("issue-10-x"))], ROOT);
  assert.deepEqual(summarize({ prs: [], issues: [issue(10)], merged: [], sessions: prompt, laneBranches: branches(10) }).waitingOnOwner.map((i) => i.stage), ["running"]);
});

test("#571: edge: a session id that is not a plain token is never printed in the stop command", () => {
  const sessions = laneSessions([agent("x; rm -rf ~", wt("issue-10-x"), { status: "idle", state: "blocked" })], ROOT);
  const s = summarize({ prs: [], issues: [issue(10)], merged: [], sessions, laneBranches: branches(10) });
  assert.equal(s.waitingOnOwner[0].note, "no PR yet: a lane session is idle; stop it and run /start 10 again");
});

test("#571: idleLaneSession is idle in any state but not on a permission prompt or busy", () => {
  assert.equal(idleLaneSession({ status: "idle", state: "blocked" }), true);
  assert.equal(idleLaneSession({ status: "idle", state: "working" }), true);
  assert.equal(idleLaneSession({ status: "idle", waitingFor: "permission prompt", state: "blocked" }), false);
  assert.equal(idleLaneSession({ status: "busy", state: "working" }), false);
  assert.equal(idleLaneSession({ status: "waiting", waitingFor: "permission prompt", state: "blocked" }), false);
  assert.equal(idleLaneSession(undefined), false);
});

test("#571: the note adds 'worktree has unsaved changes' when git status --porcelain prints something, and nothing on a read failure", () => {
  const agents = [idleAgent("42c93c57", wt("issue-10-x"))];
  const calls = [];
  const dirty = loadSessions(ROOT, () => JSON.stringify(agents), (args) => (calls.push(args), " M a.mjs\n"));
  assert.deepEqual(calls, [["-C", `${ROOT.replace(/\\/g, "/").toLowerCase()}/.claude/worktrees/issue-10-x`, "status", "--porcelain"]]);
  const s = summarize({ prs: [], issues: [issue(10)], merged: [], sessions: dirty.sessions, laneBranches: branches(10) });
  assert.equal(s.waitingOnOwner[0].note, `${RECOVER("42c93c57", 10)}; worktree has unsaved changes`);
  const clean = loadSessions(ROOT, () => JSON.stringify(agents), () => "");
  const failed = loadSessions(ROOT, () => JSON.stringify(agents), () => { throw new Error("git failed"); });
  for (const { sessions } of [clean, failed]) {
    const t = summarize({ prs: [], issues: [issue(10)], merged: [], sessions, laneBranches: branches(10) });
    assert.equal(t.waitingOnOwner[0].note, RECOVER("42c93c57", 10));
  }
});

test("#571: edge: worktreeUnsaved reads nothing for a session whose cwd is not an issue worktree, and laneWorktree finds the folder from a subfolder", () => {
  assert.equal(laneWorktree("/r/.claude/worktrees/issue-10-x/scripts/lanes", 10), "/r/.claude/worktrees/issue-10-x");
  assert.equal(laneWorktree("/r/.claude/worktrees/issue-10", 10), "/r/.claude/worktrees/issue-10");
  assert.equal(laneWorktree("/r", 10), null);
  assert.equal(laneWorktree("/r/.claude/worktrees/issue-100-x", 10), null);
  assert.equal(worktreeUnsaved(null, () => assert.fail("must not run")), false);
});

// #136: a lane that found its criteria already met left the issue labelled needs-owner
const ALREADY_MET = "close it or rewrite it";
const needsOwner = (n, ...more) => ({ ...issue(n), labels: [{ name: "needs-owner" }, ...more.map((name) => ({ name }))] });

test("an open issue labelled needs-owner is WAITING ON YOU as [already met]", () => {
  const s = summarize({ prs: [], issues: [needsOwner(60), issue(61)], merged: [], sessions: new Map() });
  assert.deepEqual(s.waitingOnOwner.map((i) => [i.number, i.stage, i.note]), [[60, "already met", ALREADY_MET]]);
  assert.match(render(s, "24h"), /WAITING ON YOU \(1\)\n  #60 \[already met\] issue 60 — close it or rewrite it\n/);
});

test("edge: needs-owner wins even if the issue still carries ready, so it is never listed as ready to start", () => {
  const s = summarize({ prs: [], issues: [needsOwner(60, "ready", "tier:quick")], merged: [], sessions: new Map() });
  assert.deepEqual([s.waitingOnOwner.map((i) => i.number), s.ready, s.blocked], [[60], [], []]);
});

test("edge: an issue without needs-owner, ready or not, is never listed as already met", () => {
  const s = summarize({ prs: [], issues: [issue(60), { ...issue(61), labels: [{ name: "lane-filed" }] }], merged: [], sessions: new Map() });
  assert.deepEqual(s.waitingOnOwner, []);
});

test("edge: a needs-owner issue that still has a lane branch is listed once as already met, not also as stopped", () => {
  const s = summarize({ prs: [], issues: [needsOwner(60, "ready")], merged: [], sessions: new Map(), laneBranches: branches(60) });
  assert.deepEqual(s.waitingOnOwner.map((i) => [i.number, i.stage]), [[60, "already met"]]);
  assert.deepEqual(s.inFlight, []);
});

test("edge: a needs-owner issue with an open PR or a busy session keeps showing as the PR or the running lane, not as already met", () => {
  const withPr = summarize({ prs: [pr(7, [gate("PENDING", "waiting for review/test-hunter")], { closingIssuesReferences: [{ number: 60 }] })], issues: [needsOwner(60)], merged: [], sessions: new Map() });
  assert.deepEqual([withPr.waitingOnOwner, withPr.inFlight.map((i) => i.number)], [[], [7]]);
  const sessions = laneSessions([agent("42c93c57", wt("issue-60-x"))], ROOT);
  const running = summarize({ prs: [], issues: [needsOwner(60)], merged: [], sessions });
  assert.deepEqual([running.waitingOnOwner, running.inFlight.map((i) => [i.number, i.stage])], [[], [[60, "running"]]]);
});

test("edge: a needs-owner issue whose session is waiting on a prompt shows as the waiting lane, not as already met", () => {
  const sessions = laneSessions([waitingAgent("42c93c57", wt("issue-60-x"))], ROOT);
  const s = summarize({ prs: [], issues: [needsOwner(60)], merged: [], sessions });
  assert.deepEqual(s.waitingOnOwner.map((i) => [i.number, i.stage]), [[60, "running"]]);
});

test("edge: several needs-owner issues are each listed once, in issue order", () => {
  const s = summarize({ prs: [], issues: [needsOwner(60), needsOwner(62)], merged: [], sessions: new Map() });
  assert.deepEqual(s.waitingOnOwner.map((i) => i.number), [60, 62]);
});

test("--json carries the stopped stage, with the idle session when there is one", () => {
  const sessions = laneSessions([idleAgent("42c93c57", wt("issue-10-x"))], ROOT);
  const s = summarize({ prs: [], issues: [issue(10)], merged: [], sessions, laneBranches: branches(10) });
  assert.deepEqual(JSON.parse(JSON.stringify(s)).waitingOnOwner, [{ number: 10, title: "issue 10", stage: "stopped", note: RECOVER("42c93c57", 10), session: { id: "42c93c57", state: "blocked" } }]);
});

test("a lane whose session is busy is running, not stopped", () => {
  const sessions = laneSessions([agent("42c93c57", wt("issue-10-x"))], ROOT);
  const s = summarize({ prs: [], issues: [issue(10)], merged: [], sessions, laneBranches: branches(10) });
  assert.deepEqual([s.waitingOnOwner, s.inFlight.map((i) => [i.number, i.stage])], [[], [[10, "running"]]]);
});

test("a branch whose PR is open is not stopped, whether the PR closes the issue or only its branch matches", () => {
  const byRef = pr(7, [gate("PENDING", "waiting for review/test-hunter")], { closingIssuesReferences: [{ number: 10 }] });
  const byBranch = pr(7, [gate("PENDING", "waiting for review/test-hunter")], { headRefName: "issue-10-x" });
  for (const p of [byRef, byBranch]) {
    const s = summarize({ prs: [p], issues: [issue(10)], merged: [], laneBranches: branches(10) });
    assert.deepEqual([s.waitingOnOwner, s.inFlight.map((i) => i.number), s.ready], [[], [7], []]);
  }
});

test("edge: an issue with several leftover branches is taken when any one of them has an open PR, not only when all do", () => {
  const p = pr(7, [gate("PENDING", "waiting for review/test-hunter")], { headRefName: "issue-10-new" });
  const s = summarize({ prs: [p], issues: [issue(10)], merged: [], laneBranches: branches(10, "issue-10-old", "issue-10-new") });
  assert.deepEqual([s.waitingOnOwner, s.inFlight.map((i) => i.number), s.ready], [[], [7], []]);
});

test("laneBranches maps pushed branches and local lane worktrees to their issue", () => {
  const remote = ["abc123\trefs/heads/issue-10-x", "def456\trefs/heads/main", "0a0a0a\trefs/heads/issue-5x-y", "1b1b1b\trefs/heads/issue-12"].join("\n");
  const worktrees = [
    `worktree ${ROOT}`, "HEAD 1", "branch refs/heads/main", "",
    `worktree ${wt("issue-13-z")}`, "HEAD 2", "branch refs/heads/issue-13-z", "",
    `worktree ${wt("issue-14")}`, "HEAD 3", "detached", "",
    `worktree ${wt("other")}`, "HEAD 4", "branch refs/heads/issue-15-w", "",
  ].join("\n");
  assert.deepEqual([...laneBranches({ remote, worktrees })], [
    [10, ["issue-10-x"]],
    [12, ["issue-12"]],
    [13, ["issue-13-z"]],
    [14, ["issue-14"]],
    [15, ["issue-15-w"]],
  ]);
});

test("edge: laneBranches reads CRLF output, dedupes a branch both pushed and local, and ignores empty or malformed input", () => {
  const remote = "abc\trefs/heads/issue-10-x\r\nnot a ref line\r\n\trefs/heads/issue-0-zero\r\n";
  const worktrees = `worktree ${wt("issue-10-x")}\r\nHEAD 1\r\nbranch refs/heads/issue-10-x\r\n\r\nbranch refs/heads/issue-11-no-path\r\n`;
  assert.deepEqual([...laneBranches({ remote, worktrees })], [[10, ["issue-10-x"]], [11, ["issue-11-no-path"]]]);
  assert.equal(laneBranches({}).size, 0);
  assert.equal(laneBranches({ remote: "", worktrees: "" }).size, 0);
});

test("edge: loadLaneBranches keeps what it could read and says what it could not", () => {
  const worktrees = `worktree ${wt("issue-10-x")}\nbranch refs/heads/issue-10-x\n`;
  const offline = (args) => {
    if (args[0] === "ls-remote") throw new Error("could not resolve host");
    return worktrees;
  };
  assert.deepEqual(loadLaneBranches(offline), { laneBranches: new Map([[10, ["issue-10-x"]]]), branchesUnavailable: "git ls-remote origin failed" });
  assert.deepEqual(loadLaneBranches(() => { throw new Error("x"); }).branchesUnavailable, "git worktree list failed; git ls-remote origin failed");
  assert.equal("branchesUnavailable" in loadLaneBranches(() => ""), false);
  const text = render(summarize({ prs: [], issues: [issue(10)], merged: [], ...loadLaneBranches(offline) }), "24h");
  assert.match(text, /#10 \[stopped\]/);
  assert.ok(text.endsWith("\n\n(stopped lanes may be missing: git ls-remote origin failed)"), text);
});

test("edge: a branch on an issue without the ready label, or a closed issue, is not listed as stopped", () => {
  const s = summarize({ prs: [], issues: [issue(10, "none", { ready: false })], merged: [], laneBranches: new Map([[10, ["issue-10-x"]], [99, ["issue-99-y"]]]) });
  assert.deepEqual([s.waitingOnOwner, s.inFlight, s.ready], [[], [], []]);
});

test("edge: a lane on a permission prompt stays a prompt to answer, not a restart", () => {
  const sessions = laneSessions([waitingAgent("42c93c57", wt("issue-10-x"))], ROOT);
  const s = summarize({ prs: [], issues: [issue(10)], merged: [], sessions, laneBranches: branches(10) });
  assert.deepEqual(s.waitingOnOwner.map((i) => [i.stage, i.note]), [["running", "waiting on a prompt: claude attach 42c93c57"]]);
});

test("edge: a stopped lane on an issue whose blockers reopened is still stopped, not blocked, and still claims its paths", () => {
  const s = summarize({ prs: [], issues: [scoped(10, "In: `a.mjs`"), issue(11), scoped(12, "In: `a.mjs`")], merged: [], laneBranches: branches(10) });
  assert.deepEqual(s.waitingOnOwner.map((i) => [i.number, i.stage]), [[10, "stopped"]]);
  const blocked = summarize({ prs: [], issues: [issue(10, "#11"), issue(11)], merged: [], laneBranches: branches(10) });
  assert.deepEqual([blocked.waitingOnOwner.map((i) => i.number), blocked.blocked], [[10], []]);
  assert.match(s.ready.find((i) => i.number === 12).note, /running #10/);
});

test("edge: an open PR from another issue's branch does not hide this issue's stopped lane", () => {
  const s = summarize({ prs: [pr(7, [], { headRefName: "issue-11-y" })], issues: [issue(10)], merged: [], laneBranches: branches(10) });
  assert.deepEqual(s.waitingOnOwner.map((i) => i.number), [10]);
});

// #97 (from #122): prStage is exported, classifying each stage as summarize relies on.
test("prStage is exported and classifies each stage", async () => {
  const { prStage } = await import("./status.mjs");
  assert.equal(typeof prStage, "function");
  assert.deepEqual(prStage(pr(1, [gate("PENDING", "x")]), 3), { stage: "queued", note: "in merge queue, position 3" });
  assert.deepEqual(prStage(pr(2, [{ name: "test", conclusion: "FAILURE" }])), { stage: "failing", note: "failing: test" });
  assert.deepEqual(prStage(pr(3, [])), { stage: "starting", note: "no lanes/gate yet" });
  assert.deepEqual(prStage(pr(4, [gate("SUCCESS", "ok")])), { stage: "ready", note: "auto-merge is off" });
  assert.deepEqual(prStage(pr(5, [gate("FAILURE", "tier label missing")])), { stage: "contract", note: "tier label missing" });
  const noDescription = [{ context: "lanes/gate", state: "PENDING" }];
  assert.deepEqual(prStage(pr(6, noDescription), undefined, "waiting for a code-owner review in GitHub"), { stage: "owner", note: "waiting for a code-owner review in GitHub" });
  assert.equal(prStage(pr(9, noDescription), undefined, "waiting on owner (/approve)").stage, "review", "the solo wording is no owner stage");
  assert.deepEqual(prStage(pr(7, [gate("PENDING", "waiting for review/test-hunter")])), { stage: "gate", note: "waiting for review/test-hunter" });
  assert.deepEqual(prStage(pr(8, [gate("PENDING", "waiting on reviewers")])), { stage: "review", note: "waiting on reviewers" });
});

const ownerGate = gate("PENDING", "waiting for a code-owner review in GitHub");
const waitingBody = (needs, contract = "none") => body(needs).replace("## Contract changes\nnone", `## Contract changes\n${contract}`);
const waitingPr = (number, extra = {}) => pr(number, [ownerGate], { body: waitingBody("Approve the new label"), files: [{ path: "a" }, { path: "b" }], ...extra });
const waitingOf = (prs) => renderWaiting(waitingApprovals(prs, summarize({ prs, issues: [], merged: [] })));

test("--waiting prints none when no PR waits on /approve", () => {
  assert.equal(waitingOf([pr(2, [gate("PENDING", "waiting for review/test-hunter")])]), "none");
  assert.equal(waitingOf([]), "none");
});

test("--waiting prints one block with the number, title, needs, contract changes and file count", () => {
  const out = waitingOf([waitingPr(7, { body: waitingBody("Approve the new label", "additive: new field") })]);
  assert.equal(out, "#7 pr 7\n  Needs the owner: Approve the new label\n  Contract changes: additive: new field\n  Files changed: 2");
});

test("--waiting lists several, skipping PRs that do not wait on /approve", () => {
  const out = waitingOf([waitingPr(7), pr(8, [gate("PENDING", "waiting for review/test-hunter")]), waitingPr(9, { files: [] })]);
  assert.deepEqual(out.split("\n\n").map((b) => b.split("\n")[0]), ["#7 pr 7", "#9 pr 9"]);
  assert.match(out, /Files changed: 0/);
});

test("edge: --waiting on a PR body without a Needs the owner section says so", () => {
  const out = waitingOf([waitingPr(7, { body: "Closes #1\n## What changed\nx" })]);
  assert.match(out, /Needs the owner: \(none stated\)/);
  assert.match(out, /Contract changes: \(none stated\)/);
});

test("edge: --waiting skips an issue waiting on the owner", () => {
  const s = summarize({ prs: [], issues: [{ number: 5, title: "t", labels: [{ name: "needs-owner" }], body: "" }], merged: [] });
  assert.equal(renderWaiting(waitingApprovals([], s)), "none");
});

test("edge: --waiting includes a PR whose body asks for /approve while its gate is elsewhere", () => {
  const p = pr(4, [gate("PENDING", "some other wait")], { body: body("Please /approve this"), files: [{ path: "a" }] });
  assert.match(waitingOf([p]), /^#4 pr 4/);
});

test("edge: --waiting strips control characters from the title and body lines", () => {
  const out = waitingOf([waitingPr(7, { title: "a\u001b[31mred", body: waitingBody("go\u001b[2Jnow") })]);
  assert.equal(out.includes("\u001b"), false);
  assert.match(out, /#7 a\[31mred/);
});

// #383: each waiting PR's age since it began waiting (the gate status's time), oldest first.
test("--waiting shows each PR's age since it began waiting, oldest first", () => {
  const now = Date.UTC(2026, 8, 29, 12, 0, 0);
  const prs = [waitingPr(7), waitingPr(8), waitingPr(9)];
  const since = new Map([[7, now - 30 * 60_000], [8, now - (2 * 3600 + 5 * 60) * 60_000 / 60], [9, now - 26 * 3600_000]]);
  const list = waitingApprovals(prs, summarize({ prs, issues: [], merged: [] }), since, now);
  assert.deepEqual(list.map((w) => [w.number, w.age]), [[9, "1d 2h"], [8, "2h 5m"], [7, "30m"]]);
  assert.match(renderWaiting(list), /^#9 pr 9 — waiting 1d 2h\n/);
});

test("edge: a waiting PR with no known time has no age and sorts after the aged ones", () => {
  const prs = [waitingPr(7), waitingPr(8)];
  const list = waitingApprovals(prs, summarize({ prs, issues: [], merged: [] }), new Map([[8, 0]]), 90_000);
  assert.deepEqual(list.map((w) => [w.number, w.age]), [[8, "1m"], [7, undefined]]);
  assert.doesNotMatch(renderWaiting(list), /#7 pr 7 —/);
});

test("gateSince reads the gate status time per PR and skips a missing or unreadable one", () => {
  const node = (number, createdAt) => ({ number, commits: { nodes: [{ commit: { status: { context: { description: "d", createdAt } } } }] } });
  const reply = { data: { repository: { pullRequests: { nodes: [node(1, "2026-09-29T10:00:00Z"), node(2, "junk"), { number: 3, commits: { nodes: [] } }] } } } };
  assert.deepEqual([...gateSince(reply)], [[1, Date.UTC(2026, 8, 29, 10)]]);
  assert.deepEqual([...gateSince({})], []);
});

test("edge: formatAge is never negative and rolls minutes into hours and days", () => {
  assert.equal(formatAge(100, 50), "0m");
  assert.equal(formatAge(0, 59 * 60_000), "59m");
  assert.equal(formatAge(0, 60 * 60_000), "1h 0m");
  assert.equal(formatAge(0, 48 * 3600_000), "2d 0h");
});

test("status.mjs exports no approveLine", async () => {
  assert.equal((await import("./status.mjs")).approveLine, undefined);
});

// Stalled: a busy session whose transcript has not been written for 30 minutes or more (#338).
const NOW = 10_000_000_000;
const ago = (min) => NOW - min * 60_000;
const stalledOf = (agents, mtime) => stalledLanes(agents, ROOT, { home: "H", now: NOW, mtime });

test("stalled: a fresh transcript carries no marker", () => {
  assert.equal(stalledOf([agent("aaaa0001", wt("issue-10-x"))], () => ago(5)).size, 0);
});

test("stalled: a 45-minute-old transcript of a busy session is marked and shown in /status and --waiting", () => {
  const agents = [agent("aaaa0001", wt("issue-10-x"))];
  const stalled = stalledOf(agents, () => ago(45));
  assert.deepEqual([...stalled], [[10, 45]]);
  const s = summarize({ prs: [], issues: [issue(10)], merged: [], sessions: laneSessions(agents, ROOT), stalled });
  assert.equal(s.inFlight[0].note, "stalled 45 min — session aaaa0001");
  assert.equal(s.inFlight[0].session.stalledMin, 45);
  assert.equal(renderWaiting([], stalledItems(s)), "#10 issue 10 — stalled 45 min: claude attach aaaa0001");
  assert.match(renderWaiting([{ number: 7, title: "t", needs: "n", contract: "c", files: 1 }], stalledItems(s)), /Files changed: 1\n\n#10 .* stalled 45 min/);
});

test("stalled: a missing or unreadable transcript never fails and adds no marker", () => {
  for (const code of ["ENOENT", "EACCES"]) {
    const mtime = () => { throw Object.assign(new Error("x"), { code }); };
    assert.equal(stalledOf([agent("aaaa0001", wt("issue-10-x"))], mtime).size, 0);
  }
  const s = summarize({ prs: [], issues: [issue(10)], merged: [], sessions: laneSessions([agent("aaaa0001", wt("issue-10-x"))], ROOT), stalled: new Map() });
  assert.equal(s.inFlight[0].note, "session aaaa0001");
});

test("stalled: an idle session with an old transcript is not stalled", () => {
  assert.equal(stalledOf([agent("aaaa0001", wt("issue-10-x"), { status: "idle", state: "blocked" })], () => ago(300)).size, 0);
});

test("edge: a session waiting on a prompt is not shown as stalled", () => {
  const agents = [waitingAgent("aaaa0001", wt("issue-10-x"))];
  const s = summarize({ prs: [], issues: [issue(10)], merged: [], sessions: laneSessions(agents, ROOT), stalled: new Map([[10, 90]]) });
  assert.equal(s.waitingOnOwner[0].note, "waiting on a prompt: claude attach aaaa0001");
  assert.equal(stalledItems(s).length, 0);
});

test("edge: stalled boundary, unsafe session id, and the fallback to the session's own folder", () => {
  assert.equal(stalledOf([agent("aaaa0001", wt("issue-10-x"))], () => ago(30)).size, 1);
  assert.equal(stalledOf([agent("aaaa0001", wt("issue-10-x"))], () => ago(29.9)).size, 0);
  assert.equal(stalledOf([{ ...agent("aaaa0001", wt("issue-10-x")), sessionId: "../x" }], () => ago(90)).size, 0);
  assert.equal(stalledOf([{ ...agent("aaaa0001", wt("issue-10-x")), sessionId: undefined }], () => ago(90)).size, 0);
  const seen = [];
  const mtime = (f) => {
    seen.push(f);
    if (seen.length === 1) throw Object.assign(new Error("x"), { code: "ENOENT" });
    return ago(60);
  };
  assert.deepEqual([...stalledOf([agent("aaaa0001", wt("issue-10-x"))], mtime)], [[10, 60]]);
  assert.equal(seen.length, 2);
  assert.notEqual(seen[0], seen[1]);
  assert.equal(stalledOf([agent("aaaa0001", wt("issue-10-x"))], () => Number.NaN).size, 0);
  assert.equal(renderWaiting([], []), "none");
});

// #416: a lane PR that GitHub reports as CONFLICTING waits on the owner, whatever its checks say.
test("a CONFLICTING PR shows conflict: rebase needed and waits on the owner; UNKNOWN shows nothing", () => {
  const pending = [gate("PENDING", "waiting for review/test-hunter")];
  const s = summarize({
    prs: [pr(1, pending, { mergeable: "CONFLICTING" }), pr(2, pending, { mergeable: "UNKNOWN" }), pr(3, [gate("SUCCESS", "ok")], { mergeable: "MERGEABLE", autoMergeRequest: {} })],
    issues: [], merged: [], mergeQueue: [],
  });
  assert.deepEqual(s.waitingOnOwner.map((i) => [i.number, i.note]), [[1, "conflict: rebase needed"]]);
  assert.deepEqual(s.inFlight.map((i) => i.number), [2, 3]);
  assert.match(render(s, "24h"), /conflict: rebase needed/);
});
test("edge: a conflicted PR stays on the owner's list even after review/owner passed", () => {
  const approved = { __typename: "StatusContext", context: "review/owner", state: "SUCCESS" };
  const s = summarize({ prs: [pr(1, [gate("PENDING", "waiting for a code-owner review in GitHub"), approved], { mergeable: "CONFLICTING" })], issues: [], merged: [], mergeQueue: [] });
  assert.deepEqual(s.waitingOnOwner.map((i) => i.number), [1]);
});

// #390
const laneAgent = (n, sessionId) => ({ kind: "background", id: `id-${n}`, cwd: `/repo/.claude/worktrees/issue-${n}-x`, sessionId, startedAt: 1 });
const okLoad = (over = {}) => (input) => ({ spent24h: 5, perNightTokens: input.perNightTokens, over: false, lanesOver: [], ...over });
const noConfig = () => { throw Object.assign(new Error("x"), { code: "ENOENT" }); };

test("liveLanes lists each running lane's issue, session and cwd", () => {
  assert.deepEqual(liveLanes([laneAgent(4, "s4"), { kind: "interactive", cwd: "/repo/.claude/worktrees/issue-9-x" }], "/repo"), [{ issue: 4, sessionId: "s4", cwd: "/repo/.claude/worktrees/issue-4-x" }]);
});

test("readBudget passes the config's caps and the running lanes to loadBudget", () => {
  let seen;
  const r = readBudget("/repo", JSON.stringify([laneAgent(4, "s4")]), {
    readConfig: () => JSON.stringify({ budget: { perNightTokens: 9, perLaneTokens: 3 } }),
    load: (input) => ((seen = input), okLoad({ over: true, lanesOver: [4] })(input)),
  });
  assert.deepEqual(r, { spent24h: 5, perNightTokens: 9, over: true, lanesOver: [4] });
  assert.equal(seen.perLaneTokens, 3);
  assert.deepEqual(seen.lanes.map((l) => l.issue), [4]);
});

test("edge: readBudget uses the defaults for a missing config and says so for a bad one or unreadable agents", () => {
  const missing = readBudget("/repo", "[]", { readConfig: noConfig, load: okLoad() });
  assert.equal(missing.perNightTokens, 100_000_000);
  assert.equal(missing.note, undefined);
  const bad = readBudget("/repo", "not json", { readConfig: () => JSON.stringify({ budget: { perNightTokens: 0 } }), load: okLoad() });
  assert.equal(bad.perNightTokens, 100_000_000);
  assert.match(bad.note, /budget not read .*perNightTokens/);
  assert.match(bad.note, /running lanes unreadable/);
});

test("edge: readBudget never puts a file system error's path in its note", () => {
  const r = readBudget("/repo", "[]", { readConfig: () => { throw Object.assign(new Error("EACCES: permission denied, open '/secret/lanes.config.json'"), { code: "EACCES" }); }, load: okLoad() });
  assert.equal(r.note, "lanes.config.json unreadable, budget defaults used");
  assert.equal(r.perNightTokens, 100_000_000);
});

test("edge: readBudget keeps loadBudget's own note", () => {
  const r = readBudget("/repo", "[]", { readConfig: () => "{}", load: okLoad({ note: "no .lanes/costs.jsonl yet, counted as 0" }) });
  assert.equal(r.note, "no .lanes/costs.jsonl yet, counted as 0");
});

// Idle lane that still owes a review or check (#465): a session idle 30+ minutes while its PR waits on a reviewer.
const idleLane = (extra = {}) => agent("aaaa0001", wt("issue-10-x"), { status: "idle", state: "blocked", ...extra });
const idleOf = (agents, mtime) => idleLanes(agents, ROOT, { home: "H", now: NOW, mtime });
const owedSummary = (gateState, min, agents = [idleLane()]) =>
  summarize({
    prs: [pr(5, [gate("PENDING", gateState)], { closingIssuesReferences: [{ number: 10 }] })],
    issues: [issue(10)],
    merged: [],
    sessions: laneSessions(agents, ROOT),
    idle: idleOf(agents, () => ago(min)),
  });

test("idle: 45 minutes idle with a review owed is reported under WAITING ON YOU with minutes and claude attach", () => {
  const s = owedSummary("waiting for review/security-reviewer", 45);
  assert.equal(s.inFlight.length, 0);
  assert.equal(s.waitingOnOwner.length, 1);
  assert.equal(s.waitingOnOwner[0].note, "waiting for review/security-reviewer — idle 45 min: claude attach aaaa0001");
  assert.equal(s.waitingOnOwner[0].session.stalledMin, 45);
  assert.equal(renderWaiting([], stalledItems(s)), "#5 pr 5 — stalled 45 min: claude attach aaaa0001");
});

test("idle: idle 45 minutes with nothing owed is not reported", () => {
  const s = owedSummary("waiting for a code-owner review in GitHub", 45);
  assert.equal(stalledItems(s).length, 0);
  assert.doesNotMatch(JSON.stringify(s), /idle 45/);
});

test("idle: idle under 30 minutes is not reported", () => {
  const s = owedSummary("waiting for review/security-reviewer", 29);
  assert.equal(s.waitingOnOwner.length, 0);
  assert.equal(s.inFlight[0].session.stalledMin, undefined);
});

test("idle: busy and silent is reported as before", () => {
  const agents = [agent("aaaa0001", wt("issue-10-x"))];
  assert.equal(idleOf(agents, () => ago(90)).size, 0);
  const s = summarize({ prs: [], issues: [issue(10)], merged: [], sessions: laneSessions(agents, ROOT), stalled: stalledOf(agents, () => ago(90)) });
  assert.equal(s.inFlight[0].note, "stalled 90 min — session aaaa0001");
});

test("edge: idle lanes skip a session waiting on a prompt, honour the 30 minute boundary and survive an unreadable transcript", () => {
  assert.equal(idleOf([idleLane({ waitingFor: "permission prompt" })], () => ago(90)).size, 0);
  assert.equal(idleOf([idleLane()], () => ago(30)).size, 1);
  assert.equal(idleOf([idleLane()], () => ago(29.9)).size, 0);
  assert.equal(idleOf([idleLane()], () => { throw new Error("x"); }).size, 0);
});

test("edge: a failing check owes the lane too, so an idle lane on it is reported", () => {
  const agents = [idleLane()];
  const s = summarize({
    prs: [pr(5, [{ __typename: "CheckRun", name: "test", conclusion: "FAILURE" }, gate("PENDING", "waiting for review/test-hunter")], { closingIssuesReferences: [{ number: 10 }] })],
    issues: [issue(10)], merged: [], sessions: laneSessions(agents, ROOT), idle: idleOf(agents, () => ago(60)),
  });
  assert.equal(s.waitingOnOwner[0].stage, "failing");
  assert.match(s.waitingOnOwner[0].note, /idle 60 min: claude attach aaaa0001/);
});

test("edge: an idle lane is reported on a PR with no gate yet or a gate in another pending state, and not on a failed contract", () => {
  const agents = [idleLane()];
  const run = (rollup) => summarize({ prs: [pr(5, rollup, { closingIssuesReferences: [{ number: 10 }] })], issues: [issue(10)], merged: [], sessions: laneSessions(agents, ROOT), idle: idleOf(agents, () => ago(60)) });
  assert.match(run([]).waitingOnOwner[0].note, /^no lanes\/gate yet — idle 60 min: claude attach aaaa0001$/);
  assert.equal(run([gate("PENDING", "checks still running")]).waitingOnOwner[0].stage, "review");
  assert.doesNotMatch(JSON.stringify(run([gate("FAILURE", "contract broken")])), /idle 60/);
});

// #483: --starts <days> summarises .lanes/starts.jsonl.
const dayAgo = (d) => new Date(NOW - d * 86_400_000).toISOString();
const row = (d, issue, outcome, reason, w) => JSON.stringify({ at: dayAgo(d), issue, outcome, ...(reason ? { reason } : {}), ...(w ? { with: w } : {}) });

test("#483: --starts on an absent or empty log prints no start decisions recorded", () => {
  assert.deepEqual(startsReport(undefined, 7, NOW), ["no start decisions recorded"]);
  assert.deepEqual(startsReport("", 7, NOW), ["no start decisions recorded"]);
  assert.deepEqual(startsReport("\n\n", 7, NOW), ["no start decisions recorded"]);
});

test("#483: --starts counts the window's started, overlap, cap and other skips, and each overlap pair", () => {
  const text = [
    row(1, 1, "started"),
    row(1, 2, "started"),
    row(1, 5, "skipped", "overlap", 3),
    row(2, 3, "skipped", "overlap", 5),
    row(2, 9, "skipped", "overlap", 4),
    row(2, 6, "skipped", "cap"),
    row(2, 7, "skipped", "blocked"),
    row(3, 8, "skipped", "in-flight"),
    row(10, 1, "skipped", "overlap", 2),
  ].join("\n");
  assert.deepEqual(startsReport(text, 7, NOW), [
    "start decisions, last 7 days: 2 started, 3 skipped for overlap, 1 for the cap, 2 for other reasons",
    "  overlap #3 and #5: 2",
    "  overlap #4 and #9: 1",
  ]);
});

test("#483: edge: a log with only old or unreadable lines reports no decisions, and a bad line never stops the summary", () => {
  assert.deepEqual(startsReport(`${row(30, 1, "started")}\nnot json\n{"at":"never","outcome":"started"}\n[]\nnull`, 7, NOW), ["no start decisions recorded"]);
  assert.deepEqual(startsReport(`garbage\n${row(0, 1, "started")}\n{"broken`, 7, NOW), ["start decisions, last 7 days: 1 started, 0 skipped for overlap, 0 for the cap, 0 for other reasons"]);
});

test("#483: edge: a future-dated line and an overlap with no partner are not counted as pairs", () => {
  const text = `${JSON.stringify({ at: dayAgo(-1), issue: 1, outcome: "started" })}\n${row(1, 2, "skipped", "overlap")}`;
  assert.deepEqual(startsReport(text, 7, NOW), ["start decisions, last 7 days: 0 started, 1 skipped for overlap, 0 for the cap, 0 for other reasons"]);
});

test("#483: edge: the window is inclusive at exactly N days and excludes one millisecond older or newer than now", () => {
  const at = (ms) => JSON.stringify({ at: new Date(ms).toISOString(), issue: 1, outcome: "started" });
  assert.match(startsReport(at(NOW - 7 * 86_400_000), 7, NOW)[0], /1 started/);
  assert.deepEqual(startsReport(at(NOW - 7 * 86_400_000 - 1), 7, NOW), ["no start decisions recorded"]);
  assert.match(startsReport(at(NOW), 7, NOW)[0], /1 started/);
  assert.deepEqual(startsReport(at(NOW + 1), 7, NOW), ["no start decisions recorded"]);
});

test("#483: health.md runs status.mjs --starts 7", async () => {
  const { readFileSync } = await import("node:fs");
  assert.match(readFileSync(new URL("../../.claude/commands/health.md", import.meta.url), "utf8"), /node scripts\/lanes\/status\.mjs --starts 7/);
});

const ctx = (context, login, type = "Bot", state = "SUCCESS") => ({ context, state, creator: login === null ? null : { login, __typename: type } });
const replyWith = (number, contexts) => ({ data: { repository: { pullRequests: { nodes: [{ number, commits: { nodes: [{ commit: { status: { contexts } } }] } }] } } } });
const review = (name) => ({ __typename: "StatusContext", context: `review/${name}`, state: "SUCCESS" });
const team = { identity: { profile: "team", app: { id: 1, installationId: 2, botLogin: "lanes-bot[bot]" } }, modules: { entries: [] } };
const waiting = (prs, reply, config) => summarize({ prs: trustedRollups(prs, reply, config), issues: [], merged: [] }).waitingOnOwner.map((i) => i.number);
const owing = () => [gate("PENDING", "waiting for a code-owner review in GitHub"), review("owner")];

test("a review/owner status, from a bot or anyone, leaves the PR WAITING ON YOU", () => {
  for (const login of ["lanes-bot[bot]", "github-actions[bot]"]) {
    assert.deepEqual(waiting([pr(8, owing())], replyWith(8, [ctx("review/owner", login)]), team), [8], login);
  }
  assert.deepEqual(waiting([pr(8, owing())], replyWith(8, [ctx("review/owner", "someone", "User")]), team), [8]);
});

test("edge: a review/owner whose creator cannot be read, or a PR missing from the reply, is untrusted", () => {
  assert.deepEqual(waiting([pr(8, owing())], replyWith(8, [ctx("review/owner", null)]), team), [8]);
  assert.deepEqual(waiting([pr(8, owing())], undefined, team), [8]);
});

test("a lane-bot reviewer status counts under team and not under solo; other checks are kept", () => {
  const prs = [pr(8, [gate("PENDING", "x"), review("test-hunter")])];
  const reply = replyWith(8, [ctx("review/test-hunter", "lanes-bot[bot]")]);
  const names = (config) => trustedRollups(prs, reply, config)[0].statusCheckRollup.map((c) => c.context);
  assert.deepEqual(names(team), ["lanes/gate", "review/test-hunter"]);
  assert.deepEqual(names({ identity: { profile: "solo" }, modules: { entries: [] } }), ["lanes/gate"]);
  assert.deepEqual(names({ modules: { entries: [] } }), ["lanes/gate"]);
});

const TEAM_WAIT = "waiting for a code-owner review in GitHub";
const teamCtx = { owners: ["boss"], identity: { profile: "team", app: { id: 1, installationId: 2, botLogin: "lanes[bot]" } } };
const nativeReview = (login, state, oid) => ({ author: { login }, state, commit: { oid } });
const teamPr = (number, reviews = [], extra = {}) => pr(number, [gate("PENDING", TEAM_WAIT)], { author: { login: "lanes[bot]" }, headRefOid: "abc", latestReviews: reviews, ...extra });

test("#604: prStage puts the team wording in the owner stage", () => {
  assert.deepEqual(prStage(pr(1, [gate("PENDING", TEAM_WAIT)]), undefined), { stage: "owner", note: TEAM_WAIT });
  assert.equal(prStage(pr(1, [gate("PENDING", `${TEAM_WAIT} (tier:full)`)]), undefined).stage, "owner");
  assert.equal(prStage(pr(1, [gate("PENDING", "waiting for a code-owner review in GitHub")]), undefined).stage, "owner");
});

test("#604: under team a PR waiting for a code-owner review is WAITING ON YOU", () => {
  const s = summarize({ prs: [teamPr(7)], issues: [], merged: [], team: teamCtx });
  assert.deepEqual(s.waitingOnOwner.map((i) => [i.number, i.stage, i.note]), [[7, "owner", TEAM_WAIT]]);
  assert.deepEqual(s.inFlight, []);
});

test("#604: a team PR approved by a code owner on its head is in flight", () => {
  const s = summarize({ prs: [teamPr(7, [nativeReview("boss", "APPROVED", "abc")])], issues: [], merged: [], team: teamCtx });
  assert.deepEqual(s.waitingOnOwner, []);
  assert.deepEqual(s.inFlight.map((i) => i.number), [7]);
});

test("edge: a team approval on an older head, by a non-owner, by the lane bot or superseded does not count", () => {
  const cases = [
    [nativeReview("boss", "APPROVED", "old")],
    [nativeReview("someone", "APPROVED", "abc")],
    [nativeReview("lanes[bot]", "APPROVED", "abc")],
    [nativeReview("boss", "APPROVED", "abc"), nativeReview("boss", "CHANGES_REQUESTED", "abc")],
  ];
  for (const reviews of cases) {
    const s = summarize({ prs: [teamPr(7, reviews, { author: { login: "other" } })], issues: [], merged: [], team: teamCtx });
    assert.deepEqual(s.waitingOnOwner.map((i) => i.number), [7], JSON.stringify(reviews));
  }
});

test("edge: a team PR with no review data, and one approved only by its own author, still wait", () => {
  const bare = pr(7, [gate("PENDING", TEAM_WAIT)]);
  assert.deepEqual(summarize({ prs: [bare], issues: [], merged: [], team: teamCtx }).waitingOnOwner.map((i) => i.number), [7]);
  const self = teamPr(7, [nativeReview("boss", "APPROVED", "abc")], { author: { login: "boss" } });
  assert.deepEqual(summarize({ prs: [self], issues: [], merged: [], team: teamCtx }).waitingOnOwner.map((i) => i.number), [7]);
});

test("#604: a review/owner status is never an approval, with or without a team context", () => {
  const withStatus = [gate("PENDING", TEAM_WAIT), ownerApproved()];
  for (const team of [teamCtx, undefined]) {
    assert.deepEqual(summarize({ prs: [pr(7, withStatus)], issues: [], merged: [], team }).waitingOnOwner.map((i) => i.number), [7]);
  }
});

test("edge: teamContext is undefined under solo or no config, and reads code owners under team", async () => {
  const { teamContext } = await import("./status.mjs");
  assert.equal(teamContext(undefined, "* @boss"), undefined);
  assert.equal(teamContext({ identity: { profile: "solo" } }, "* @boss"), undefined);
  const identity = { profile: "team", app: { id: 1, installationId: 2, botLogin: "lanes[bot]" } };
  assert.deepEqual(teamContext({ identity }, "* @boss @dev\n# c\n"), { owners: ["boss", "dev"], identity });
  assert.deepEqual(teamContext({ identity }, undefined), { owners: [], identity });
});

// #613 (ADR 0025): a config that is not team shows the one line in place of data; the command does not crash.
test("status.mjs prints the team-required line instead of data for a missing config, a missing identity, solo or an unknown profile", () => {
  const dir = mkdtempSync(join(tmpdir(), "status-refuse-"));
  const script = resolve("scripts/lanes/status.mjs");
  try {
    for (const config of [null, "{}", JSON.stringify({ identity: {} }), JSON.stringify({ identity: { profile: "solo" } }), JSON.stringify({ identity: { profile: "other" } })]) {
      rmSync(join(dir, "lanes.config.json"), { force: true });
      if (config !== null) writeFileSync(join(dir, "lanes.config.json"), config);
      for (const flags of [[], ["--json"], ["--waiting"]]) {
        const stdout = execFileSync(process.execPath, [script, ...flags], { encoding: "utf8", cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
        assert.ok(stdout.startsWith(TEAM_REQUIRED_MESSAGE), stdout);
        assert.equal(stdout.trim().split("\n").length, 1, "one line, no data");
      }
    }
    writeFileSync(join(dir, "lanes.config.json"), JSON.stringify({ identity: { profile: "solo" } }));
    assert.match(execFileSync(process.execPath, [script], { encoding: "utf8", cwd: dir }), /profile "solo"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
