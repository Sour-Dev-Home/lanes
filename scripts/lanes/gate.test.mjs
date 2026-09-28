import { test } from "node:test";
import assert from "node:assert/strict";
import { carry, evaluatePr, main, noteOwnerApproval } from "./gate.mjs";
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

// #241: a file an accepted ADR governs no longer requires the advisor on its own; a change under docs/adr/ does.
test("evaluatePr and carry need no architecture-advisor for a file an accepted ADR only governs", () => {
  const adrs = [parseAdr(adrMd(3, "src/"))];
  const { api } = fakeApi(fullRoutes([verdictComment("leo", "test-hunter")]));
  assert.equal(evaluatePr(api, "o/r", 5, config, adrs).state, "success");
});

test("evaluatePr and carry require the architecture-advisor for an ADR change", () => {
  const adrs = [parseAdr(adrMd(3, "src/"))];
  const routes = fullRoutes([verdictComment("leo", "test-hunter")]);
  routes["repos/o/r/pulls/5/files"] = "docs/adr/0003-src.md\nsrc/a.ts\n";
  const { api, posted } = fakeApi(routes);
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

test("main loads the default branch's ADRs: a governed file alone no longer waits for the architecture-advisor", () => {
  const { api, posted } = fakeApi(fullRoutes([verdictComment("leo", "test-hunter")]));
  inCheckout({ "0003-src.md": adrMd(3, "src/") }, () => main({ REPO: "o/r", EVENT_NAME: "pull_request_target", PR_NUMBER: "5" }, api));
  assert.equal(descriptionOf(posted[0]), "unattended-eligible (tier:full), reviews in");
});

test("main requires the advisor for an ADR the PR itself adds, though it is not on the default branch yet", () => {
  const routes = fullRoutes([verdictComment("leo", "test-hunter")]);
  routes["repos/o/r/pulls/5/files"] = "docs/adr/0003-src.md\nsrc/a.ts\n";
  const { api, posted } = fakeApi(routes);
  inCheckout({}, () => main({ REPO: "o/r", EVENT_NAME: "pull_request_target", PR_NUMBER: "5" }, api));
  assert.equal(descriptionOf(posted[0]), WAIT_ADVISOR);
});

// #241 (from #250): the gate passes the linked issue's Interface contract to the reviewer rule.
const withContract = (contract) => {
  const routes = fullRoutes([verdictComment("leo", "test-hunter")]);
  routes["repos/o/r/issues/7"] = { ...routes["repos/o/r/issues/7"], body: `### Goal\n\ng\n\n### Interface contract\n\n${contract}\n\n### Blocked by\n\nnone\n` };
  return routes;
};

test("evaluatePr waits for the architecture-advisor when the issue's Interface contract names a changed path", () => {
  const { api, posted } = fakeApi(withContract("`src/a.ts` exports `f(x)`"));
  assert.equal(evaluatePr(api, "o/r", 5, config).description, WAIT_ADVISOR);
  assert.ok(posted[0].fields.includes("state=pending"));
});

test("evaluatePr needs no advisor when the Interface contract is none", () => {
  const { api } = fakeApi(withContract("none"));
  assert.equal(evaluatePr(api, "o/r", 5, config).description, "unattended-eligible (tier:full), reviews in");
});

test("edge: an Interface contract naming a path the PR does not change needs no advisor", () => {
  const { api } = fakeApi(withContract("`src/b.ts` exports `g`"));
  assert.equal(evaluatePr(api, "o/r", 5, config).state, "success");
});

test("edge: carry re-decides with the Interface contract too", () => {
  const { api } = fakeApi(withContract("`src/a.ts`"));
  const d = carry(api, "o/r", `gh-readonly-queue/main/pr-5-${"c".repeat(40)}`, "b".repeat(40), config);
  assert.deepEqual(d, { state: "failure", description: WAIT_ADVISOR });
});

test("edge: an issue body that is missing or not a string names no path (the blocker check still fails it closed)", () => {
  for (const body of [null, undefined, 42]) {
    const routes = fullRoutes([verdictComment("leo", "test-hunter")]);
    routes["repos/o/r/issues/7"] = { ...routes["repos/o/r/issues/7"], body };
    const d = evaluatePr(fakeApi(routes).api, "o/r", 5, config);
    assert.notEqual(d.description, WAIT_ADVISOR, String(body));
    assert.notEqual(d.state, "success", String(body));
  }
});

// #25: reuse a test-hunter success from an earlier commit when the PR's own diff is unchanged
const OLD = "e".repeat(40);
const MID = "f".repeat(40);
const FIRST = "1".repeat(40);
const ownDiff = (index, hunk, line = "+y") => `diff --git a/src/a.ts b/src/a.ts\nindex ${index}..9999999 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ ${hunk} @@\n-x\n${line}\n`;
const statusesRoute = (sha) => `repos/o/r/commits/${sha}/statuses?per_page=100`;
const compareRoute = (sha) => `repos/o/r/compare/main...${sha}`;
const sinceRoute = (sha) => `repos/o/r/compare/${sha}...${SHA}`;
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
    [compareRoute(MID)]: ownDiff("1111111", "-1,1 +1,1"),
    // #154: what changed between each reviewed commit and the head (the merge from main), count first.
    [sinceRoute(OLD)]: "1\nsrc/other.ts\n",
    [sinceRoute(MID)]: "1\nsrc/other.ts\n",
  };
  if (headDiff !== null) routes[compareRoute(SHA)] = headDiff;
  return routes;
}
const REUSED = `unattended-eligible (tier:full), reviews in, reused test-hunter from ${OLD.slice(0, 7)}`;

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
  const compares = calls.filter((a) => a[0].startsWith("repos/o/r/compare/main..."));
  assert.deepEqual(compares.map((a) => a[0]).sort(), [compareRoute(OLD), compareRoute(SHA)].sort());
  for (const a of compares) assert.ok(a.includes("Accept: application/vnd.github.diff"), a.join(" "));
  // #154: plus one list of the files changed between the reviewed commit and the head.
  assert.deepEqual(calls.filter((a) => a[0] === sinceRoute(OLD)).length, 1);
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
  assert.equal(evaluatePr(api, "o/r", 5, config).description, `unattended-eligible (tier:quick), reviews in, reused test-hunter from ${OLD.slice(0, 7)}`);
});

