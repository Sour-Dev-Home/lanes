import { test } from "node:test";
import assert from "node:assert/strict";
import { carry, evaluatePr, main } from "./gate.mjs";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileConfig, parseAdr } from "./lib.mjs";

const config = compileConfig({ requiredChecks: ["verify"], paths: { skip: ["^docs/"], contract: [], sensitive: [], ui: [] } });
const SHA = "a".repeat(40);
// The linked task issue's form; #36 reads its "Blocked by" field.
const issueBody = "### Goal\n\ng\n\n### Blocked by\n\nnone\n";
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
const readyIssue = (login) => ({ state: "open", body: issueBody, user: { login }, labels: [{ name: "tier:skip" }, { name: "ready" }] });
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
    "repos/o/r/issues/7": { state: "open", body: issueBody, user: { login: "leo" }, labels: [{ name: "tier:skip" }, { name: "ready" }] },
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
    "repos/o/r/issues/7": { state: "open", body: issueBody, user: { login: "stranger" }, labels: [{ name: "tier:skip" }] },
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
    "repos/o/r/issues/7": { state: "open", body: issueBody, user: { login: "leo" }, labels: [{ name: "tier:skip" }, { name: "ready" }], pull_request: { url: "https://api.github.com/repos/o/r/pulls/7" } },
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
    "repos/o/r/issues/7": { state: "open", body: issueBody, user: { login: "leo" }, labels: [{ name: "tier:skip" }, { name: "ready" }] },
    [`repos/o/r/commits/${SHA}/statuses?per_page=100`]: [],
  });
  main({ REPO: "o/r", EVENT_NAME: "pull_request_target", PR_NUMBER: "5" }, api);
  assert.equal(posted.length, 1);
});

test("main still rejects a truly unsupported event", () => {
  assert.throws(() => main({ REPO: "o/r", EVENT_NAME: "push" }, () => "{}"), /unsupported event/);
});

// R3: carry() must re-decide from the same live inputs evaluatePr uses, never trust the head's own posted lanes/gate
// status — a lane-pushed workflow running in the merge queue with GITHUB_TOKEN could otherwise forge it.
const readyBody = "Closes #7\n## What changed\nx\n## Contract changes\nnone\n## Tests added\nx\n## Reviewer results\nx\n## Needs the owner\nnothing\n## Not done\nnothing";

