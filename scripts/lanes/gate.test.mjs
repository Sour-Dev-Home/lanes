import { test } from "node:test";
import assert from "node:assert/strict";
import { carry, evaluatePr, main } from "./gate.mjs";
import { compileConfig } from "./lib.mjs";

const config = compileConfig({ requiredChecks: ["verify"], paths: { skip: ["^docs/"], contract: [], sensitive: [], ui: [] } });
const SHA = "a".repeat(40);
const body = "Closes #7\n## What changed\nx\n## Contract changes\nnone\n## Tests added\nx\n## Reviewer results\nx\n## Needs the owner\nnothing\n## Not done\nnothing";

// "leo" has write access unless a test overrides the route; any other login has no route, so its lookup throws.
function fakeApi(testRoutes) {
  const routes = { "repos/o/r/collaborators/leo/permission": { permission: "admin" }, ...testRoutes };
  const posted = [];
  const api = (args) => {
    if (args[0].endsWith(`/statuses/${args[0].split("/").pop()}`) && args.includes("-f")) {
      posted.push({ sha: args[0].split("/").pop(), fields: args.filter((a, i) => args[i - 1] === "-f") });
      return "{}";
    }
    const hit = routes[args[0]];
    if (hit === undefined) throw new Error(`unexpected gh api ${args.join(" ")}`);
    return typeof hit === "string" ? hit : JSON.stringify(hit);
  };
  return { api, posted };
}

test("evaluatePr posts lanes/gate on the PR head, using old and new names of renamed files", () => {
  const { api, posted } = fakeApi({
    "repos/o/r/pulls/5": { state: "open", body, head: { sha: SHA } },
    "repos/o/r/pulls/5/files": "docs/a.ts\nsrc/a.ts\n",
    "repos/o/r/issues/7": { labels: [{ name: "tier:skip" }] },
    [`repos/o/r/commits/${SHA}/statuses?per_page=100`]: [],
  });
  const d = evaluatePr(api, "o/r", 5, config);
  assert.equal(d.state, "failure");
  assert.equal(posted[0].sha, SHA);
  assert.ok(posted[0].fields.includes("context=lanes/gate"));
  assert.ok(posted[0].fields.includes("state=failure"));
});

const okBody = "Closes #7\n## What changed\nx\n## Contract changes\nnone\n## Tests added\nx\n## Reviewer results\nx\n## Needs the owner\nnothing\n## Not done\nnothing";
const readyIssue = (login) => ({ state: "open", user: { login }, labels: [{ name: "tier:skip" }, { name: "ready" }] });
const writeAccessRoutes = (login, permission) => ({
  "repos/o/r/pulls/5": { state: "open", body: okBody, head: { sha: SHA, ref: "issue-7-add-thing" } },
  "repos/o/r/pulls/5/files": "docs/a.md\n",
  "repos/o/r/issues/7": readyIssue(login),
  [`repos/o/r/commits/${SHA}/statuses?per_page=100`]: [],
  ...(permission === undefined ? {} : { [`repos/o/r/collaborators/${login}/permission`]: { permission } }),
});

test("evaluatePr rejects a ready issue whose author has only read or triage permission, or none", () => {
  for (const permission of ["read", "none"]) {
    const { api } = fakeApi(writeAccessRoutes("guest", permission));
    const d = evaluatePr(api, "o/r", 5, config);
    assert.equal(d.state, "failure", permission);
    assert.match(d.description, /write access/, permission);
  }
});

test("evaluatePr accepts a ready issue whose author has write, maintain or admin permission", () => {
  for (const permission of ["write", "admin"]) {
    const { api } = fakeApi(writeAccessRoutes("maint", permission));
    assert.equal(evaluatePr(api, "o/r", 5, config).state, "success", permission);
  }
});

test("evaluatePr fails closed when the issue author's permission cannot be read", () => {
  const { api, posted } = fakeApi(writeAccessRoutes("ghost")); // no permission route: the lookup throws
  const d = evaluatePr(api, "o/r", 5, config);
  assert.equal(d.state, "failure");
  assert.match(d.description, /write access/);
  assert.ok(posted[0].fields.includes("state=failure"));
});