// #154: the same reuse for the security-reviewer and the architecture-advisor
const secArch = compileConfig({ requiredChecks: ["verify"], paths: { skip: ["^docs/"], contract: [], sensitive: ["^src/"], ui: [] } });
const srcAdrs = [parseAdr("# 0003: src\n\nStatus: accepted\n\n## Governs\n\n- src/\n")];
const THREE = ["test-hunter", "security-reviewer", "architecture-advisor"];
const at = (sha, names) => names.map((n) => ({ ...reviewStatus, context: `review/${n}` }));
// `reusedNames` were reviewed at OLD only; every other required reviewer reviewed the head.
function threeRoutes(reusedNames, over = {}) {
  const onHead = THREE.filter((n) => !reusedNames.includes(n));
  const routes = reuseRoutes({
    oldStatuses: at(OLD, THREE),
    comments: [...THREE.map((n) => verdictComment("leo", n, OLD)), ...onHead.map((n) => verdictComment("leo", n, SHA))],
    ...over,
  });
  routes[statusesRoute(SHA)] = at(SHA, onHead);
  // #241: srcAdrs governing src/a.ts no longer requires the advisor; the PR's own ADR change does.
  routes["repos/o/r/pulls/5/files"] = "src/a.ts\ndocs/adr/0005-new.md\n";
  return routes;
}
const decide = (routes) => evaluatePr(fakeApi(routes).api, "o/r", 5, secArch, srcAdrs);
const reusedNote = (...names) => `unattended-eligible (tier:full), reviews in, reused ${names.join("+")} from ${OLD.slice(0, 7)}`;

test("evaluatePr reuses a security-reviewer or architecture-advisor success after a merge from main, each on its own", () => {
  for (const name of ["security-reviewer", "architecture-advisor"]) {
    const d = decide(threeRoutes([name]));
    assert.equal(d.state, "success", name);
    assert.equal(d.description, reusedNote(name));
  }
  assert.equal(decide(threeRoutes(THREE)).description, reusedNote(...THREE));
});

test("evaluatePr reuses none of them when the PR's own diff changed", () => {
  for (const name of ["security-reviewer", "architecture-advisor"]) {
    assert.equal(decide(threeRoutes([name], { headDiff: ownDiff("2222222", "-40,1 +41,1", "+z") })).description, `waiting for review/${name}`);
  }
});