test("carry re-decides for the queued PR and posts success on the merge-group commit when it is genuinely success", () => {
  const group = "b".repeat(40);
  const { api, posted } = fakeApi({
    "repos/o/r/pulls/5": { state: "open", body: readyBody, head: { sha: SHA, ref: "issue-7-add-thing" } },
    "repos/o/r/pulls/5/files": "docs/a.md\n",
    "repos/o/r/issues/7": { state: "open", body: issueBody, user: { login: "leo" }, labels: [{ name: "tier:skip" }, { name: "ready" }] },
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
    "repos/o/r/issues/7": { state: "open", body: issueBody, user: { login: "leo" }, labels: [{ name: "tier:quick" }, { name: "ready" }] },
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
  "repos/o/r/issues/7": { state: "open", body: issueBody, user: { login: "leo" }, labels: [{ name: "tier:full" }, { name: "ready" }] },
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

// #45: the gate loads accepted ADRs from its own working tree (the default branch's checkout) and passes them on.
const adrMd = (n, governs) =>
  `# ${String(n).padStart(4, "0")}: ADR ${n}\n\nStatus: accepted\n\n## Context\n\nx\n\n## Decision\n\nx\n\n## Decisions for the owner\n\nnothing\n\n## Consequences\n\nx\n\n## Governs\n\n- ${governs}\n`;
const WAIT_ADVISOR = "waiting for review/architecture-advisor";

test("evaluatePr and carry require the architecture-advisor for a file an accepted ADR governs", () => {
  const adrs = [parseAdr(adrMd(3, "src/"))];
  const { api, posted } = fakeApi(fullRoutes([verdictComment("leo", "test-hunter")]));
  assert.equal(evaluatePr(api, "o/r", 5, config, adrs).description, WAIT_ADVISOR);
  assert.ok(posted[0].fields.includes("state=pending"));
  const d = carry(api, "o/r", `gh-readonly-queue/main/pr-5-${"c".repeat(40)}`, "b".repeat(40), config, adrs);
  assert.deepEqual(d, { state: "failure", description: WAIT_ADVISOR });
});

test("edge: evaluatePr without adrs decides as before", () => {
  const { api } = fakeApi(fullRoutes([verdictComment("leo", "test-hunter")]));
  assert.equal(evaluatePr(api, "o/r", 5, config).state, "success");
});

// main reads lanes.config.json and docs/adr from the directory it runs in, like the workflow's default-branch checkout.
function inCheckout(adrFiles, fn) {
  const root = mkdtempSync(join(tmpdir(), "lanes-gate-"));
  const prev = process.cwd();
  try {
    writeFileSync(join(root, "lanes.config.json"), JSON.stringify({ requiredChecks: ["verify"], paths: { skip: ["^docs/"], contract: [], sensitive: [], ui: [] } }));
    mkdirSync(join(root, "docs", "adr"), { recursive: true });
    for (const [name, text] of Object.entries(adrFiles)) writeFileSync(join(root, "docs", "adr", name), text);
    process.chdir(root);
    return fn();
  } finally {
    process.chdir(prev);
    rmSync(root, { recursive: true, force: true });
  }
}
const descriptionOf = (post) => post.fields.find((f) => f.startsWith("description=")).slice("description=".length);

test("main loads the default branch's ADRs: a governed file waits for the architecture-advisor", () => {
  const { api, posted } = fakeApi(fullRoutes([verdictComment("leo", "test-hunter")]));
  inCheckout({ "0003-src.md": adrMd(3, "src/") }, () => main({ REPO: "o/r", EVENT_NAME: "pull_request_target", PR_NUMBER: "5" }, api));
  assert.equal(descriptionOf(posted[0]), WAIT_ADVISOR);
});

test("main ignores an ADR the PR itself adds: it is not on the default branch yet", () => {
  const routes = fullRoutes([verdictComment("leo", "test-hunter")]);
  routes["repos/o/r/pulls/5/files"] = "docs/adr/0003-src.md\nsrc/a.ts\n";
  const { api, posted } = fakeApi(routes);
  inCheckout({}, () => main({ REPO: "o/r", EVENT_NAME: "pull_request_target", PR_NUMBER: "5" }, api));
  assert.equal(descriptionOf(posted[0]), "unattended-eligible (tier:full), reviews in");
});

// #25: reuse a test-hunter success from an earlier commit when the PR's own diff is unchanged
const OLD = "e".repeat(40);
const MID = "f".repeat(40);
const FIRST = "1".repeat(40);
const ownDiff = (index, hunk, line = "+y") => `diff --git a/src/a.ts b/src/a.ts\nindex ${index}..9999999 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ ${hunk} @@\n-x\n${line}\n`;
const statusesRoute = (sha) => `repos/o/r/commits/${sha}/statuses?per_page=100`;
const compareRoute = (sha) => `repos/o/r/compare/main...${sha}`;
const WAIT_HUNTER = "waiting for review/test-hunter";
// A full PR at head SHA whose test-hunter reviewed OLD; since then main was merged in, moving the diff's line numbers.
function reuseRoutes({ tier = "full", headDiff = ownDiff("2222222", "-40,1 +41,1"), oldStatuses = [{ ...reviewStatus }], commits = [FIRST, OLD, SHA], comments } = {}) {
  const routes = {
    ...fullRoutes(comments ?? [verdictComment("leo", "test-hunter", OLD)]),
    "repos/o/r/pulls/5": { state: "open", body: readyBody, head: { sha: SHA, ref: "issue-7-add-thing" }, base: { ref: "main", sha: "0".repeat(40) } },
    "repos/o/r/issues/7": { state: "open", body: issueBody, user: { login: "leo" }, labels: [{ name: `tier:${tier}` }, { name: "ready" }] },
    "repos/o/r/pulls/5/commits": commits.join("\n") + "\n",
    [statusesRoute(SHA)]: [],
    [statusesRoute(OLD)]: oldStatuses,
    [statusesRoute(MID)]: [],
    [statusesRoute(FIRST)]: [],
    [compareRoute(OLD)]: ownDiff("1111111", "-1,1 +1,1"),
  };
  if (headDiff !== null) routes[compareRoute(SHA)] = headDiff;
  return routes;
}
const REUSED = `unattended-eligible (tier:full), reviews in, test-hunter reused from ${OLD.slice(0, 7)}`;

test("evaluatePr reuses a test-hunter success after a merge from main that left the PR's own diff unchanged", () => {
  const { api, posted } = fakeApi(reuseRoutes());
  const d = evaluatePr(api, "o/r", 5, config);
  assert.equal(d.state, "success");
  assert.equal(d.description, REUSED);
  assert.equal(descriptionOf(posted[0]), REUSED);
});

test("evaluatePr fetches each commit's own diff from the three-dot compare API with the diff media type", () => {
  const { api } = fakeApi(reuseRoutes());
  const calls = [];
  evaluatePr((a) => (calls.push(a), api(a)), "o/r", 5, config);
  const compares = calls.filter((a) => a[0].startsWith("repos/o/r/compare/"));
  assert.deepEqual(compares.map((a) => a[0]).sort(), [compareRoute(OLD), compareRoute(SHA)].sort());
  for (const a of compares) assert.ok(a.includes("Accept: application/vnd.github.diff"), a.join(" "));
});

test("evaluatePr does not reuse when the PR's own diff changed", () => {
  const { api } = fakeApi(reuseRoutes({ headDiff: ownDiff("2222222", "-40,1 +41,1", "+z") }));
  assert.equal(evaluatePr(api, "o/r", 5, config).description, WAIT_HUNTER);
});

test("evaluatePr does not reuse a failure or a pending on the reviewed commit", () => {
  for (const state of ["failure", "pending", "error"]) {
    const { api } = fakeApi(reuseRoutes({ oldStatuses: [{ ...reviewStatus, state }] }));
    assert.equal(evaluatePr(api, "o/r", 5, config).description, WAIT_HUNTER, state);
  }
});

test("evaluatePr does not reuse an older success when a newer commit's test-hunter failed", () => {
  const routes = reuseRoutes({ commits: [OLD, MID, SHA] });
  routes[statusesRoute(MID)] = [{ ...reviewStatus, state: "failure" }];
  routes[compareRoute(MID)] = routes[compareRoute(OLD)];
  const { api } = fakeApi(routes);
  assert.equal(evaluatePr(api, "o/r", 5, config).description, WAIT_HUNTER);
});

test("evaluatePr never reuses a bot-posted success", () => {
  const bot = { ...reviewStatus, creator: { type: "Bot", login: "github-actions[bot]" } };
  const { api } = fakeApi(reuseRoutes({ oldStatuses: [bot] }));
  assert.equal(evaluatePr(api, "o/r", 5, config).description, WAIT_HUNTER);
});

test("evaluatePr lets any trusted test-hunter status on the head win over reuse, without fetching diffs", () => {
  const routes = reuseRoutes();
  routes[statusesRoute(SHA)] = [{ ...reviewStatus, state: "failure" }];
  const { api } = fakeApi(routes);
  const calls = [];
  const d = evaluatePr((a) => (calls.push(a[0]), api(a)), "o/r", 5, config);
  assert.equal(d.description, "review/test-hunter is failure");
  assert.ok(!calls.some((c) => c.startsWith("repos/o/r/compare/") || c === "repos/o/r/pulls/5/commits"));
});

test("evaluatePr does not reuse when a diff cannot be fetched", () => {
  const { api } = fakeApi(reuseRoutes({ headDiff: null })); // no route: the API call throws
  assert.equal(evaluatePr(api, "o/r", 5, config).description, WAIT_HUNTER);
});

test("carry passes the merge queue on a reused test-hunter verdict", () => {
  const group = "b".repeat(40);
  const { api, posted } = fakeApi(reuseRoutes());
  const d = carry(api, "o/r", `gh-readonly-queue/main/pr-5-${"c".repeat(40)}`, group, config);
  assert.equal(d.state, "success");
  assert.equal(d.description, REUSED);
  assert.equal(posted[0].sha, group);
});

test("evaluatePr reuses only review/test-hunter, never another reviewer or the owner", () => {
  const ui = compileConfig({ requiredChecks: ["verify"], paths: { skip: ["^docs/"], contract: [], sensitive: [], ui: ["^src/"] } });
  const others = [{ ...reviewStatus }, { ...reviewStatus, context: "review/ui-reviewer" }, { ...reviewStatus, context: "review/owner" }];
  const { api } = fakeApi(reuseRoutes({ oldStatuses: others, comments: [verdictComment("leo", "test-hunter", OLD), verdictComment("leo", "ui-reviewer", OLD)] }));
  assert.equal(evaluatePr(api, "o/r", 5, ui).description, "waiting for review/ui-reviewer");
  const { api: api2 } = fakeApi(reuseRoutes({ oldStatuses: others }));
  assert.equal(evaluatePr(api2, "o/r", 5, config).description, REUSED); // the old review/owner is not an approval
});

test("edge: a reused full-tier status still needs the test-hunter's verdict comment bound to the reused commit", () => {
  const { api } = fakeApi(reuseRoutes({ comments: [verdictComment("leo", "test-hunter", FIRST)] }));
  const d = evaluatePr(api, "o/r", 5, config);
  assert.equal(d.state, "pending");
  assert.match(d.description, /no verdict for head from test-hunter/);
});

test("edge: a quick-tier PR passes on a reused status alone", () => {
  const { api } = fakeApi(reuseRoutes({ tier: "quick", comments: [] }));
  assert.equal(evaluatePr(api, "o/r", 5, config).description, `unattended-eligible (tier:quick), reviews in, test-hunter reused from ${OLD.slice(0, 7)}`);
});

test("edge: a skip-tier PR never looks for a reusable verdict", () => {
  const routes = reuseRoutes({ tier: "skip" });
  routes["repos/o/r/pulls/5/files"] = "docs/a.md\n";
  const { api } = fakeApi(routes);
  const calls = [];
  assert.equal(evaluatePr((a) => (calls.push(a[0]), api(a)), "o/r", 5, config).state, "success");
  assert.ok(!calls.includes("repos/o/r/pulls/5/commits"));
});

test("edge: the walk stops after the 20 newest commits", () => {
  const filler = Array.from({ length: 19 }, (_, i) => (i + 2).toString(16).padStart(2, "0").repeat(20));
  const routes = reuseRoutes({ commits: [OLD, ...filler, SHA] });
  for (const sha of filler) routes[statusesRoute(sha)] = [];
  const { api } = fakeApi(routes);
  assert.equal(evaluatePr(api, "o/r", 5, config).description, WAIT_HUNTER);
  const { api: api2 } = fakeApi({ ...routes, "repos/o/r/pulls/5/commits": [OLD, ...filler.slice(1), SHA].join("\n") });
  assert.equal(evaluatePr(api2, "o/r", 5, config).description, REUSED);
});

test("edge: no reuse when the commit list cannot be read or does not end at the head", () => {
  const unreadable = reuseRoutes();
  delete unreadable["repos/o/r/pulls/5/commits"];
  const stale = reuseRoutes({ commits: [FIRST, OLD] });
  for (const routes of [unreadable, stale]) {
    const { api } = fakeApi(routes);
    assert.equal(evaluatePr(api, "o/r", 5, config).description, WAIT_HUNTER);
  }
});

test("edge: no reuse when both own diffs are empty, or the base ref is missing or malformed", () => {
  const empty = reuseRoutes({ headDiff: "" });
  empty[compareRoute(OLD)] = "";
  const noBase = reuseRoutes();
  noBase["repos/o/r/pulls/5"] = { ...noBase["repos/o/r/pulls/5"], base: undefined };
  const dotted = reuseRoutes();
  dotted["repos/o/r/pulls/5"] = { ...dotted["repos/o/r/pulls/5"], base: { ref: "main..evil" } };
  for (const routes of [empty, noBase, dotted]) {
    const { api } = fakeApi(routes);
    assert.equal(evaluatePr(api, "o/r", 5, config).description, WAIT_HUNTER);
  }
});

// #36: the gate waits while the linked issue's "Blocked by" names an open issue.
const blockedIssue = (blockedBy) => ({ ...readyIssue("leo"), body: `### Goal\n\ng\n\n### Blocked by\n\n${blockedBy}\n` });
const blockerRoutes = (blockedBy, states) => ({
  ...writeAccessRoutes("leo"),
  "repos/o/r/issues/7": blockedIssue(blockedBy),
  ...Object.fromEntries(Object.entries(states).map(([n, state]) => [`repos/o/r/issues/${n}`, { state }])),
});

test("evaluatePr with no blockers passes as before", () => {
  const { api } = fakeApi(blockerRoutes("none", {}));
  assert.equal(evaluatePr(api, "o/r", 5, config).state, "success");
});

test("evaluatePr waits while a blocker is open, reading each blocker once", () => {
  const { api, posted } = fakeApi(blockerRoutes("#3, #4", { 3: "open", 4: "closed" }));
  const calls = [];
  const d = evaluatePr((args) => (calls.push(args[0]), api(args)), "o/r", 5, config);
  assert.deepEqual(d, { state: "pending", description: "waiting for blocker #3 (open)", stage: "blocked" });
  assert.ok(posted[0].fields.includes("state=pending"));
  assert.equal(calls.filter((c) => c === "repos/o/r/issues/3").length, 1);
  assert.equal(calls.filter((c) => c === "repos/o/r/issues/4").length, 1);
});

test("evaluatePr passes when every blocker is closed", () => {
  const { api } = fakeApi(blockerRoutes("#3\n#4", { 3: "closed", 4: "closed" }));
  assert.equal(evaluatePr(api, "o/r", 5, config).state, "success");
});

test("evaluatePr fails closed on an unreadable or nonexistent blocker", () => {
  const { api } = fakeApi(blockerRoutes("#3, #9", { 3: "closed" })); // no route for #9: the read throws
  assert.deepEqual(evaluatePr(api, "o/r", 5, config), { state: "failure", description: "cannot check blockers of #7: #9 unreadable", stage: "blocked" });
});

test("carry fails a queue entry whose PR has an open blocker", () => {
  const group = "b".repeat(40);
  const { api, posted } = fakeApi(blockerRoutes("#3", { 3: "open" }));
  const d = carry(api, "o/r", `gh-readonly-queue/main/pr-5-${"c".repeat(40)}`, group, config);
  assert.deepEqual(d, { state: "failure", description: "waiting for blocker #3 (open)" });
  assert.equal(posted[0].sha, group);
  assert.ok(posted[0].fields.includes("state=failure"));
});

// Not named in the issue's acceptance criteria or its listed edge cases: carry must fail closed the same way for an
// unreadable blocker as it does for an open one, not just for evaluatePr's own PR-head decision.
test("carry fails a queue entry whose PR has an unreadable blocker, not just an open one", () => {
  const group = "b".repeat(40);
  const { api, posted } = fakeApi(blockerRoutes("#3, #9", { 3: "closed" })); // no route for #9: the read throws
  const d = carry(api, "o/r", `gh-readonly-queue/main/pr-5-${"c".repeat(40)}`, group, config);
  assert.deepEqual(d, { state: "failure", description: "cannot check blockers of #7: #9 unreadable" });
  assert.equal(posted[0].sha, group);
  assert.ok(posted[0].fields.includes("state=failure"));
});

test("edge: a blocker with an unexpected state counts as unreadable", () => {
  const { api } = fakeApi(blockerRoutes("#3", { 3: "weird" }));
  assert.equal(evaluatePr(api, "o/r", 5, config).description, "cannot check blockers of #7: #3 unreadable");
});

test("edge: an issue without a readable Blocked by field fails closed", () => {
  for (const issueBody of [undefined, "### Goal\n\ng\n", "### Blocked by\n\nsoon\n"]) {
    const { api } = fakeApi({ ...writeAccessRoutes("leo"), "repos/o/r/issues/7": { ...readyIssue("leo"), body: issueBody } });
    const d = evaluatePr(api, "o/r", 5, config);
    assert.equal(d.state, "failure", String(issueBody));
    assert.match(d.description, /^cannot check blockers of #7: blocked by|^cannot check blockers of #7: missing: blocked by/, String(issueBody));
  }
});

test("edge: a repeated blocker is read once", () => {
  const { api } = fakeApi(blockerRoutes("#3, #3", { 3: "open" }));
  const calls = [];
  evaluatePr((args) => (calls.push(args[0]), api(args)), "o/r", 5, config);
  assert.equal(calls.filter((c) => c === "repos/o/r/issues/3").length, 1);
});

// #36 security round 2: a stranger's issue must not make the gate read its blockers (one API call each, on every
// pull_request_target run), and no issue may list more blockers than the cap.
const blockerReads = (calls) => calls.filter((c) => /^repos\/o\/r\/issues\/(?!7$)\d+$/.test(c));
const many = (n) => Array.from({ length: n }, (_, i) => `#${100 + i}`).join(", ");

test("edge: blockers are not read for an untrusted linked issue", () => {
  const untrusted = [
    { ...blockedIssue(many(50)), user: { login: "stranger" } }, // no write access: the permission lookup throws
    { ...blockedIssue(many(50)), labels: [{ name: "tier:skip" }] }, // not ready
    { ...blockedIssue(many(50)), state: "closed" },
    { ...blockedIssue(many(50)), pull_request: { url: "x" } },
  ];
  for (const issue of untrusted) {
    const { api } = fakeApi({ ...writeAccessRoutes("leo"), "repos/o/r/issues/7": issue });
    const calls = [];
    const d = evaluatePr((args) => (calls.push(args[0]), api(args)), "o/r", 5, config);
    assert.equal(d.state, "failure", JSON.stringify(issue.labels));
    assert.deepEqual(blockerReads(calls), [], JSON.stringify(issue.labels));
  }
});

test("edge: more blockers than the cap fail closed without reading any", () => {
  const { api } = fakeApi({ ...writeAccessRoutes("leo"), "repos/o/r/issues/7": blockedIssue(many(21)) });
  const calls = [];
  const d = evaluatePr((args) => (calls.push(args[0]), api(args)), "o/r", 5, config);
  assert.deepEqual(d, { state: "failure", description: "cannot check blockers of #7: more than 20 blockers", stage: "blocked" });
  assert.deepEqual(blockerReads(calls), []);
});

test("edge: exactly the cap of blockers is read", () => {
  const states = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [100 + i, "closed"]));
  const { api } = fakeApi(blockerRoutes(many(20), states));
  assert.equal(evaluatePr(api, "o/r", 5, config).state, "success");
});

// #36: closing an issue re-evaluates the open PRs whose linked issue lists it in "Blocked by", and only those.
const OPEN_PRS = "repos/o/r/pulls?state=open&per_page=100";
const prLine = (number, closes) => JSON.stringify({ number, body: `Closes #${closes}\n## What changed\nx` });

test("main on an issues event re-evaluates only the PRs whose issue lists the closed one", () => {
  const sha = (c) => c.repeat(40);
  const prRoute = (n, closes, c) => ({ state: "open", body: okBody.replace("#7", `#${closes}`), head: { sha: sha(c), ref: `issue-${closes}-x` } });
  const issue = (blockedBy) => ({ ...readyIssue("leo"), body: `### Blocked by\n\n${blockedBy}\n` });
  const { api, posted } = fakeApi({
    [OPEN_PRS]: [prLine(5, 7), prLine(6, 8), prLine(10, 11), JSON.stringify({ number: 12, body: "no closes line" })].join("\n") + "\n",
    "repos/o/r/issues/7": issue("#3"),
    "repos/o/r/issues/8": issue("none"),
    "repos/o/r/issues/11": issue("#4, #3"),
    "repos/o/r/issues/3": { state: "closed" },
    "repos/o/r/issues/4": { state: "open" },
    "repos/o/r/pulls/5": prRoute(5, 7, "d"),
    "repos/o/r/pulls/5/files": "docs/a.md\n",
    [`repos/o/r/commits/${sha("d")}/statuses?per_page=100`]: [],
    "repos/o/r/pulls/10": prRoute(10, 11, "e"),
    "repos/o/r/pulls/10/files": "docs/a.md\n",
    [`repos/o/r/commits/${sha("e")}/statuses?per_page=100`]: [],
  });
  main({ REPO: "o/r", EVENT_NAME: "issues", ISSUE_NUMBER: "3" }, api);
  assert.deepEqual(posted.map((p) => [p.sha, p.fields.find((f) => f.startsWith("state="))]), [
    [sha("d"), "state=success"],
    [sha("e"), "state=pending"],
  ]);
});

test("main on an issues event lists open PRs with pagination, one JSON line each", () => {
  const calls = [];
  const api = (args) => (calls.push(args), "");
  main({ REPO: "o/r", EVENT_NAME: "issues", ISSUE_NUMBER: "3" }, api);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], OPEN_PRS);
  assert.ok(calls[0].includes("--paginate"));
  assert.ok(calls[0].includes("--jq"));
});

test("edge: an issues event with a malformed issue number is rejected without calling the API", () => {
  for (const n of [undefined, "", "0", "3; rm", "-1"]) {
    assert.throws(() => main({ REPO: "o/r", EVENT_NAME: "issues", ISSUE_NUMBER: n }, () => assert.fail("api called")), /ISSUE_NUMBER/, String(n));
  }
});

test("edge: an issues event skips a PR whose issue cannot be read, and reads each issue once", () => {
  const calls = [];
  const { api, posted } = fakeApi({ [OPEN_PRS]: [prLine(5, 7), prLine(6, 7), prLine(9, 99)].join("\n") + "\n", "repos/o/r/issues/7": blockedIssue("none") });
  main({ REPO: "o/r", EVENT_NAME: "issues", ISSUE_NUMBER: "3" }, (args) => (calls.push(args[0]), api(args)));
  assert.equal(posted.length, 0);
  assert.equal(calls.filter((c) => c === "repos/o/r/issues/7").length, 1);
});

// Not named in the issue's acceptance criteria or its listed edge cases: a malformed "Blocked by" field (as opposed
// to an issue the API cannot read at all) must also be skipped during re-evaluation, without ever touching the PR
// itself. Its own next gate run still fails closed on the malformed field (see gate-decision.test.mjs).
test("edge: an issues event skips a PR whose issue's Blocked by field is malformed, without evaluating the PR", () => {
  const calls = [];
  const { api, posted } = fakeApi({
    [OPEN_PRS]: [prLine(5, 7)].join("\n") + "\n",
    "repos/o/r/issues/7": { ...readyIssue("leo"), body: "### Goal\n\ng\n" }, // no "Blocked by" heading at all
  });
  main({ REPO: "o/r", EVENT_NAME: "issues", ISSUE_NUMBER: "3" }, (args) => (calls.push(args[0]), api(args)));
  assert.equal(posted.length, 0);
  assert.ok(!calls.includes("repos/o/r/pulls/5"), "the PR itself must never be fetched for a skipped entry");
});