test("evaluatePr wires the linked issue's state and author's write access, and the PR's head ref, into the gate decision", () => {
  const readyBody = "Closes #7\n## What changed\nx\n## Contract changes\nnone\n## Tests added\nx\n## Reviewer results\nx\n## Needs the owner\nnothing\n## Not done\nnothing";
  const { api, posted } = fakeApi({
    "repos/o/r/pulls/5": { state: "open", body: readyBody, head: { sha: SHA, ref: "issue-7-add-thing" } },
    "repos/o/r/pulls/5/files": "docs/a.md\n",
    "repos/o/r/issues/7": { state: "open", user: { login: "leo" }, labels: [{ name: "tier:skip" }, { name: "ready" }] },
    [`repos/o/r/commits/${SHA}/statuses?per_page=100`]: [],
  });
  const d = evaluatePr(api, "o/r", 5, config);
  assert.equal(d.state, "success");
  assert.ok(posted[0].fields.includes("state=success"));
});

test("evaluatePr fails a PR whose linked issue is not ready, even with a matching head ref", () => {
  const readyBody = "Closes #7\n## What changed\nx\n## Contract changes\nnone\n## Tests added\nx\n## Reviewer results\nx\n## Needs the owner\nnothing\n## Not done\nnothing";
  const { api } = fakeApi({
    "repos/o/r/pulls/5": { state: "open", body: readyBody, head: { sha: SHA, ref: "issue-7-add-thing" } },
    "repos/o/r/pulls/5/files": "docs/a.md\n",
    "repos/o/r/issues/7": { state: "open", user: { login: "stranger" }, labels: [{ name: "tier:skip" }] },
    [`repos/o/r/commits/${SHA}/statuses?per_page=100`]: [],
  });
  const d = evaluatePr(api, "o/r", 5, config);
  assert.equal(d.state, "failure");
});

test("evaluatePr treats a missing issue as having no labels", () => {
  const routes = {
    "repos/o/r/pulls/5": { state: "open", body, head: { sha: SHA } },
    "repos/o/r/pulls/5/files": "docs/a.md\n",
    [`repos/o/r/commits/${SHA}/statuses?per_page=100`]: [],
  };
  const { api } = fakeApi(routes);
  assert.match(evaluatePr(api, "o/r", 5, config).description, /tier/);
});

// E2: "Closes #N" can name a pull request, since the issues API returns both; that must not be treated as a task issue
test("evaluatePr rejects a linked issue number that is actually a pull request", () => {
  const readyBody = "Closes #7\n## What changed\nx\n## Contract changes\nnone\n## Tests added\nx\n## Reviewer results\nx\n## Needs the owner\nnothing\n## Not done\nnothing";
  const { api } = fakeApi({
    "repos/o/r/pulls/5": { state: "open", body: readyBody, head: { sha: SHA, ref: "issue-7-add-thing" } },
    "repos/o/r/pulls/5/files": "docs/a.md\n",
    "repos/o/r/issues/7": { state: "open", user: { login: "leo" }, labels: [{ name: "tier:skip" }, { name: "ready" }], pull_request: { url: "https://api.github.com/repos/o/r/pulls/7" } },
    [`repos/o/r/commits/${SHA}/statuses?per_page=100`]: [],
  });
  const d = evaluatePr(api, "o/r", 5, config);
  assert.equal(d.state, "failure");
  assert.match(d.description, /pull request/);
});

test("evaluatePr skips a closed PR", () => {
  const { api, posted } = fakeApi({ "repos/o/r/pulls/5": { state: "closed", body, head: { sha: SHA } } });
  assert.equal(evaluatePr(api, "o/r", 5, config), null);
  assert.equal(posted.length, 0);
});

// I3: the workflow trigger changed from pull_request to pull_request_target; the dispatcher must accept both
test("main accepts pull_request_target, not just pull_request", () => {
  const { api, posted } = fakeApi({
    "repos/o/r/pulls/5": { state: "open", body, head: { sha: SHA, ref: "issue-7-x" } },
    "repos/o/r/pulls/5/files": "docs/a.md\n",
    "repos/o/r/issues/7": { state: "open", user: { login: "leo" }, labels: [{ name: "tier:skip" }, { name: "ready" }] },
    [`repos/o/r/commits/${SHA}/statuses?per_page=100`]: [],
  });
  main({ REPO: "o/r", EVENT_NAME: "pull_request_target", PR_NUMBER: "5" }, api);
  assert.equal(posted.length, 1);
});

