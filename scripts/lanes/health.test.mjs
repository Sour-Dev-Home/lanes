import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { HEARTBEAT_MARKER, evaluate, failingTests, findOrCreateHealthIssue, oneLine, ghClient, healthThresholds, readHeartbeat, readStored, reconcile, renderBody, run } from "./health.mjs";

const NOW = Date.parse("2026-10-02T12:00:00Z");
const MIN = 60_000;
const identity = { profile: "team", app: { botLogin: "lanes-app[bot]" } };
const BOT = { login: "lanes-app[bot]" };
const ACTIONS = { login: "github-actions[bot]" };
const timeline = (...events) => ({ nodes: events.map(([t, at]) => ({ __typename: t, createdAt: at })) });
const replyOf = (prs, queue = []) => ({ data: { repository: { mergeQueue: { entries: { nodes: queue.map((n, i) => ({ position: i + 1, pullRequest: { number: n } })) } }, pullRequests: { nodes: prs } } } });
const base = (extra = {}) => ({ config: {}, identity, reply: replyOf([]), mergeGroupRuns: [], prs: [], readyCount: 0, inFlightCount: 0, checkRuns: [], comments: [], ...extra });
const keys = (inputs, now = NOW) => evaluate(inputs, now).map((p) => p.key);
const heartbeat = (at, findings = [], author = BOT) => ({ body: `${HEARTBEAT_MARKER}\n\`\`\`json\n${JSON.stringify({ at: new Date(at).toISOString(), findings })}\n\`\`\``, author, updatedAt: new Date(at).toISOString() });

test("a healthy repository has no problems", () => assert.deepEqual(evaluate(base(), NOW), []));

test("queue-removed: a PR removed and not re-queued", () => {
  const reply = replyOf([{ number: 7, timelineItems: timeline(["AddedToMergeQueueEvent", "2026-10-02T10:00:00Z"], ["RemovedFromMergeQueueEvent", "2026-10-02T11:00:00Z"]) }]);
  assert.deepEqual(keys(base({ reply })), ["queue-removed:PR 7"]);
  assert.deepEqual(keys(base({ reply: replyOf(reply.data.repository.pullRequests.nodes, [7]) })), []);
});

test("approved-stuck: a green gate older than the threshold, and the threshold comes from the config", () => {
  const pr = (ageMin) => ({ number: 3, gateState: "SUCCESS", gateSince: NOW - ageMin * MIN });
  assert.deepEqual(keys(base({ prs: [pr(31)] })), ["approved-stuck:PR 3"]);
  assert.deepEqual(keys(base({ prs: [pr(29)] })), []);
  assert.deepEqual(keys(base({ prs: [pr(29)], config: { health: { approvedStuckMinutes: 10 } } })), ["approved-stuck:PR 3"]);
  assert.deepEqual(keys(base({ prs: [{ number: 3, gateState: "PENDING", gateSince: NOW - 99 * MIN }] })), []);
});

test("gate-failure: a failing gate, or a merge-group failure on an open PR that is not in the queue", () => {
  const runs = [{ headBranch: "gh-readonly-queue/main/pr-9-abc", workflowName: "verify", createdAt: "2026-10-02T11:00:00Z" }, { headBranch: "gh-readonly-queue/main/pr-8-abc", workflowName: "verify", createdAt: "2026-10-02T11:00:00Z" }];
  const prs = [{ number: 4, gateState: "FAILURE", gateSince: NOW - 11 * MIN }, { number: 9, gateState: "PENDING" }];
  assert.deepEqual(keys(base({ prs, mergeGroupRuns: runs })), ["gate-failure:PR 4", "gate-failure:PR 9"]);
  assert.deepEqual(keys(base({ prs: [{ number: 9, gateState: "PENDING" }], reply: replyOf([], [9]), mergeGroupRuns: runs })), []);
});

test("gate-failure (#732): a lane PR's failing gate alerts only after gateFailureMinutes, with the who-acts fix; a merge-group failure alerts at once", () => {
  const pr = (ageMin) => ({ number: 4, gateState: "FAILURE", gateDescription: "PR template sections missing: reviewer results", gateSince: NOW - ageMin * MIN });
  assert.deepEqual(keys(base({ prs: [pr(9)] })), []);
  assert.deepEqual(keys(base({ prs: [pr(10)] })), ["gate-failure:PR 4"]);
  assert.deepEqual(keys(base({ prs: [pr(3)], config: { health: { gateFailureMinutes: 2 } } })), ["gate-failure:PR 4"]);
  assert.deepEqual(keys(base({ prs: [pr(30)], config: { health: { gateFailureMinutes: 60 } } })), []);
  const [p] = evaluate(base({ prs: [pr(11)] }), NOW);
  assert.match(p.cause, /lanes\/gate says: PR template sections missing/);
  assert.equal(p.fix, "the lane fixes this; if its session has stopped, the issue shows needs-owner with what to do");
  const runs = [{ headBranch: "gh-readonly-queue/main/pr-9-abc", workflowName: "verify", createdAt: "2026-10-02T11:59:00Z" }];
  const [m] = evaluate(base({ prs: [{ number: 9, gateState: "PENDING", gateSince: NOW - MIN }], mergeGroupRuns: runs }), NOW);
  assert.equal(m.key, "gate-failure:PR 9");
  assert.equal(m.fix, "open the run, fix what it names, and push");
});

test("edge: a failing gate with no known start time still alerts", () => {
  assert.deepEqual(keys(base({ prs: [{ number: 4, gateState: "FAILURE" }] })), ["gate-failure:PR 4"]);
});

test("no-progress: ready issues, nothing in flight, heartbeat absent or old", () => {
  const ready = { readyCount: 2, inFlightCount: 0 };
  assert.deepEqual(keys(base(ready)), ["no-progress"]);
  assert.deepEqual(keys(base({ ...ready, comments: [heartbeat(NOW - 5 * MIN)] })), []);
  assert.deepEqual(keys(base({ ...ready, comments: [heartbeat(NOW - 31 * MIN)] })), ["no-progress"]);
  assert.deepEqual(keys(base({ ...ready, config: { health: { noProgressMinutes: 60 } }, comments: [heartbeat(NOW - 31 * MIN)] })), []);
  assert.deepEqual(keys(base({ readyCount: 2, inFlightCount: 1 })), []);
  assert.deepEqual(keys(base({ readyCount: 0, inFlightCount: 0 })), []);
});