test("evaluatePr does not reuse a review after its brief, its checklist or a governing ADR changed since", () => {
  const cases = [
    ["test-hunter", ".claude/agents/test-hunter.md"],
    ["security-reviewer", ".claude/agents/security-reviewer.md"],
    ["security-reviewer", "vendor/agent-skills/references/security-checklist.md"],
    ["security-reviewer", "vendor/owasp-cheatsheets/Injection_Prevention_Cheat_Sheet.md"],
    ["architecture-advisor", ".claude/agents/architecture-advisor.md"],
    ["architecture-advisor", "docs/adr/0003-src.md"],
  ];
  for (const [name, file] of cases) {
    const routes = threeRoutes([name]);
    routes[sinceRoute(OLD)] = `2\nsrc/other.ts\n${file}\n`;
    assert.equal(decide(routes).description, `waiting for review/${name}`, file);
  }
  // Only the reviewer whose inputs changed loses its reuse: the others still carry over.
  const routes = threeRoutes(THREE);
  routes[sinceRoute(OLD)] = "1\nvendor/agent-skills/references/security-checklist.md\n";
  const d = decide(routes);
  assert.equal(d.description, "waiting for review/security-reviewer");
});

test("evaluatePr reuses the architecture-advisor across an ADR that does not govern the PR's files", () => {
  const routes = threeRoutes(["architecture-advisor"]);
  routes[sinceRoute(OLD)] = "2\ndocs/adr/0004-other.md\n.claude/agents/ui-reviewer.md\n";
  assert.equal(decide(routes).description, reusedNote("architecture-advisor"));
});

test("evaluatePr never reuses a security-reviewer or architecture-advisor failure", () => {
  for (const name of ["security-reviewer", "architecture-advisor"]) {
    for (const state of ["failure", "pending", "error"]) {
      const routes = threeRoutes([name]);
      routes[statusesRoute(OLD)] = at(OLD, THREE).map((s) => (s.context === `review/${name}` ? { ...s, state } : s));
      assert.equal(decide(routes).description, `waiting for review/${name}`, `${name} ${state}`);
    }
  }
});

test("edge: a failure verdict comment on the reused commit still waits on the owner", () => {
  const failed = verdictComment("leo", "security-reviewer", OLD);
  failed.body = failed.body.replace('"verdict": "success"', '"verdict": "failure"');
  assert.match(failed.body, /"verdict": "failure"/);
  const routes = threeRoutes(["security-reviewer"], { comments: [failed, ...["test-hunter", "architecture-advisor"].map((n) => verdictComment("leo", n, SHA))] });
  const d = decide(routes);
  assert.equal(d.state, "pending");
  assert.match(d.description, /^waiting on owner \(\/approve\) \(verdict from security-reviewer is not success\), reused security-reviewer from eeeeeee$/);
});

test("edge: no reuse when the files changed since the review cannot be listed, or the list may be cut short", () => {
  for (const since of [undefined, "", "x\nsrc/a.ts\n", "300\nsrc/a.ts\n", "-1\n"]) {
    const routes = threeRoutes(["security-reviewer"]);
    if (since === undefined) delete routes[sinceRoute(OLD)];
    else routes[sinceRoute(OLD)] = since;
    assert.equal(decide(routes).description, "waiting for review/security-reviewer", JSON.stringify(since));
  }
  const edge = threeRoutes(["security-reviewer"]);
  edge[sinceRoute(OLD)] = "299\nsrc/a.ts\n";
  assert.equal(decide(edge).description, reusedNote("security-reviewer"));
});

test("edge: each commit's diff, statuses and changed files are read once, however many reviewers reuse it", () => {
  const { api } = fakeApi(threeRoutes(THREE));
  const calls = [];
  evaluatePr((a) => (calls.push(a[0]), api(a)), "o/r", 5, secArch, srcAdrs);
  for (const route of [compareRoute(OLD), compareRoute(SHA), sinceRoute(OLD), statusesRoute(OLD)]) {
    assert.equal(calls.filter((c) => c === route).length, 1, route);
  }
});