test("main still rejects a truly unsupported event", () => {
  assert.throws(() => main({ REPO: "o/r", EVENT_NAME: "issues" }, () => "{}"), /unsupported event/);
});

// R3: carry() must re-decide from the same live inputs evaluatePr uses, never trust the head's own posted lanes/gate
// status — a lane-pushed workflow running in the merge queue with GITHUB_TOKEN could otherwise forge it.
const readyBody = "Closes #7\n## What changed\nx\n## Contract changes\nnone\n## Tests added\nx\n## Reviewer results\nx\n## Needs the owner\nnothing\n## Not done\nnothing";

test("carry re-decides for the queued PR and posts success on the merge-group commit when it is genuinely success", () => {
  const group = "b".repeat(40);
  const { api, posted } = fakeApi({
    "repos/o/r/pulls/5": { state: "open", body: readyBody, head: { sha: SHA, ref: "issue-7-add-thing" } },
    "repos/o/r/pulls/5/files": "docs/a.md\n",
    "repos/o/r/issues/7": { state: "open", user: { login: "leo" }, labels: [{ name: "tier:skip" }, { name: "ready" }] },
    [`repos/o/r/commits/${SHA}/statuses?per_page=100`]: [],
  });
  const d = carry(api, "o/r", `gh-readonly-queue/main/pr-5-${"c".repeat(40)}`, group, config);
  assert.equal(d.state, "success");
  assert.equal(posted[0].sha, group);
});

test("carry posts failure in the queue when the re-decision is not success, even if the head carries a forged lanes/gate success", () => {
  const group = "b".repeat(40);
  const { api, posted } = fakeApi({
    // tier:quick on a non-skip file with no review posted: the real decision is "pending", never success.
    "repos/o/r/pulls/5": { state: "open", body: readyBody, head: { sha: SHA, ref: "issue-7-add-thing" } },
    "repos/o/r/pulls/5/files": "src/a.ts\n",
    "repos/o/r/issues/7": { state: "open", user: { login: "leo" }, labels: [{ name: "tier:quick" }, { name: "ready" }] },
    // a forged lanes/gate success is present on the head; carry must not read or trust it.
    [`repos/o/r/commits/${SHA}/statuses?per_page=100`]: [{ context: "lanes/gate", state: "success", created_at: "2026-09-26T10:00:00Z" }],
  });
  const d = carry(api, "o/r", `gh-readonly-queue/main/pr-5-${"c".repeat(40)}`, group, config);
  assert.equal(d.state, "failure");
  assert.equal(posted[0].sha, group);
});

// #27: decideForPr reads the PR's verdict comments and keeps only those whose author has write access
const verdictComment = (login, reviewer, sha = SHA) => ({
  login,
  body: `<!-- lanes:verdict ${reviewer} ${sha} -->\n\`\`\`json\n${JSON.stringify({ reviewer, verdict: "success", summary: "s", criteria: [], findings: [] }, null, 2)}\n\`\`\``,
});
// The gh --jq filter emits one @json line per comment.
const commentsOut = (comments) => comments.map((c) => JSON.stringify(c)).join("\n") + "\n";
const reviewStatus = { context: "review/test-hunter", state: "success", description: "ok", created_at: "2026-09-26T10:00:00Z", creator: { type: "User", login: "leo" } };
const fullRoutes = (comments) => ({
  "repos/o/r/pulls/5": { state: "open", body: readyBody, head: { sha: SHA, ref: "issue-7-add-thing" } },
  "repos/o/r/pulls/5/files": "src/a.ts\n",
  "repos/o/r/issues/7": { state: "open", user: { login: "leo" }, labels: [{ name: "tier:full" }, { name: "ready" }] },
  [`repos/o/r/commits/${SHA}/statuses?per_page=100`]: [reviewStatus],
  "repos/o/r/issues/5/comments": commentsOut(comments),
});

test("evaluatePr passes a clean full PR on a trusted verdict comment for its head", () => {
  const { api, posted } = fakeApi(fullRoutes([verdictComment("leo", "test-hunter")]));
  const d = evaluatePr(api, "o/r", 5, config);
  assert.equal(d.state, "success");
  assert.equal(d.description, "unattended-eligible (tier:full), reviews in");
  assert.ok(posted[0].fields.includes("state=success"));
});

