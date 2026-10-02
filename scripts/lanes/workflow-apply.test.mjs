import { test } from "node:test";
import assert from "node:assert/strict";
import { filterDecision, parseHandoverFiles, applyChecks, main, HANDOVER_MARKER } from "./workflow-apply.mjs";
import { pendingFileHash } from "./lib.mjs";

// The hand-over shape handover.mjs writes (the module map forbids importing it here): the marker, then per file a
// `#### \`path\`` heading, an edit link and a fence longer than any backtick run inside.
function handoverComment({ files }) {
  const parts = [`${HANDOVER_MARKER} to commit in GitHub's web editor`, "", "Read each file before you commit."];
  for (const f of files) {
    const fence = "`".repeat(Math.max(3, ...[...f.text.matchAll(/`+/g)].map((m) => m[0].length + 1)));
    parts.push("", `#### \`${f.path}\` (${f.status === "A" ? "new file" : "changed file"})`, "", "Edit it here: https://github.com/o/r/edit/b/x", "", `${fence}yaml`, f.text.replace(/\n+$/, ""), fence);
  }
  return `${parts.join("\n")}\n`;
}

const IDENTITY = { profile: "team", app: { id: 1, installationId: 2, botLogin: "lanes[bot]" } };
const BOT = { login: "lanes[bot]", type: "Bot" };
const HEAD = "a".repeat(40);
const PATH = ".github/workflows/ci.yml";
const TEXT = "name: ci\non: push\n";
const TOKEN = "ghs_SECRETTOKEN123";

const handover = (files = [{ path: PATH, status: "M", text: TEXT }]) => handoverComment({ files });
const verdict = (reviewer, pending, sha = HEAD) =>
  `<!-- lanes:verdict ${reviewer} ${sha} -->\n\`\`\`json\n${JSON.stringify({ reviewer, verdict: "success", pending })}\n\`\`\``;
const pend = (path = PATH, text = TEXT) => [{ path, sha256: pendingFileHash(text) }];

function inputs(over = {}) {
  const comment = { id: 10, author: BOT, body: handover(), createdAt: "2026-10-02T10:00:00Z", lastEditedAt: null };
  return {
    comment,
    comments: [comment, { id: 11, author: BOT, body: verdict("test-hunter", pend()), createdAt: "2026-10-02T10:01:00Z" }],
    pr: { state: "OPEN", headRepo: "o/r", baseRepo: "o/r", headSha: HEAD, headRef: "issue-1-x" },
    headShaAtFilter: HEAD,
    identity: IDENTITY,
    ...over,
  };
}
const refusal = (over, re) => {
  const r = applyChecks(inputs(over));
  assert.equal(r.ok, false);
  assert.match(r.reason, re);
};

// ---- filterDecision ----

test("filter: go for the lane bot's hand-over on a PR", () => {
  assert.equal(filterDecision({ comment: { body: handover(), author: BOT }, isPr: true, identity: IDENTITY }).go, true);
});

test("filter: no go off a PR, for another author, a user typed as bot-like login, a missing marker or no comment", () => {
  const base = { comment: { body: handover(), author: BOT }, isPr: true, identity: IDENTITY };
  assert.equal(filterDecision({ ...base, isPr: false }).go, false);
  assert.equal(filterDecision({ ...base, comment: { body: handover(), author: { login: "someone", type: "User" } } }).go, false);
  assert.equal(filterDecision({ ...base, comment: { body: handover(), author: { login: "lanes[bot]", type: "User" } } }).go, false);
  assert.equal(filterDecision({ ...base, comment: { body: `hi\n${HANDOVER_MARKER}`, author: BOT } }).go, false);
  assert.equal(filterDecision({ ...base, comment: undefined }).go, false);
  assert.equal(filterDecision({ ...base, identity: undefined }).go, false);
  assert.match(filterDecision({ ...base, isPr: false }).reason, /not on a pull request/);
});

// ---- parseHandoverFiles ----

test("parse: reads each file's path and text, including a fence-like line inside", () => {
  const text = "a: |\n  ```\n  b\n  ```\n";
  const r = parseHandoverFiles(handover([{ path: PATH, status: "M", text }, { path: ".github/workflows/b.yaml", status: "A", text: TEXT }]));
  assert.deepEqual(r.files.map((f) => f.path), [PATH, ".github/workflows/b.yaml"]);
  assert.equal(pendingFileHash(r.files[0].text), pendingFileHash(text));
});

test("parse edge: not a hand-over, no files, unclosed fence, heading without a block, duplicate path", () => {
  assert.match(parseHandoverFiles("hello").error, /not a workflow hand-over/);
  assert.match(parseHandoverFiles(undefined).error, /not a workflow hand-over/);
  assert.match(parseHandoverFiles(`${HANDOVER_MARKER}\nnothing`).error, /no files/);
  assert.match(parseHandoverFiles(`${HANDOVER_MARKER}\n#### \`${PATH}\`\n\`\`\`yaml\nx\n`).error, /not closed/);
  assert.match(parseHandoverFiles(`${HANDOVER_MARKER}\n#### \`${PATH}\`\n`).error, /no fenced content/);
  assert.match(parseHandoverFiles(`${HANDOVER_MARKER}\n#### \`${PATH}\`\n#### \`b\`\n`).error, /no fenced content/);
  const dup = handover([{ path: PATH, status: "M", text: TEXT }, { path: PATH, status: "M", text: TEXT }]);
  assert.match(parseHandoverFiles(dup).error, /twice/);
});

// ---- applyChecks ----

test("apply: passes with the normalised content the hash covers", () => {
  const r = applyChecks(inputs());
  assert.equal(r.ok, true);
  assert.deepEqual(r.files, [{ path: PATH, content: TEXT }]);
  assert.equal(r.headSha, HEAD);
});

test("apply refuses: edited comment", () => {
  const i = inputs();
  i.comment = { ...i.comment, lastEditedAt: "2026-10-02T10:05:00Z" };
  refusal(i, /edited/);
});

test("apply refuses: comment by another author or not a hand-over", () => {
  refusal({ comment: { ...inputs().comment, author: { login: "evil", type: "User" } } }, /not by the lane bot/);
  refusal({ comment: { ...inputs().comment, body: "plain" } }, /not a workflow hand-over/);
  refusal({ comment: { ...inputs().comment, id: 99 } }, /not among/);
});

test("apply refuses: not the newest hand-over (by time, and by id on a tie)", () => {
  const i = inputs();
  const newer = { id: 12, author: BOT, body: handover(), createdAt: "2026-10-02T10:02:00Z" };
  refusal({ comments: [...i.comments, newer] }, /newer hand-over/);
  const tie = { ...newer, createdAt: i.comment.createdAt };
  refusal({ comments: [...i.comments, tie] }, /newer hand-over/);
  assert.equal(applyChecks(inputs({ comments: [...i.comments, { ...tie, id: 9 }] })).ok, true);
});

test("apply refuses: closed PR, fork head, deleted fork, moved head, unreadable head, odd branch", () => {
  const pr = inputs().pr;
  refusal({ pr: { ...pr, state: "CLOSED" } }, /not open/);
  refusal({ pr: { ...pr, state: "MERGED" } }, /not open/);
  refusal({ pr: { ...pr, headRepo: "fork/r" } }, /not in this repository/);
  refusal({ pr: { ...pr, headRepo: null } }, /not in this repository/);
  refusal({ pr: { ...pr, headSha: "b".repeat(40) } }, /moved/);
  refusal({ pr: { ...pr, headSha: "xyz" } }, /could not be read/);
  refusal({ pr: { ...pr, headRef: "-x" } }, /plain name/);
  refusal({ pr: { ...pr, headRef: "a/../b" } }, /plain name/);
});

test("apply refuses: a path outside the pattern", () => {
  for (const path of [".github/workflows/sub/ci.yml", ".github/workflows/ci.txt", ".github/other.yml", "scripts/x.yml", ".github/workflows/ci.yml.sh"]) {
    const comment = { ...inputs().comment, body: handover([{ path, status: "M", text: TEXT }]) };
    refusal({ comment, comments: [comment] }, /outside \.github\/workflows/);
  }
});

test("apply refuses: file set differs from pending (extra file, missing file, no pending, wrong head)", () => {
  const i = inputs();
  const two = { ...i.comment, body: handover([{ path: PATH, status: "M", text: TEXT }, { path: ".github/workflows/b.yml", status: "A", text: TEXT }]) };
  refusal({ comment: two, comments: [two, i.comments[1]] }, /differ from the verdicts.*\+\.github\/workflows\/b\.yml/);
  const withTwoPending = { id: 11, author: BOT, body: verdict("test-hunter", [...pend(), ...pend(".github/workflows/b.yml")]) };
  refusal({ comments: [i.comment, withTwoPending] }, /differ from the verdicts.*-\.github\/workflows\/b\.yml/);
  refusal({ comments: [i.comment, { id: 11, author: BOT, body: verdict("test-hunter", undefined) }] }, /no verdict/);
  refusal({ comments: [i.comment, { id: 11, author: BOT, body: verdict("test-hunter", pend(), "c".repeat(40)) }] }, /no verdict/);
  refusal({ comments: [i.comment] }, /no verdict/);
});

test("apply refuses: verdicts by a non-bot are ignored", () => {
  const i = inputs();
  refusal({ comments: [i.comment, { id: 11, author: { login: "evil", type: "User" }, body: verdict("test-hunter", pend()) }] }, /no verdict/);
});

test("apply refuses: hash mismatch", () => {
  const i = inputs();
  const tampered = { id: 11, author: BOT, body: verdict("test-hunter", pend(PATH, "name: other\n")) };
  refusal({ comments: [i.comment, tampered] }, /hash of .*ci\.yml differs/);
});

test("apply refuses: two verdicts disagree on one path", () => {
  const i = inputs();
  const other = { id: 12, author: BOT, body: verdict("security-reviewer", pend(PATH, "name: other\n")) };
  refusal({ comments: [...i.comments, other] }, /two verdicts record different hashes/);
});

test("apply accepts agreeing verdicts and a CRLF comment body", () => {
  const i = inputs();
  const second = { id: 12, author: BOT, body: verdict("security-reviewer", pend()) };
  assert.equal(applyChecks(inputs({ comments: [...i.comments, second] })).ok, true);
  const crlf = { ...i.comment, body: i.comment.body.replaceAll("\n", "\r\n") };
  const r = applyChecks(inputs({ comment: crlf, comments: [crlf, i.comments[1]] }));
  assert.equal(r.ok, true);
  assert.equal(r.files[0].content, TEXT);
});

test("apply edge: empty file content and incomplete inputs", () => {
  const comment = { ...inputs().comment, body: `${HANDOVER_MARKER}\n#### \`${PATH}\`\n\n\`\`\`yaml\n\n\`\`\`\n` };
  refusal({ comment, comments: [comment, inputs().comments[1]] }, /hash of/);
  assert.equal(applyChecks().ok, false);
  assert.equal(applyChecks({ ...inputs(), comments: null }).ok, false);
});

// ---- main ----

function fakeApi({ headMoved = false, failAt = null } = {}) {
  const calls = [];
  const api = async (method, path, body) => {
    calls.push({ method, path, body });
    if (failAt && path.includes(failAt)) return { status: 500, json: null };
    if (method === "GET" && path.includes("/git/commits/")) return { status: 200, json: { tree: { sha: "tree0" } } };
    if (method === "GET" && path.includes("/pulls/")) return { status: 200, json: { head: { sha: HEAD } } };
    if (path.endsWith("/git/blobs")) return { status: 201, json: { sha: `blob${calls.length}` } };
    if (path.endsWith("/git/trees")) return { status: 201, json: { sha: "tree1" } };
    if (path.endsWith("/git/commits")) return { status: 201, json: { sha: "d".repeat(40) } };
    if (method === "PATCH") return headMoved ? { status: 422, json: { message: "Update is not a fast forward" } } : { status: 200, json: {} };
    return { status: 404, json: null };
  };
  return { api, calls };
}

function graphqlFor(i, { pages = null } = {}) {
  const node = (c) => ({ databaseId: c.id, body: c.body, createdAt: c.createdAt ?? "2026-10-02T10:00:00Z", lastEditedAt: c.lastEditedAt ?? null, author: { login: c.author.login.replace("[bot]", ""), __typename: c.author.type ?? "User" } });
  return async (_q, vars) => {
    const all = i.comments.map(node);
    const page = pages ? pages[vars.before ? 1 : 0] : { nodes: all, hasPreviousPage: false };
    return { repository: { pullRequest: { state: i.pr.state, headRefName: i.pr.headRef, headRefOid: i.pr.headSha, headRepository: { nameWithOwner: i.pr.headRepo }, baseRepository: { nameWithOwner: i.pr.baseRepo }, comments: { pageInfo: { hasPreviousPage: page.hasPreviousPage, startCursor: "c1" }, nodes: page.nodes } } } };
  };
}

const applyEnv = { LANES_REPO: "o/r", LANES_PR: "5", LANES_COMMENT_ID: "10", LANES_HEAD_SHA: HEAD };
const readConfig = () => JSON.stringify({ identity: IDENTITY });

test("main apply: commits through the Git Data API, non-forced, and never prints the token", async () => {
  const { api, calls } = fakeApi();
  const r = await main(["apply"], { env: applyEnv, token: TOKEN, readConfig, api, graphql: graphqlFor(inputs()) });
  assert.equal(r.code, 0, r.lines.join("\n"));
  const kinds = calls.map((c) => `${c.method} ${c.path.replace("/repos/o/r", "")}`);
  assert.deepEqual(kinds, [`GET /git/commits/${HEAD}`, "POST /git/blobs", "POST /git/trees", "POST /git/commits", "PATCH /git/refs/heads/issue-1-x"]);
  assert.deepEqual(calls[1].body, { content: TEXT, encoding: "utf-8" });
  assert.equal(calls[2].body.base_tree, "tree0");
  assert.deepEqual(calls[3].body.parents, [HEAD]);
  assert.equal(calls[4].body.force, false);
  assert.ok(!JSON.stringify(r).includes(TOKEN));
});

test("main apply: a ref-update conflict refuses with a reason", async () => {
  const r = await main(["apply"], { env: applyEnv, token: TOKEN, readConfig, api: fakeApi({ headMoved: true }).api, graphql: graphqlFor(inputs()) });
  assert.equal(r.code, 1);
  assert.match(r.lines[0], /branch moved/);
});

test("main apply: a refused check writes nothing and exits 1 naming the reason", async () => {
  const i = inputs();
  i.comment.lastEditedAt = "2026-10-02T10:05:00Z";
  i.comments[0] = i.comment;
  const { api, calls } = fakeApi();
  const r = await main(["apply"], { env: applyEnv, token: TOKEN, readConfig, api, graphql: graphqlFor(i) });
  assert.equal(r.code, 1);
  assert.match(r.lines[0], /refused: the comment was edited/);
  assert.equal(calls.length, 0);
});

test("main apply: an API failure exits 1, and an error holding the token is scrubbed", async () => {
  const a = await main(["apply"], { env: applyEnv, token: TOKEN, readConfig, api: fakeApi({ failAt: "/git/trees" }).api, graphql: graphqlFor(inputs()) });
  assert.equal(a.code, 1);
  assert.match(a.lines[0], /creating the tree failed \(HTTP 500\)/);
  const leaky = async () => {
    throw new Error(`boom ${TOKEN}`);
  };
  const b = await main(["apply"], { env: applyEnv, token: TOKEN, readConfig, api: leaky, graphql: graphqlFor(inputs()) });
  assert.equal(b.code, 2);
  assert.ok(!JSON.stringify(b).includes(TOKEN));
  assert.match(b.lines[0], /\*\*\*/);
});

test("main apply: reads earlier comment pages; a comment that vanished refuses", async () => {
  const i = inputs();
  const pages = [{ nodes: [], hasPreviousPage: true }, { nodes: [], hasPreviousPage: false }];
  const none = await main(["apply"], { env: applyEnv, token: TOKEN, readConfig, api: fakeApi().api, graphql: graphqlFor(i, { pages }) });
  assert.equal(none.code, 1);
  assert.match(none.lines[0], /no longer on the pull request/);
  const split = [{ nodes: [], hasPreviousPage: true }, { nodes: i.comments.map((c) => ({ databaseId: c.id, body: c.body, createdAt: c.createdAt ?? "2026-10-02T10:00:00Z", lastEditedAt: null, author: { login: "lanes", __typename: "Bot" } })), hasPreviousPage: false }];
  const ok = await main(["apply"], { env: applyEnv, token: TOKEN, readConfig, api: fakeApi().api, graphql: graphqlFor(i, { pages: split }) });
  assert.equal(ok.code, 0, ok.lines.join("\n"));
  const endless = async () => ({ repository: { pullRequest: { state: "OPEN", headRefName: "x", headRefOid: HEAD, headRepository: null, baseRepository: null, comments: { pageInfo: { hasPreviousPage: true, startCursor: "c" }, nodes: [] } } } });
  const many = await main(["apply"], { env: applyEnv, token: TOKEN, readConfig, api: fakeApi().api, graphql: endless });
  assert.match(many.lines[0], /too many comments/);
});

test("main: usage and malformed input exit 2", async () => {
  const deps = { env: applyEnv, token: TOKEN, readConfig, api: fakeApi().api, graphql: graphqlFor(inputs()) };
  assert.equal((await main([], deps)).code, 2);
  assert.equal((await main(["push"], deps)).code, 2);
  assert.equal((await main(["apply"], { ...deps, readConfig: () => "nope" })).code, 2);
  assert.equal((await main(["apply"], { ...deps, readConfig: () => JSON.stringify({}) })).code, 2);
  assert.equal((await main(["apply"], { ...deps, env: { ...applyEnv, LANES_PR: "0" } })).code, 2);
  assert.equal((await main(["apply"], { ...deps, env: { ...applyEnv, LANES_HEAD_SHA: "x" } })).code, 2);
  assert.equal((await main(["apply"], { ...deps, token: "" })).code, 2);
});

test("main filter: go=true outputs the head; every other outcome is go=false with exit 0", async () => {
  const env = { LANES_REPO: "o/r", LANES_PR: "5", COMMENT_BODY: handover(), COMMENT_LOGIN: "lanes[bot]", COMMENT_TYPE: "Bot", IS_PR: "true" };
  const deps = (e, api = fakeApi().api) => ({ env: e, readConfig, api, graphql: null });
  const go = await main(["filter"], deps(env));
  assert.deepEqual([go.code, go.outputs], [0, { go: "true", head: HEAD }]);
  for (const over of [{ IS_PR: "false" }, { COMMENT_LOGIN: "someone", COMMENT_TYPE: "User" }, { COMMENT_BODY: "hello" }]) {
    const r = await main(["filter"], deps({ ...env, ...over }));
    assert.deepEqual([r.code, r.outputs], [0, { go: "false" }]);
  }
  const unreadable = await main(["filter"], deps(env, async () => ({ status: 404, json: null })));
  assert.deepEqual([unreadable.code, unreadable.outputs.go], [0, "false"]);
});

test("filter strictness: isPr must be boolean true, not a truthy string, number or object", () => {
  const base = { comment: { body: handover(), author: BOT }, identity: IDENTITY };
  for (const isPr of ["true", 1, {}, undefined, null]) assert.equal(filterDecision({ ...base, isPr }).go, false);
});

test("apply edge: any non-null edit stamp refuses, and a marker-only body holds no files", () => {
  for (const lastEditedAt of ["2026-10-02T10:05:00Z", 0, ""]) {
    const base = inputs();
    refusal({ comment: { ...base.comment, lastEditedAt }, comments: [{ ...base.comment, lastEditedAt }, base.comments[1]] }, /edited/);
  }
  assert.equal(parseHandoverFiles(HANDOVER_MARKER).error, "the comment holds no files");
});