test("flake: failed then passed on one SHA, cleared after 7 days", () => {
  const sha = "abcdef0123456789";
  const runs = (passAt) => [{ name: "verify", sha, conclusion: "failure", at: "2026-09-20T10:00:00Z" }, { name: "verify", sha, conclusion: "success", at: passAt }];
  assert.deepEqual(keys(base({ checkRuns: runs("2026-10-02T10:00:00Z") })), ["flake:verify@abcdef0"]);
  assert.deepEqual(keys(base({ checkRuns: runs("2026-09-24T10:00:00Z") })), []);
  assert.deepEqual(keys(base({ checkRuns: [{ name: "verify", sha, conclusion: "success", at: "2026-10-02T10:00:00Z" }] })), []);
  assert.deepEqual(keys(base({ checkRuns: [{ name: "verify", sha, conclusion: "success", at: "2026-10-02T09:00:00Z" }, { name: "verify", sha, conclusion: "failure", at: "2026-10-02T10:00:00Z" }] })), []);
  assert.deepEqual(keys(base({ checkRuns: [{ name: "verify", sha: "1111111", conclusion: "failure", at: "2026-10-02T09:00:00Z" }, { name: "verify", sha: "2222222", conclusion: "success", at: "2026-10-02T10:00:00Z" }] })), []);
  assert.deepEqual(keys(base({ checkRuns: runs("2026-10-02T10:00:00Z").map((r) => ({ ...r, name: "a`b@x" })) })), ["flake:a_b_x@abcdef0"]);
});

test("the queue's findings come from a trusted heartbeat only", () => {
  const findings = ["idle-lane:issue 5", "queue-stopped"];
  assert.deepEqual(keys(base({ comments: [heartbeat(NOW, findings)] })), ["idle-lane:issue 5", "queue-stopped"]);
  assert.deepEqual(keys(base({ comments: [heartbeat(NOW, findings, { login: "someone" })] })), []);
  assert.deepEqual(keys(base({ comments: [heartbeat(NOW, ["bad key with `ticks`", "x".repeat(200), 5, "ok-kind"])] })), ["ok-kind"]);
});

test("readHeartbeat: lane bot only, marker first, newest wins, solo profile trusts nobody", () => {
  const stray = { body: `intro ${HEARTBEAT_MARKER}`, author: BOT, updatedAt: new Date(NOW).toISOString() };
  assert.equal(readHeartbeat([stray], identity), null);
  assert.equal(readHeartbeat([heartbeat(NOW, [], { login: "lanes-app[bot]x" })], identity), null);
  assert.equal(readHeartbeat([heartbeat(NOW)], { profile: "solo", app: { botLogin: "lanes-app[bot]" } }), null);
  assert.equal(readHeartbeat([heartbeat(NOW)], undefined), null);
  assert.equal(readHeartbeat(undefined, identity), null);
  assert.equal(readHeartbeat([heartbeat(NOW - 9 * MIN), heartbeat(NOW - 2 * MIN)], identity).at, NOW - 2 * MIN);
  const broken = { body: `${HEARTBEAT_MARKER}\n{not json}`, author: BOT, updatedAt: new Date(NOW - MIN).toISOString() };
  assert.deepEqual(readHeartbeat([broken], identity), { at: NOW - MIN, findings: [], paused: false });
});

test("flake: a lanes-flaky annotation on a verify check run is a flake keyed by file and sha, cleared after 7 days (#637)", () => {
  const sha = "abcdef0123456789";
  const note = (extra = {}) => ({ file: "scripts/lanes/reap.test.mjs", sha, at: "2026-10-02T10:00:00Z", ...extra });
  assert.deepEqual(keys(base({ flakyAnnotations: [note()] })), ["flake:scripts/lanes/reap.test.mjs@abcdef0"]);
  assert.deepEqual(keys(base({ flakyAnnotations: [note(), note({ at: "2026-10-02T11:00:00Z" })] })), ["flake:scripts/lanes/reap.test.mjs@abcdef0"]);
  assert.deepEqual(keys(base({ flakyAnnotations: [note({ at: "2026-09-24T10:00:00Z" })] })), []);
  assert.deepEqual(keys(base({ flakyAnnotations: [note({ file: "a.test.mjs" }), note({ sha: "1234567890" })] })), ["flake:a.test.mjs@abcdef0", "flake:scripts/lanes/reap.test.mjs@1234567"]);
});

test("edge: a malformed or hostile lanes-flaky annotation is dropped or made safe", () => {
  const sha = "abcdef0123456789";
  const at = "2026-10-02T10:00:00Z";
  assert.deepEqual(keys(base({ flakyAnnotations: [{ file: 5, sha, at }, { file: "a.test.mjs", sha: 7, at }, { file: "a.test.mjs", sha, at: "nonsense" }, null, { file: "", sha, at }] })), []);
  assert.deepEqual(keys(base({ flakyAnnotations: [{ file: "a`b@x\n#1.test.mjs", sha, at }] })), ["flake:a_b_x__1.test.mjs@abcdef0"]);
  assert.deepEqual(keys(base({ flakyAnnotations: "nope" })), []);
});

test("edge: thresholds are inclusive at exactly 30 minutes and the flake window ends at 7 days", () => {
  assert.deepEqual(keys(base({ prs: [{ number: 3, gateState: "SUCCESS", gateSince: NOW - 30 * MIN }] })), ["approved-stuck:PR 3"]);
  assert.deepEqual(keys(base({ readyCount: 1, comments: [heartbeat(NOW - 30 * MIN)] })), ["no-progress"]);
  const flake = (at) => [{ name: "v", sha: "abcdef0", conclusion: "failure", at: "2026-09-01T00:00:00Z" }, { name: "v", sha: "abcdef0", conclusion: "success", at }];
  assert.deepEqual(keys(base({ checkRuns: flake(new Date(NOW - 7 * 86_400_000 + 1000).toISOString()) })), ["flake:v@abcdef0"]);
  assert.deepEqual(keys(base({ checkRuns: flake(new Date(NOW - 7 * 86_400_000).toISOString()) })), []);
});

test("edge: a finding with a mention or cross-link is dropped", () => {
  assert.deepEqual(keys(base({ comments: [heartbeat(NOW, ["idle-lane:@someone", "idle-lane:#5", "idle-lane:issue 5"])] })), ["idle-lane:issue 5"]);
});

test("the client maps GraphQL actors so the real github-actions writer is trusted", async () => {
  const body = renderBody([{ key: "no-progress", at: 1 }], [], null);
  const reply = (author, editor) => ({ data: { repository: { issues: { nodes: [{ number: 5, state: "OPEN", body, author, editor }] } } } });
  const actions = { login: "github-actions", __typename: "Bot" };
  const [fromAuthor] = await ghClient(() => reply(actions, null)).listIssues("lanes-health");
  assert.deepEqual(readStored(fromAuthor), [{ key: "no-progress", at: 1 }]);
  const [edited] = await ghClient(() => reply(actions, { login: "someone", __typename: "User" })).listIssues("lanes-health");
  assert.deepEqual(readStored(edited), []);
  const [lookalike] = await ghClient(() => reply({ login: "github-actions", __typename: "User" }, null)).listIssues("lanes-health");
  assert.deepEqual(readStored(lookalike), []);
  const [ghost] = await ghClient(() => reply(null, null)).listIssues("lanes-health");
  assert.deepEqual(readStored(ghost), []);
});