test("evaluatePr ignores a verdict comment from an author without write access", () => {
  const routes = { ...fullRoutes([verdictComment("guest", "test-hunter")]), "repos/o/r/collaborators/guest/permission": { permission: "read" } };
  const { api } = fakeApi(routes);
  assert.equal(evaluatePr(api, "o/r", 5, config).description, "waiting on owner (/approve) (no verdict for head from test-hunter)");
});

test("evaluatePr ignores a verdict comment from a bot login (fails closed without a lookup)", () => {
  const { api } = fakeApi(fullRoutes([verdictComment("github-actions[bot]", "test-hunter")]));
  assert.equal(evaluatePr(api, "o/r", 5, config).state, "pending");
});

test("evaluatePr ignores a verdict comment for an older SHA, and an old-format one without a SHA", () => {
  const oldFormat = { login: "leo", body: verdictComment("leo", "test-hunter").body.replace(` ${SHA} -->`, " -->") };
  for (const c of [verdictComment("leo", "test-hunter", "d".repeat(40)), oldFormat]) {
    const { api } = fakeApi(fullRoutes([c]));
    assert.equal(evaluatePr(api, "o/r", 5, config).description, "waiting on owner (/approve) (no verdict for head from test-hunter)");
  }
});

test("evaluatePr looks up each comment author's permission once", () => {
  const { api } = fakeApi(fullRoutes([verdictComment("leo", "test-hunter"), verdictComment("leo", "ui-reviewer"), verdictComment("leo", "test-hunter")]));
  let lookups = 0;
  const counting = (args) => {
    if (args[0] === "repos/o/r/collaborators/leo/permission") lookups++;
    return api(args);
  };
  assert.equal(evaluatePr(counting, "o/r", 5, config).state, "success");
  assert.equal(lookups, 2); // one for the issue author, one for the comment author
});

test("evaluatePr fetches comments with pagination and a filter that emits one JSON line per comment", () => {
  const { api } = fakeApi(fullRoutes([verdictComment("leo", "test-hunter")]));
  let args;
  const spy = (a) => {
    if (a[0] === "repos/o/r/issues/5/comments") args = a;
    return api(a);
  };
  evaluatePr(spy, "o/r", 5, config);
  assert.ok(args.includes("--paginate"));
  assert.ok(args.includes("--jq"));
});

test("evaluatePr waits on the owner when the comments cannot be read", () => {
  const routes = fullRoutes([]);
  delete routes["repos/o/r/issues/5/comments"];
  const { api } = fakeApi(routes);
  assert.equal(evaluatePr(api, "o/r", 5, config).stage, "owner");
});

test("carry passes a clean full PR in the merge queue", () => {
  const group = "b".repeat(40);
  const { api, posted } = fakeApi(fullRoutes([verdictComment("leo", "test-hunter")]));
  const d = carry(api, "o/r", `gh-readonly-queue/main/pr-5-${"c".repeat(40)}`, group, config);
  assert.equal(d.state, "success");
  assert.equal(posted[0].sha, group);
});

test("carry fails a full PR in the queue when its verdict comment is untrusted", () => {
  const group = "b".repeat(40);
  const { api } = fakeApi({ ...fullRoutes([verdictComment("guest", "test-hunter")]), "repos/o/r/collaborators/guest/permission": { permission: "read" } });
  assert.equal(carry(api, "o/r", `gh-readonly-queue/main/pr-5-${"c".repeat(40)}`, group, config).state, "failure");
});

test("carry fails closed on an unknown queue ref, without calling the API", () => {
  const group = "b".repeat(40);
  const { api, posted } = fakeApi({});
  assert.equal(carry(api, "o/r", "not-a-queue-ref", group, config).state, "failure");
  assert.equal(posted[0].sha, group);
});

test("carry fails closed when the queued PR is no longer open", () => {
  const group = "b".repeat(40);
  const { api } = fakeApi({ "repos/o/r/pulls/5": { state: "closed", body, head: { sha: SHA } } });
  assert.equal(carry(api, "o/r", `gh-readonly-queue/main/pr-5-${"c".repeat(40)}`, group, config).state, "failure");
});