test("edge: a reviewer the head already has a status for is never looked up on older commits", () => {
  const routes = threeRoutes(["security-reviewer"]);
  const { api } = fakeApi(routes);
  const calls = [];
  const d = evaluatePr((a) => (calls.push(a), api(a)), "o/r", 5, secArch, srcAdrs);
  assert.equal(d.description, reusedNote("security-reviewer"));
  // One reviewer to reuse, so the head's own diff and the reviewed commit's diff: two compares, not six.
  assert.equal(calls.filter((a) => a[0].startsWith("repos/o/r/compare/main...")).length, 2);
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

// Not named in the issue's acceptance criteria or its listed edge cases: the cap counts distinct blockers, so a
// list that names 20 issues twice each (40 raw mentions) must still be read, not rejected as "more than 20".
test("edge: a blocker repeated past the cap in raw mentions still passes, since only distinct blockers count", () => {
  const distinct = Array.from({ length: 20 }, (_, i) => `#${100 + i}`);
  const states = Object.fromEntries(distinct.map((b) => [Number(b.slice(1)), "closed"]));
  const { api } = fakeApi(blockerRoutes([...distinct, ...distinct].join(", "), states));
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

// #82 (ADR 0004): an owner approval on a PR head is announced by a PR comment, whatever route posted the status.
const OWNER = "review/owner";
const STATUS_PULLS = `repos/o/r/commits/${SHA}/pulls`;
const COMMENTS_5 = "repos/o/r/issues/5/comments";
const GATE_BOT = "github-actions[bot]";
const MARKER = `<!-- lanes:owner-approval ${SHA} -->`;
const statusRoutes = (pulls = [{ number: 5, state: "open", head: { sha: SHA } }]) => ({
  [STATUS_PULLS]: pulls,
  "repos/o/r/pulls/5": { state: "open", body, head: { sha: SHA } },
  "repos/o/r/pulls/5/files": "src/a.ts\n",
  "repos/o/r/issues/7": { labels: [{ name: "tier:skip" }] },
  [`repos/o/r/commits/${SHA}/statuses?per_page=100`]: [],
});

// The comments route is stateful: a comment the gate posts is listed on the next read, as on GitHub.
function commentingApi(routes, existing = []) {
  const { api, posted } = fakeApi(routes);
  const listed = [...existing];
  const comments = [];
  const wrapped = (args) => {
    if (args[0].endsWith("/comments") && args.includes("-f")) {
      const text = args[args.indexOf("-f") + 1].slice("body=".length);
      comments.push({ path: args[0], body: text });
      listed.push({ login: GATE_BOT, body: text });
      return "{}";
    }
    if (args[0] === COMMENTS_5) return listed.map((c) => JSON.stringify(c)).join("\n") + "\n";
    return api(args);
  };
  return { api: wrapped, posted, comments };
}

const statusEvent = (context, state) => ({ REPO: "o/r", EVENT_NAME: "status", STATUS_SHA: SHA, STATUS_CONTEXT: context, STATUS_STATE: state });

test("an owner success status comments once on the PR, with the sha7, UTC time and marker, then re-evaluates the gate", () => {
  const { api, posted, comments } = commentingApi(statusRoutes());
  main(statusEvent(OWNER, "success"), api);
  assert.equal(comments.length, 1);
  assert.equal(comments[0].path, COMMENTS_5);
  assert.match(
    comments[0].body,
    new RegExp(`^Owner approval recorded for ${SHA.slice(0, 7)} at \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2} UTC\\. If you didn't approve this, dismiss the review/owner status and report it\\.`),
  );
  assert.ok(comments[0].body.includes(MARKER));
  assert.equal(posted.length, 1, "the gate is still re-evaluated on the PR head");
  assert.equal(posted[0].sha, SHA);
});

test("a repeat owner success event for the same SHA posts no second comment but still re-evaluates", () => {
  const { api, posted, comments } = commentingApi(statusRoutes());
  main(statusEvent(OWNER, "success"), api);
  main(statusEvent(OWNER, "success"), api);
  assert.equal(comments.length, 1);
  assert.equal(posted.length, 2);
});

test("a review/test-hunter success posts no comment", () => {
  const { api, posted, comments } = commentingApi(statusRoutes());
  main(statusEvent("review/test-hunter", "success"), api);
  assert.equal(comments.length, 0);
  assert.equal(posted.length, 1);
});

test("an owner failure status posts no comment", () => {
  const { api, posted, comments } = commentingApi(statusRoutes());
  main(statusEvent(OWNER, "failure"), api);
  assert.equal(comments.length, 0);
  assert.equal(posted.length, 1);
});

test("an owner success on a SHA with no open PR posts no comment", () => {
  const { api, posted, comments } = commentingApi(statusRoutes([]));
  main(statusEvent(OWNER, "success"), api);
  assert.equal(comments.length, 0);
  assert.equal(posted.length, 0);
});

test("edge: a closed PR, or an open PR whose head moved on, gets no comment", () => {
  const { api, comments } = commentingApi(
    statusRoutes([
      { number: 5, state: "closed", head: { sha: SHA } },
      { number: 6, state: "open", head: { sha: "b".repeat(40) } },
    ]),
  );
  main(statusEvent(OWNER, "success"), api);
  assert.equal(comments.length, 0);
});

test("edge: a missing STATUS_STATE posts no comment", () => {
  const { api, posted, comments } = commentingApi(statusRoutes());
  main({ ...statusEvent(OWNER, "success"), STATUS_STATE: undefined }, api);
  assert.equal(comments.length, 0);
  assert.equal(posted.length, 1);
});

test("edge: an owner pending or error status posts no comment", () => {
  for (const state of ["pending", "error"]) {
    const { api, comments } = commentingApi(statusRoutes());
    main(statusEvent(OWNER, state), api);
    assert.equal(comments.length, 0, state);
  }
});

test("edge: the marker in a comment by anyone but the gate's bot does not suppress the notice", () => {
  const { api, comments } = commentingApi(statusRoutes(), [{ login: "leo", body: `pre-empted ${MARKER}` }]);
  main(statusEvent(OWNER, "success"), api);
  assert.equal(comments.length, 1);
});

test("edge: the gate's marker for a different SHA does not suppress the notice", () => {
  const { api, comments } = commentingApi(statusRoutes(), [{ login: GATE_BOT, body: `<!-- lanes:owner-approval ${"c".repeat(40)} -->` }]);
  main(statusEvent(OWNER, "success"), api);
  assert.equal(comments.length, 1);
});

test("edge: malformed comment lines are skipped, and a bot marker after them still suppresses", () => {
  const { api: inner, comments } = commentingApi(statusRoutes());
  const api = (args) => (args[0] === COMMENTS_5 && !args.includes("-f") ? `not json\n{"login":null}\n${JSON.stringify({ login: GATE_BOT, body: MARKER })}\n` : inner(args));
  main(statusEvent(OWNER, "success"), api);
  assert.equal(comments.length, 0);
});

test("edge: owner success on a SHA with two open PRs comments on each", () => {
  const routes = {
    ...statusRoutes([
      { number: 5, state: "open", head: { sha: SHA } },
      { number: 6, state: "open", head: { sha: SHA } },
    ]),
    "repos/o/r/pulls/6": { state: "open", body, head: { sha: SHA } },
    "repos/o/r/pulls/6/files": "src/a.ts\n",
    "repos/o/r/issues/6/comments": "",
  };
  const { api, posted, comments } = commentingApi(routes);
  main(statusEvent(OWNER, "success"), api);
  assert.deepEqual(comments.map((c) => c.path), [COMMENTS_5, "repos/o/r/issues/6/comments"]);
  assert.equal(posted.length, 2);
});

// Not required by the criteria or a listed edge: case, but noteOwnerApproval's own return-value contract ("Returns
// whether it commented") and its zero-padded date formatting are otherwise only exercised indirectly through main().
test("edge: noteOwnerApproval reports whether it commented, and zero-pads a single-digit month, day, hour and minute", () => {
  const { api, comments } = commentingApi(statusRoutes());
  const now = new Date("2026-01-05T03:04:00Z");
  const first = noteOwnerApproval(api, "o/r", 5, SHA, now);
  assert.equal(first, true);
  assert.equal(
    comments[0].body,
    `Owner approval recorded for ${SHA.slice(0, 7)} at 2026-01-05 03:04 UTC. If you didn't approve this, dismiss the review/owner status and report it.\n\n${MARKER}`,
  );
  const second = noteOwnerApproval(api, "o/r", 5, SHA, now);
  assert.equal(second, false, "a second call for the same PR and SHA must not comment again");
  assert.equal(comments.length, 1);
});

test("edge: an unreadable comment list still re-evaluates the gate, then fails the run naming the PR", () => {
  const { api: inner, posted, comments } = commentingApi(statusRoutes());
  const api = (args) => {
    if (args[0] === COMMENTS_5) throw new Error("HTTP 502");
    return inner(args);
  };
  assert.throws(() => main(statusEvent(OWNER, "success"), api), /owner approval comment failed on #5: HTTP 502/);
  assert.equal(comments.length, 0);
  assert.equal(posted.length, 1, "the gate status is still posted");
});
