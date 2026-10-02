import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { HEARTBEAT_MARKER, evaluate, ghClient, healthThresholds, readHeartbeat, readStored, reconcile, renderBody, run } from "./health.mjs";

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
  const prs = [{ number: 4, gateState: "FAILURE" }, { number: 9, gateState: "PENDING" }];
  assert.deepEqual(keys(base({ prs, mergeGroupRuns: runs })), ["gate-failure:PR 4", "gate-failure:PR 9"]);
  assert.deepEqual(keys(base({ prs: [{ number: 9, gateState: "PENDING" }], reply: replyOf([], [9]), mergeGroupRuns: runs })), []);
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
  assert.deepEqual(readHeartbeat([broken], identity), { at: NOW - MIN, findings: [] });
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
  assert.deepEqual(healthThresholds({}), { approvedStuckMinutes: 30, noProgressMinutes: 30 });
  assert.deepEqual(healthThresholds({ health: { approvedStuckMinutes: -1, noProgressMinutes: "5" } }), { approvedStuckMinutes: 30, noProgressMinutes: 30 });
  assert.deepEqual(healthThresholds({ health: { approvedStuckMinutes: 5, noProgressMinutes: 7 } }), { approvedStuckMinutes: 5, noProgressMinutes: 7 });
});

test("lanes.config.json registers the module and sets both thresholds", () => {
  const config = JSON.parse(readFileSync(new URL("../../lanes.config.json", import.meta.url), "utf8"));
  assert.ok(config.modules.entries.some((m) => m.paths.includes("scripts/lanes/health.")));
  assert.deepEqual(healthThresholds(config), { approvedStuckMinutes: 30, noProgressMinutes: 30 });
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
    if (args[0] === "issue") return [{ number: 1, labels: [{ name: "ready" }] }, { number: 2, labels: [{ name: "ready" }, { name: "lane:running" }] }, { number: 3, labels: [{ name: "lane:running" }] }];
    return args.includes("merge_group") ? [] : [{ name: "verify", headSha: "ab", conclusion: "success", updatedAt: "t" }];
  };
  const r = gatherInputs(gh, { identity });
  assert.deepEqual(r.prs, [{ number: 5, gateState: "SUCCESS", gateSince: Date.parse("2026-10-02T10:00:00Z") }, { number: 6, gateState: null, gateSince: undefined }]);
  assert.equal(r.readyCount, 1);
  assert.equal(r.inFlightCount, 4);
  assert.deepEqual(r.checkRuns, [{ name: "verify", sha: "ab", conclusion: "success", at: "t" }]);
  assert.equal(r.identity, identity);
});