test("run: with a closed low number and an open higher one, the open one is used", async () => {
  const f = fake({ issues: [{ number: 12, state: "CLOSED", body: "", lastWriter: null }, { number: 20, state: "OPEN", body: "", lastWriter: null }] });
  assert.equal((await run({ client: f.client, inputs: withProblem(), now: NOW })).number, 20);
});

test("healthThresholds: defaults and invalid values", () => {
  assert.deepEqual(healthThresholds({}), { approvedStuckMinutes: 30, noProgressMinutes: 30, gateFailureMinutes: 10 });
  assert.deepEqual(healthThresholds({ health: { approvedStuckMinutes: -1, noProgressMinutes: "5", gateFailureMinutes: 0 } }), { approvedStuckMinutes: 30, noProgressMinutes: 30, gateFailureMinutes: 10 });
  assert.equal(healthThresholds({ health: { gateFailureMinutes: "x" } }).gateFailureMinutes, 10);
  assert.deepEqual(healthThresholds({ health: { approvedStuckMinutes: 5, noProgressMinutes: 7, gateFailureMinutes: 3 } }), { approvedStuckMinutes: 5, noProgressMinutes: 7, gateFailureMinutes: 3 });
});

test("lanes.config.json registers the module and sets both thresholds", () => {
  const config = JSON.parse(readFileSync(new URL("../../lanes.config.json", import.meta.url), "utf8"));
  assert.ok(config.modules.entries.some((m) => m.paths.includes("scripts/lanes/health.")));
  assert.deepEqual(healthThresholds(config), { approvedStuckMinutes: 30, noProgressMinutes: 30, gateFailureMinutes: 10 });
  assert.equal(config.health.gateFailureMinutes, 10);
});

test("readStored trusts the block only when github-actions wrote the body", () => {
  const body = renderBody([{ key: "no-progress", at: 5 }], [], null);
  assert.deepEqual(readStored({ body, lastWriter: ACTIONS }), [{ key: "no-progress", at: 5 }]);
  assert.deepEqual(readStored({ body, lastWriter: { login: "github-actions", type: "Bot" } }), [{ key: "no-progress", at: 5 }]);
  assert.deepEqual(readStored({ body, lastWriter: { login: "github-actions" } }), []);
  assert.deepEqual(readStored({ body, lastWriter: { login: "owner" } }), []);
  assert.deepEqual(readStored({ body, lastWriter: BOT }), []);
  assert.deepEqual(readStored({ body: "<!-- lanes:health {nope} -->", lastWriter: ACTIONS }), []);
  assert.deepEqual(readStored({ body: '<!-- lanes:health {"open":"x"} -->', lastWriter: ACTIONS }), []);
  assert.deepEqual(readStored({ body: '<!-- lanes:health {"open":[{"key":"bad key!","at":1},{"key":"ok","at":"x"},{"key":"fine","at":2}]} -->', lastWriter: ACTIONS }), [{ key: "fine", at: 2 }]);
  assert.deepEqual(readStored({ body: "no block", lastWriter: ACTIONS }), []);
  assert.deepEqual(readStored(null), []);
});

test("reconcile keys: new once, kept silent with first-seen time, gone removed, recovery when empty", () => {
  const p = (key) => ({ key, kind: "k", text: key });
  let r = reconcile([], [p("a")], 10);
  assert.deepEqual([r.open, r.added.map((x) => x.key), r.recovered], [[{ key: "a", at: 10 }], ["a"], false]);
  r = reconcile(r.open, [p("a"), p("b")], 20);
  assert.deepEqual([r.open, r.added.map((x) => x.key)], [[{ key: "a", at: 10 }, { key: "b", at: 20 }], ["b"]]);
  r = reconcile(r.open, [p("b")], 30);
  assert.deepEqual([r.open, r.added, r.recovered], [[{ key: "b", at: 20 }], [], false]);
  r = reconcile(r.open, [], 40);
  assert.deepEqual([r.open, r.recovered], [[], true]);
  assert.equal(reconcile([], [], 50).recovered, false);
  r = reconcile([], [p("b")], 60);
  assert.deepEqual(r.added.map((x) => x.key), ["b"]);
});

// A fake client that records every call and applies writes to its in-memory issues.
function fake({ issues = [], comments = [] } = {}) {
  const calls = [];
  let created = 0;
  const store = new Map(issues.map((i) => [i.number, { ...i }]));
  const client = {
    async listIssues(label) { calls.push(["listIssues", label]); return [...store.values()].map((i) => ({ ...i })); },
    async createLabel(label) { calls.push(["createLabel", label]); },
    async createIssue(x) { calls.push(["createIssue", x]); created = 900; store.set(900, { number: 900, state: "OPEN", body: x.body, lastWriter: ACTIONS }); return 900; },
    async listComments(n) { calls.push(["listComments", n]); return comments; },
    async editBody(n, body) { calls.push(["editBody", n, body]); Object.assign(store.get(n), { body, lastWriter: ACTIONS }); },
    async reopen(n) { calls.push(["reopen", n]); store.get(n).state = "OPEN"; },
    async comment(n, body) { calls.push(["comment", n, body]); },
  };
  return { client, calls, store, created: () => created };
}
const withProblem = (extra = {}) => base({ readyCount: 1, inFlightCount: 0, ...extra });
const names = (calls) => calls.map((c) => c[0]);

test("run creates the label and the issue when none exists, then every write targets that number", async () => {
  const f = fake();
  const out = await run({ client: f.client, inputs: withProblem(), now: NOW });
  assert.equal(out.number, 900);
  assert.deepEqual(names(f.calls).slice(0, 3), ["listIssues", "createLabel", "createIssue"]);
  assert.deepEqual(f.calls[1], ["createLabel", "lanes-health"]);
  for (const c of f.calls.filter((c) => ["listComments", "editBody", "reopen", "comment"].includes(c[0]))) assert.equal(c[1], 900);
  assert.equal(f.calls.filter((c) => c[0] === "comment").length, 1);
});

test("findOrCreateHealthIssue: an open issue is preferred over a lower closed one", async () => {
  const f = fake({ issues: [{ number: 3, state: "CLOSED", body: "old", lastWriter: ACTIONS }, { number: 7, state: "OPEN", body: "new", lastWriter: ACTIONS }, { number: 9, state: "OPEN", body: "x", lastWriter: ACTIONS }] });
  assert.deepEqual(await findOrCreateHealthIssue(f.client), { number: 7, state: "OPEN", body: "new", lastWriter: ACTIONS });
  assert.deepEqual(names(f.calls), ["listIssues"]);
});

