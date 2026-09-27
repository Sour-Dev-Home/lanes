import { test } from "node:test";
import assert from "node:assert/strict";
import { carry, evaluatePr, main } from "./gate.mjs";
import { compileConfig } from "./lib.mjs";

const config = compileConfig({ requiredChecks: ["verify"], paths: { skip: ["^docs/"], contract: [], sensitive: [], ui: [] } });
const SHA = "a".repeat(40);
const body = "Closes #7\n## What changed\nx\n## Contract changes\nnone\n## Tests added\nx\n## Reviewer results\nx\n## Needs the owner\nnothing\n## Not done\nnothing";

function fakeApi(routes) {
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

test("evaluatePr wires the linked issue's state and author association, and the PR's head ref, into the gate decision", () => {
  const readyBody = "Closes #7\n## What changed\nx\n## Contract changes\nnone\n## Tests added\nx\n## Reviewer results\nx\n## Needs the owner\nnothing\n## Not done\nnothing";
  const { api, posted } = fakeApi({
    "repos/o/r/pulls/5": { state: "open", body: readyBody, head: { sha: SHA, ref: "issue-7-add-thing" } },
    "repos/o/r/pulls/5/files": "docs/a.md\n",
    "repos/o/r/issues/7": { state: "open", author_association: "OWNER", labels: [{ name: "tier:skip" }, { name: "ready" }] },
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
    "repos/o/r/issues/7": { state: "open", author_association: "NONE", labels: [{ name: "tier:skip" }] },
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
    "repos/o/r/issues/7": { state: "open", author_association: "OWNER", labels: [{ name: "tier:skip" }, { name: "ready" }], pull_request: { url: "https://api.github.com/repos/o/r/pulls/7" } },
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
    "repos/o/r/issues/7": { state: "open", author_association: "OWNER", labels: [{ name: "tier:skip" }, { name: "ready" }] },
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
    "repos/o/r/issues/7": { state: "open", author_association: "OWNER", labels: [{ name: "tier:skip" }, { name: "ready" }] },
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
    "repos/o/r/issues/7": { state: "open", author_association: "OWNER", labels: [{ name: "tier:quick" }, { name: "ready" }] },
    // a forged lanes/gate success is present on the head; carry must not read or trust it.
    [`repos/o/r/commits/${SHA}/statuses?per_page=100`]: [{ context: "lanes/gate", state: "success", created_at: "2026-09-26T10:00:00Z" }],
  });
  const d = carry(api, "o/r", `gh-readonly-queue/main/pr-5-${"c".repeat(40)}`, group, config);
  assert.equal(d.state, "failure");
  assert.equal(posted[0].sha, group);
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
