import { test } from "node:test";
import assert from "node:assert/strict";
import { controlBody, nextState, run } from "./control.mjs";
import { controlState } from "./lib.mjs";

const NOW = Date.parse("2026-10-02T12:00:00Z");
const ACTIONS_BOT = { login: "github-actions[bot]", type: "Bot" };
const REPO = "o/r";

// A fake `gh api`: `issues` are the lanes-health issues, `comments` the comments on the issue; it records every write.
function fakeApi({ issues = [{ number: 5, state: "open" }], comments = [], labelFails = null } = {}) {
  const writes = [];
  let nextId = 100;
  const api = (args) => {
    const path = args.find((a) => String(a).startsWith(`repos/${REPO}`)) ?? "";
    const write = args.some((a) => String(a).startsWith("body=") || String(a).startsWith("name="));
    if (write) writes.push({ method: args.includes("PATCH") ? "PATCH" : "POST", path, args });
    if (path.endsWith("/labels")) {
      if (labelFails) throw Object.assign(new Error("failed"), { stderr: labelFails });
      return "{}";
    }
    if (path.endsWith("/issues") && args.includes("GET")) return JSON.stringify(issues);
    if (path.endsWith("/issues")) {
      issues = [{ number: 77, state: "open" }];
      return JSON.stringify({ number: 77 });
    }
    if (path.includes("/comments?")) return JSON.stringify([comments]);
    if (write) return JSON.stringify({ id: nextId++ });
    throw new Error(`unexpected ${args.join(" ")}`);
  };
  return { api, writes };
}
const bodyOf = (w) => w.args.find((a) => String(a).startsWith("body=")).slice("body=".length);
const env = (extra = {}) => ({ LANES_ACTION: "pause", LANES_REASON: "maintenance", LANES_ACTOR: "owner", ...extra });
const asComment = (body, id = 1, user = ACTIONS_BOT) => ({ id, body, user });

test("pause creates one control comment on the health issue, holding paused, since, by and reason", () => {
  const f = fakeApi();
  const r = run({ api: f.api, repo: REPO, env: env(), now: NOW });
  assert.deepEqual(r, { number: 5, created: true, state: { paused: true, since: "2026-10-02T12:00:00.000Z", by: "owner", reason: "maintenance" } });
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].path, "repos/o/r/issues/5/comments");
  assert.ok(bodyOf(f.writes[0]).startsWith("<!-- lanes:control -->\n"));
  const state = controlState({ body: bodyOf(f.writes[0]), author: ACTIONS_BOT, editor: null }, NOW);
  assert.deepEqual([state.paused, state.by, state.reason], [true, "owner", "maintenance"]);
});

test("resume edits the existing control comment of github-actions[bot], and writes no other comment", () => {
  const old = asComment(controlBody({ paused: true, since: "2026-10-02T10:00:00.000Z", by: "owner", reason: "x" }), 41);
  const other = asComment("hello", 40, { login: "someone", type: "User" });
  const f = fakeApi({ comments: [other, old] });
  const r = run({ api: f.api, repo: REPO, env: env({ LANES_ACTION: "resume", LANES_REASON: "" }), now: NOW });
  assert.equal(r.created, false);
  assert.equal(f.writes.length, 1);
  assert.deepEqual([f.writes[0].method, f.writes[0].path], ["PATCH", "repos/o/r/issues/comments/41"]);
  assert.match(bodyOf(f.writes[0]), /"paused":false/);
});

test("a control comment by another author is never edited: a new comment is made, and it is not adopted", () => {
  const forged = asComment(controlBody({ paused: false, since: "2026-10-02T10:00:00.000Z", by: "x", reason: "" }), 9, { login: "sour-dev-lanes[bot]", type: "Bot" });
  const f = fakeApi({ comments: [forged] });
  const r = run({ api: f.api, repo: REPO, env: env(), now: NOW });
  assert.equal(r.created, true);
  assert.deepEqual(f.writes.map((w) => w.method), ["POST"]);
});

test("the lowest-numbered control comment of the bot is the one edited", () => {
  const body = controlBody({ paused: true, since: "2026-10-02T10:00:00.000Z", by: "o", reason: "" });
  const f = fakeApi({ comments: [asComment(body, 60), asComment(body, 30)] });
  run({ api: f.api, repo: REPO, env: env(), now: NOW });
  assert.equal(f.writes[0].path, "repos/o/r/issues/comments/30");
});

test("with no health issue, the label and the issue are created first, then the comment goes on the new issue", () => {
  const f = fakeApi({ issues: [] });
  const r = run({ api: f.api, repo: REPO, env: env(), now: NOW });
  assert.equal(r.number, 77);
  assert.deepEqual(f.writes.map((w) => w.path), ["repos/o/r/labels", "repos/o/r/issues", "repos/o/r/issues/77/comments"]);
});

test("edge: an existing label (422) is fine, any other label failure throws", () => {
  assert.equal(run({ api: fakeApi({ issues: [], labelFails: "HTTP 422 already_exists" }).api, repo: REPO, env: env(), now: NOW }).number, 77);
  assert.throws(() => run({ api: fakeApi({ issues: [], labelFails: "HTTP 403" }).api, repo: REPO, env: env(), now: NOW }), /failed/);
});

test("the health issue is the lowest open one, else the lowest of any state, and pull requests are skipped", () => {
  const issues = [{ number: 9, state: "open" }, { number: 3, state: "closed" }, { number: 2, state: "open", pull_request: {} }, { number: 6, state: "open" }];
  assert.equal(run({ api: fakeApi({ issues }).api, repo: REPO, env: env(), now: NOW }).number, 6);
  assert.equal(run({ api: fakeApi({ issues: [{ number: 8, state: "closed" }, { number: 4, state: "closed" }] }).api, repo: REPO, env: env(), now: NOW }).number, 4);
});

test("nextState rejects an unknown or missing action and a reason over 200 characters", () => {
  for (const action of ["stop", "", undefined, "PAUSE", "pause; rm -rf"]) assert.throws(() => nextState({ action, reason: "", actor: "o" }, NOW), /action must be pause or resume/);
  assert.throws(() => nextState({ action: "pause", reason: "x".repeat(201), actor: "o" }, NOW), /over the 200 limit/);
  assert.equal(nextState({ action: "pause", reason: "x".repeat(200), actor: "o" }, NOW).reason.length, 200);
});

test("edge: the reason loses control characters and newlines; a missing reason or odd actor is tolerated", () => {
  const s = nextState({ action: "pause", reason: "a\r\nb\u001b[2Jc‮", actor: "evil\nname" }, NOW);
  assert.doesNotMatch(s.reason, /[\u0000-\u001f‮]/);
  assert.equal(s.by, "unknown");
  assert.equal(nextState({ action: "resume", reason: undefined, actor: "dependabot[bot]" }, NOW).by, "dependabot[bot]");
  assert.equal(nextState({ action: "resume", reason: undefined, actor: "o" }, NOW).reason, "");
});

test("run touches only the control comment: no issue body, label or other comment write", () => {
  const f = fakeApi({ comments: [asComment("<!-- lanes:heartbeat -->", 1), asComment("alert", 2)] });
  run({ api: f.api, repo: REPO, env: env(), now: NOW });
  assert.deepEqual(f.writes.map((w) => w.path), ["repos/o/r/issues/5/comments"]);
});