test("findOrCreateHealthIssue: only closed issues means the lowest one is used and none is created", async () => {
  const f = fake({ issues: [{ number: 8, state: "CLOSED", body: "b", lastWriter: ACTIONS }, { number: 4, state: "CLOSED", body: "a", lastWriter: ACTIONS }] });
  assert.equal((await findOrCreateHealthIssue(f.client)).number, 4);
  assert.deepEqual(names(f.calls), ["listIssues"]);
});

test("findOrCreateHealthIssue: none creates the label and the issue once, and returns it", async () => {
  const f = fake();
  const issue = await findOrCreateHealthIssue(f.client);
  assert.deepEqual(issue, { number: 900, state: "OPEN", body: "", lastWriter: null });
  assert.deepEqual(names(f.calls), ["listIssues", "createLabel", "createIssue"]);
  assert.deepEqual(f.calls[1], ["createLabel", "lanes-health"]);
  assert.deepEqual(f.calls[2][1].labels, ["lanes-health"]);
});

test("edge: findOrCreateHealthIssue ignores entries without an integer number", async () => {
  const f = fake({ issues: [{ number: 5, state: "OPEN", body: "ok", lastWriter: null }] });
  const client = { ...f.client, listIssues: async () => [null, { state: "OPEN" }, { number: "2", state: "OPEN" }, { number: 5, state: "OPEN", body: "ok", lastWriter: null }] };
  assert.equal((await findOrCreateHealthIssue(client)).number, 5);
});

test("run: the same problem on the next run adds no comment; recovery adds one; a recurrence is new", async () => {
  const f = fake();
  await run({ client: f.client, inputs: withProblem(), now: NOW });
  const after = (fn) => f.calls.length;
  let mark = after();
  await run({ client: f.client, inputs: withProblem(), now: NOW + 5 * MIN });
  assert.equal(f.calls.slice(mark).filter((c) => c[0] === "comment").length, 0);
  mark = after();
  await run({ client: f.client, inputs: base(), now: NOW + 10 * MIN });
  const recovery = f.calls.slice(mark).filter((c) => c[0] === "comment");
  assert.equal(recovery.length, 1);
  assert.match(recovery[0][2], /Recovered/);
  assert.match(f.store.get(900).body, /\*\*Status:\*\* healthy/);
  mark = after();
  await run({ client: f.client, inputs: base(), now: NOW + 15 * MIN });
  assert.equal(f.calls.slice(mark).filter((c) => c[0] === "comment").length, 0);
  mark = after();
  await run({ client: f.client, inputs: withProblem(), now: NOW + 20 * MIN });
  assert.equal(f.calls.slice(mark).filter((c) => c[0] === "comment").length, 1);
});

test("run: a closed issue is reopened only with an active problem and no second issue is made", async () => {
  const closed = { number: 41, state: "CLOSED", body: renderBody([], [], null), lastWriter: ACTIONS };
  let f = fake({ issues: [closed] });
  await run({ client: f.client, inputs: base(), now: NOW });
  assert.deepEqual(names(f.calls).filter((n) => ["reopen", "createIssue", "comment"].includes(n)), []);
  f = fake({ issues: [closed] });
  await run({ client: f.client, inputs: withProblem(), now: NOW });
  assert.deepEqual(names(f.calls).filter((n) => ["reopen", "createIssue"].includes(n)), ["reopen"]);
  assert.equal(f.store.get(41).state, "OPEN");
});

test("run: a closed issue whose problems cleared gets a body update but no recovery comment", async () => {
  const closed = { number: 41, state: "CLOSED", body: renderBody([{ key: "no-progress", at: 1 }], [], null), lastWriter: ACTIONS };
  const f = fake({ issues: [closed] });
  await run({ client: f.client, inputs: base(), now: NOW });
  assert.deepEqual(names(f.calls).filter((n) => ["reopen", "comment"].includes(n)), []);
  assert.match(f.store.get(41).body, /healthy/);
});

test("run: a hand-edited body is rewritten and the active problems are commented again", async () => {
  const stored = renderBody([{ key: "no-progress", at: 1 }], [], null);
  for (const writer of [{ login: "the-owner" }, null]) {
    const f = fake({ issues: [{ number: 5, state: "OPEN", body: stored, lastWriter: writer }] });
    await run({ client: f.client, inputs: withProblem(), now: NOW });
    assert.equal(f.calls.filter((c) => c[0] === "comment").length, 1);
    assert.deepEqual(readStored(f.store.get(5)), [{ key: "no-progress", at: NOW }]);
  }
});

test("run: a body kept by github-actions is trusted, so an ongoing problem is not commented again", async () => {
  const stored = renderBody([{ key: "no-progress", at: 1 }], [], null);
  const f = fake({ issues: [{ number: 5, state: "OPEN", body: stored, lastWriter: ACTIONS }] });
  await run({ client: f.client, inputs: withProblem(), now: NOW });
  assert.equal(f.calls.filter((c) => c[0] === "comment").length, 0);
  assert.deepEqual(readStored(f.store.get(5)), [{ key: "no-progress", at: 1 }]);
});

test("run: several health issues use the lowest open number and touch no other", async () => {
  const mk = (number, state) => ({ number, state, body: "", lastWriter: null });
  const f = fake({ issues: [mk(30, "OPEN"), mk(12, "CLOSED"), mk(20, "OPEN")] });
  const out = await run({ client: f.client, inputs: withProblem(), now: NOW });
  assert.equal(out.number, 20);
  for (const c of f.calls.filter((c) => c[0] !== "listIssues")) assert.equal(c[1], 20);
  assert.equal(f.calls.some((c) => c[0] === "createIssue"), false);
});

test("run: an unchanged body is not edited again", async () => {
  const f = fake({ issues: [{ number: 5, state: "OPEN", body: renderBody([], [], null), lastWriter: ACTIONS }] });
  await run({ client: f.client, inputs: base(), now: NOW });
  assert.deepEqual(names(f.calls), ["listIssues", "listComments"]);
});

test("run: the heartbeat time is in the body", async () => {
  const f = fake({ issues: [{ number: 5, state: "OPEN", body: "", lastWriter: null }], comments: [heartbeat(Date.parse("2026-10-02T11:55:00Z"))] });
  await run({ client: f.client, inputs: base(), now: NOW });
  assert.match(f.store.get(5).body, /Last queue heartbeat: 2026-10-02 11:55 UTC/);
});

test("ghClient only issues the health operations, each on the given number", async () => {
  const seen = [];
  const gh = (args) => { seen.push(args); return args.includes("--slurp") ? [[{ body: "b", user: { login: "u" }, updated_at: "t" }]] : { number: 77, data: { repository: { issues: { nodes: [] } } } }; };
  const c = ghClient(gh);
  await c.listIssues("lanes-health");
  await c.createLabel("lanes-health");
  assert.equal(await c.createIssue({ title: "t", body: "b", labels: ["lanes-health"] }), 77);
  assert.deepEqual(await c.listComments(5), [{ body: "b", author: { login: "u" }, updatedAt: "t" }]);
  await c.editBody(5, "x");
  await c.reopen(5);
  await c.comment(5, "y");
  const writes = seen.filter((a) => a.includes("-X") || a.some((s) => /^(body|title)=/.test(s)));
  for (const a of writes) assert.ok(a.some((s) => /issues\/5(\/comments)?$/.test(s)) || a.some((s) => /\/(labels|issues)$/.test(s)), a.join(" "));
  assert.ok(seen.every((a) => a[0] === "api"));
  const label = ghClient(() => { throw Object.assign(new Error("x"), { stderr: "HTTP 422: already_exists" }); });
  await label.createLabel("lanes-health");
  const other = ghClient(() => { throw new Error("boom"); });
  await assert.rejects(other.createLabel("lanes-health"), /boom/);
});

test("thresholds are inclusive at exactly the limit and the flake window ends at exactly 7 days", () => {
  assert.deepEqual(keys(base({ prs: [{ number: 3, gateState: "SUCCESS", gateSince: NOW - 30 * MIN }] })), ["approved-stuck:PR 3"]);
  assert.deepEqual(keys(base({ prs: [{ number: 3, gateState: "SUCCESS", gateSince: NOW - 30 * MIN + 1 }] })), []);
  assert.deepEqual(keys(base({ readyCount: 1, comments: [heartbeat(NOW - 30 * MIN)] })), ["no-progress"]);
  assert.deepEqual(keys(base({ readyCount: 1, comments: [heartbeat(NOW - 30 * MIN + 1)] })), []);
  const sha = "abcdef0123456789";
  const runs = (pass) => [{ name: "v", sha, conclusion: "failure", at: "2026-09-01T00:00:00Z" }, { name: "v", sha, conclusion: "success", at: new Date(pass).toISOString() }];
  assert.deepEqual(keys(base({ checkRuns: runs(NOW - 7 * 86_400_000) })), []);
  assert.deepEqual(keys(base({ checkRuns: runs(NOW - 7 * 86_400_000 + 1000) })), ["flake:v@abcdef0"]);
});

test("an unparseable heartbeat time is absent, and a spoofed writer type is not trusted", () => {
  assert.equal(readHeartbeat([{ body: `${HEARTBEAT_MARKER}\n{"at":"nonsense"}`, author: BOT, updatedAt: "also bad" }], identity), null);
  const body = renderBody([{ key: "no-progress", at: 5 }], [], null);
  assert.deepEqual(readStored({ body, lastWriter: { login: "github-actions", type: "User" } }), []);
  assert.deepEqual(readStored({ body, lastWriter: { login: "github-actions", type: true } }), []);
});

test("gatherInputs shapes the gh replies into evaluate's inputs", async () => {
  const { gatherInputs } = await import("./health.mjs");
  const node = { number: 5, commits: { nodes: [{ commit: { status: { context: { createdAt: "2026-10-02T10:00:00Z" }, contexts: [{ context: "lanes/gate", state: "SUCCESS" }] } } }] } };
  const reply = { data: { repository: { pullRequests: { nodes: [node, { number: 6 }] } } } };
  const gh = (args) => {
    if (args[0] === "api") return reply;
    if (args[0] === "pr") return [{ number: 5, url: "https://github.com/o/r/pull/5", headRefOid: "new", latestReviews: [{ state: "APPROVED", commit: { oid: "old" } }] }];
    if (args[0] === "repo") return { url: "https://github.com/o/r" };
    if (args[0] === "issue") return [{ number: 1, labels: [{ name: "ready" }] }, { number: 2, labels: [{ name: "ready" }, { name: "lane:running" }] }, { number: 3, labels: [{ name: "lane:running" }] }];
    return args.includes("merge_group") ? [] : [{ name: "verify", headSha: "ab", conclusion: "success", updatedAt: "t" }];
  };
  const r = gatherInputs(gh, { identity });
  assert.deepEqual(r.prs, [{ number: 5, gateState: "SUCCESS", gateSince: Date.parse("2026-10-02T10:00:00Z"), gateDescription: undefined, url: "https://github.com/o/r/pull/5", approved: true, approvalStale: true }, { number: 6, gateState: null, gateSince: undefined, gateDescription: undefined }]);
  assert.equal(r.repoUrl, "https://github.com/o/r");
  assert.equal(r.readyCount, 1);
  assert.equal(r.inFlightCount, 4);
  assert.deepEqual(r.checkRuns, [{ name: "verify", sha: "ab", conclusion: "success", at: "t" }]);
  assert.deepEqual(r.flakyAnnotations, []);
  assert.equal(r.identity, identity);
  assert.equal(typeof r.readLog, "function");
});

test("gatherInputs reads lanes-flaky annotations from the jobs of successful verify runs (#637)", async () => {
  const { gatherInputs } = await import("./health.mjs");
  const calls = [];
  const gh = (args) => {
    calls.push(args.join(" "));
    if (args[0] === "api" && args.includes("graphql")) return { data: { repository: { pullRequests: { nodes: [] } } } };
    if (args[0] === "api" && /actions\/runs\/11\/jobs/.test(args[1])) return { jobs: [{ id: 901 }, { id: 902 }] };
    if (args[0] === "api" && /check-runs\/901\/annotations/.test(args[1])) return [{ title: "lanes-flaky", annotation_level: "warning", message: "scripts/lanes/reap.test.mjs :: reaps one" }, { title: "other", message: "x :: y" }];
    if (args[0] === "api" && /check-runs\/902\/annotations/.test(args[1])) return [];
    if (args[0] === "api") return [];
    if (args[0] === "pr" || args[0] === "issue") return [];
    if (args[0] === "repo") return { url: "https://github.com/o/r" };
    if (args.includes("merge_group")) return [];
    return [
      { databaseId: 11, name: "verify", headSha: "abcdef0123", conclusion: "success", updatedAt: "2026-10-02T10:00:00Z" },
      { databaseId: 12, name: "verify", headSha: "bbbbbbb", conclusion: "failure", updatedAt: "2026-10-02T10:00:00Z" },
      { databaseId: 13, name: "dashboard", headSha: "ccccccc", conclusion: "success", updatedAt: "2026-10-02T10:00:00Z" },
    ];
  };
  const r = gatherInputs(gh, { identity });
  assert.deepEqual(r.flakyAnnotations, [{ file: "scripts/lanes/reap.test.mjs", sha: "abcdef0123", at: "2026-10-02T10:00:00Z" }]);
  assert.equal(calls.filter((c) => /actions\/runs\//.test(c)).length, 1, "only the successful verify run is read");
});

test("edge: a failing annotations read or an odd reply leaves flakyAnnotations empty, never throws (#637)", async () => {
  const { gatherInputs } = await import("./health.mjs");
  const gh = (args) => {
    if (args[0] === "api" && args.includes("graphql")) return { data: { repository: { pullRequests: { nodes: [] } } } };
    if (args[0] === "api") throw new Error("boom");
    if (args[0] === "pr" || args[0] === "issue") return [];
    if (args[0] === "repo") return { url: "https://github.com/o/r" };
    if (args.includes("merge_group")) return [];
    return [{ databaseId: 11, name: "verify", headSha: "abcdef0", conclusion: "success", updatedAt: "t" }];
  };
  assert.deepEqual(gatherInputs(gh, { identity }).flakyAnnotations, []);
});

// The comment for a new problem: cause, fix and a runbook link (#641).
const REPO = "https://github.com/o/r";
const docs = (anchor) => `Runbook: ${REPO}/blob/main/docs/OPERATIONS.md#${anchor}`;
// The new-problem comment whose key matches `kind` (a PR in the merge queue's trouble can raise several problems at once).
const commentFor = async (inputs, readLog, kind = /^New problem/) => {
  const f = fake({ comments: inputs.comments });
  await run({ client: f.client, inputs: { ...inputs, repoUrl: REPO, readLog }, now: NOW });
  return f.calls.filter((c) => c[0] === "comment" && kind.test(c[2])).map((c) => c[2]);
};
const REMOVED = /^New problem: PR \d+ was removed/;
const removedReply = replyOf([{ number: 7, timelineItems: timeline(["AddedToMergeQueueEvent", "2026-10-02T10:00:00Z"], ["RemovedFromMergeQueueEvent", "2026-10-02T11:00:00Z"]) }]);
const mgRun = { headBranch: "gh-readonly-queue/main/pr-7-abc", workflowName: "verify", url: `${REPO}/actions/runs/555`, createdAt: "2026-10-02T11:00:00Z" };
const CTRL = String.fromCharCode(0, 7, 27, 127);

test("failingTests: spec and TAP lines, deduplicated, at most 10, each one line of at most 120 characters", () => {
  const log = ["job\tstep\t2026-10-02T11:00:00Z ✖ failing tests:", "x ✖ first test (3.2ms)", "x not ok 4 - second test", "x ✖ first test (1ms)", `x ✖ ${"a".repeat(300)} (1ms)`].join("\n");
  const names = failingTests(log);
  assert.deepEqual(names.slice(0, 2), ["first test", "second test"]);
  assert.equal(names.length, 3);
  assert.equal(names[2].length, 120);
  const many = Array.from({ length: 25 }, (_, i) => `not ok ${i} - t${i}`).join("\n");
  assert.equal(failingTests(many).length, 10);
  assert.deepEqual(failingTests(""), []);
  assert.deepEqual(failingTests(undefined), []);
});

test("oneLine: control characters and line breaks become one line, mentions and cross-links are neutralised", () => {
  assert.equal(oneLine(`a${CTRL}b\nc\r\n  d`), "a b c d");
  assert.equal(oneLine("ping @someone see #12"), "ping _someone see _12");
  assert.equal(oneLine("x".repeat(500)).length, 120);
  assert.equal(oneLine(undefined), "");
});

test("queue-removed comment: check name, failing tests, run link, fix and runbook link", async () => {
  const [c] = await commentFor(withProblem({ reply: removedReply, mergeGroupRuns: [mgRun], prs: [{ number: 7, url: `${REPO}/pull/7` }] }), async () => "x ✖ broken thing (2ms)\nx not ok 2 - other thing", REMOVED);
  assert.match(c, /Cause: the merge-group check verify failed/);
  assert.match(c, /- broken thing\n- other thing/);
  assert.match(c, new RegExp(`Run: ${REPO}/actions/runs/555`));
  assert.match(c, new RegExp(`PR: ${REPO}/pull/7`));
  assert.match(c, /Fix: fix the cause, then click Enable auto-merge on the PR/);
  assert.ok(c.endsWith(docs("merge-queue-removed")));
});

test("a failed log read still posts the alert, saying the test names could not be read", async () => {
  const [c] = await commentFor(withProblem({ reply: removedReply, mergeGroupRuns: [mgRun] }), async () => { throw new Error("boom"); }, REMOVED);
  assert.match(c, /could not be read from the log/);
  assert.match(c, /Cause: the merge-group check verify failed/);
  const [d] = await commentFor(withProblem({ reply: removedReply, mergeGroupRuns: [mgRun] }), undefined, REMOVED);
  assert.match(d, /No failing test names were found/);
});

test("edge: queue-removed with no merge-group run says so and reads no log", async () => {
  let read = 0;
  const [c] = await commentFor(withProblem({ reply: removedReply }), async () => { read++; return ""; }, REMOVED);
  assert.equal(read, 0);
  assert.match(c, /no failed merge-group check was found/);
});

test("approved-stuck comment gives the reason: stale approval, not queued, in the queue", async () => {
  const stuck = (extra) => withProblem({ prs: [{ number: 3, gateState: "SUCCESS", gateSince: NOW - 40 * MIN, ...extra }] });
  const [a] = await commentFor(stuck({ approvalStale: true }));
  assert.match(a, /Fix: a push dismissed your approval: approve again/);
  assert.ok(a.endsWith(docs("approved-not-merged")));
  const [b] = await commentFor(stuck({}));
  assert.match(b, /Cause: the PR is not in the merge queue/);
  assert.match(b, /Fix: click Enable auto-merge on the PR/);
  const [q] = await commentFor({ ...stuck({}), reply: replyOf([], [3]) });
  assert.match(q, /in the merge queue but has not merged/);
});

test("approved-stuck with a pending gate quotes its reason on one line", async () => {
  const pr = (extra) => ({ number: 3, gateState: "PENDING", gateSince: NOW - 40 * MIN, gateDescription: `waiting for review/test-hunter\n@x${CTRL}`, ...extra });
  const [c] = await commentFor(base({ prs: [pr({ approved: true })] }), undefined, /is approved/);
  assert.match(c, /Cause: the gate is pending: waiting for review\/test-hunter _x$/m);
  assert.match(c, /Fix: wait for the gate/);
  assert.deepEqual(keys(base({ prs: [pr({})] })), []);
  assert.deepEqual(keys(base({ prs: [pr({ approved: true, gateSince: NOW - 29 * MIN })] })), []);
});

test("failingTests reads a long hostile log in bounded time, and caps the line length it reads", () => {
  const started = Date.now();
  const hostile = `✖ ${" ".repeat(80_000)}x\nnot ok 1 - ${" ".repeat(80_000)}y\n✖ real failure (1ms)`;
  assert.deepEqual(failingTests(hostile), ["real failure"]);
  assert.ok(Date.now() - started < 1000);
  assert.equal(failingTests(`✖ ${"n".repeat(1000)}`)[0].length, 120);
  const many = `✖ ${" ".repeat(396)}x\nnot ok 2 - ${" ".repeat(380)}y\n`.repeat(100_000);
  const manyStarted = Date.now();
  assert.equal(failingTests(many).length, 2);
  assert.ok(Date.now() - manyStarted < 5000, "200000 padded lines are read in bounded time");
  const late = `${"noise\n".repeat(200_000)}✖ too late (1ms)`;
  assert.deepEqual(failingTests(late), []);
});

test("oneLine drops bidi override and zero-width format characters", () => {
  assert.equal(oneLine(`a${String.fromCharCode(0x202e, 0x200b, 0xfeff)}b`), "ab");
});

test("failingTests: a marker inside a word is not a failure, and a duration after a long name is stripped before the cut", () => {
  assert.deepEqual(failingTests("no✖ glued\nxnot ok 3 - glued"), []);
  assert.deepEqual(failingTests(`✖ ${"n".repeat(110)} (12.5ms)`), ["n".repeat(110)]);
});

test("oneLine breaks markdown links and bare URLs in quoted text", () => {
  assert.equal(oneLine("[x](https://evil.example) www.evil.example"), "_x_(https:/ /evil.example) www_evil.example");
});

test("gate-failure comment carries the gate's description and the run link", async () => {
  const [a] = await commentFor(withProblem({ prs: [{ number: 4, gateState: "FAILURE", gateDescription: `tests failed\n@owner #9${CTRL}`, url: `${REPO}/pull/4` }] }));
  assert.match(a, /Cause: lanes\/gate says: tests failed _owner _9$/m);
  assert.match(a, new RegExp(`Run: ${REPO}/pull/4/checks`));
  assert.ok(a.endsWith(docs("gate-failure")));
  const [b] = await commentFor(withProblem({ prs: [{ number: 9, gateState: "PENDING" }], mergeGroupRuns: [{ ...mgRun, headBranch: "gh-readonly-queue/main/pr-9-abc" }] }), async () => "not ok 1 - flaky one");
  assert.match(b, /Cause: the merge-group check verify failed/);
  assert.match(b, /- flaky one/);
});

test("no-progress comment gives the heartbeat age and starts or resumes the queue", async () => {
  const [a] = await commentFor(withProblem({ comments: [heartbeat(NOW - 95 * MIN)] }));
  assert.match(a, /Cause: the queue's last heartbeat was 1h 35m ago/);
  assert.match(a, /Fix: start the queue/);
  assert.ok(a.endsWith(docs("no-progress")));
  const [n] = await commentFor(withProblem());
  assert.match(n, /never reported/);
  const [p] = await commentFor(withProblem({ queuePaused: true }));
  assert.match(p, /Fix: the queue is paused/);
  assert.ok(p.endsWith(docs("paused")));
});

test("a stalled lane from the heartbeat names the session and the /status recovery", async () => {
  const [c] = await commentFor(base({ comments: [heartbeat(NOW - MIN, ["stalled:abc123"])] }));
  assert.match(c, /Cause: lane session abc123 stopped making progress/);
  assert.match(c, /Fix: run \/status: it gives the recovery for session abc123 \(claude attach abc123\)/);
  assert.ok(c.endsWith(docs("stalled-lane")));
});

test("flake and other findings still get a cause and a fix", async () => {
  const [o] = await commentFor(base({ comments: [heartbeat(NOW - MIN, ["odd-thing"])] }));
  assert.match(o, /Cause: .*\nFix: .*\nRunbook: https:\/\/github.com\/o\/r\/blob\/main\/docs\/OPERATIONS.md$/);
  const [f] = await commentFor(base({ checkRuns: [{ name: "verify", sha: "abc1234", conclusion: "failure", at: "2026-10-02T10:00:00Z" }, { name: "verify", sha: "abc1234", conclusion: "success", at: "2026-10-02T11:00:00Z" }] }));
  assert.ok(f.endsWith(docs("flaky-test")));
});

test("a comment holds no login: hostile quoted text is one line with no mention, and only an https PR link is kept", async () => {
  const hostile = { ...mgRun, workflowName: `ver @ify${CTRL}\n#5` };
  const [c] = await commentFor(withProblem({ reply: removedReply, mergeGroupRuns: [hostile], prs: [{ number: 7, url: `${REPO}/pull/7` }] }), async () => `x ✖ @victim please #1${CTRL} (1ms)`, REMOVED);
  assert.doesNotMatch(c.replace(/https:\/\/\S+/g, ""), /@/);
  assert.doesNotMatch(c, new RegExp(`[${CTRL}]`));
  assert.doesNotMatch(c.replace(/^(New problem|PR|Run|Runbook).*$/gm, ""), /#\d/);
  const [d] = await commentFor(withProblem({ reply: removedReply, prs: [{ number: 7, url: "http://evil.example/x" }] }), undefined, REMOVED);
  assert.doesNotMatch(d, /evil/);
});

test("caps: 120 characters and 10 names are kept whole, one past is cut", () => {
  assert.equal(oneLine("a".repeat(120)), "a".repeat(120));
  assert.equal(oneLine("a".repeat(121)), `${"a".repeat(119)}…`);
  const lines = (n) => Array.from({ length: n }, (_, i) => `not ok ${i} - t${i}`).join("\n");
  assert.equal(failingTests(lines(9)).length, 9);
  assert.equal(failingTests(lines(10)).length, 10);
  assert.equal(failingTests(lines(11)).length, 10);
  assert.deepEqual(failingTests(`not ok 1 - ${"b".repeat(120)}`), ["b".repeat(120)]);
});

// #679: an open issue a lane stopped on (labelled needs-owner) is a problem the owner gets one notification for.
const stopped = (extra = {}) => base({ needsOwner: [{ number: 630, url: "https://github.com/o/r/issues/630", title: "@owner see #1 secret" }], ...extra });

test("needs-owner: an open labelled issue is one problem, keyed by number, with a text that copies no title", () => {
  const [p] = evaluate(stopped(), NOW);
  assert.deepEqual([p.key, p.kind], ["needs-owner:#630", "needs-owner"]);
  assert.equal(p.text, "#630 needs you: a lane stopped or found nothing to build; see its last comment");
  assert.equal(p.url, "https://github.com/o/r/issues/630");
  assert.equal(p.anchor, "needs-owner");
  assert.doesNotMatch(JSON.stringify(p), /secret/);
});

test("edge: a malformed needs-owner entry is skipped and an unsafe url is dropped", () => {
  assert.deepEqual(keys(base({ needsOwner: [null, { number: "x" }, { number: 0 }, { number: 3, url: "javascript:alert(1)" }] })), ["needs-owner:#3"]);
  assert.equal(evaluate(base({ needsOwner: [{ number: 3, url: "javascript:alert(1)" }] }), NOW)[0].url, undefined);
});

test("needs-owner: commented once when it appears, silent on the next run, recovered when the label goes or the issue closes", async () => {
  const f = fake();
  await run({ client: f.client, inputs: { ...stopped(), repoUrl: REPO }, now: NOW });
  const comments = () => f.calls.filter((c) => c[0] === "comment");
  assert.equal(comments().length, 1);
  assert.match(comments()[0][2], /^New problem: #630 needs you: a lane stopped or found nothing to build; see its last comment/);
  assert.match(comments()[0][2], /Issue: https:\/\/github\.com\/o\/r\/issues\/630/);
  assert.match(comments()[0][2], /Runbook: .*docs\/OPERATIONS\.md#needs-owner/);
  await run({ client: f.client, inputs: stopped(), now: NOW + 5 * MIN });
  assert.equal(comments().length, 1);
  await run({ client: f.client, inputs: base(), now: NOW + 10 * MIN });
  assert.equal(comments().length, 2);
  assert.match(comments()[1][2], /Recovered/);
});

test("needs-owner: gatherInputs lists open issues only and keeps those labelled needs-owner", async () => {
  const { gatherInputs } = await import("./health.mjs");
  const seen = [];
  const gh = (args) => {
    if (args[0] === "issue") {
      seen.push(args);
      return [{ number: 4, url: "https://github.com/o/r/issues/4", title: "t", labels: [{ name: "needs-owner" }] }, { number: 5, url: "u", labels: [{ name: "ready" }] }];
    }
    if (args[0] === "repo") return { url: "https://github.com/o/r" };
    if (args[0] === "pr" || args[0] === "run") return [];
    return { data: { repository: { pullRequests: { nodes: [] } } } };
  };
  const r = gatherInputs(gh, { identity });
  assert.deepEqual(r.needsOwner, [{ number: 4, url: "https://github.com/o/r/issues/4" }]);
  assert.ok(seen[0].includes("open") && seen[0].includes("number,labels,url"));
});

// --- #645 (ADR 0028): the pause in the health issue. ---
const PAUSE = { paused: true, since: "2026-10-02T10:30:00.000Z", by: "owner", reason: "maintenance", failClosed: false };
const pausedBeat = (at, paused) => ({ ...heartbeat(at), body: `${HEARTBEAT_MARKER}\n\`\`\`json\n${JSON.stringify({ at: new Date(at).toISOString(), findings: [], ...(paused === undefined ? {} : { paused }) })}\n\`\`\`` });

test("#645: the body shows `Paused since <time> by <who>: <reason>`, and nothing when running", () => {
  assert.match(renderBody([], [], null, PAUSE), /^Paused since 2026-10-02 10:30 UTC by owner: maintenance$/m);
  assert.doesNotMatch(renderBody([], [], null, { ...PAUSE, paused: false }), /Paused/);
  assert.doesNotMatch(renderBody([], [], null), /Paused/);
  assert.match(renderBody([], [], null, { ...PAUSE, reason: "" }), /by owner: no reason given$/m);
});

test("edge: #645 the paused line carries no mention, link or control character", () => {
  const line = /^Paused since .*$/m.exec(renderBody([], [], null, { ...PAUSE, by: "o@wner", reason: "see #9\u001b[31m [x](http://e.com)" }))[0];
  assert.doesNotMatch(line, /[@#\u001b[\]]|:\/\//);
});

test("#645: while paused no-progress is suppressed, from the control comment or from the heartbeat", () => {
  const ready = { readyCount: 2, inFlightCount: 0 };
  assert.deepEqual(keys(base({ ...ready, control: PAUSE })), []);
  assert.deepEqual(keys(base({ ...ready, comments: [pausedBeat(NOW - 40 * MIN, true)] })), []);
  assert.deepEqual(keys(base({ ...ready, control: { ...PAUSE, paused: false } })), ["no-progress"]);
});

test("#645: other alerts still fire while paused", () => {
  assert.deepEqual(keys(base({ control: PAUSE, prs: [{ number: 4, gateState: "FAILURE" }] })), ["gate-failure:PR 4"]);
});

test("#645: a heartbeat without paused reads as not paused, and paused must be literally true", () => {
  assert.equal(readHeartbeat([pausedBeat(NOW, undefined)], identity).paused, false);
  assert.equal(readHeartbeat([pausedBeat(NOW, "yes")], identity).paused, false);
  assert.equal(readHeartbeat([pausedBeat(NOW, true)], identity).paused, true);
  assert.deepEqual(keys(base({ readyCount: 2, inFlightCount: 0, comments: [pausedBeat(NOW - 40 * MIN, undefined)] })), ["no-progress"]);
});

test("#645: a pause posts no alert comment, and the body is written with the pause line", async () => {
  const f = fake({});
  await run({ client: f.client, inputs: base({ control: PAUSE }), now: NOW });
  assert.deepEqual(names(f.calls).filter((n) => n === "comment"), []);
  assert.match(f.store.get(900).body, /Paused since 2026-10-02 10:30 UTC by owner: maintenance/);
});

test("#645: gatherInputs carries the pause state, paused when it cannot be read", async () => {
  const { gatherInputs } = await import("./health.mjs");
  const gh = (args) => {
    if (args[0] === "repo") return { url: "https://github.com/o/r", nameWithOwner: "o/r" };
    if (args.some((a) => String(a).includes("lanes-control.yml"))) throw new Error("HTTP 502");
    if (args[0] === "api") return {};
    if (args[0] === "issue") return [];
    if (args[0] === "pr") return [];
    if (args[0] === "run") return [];
    return {};
  };
  const r = gatherInputs(gh, { identity });
  assert.equal(r.control.paused, true);
  assert.match(r.control.reason, /cannot be read: HTTP 502/);
});

test("#645: gatherInputs reads the lanes-control run history, so a successful pause run shows in the inputs", async () => {
  const { gatherInputs } = await import("./health.mjs");
  const runs = { workflow_runs: [{ conclusion: "success", event: "workflow_dispatch", head_branch: "main", display_title: "pause: maintenance", triggering_actor: { login: "owner" }, run_started_at: "2026-10-04T09:00:00Z", created_at: "2026-10-04T09:00:00Z" }] };
  const gh = (args) => {
    if (args[0] === "repo") return { url: "https://github.com/o/r", nameWithOwner: "o/r" };
    if (args[0] === "api" && String(args[1]).includes("/actions/workflows/lanes-control.yml/runs")) return runs;
    if (args[0] === "api") return {};
    return [];
  };
  const r = gatherInputs(gh, { identity });
  assert.deepEqual([r.control.paused, r.control.by, r.control.reason], [true, "owner", "maintenance"]);
});
