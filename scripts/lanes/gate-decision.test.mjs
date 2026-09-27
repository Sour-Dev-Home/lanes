import { test } from "node:test";
import assert from "node:assert/strict";
import { compileConfig, gateDecision, isBotStatus } from "./lib.mjs";

const config = compileConfig({
  requiredChecks: ["verify"],
  paths: { skip: ["^docs/", "\\.md$"], contract: ["^contracts/"], sensitive: ["^\\.github/"], ui: ["^frontend/"] },
});
const body = (contract = "none") =>
  `Closes #7\n\n## What changed\nx\n## Contract changes\n${contract}\n## Tests added\nx\n## Reviewer results\nx\n## Needs the owner\nnothing\n## Not done\nnothing\n`;
// A real GitHub status always carries a creator (confirmed live); a human reviewer posting via `gh` is a User, never a Bot.
const st = (context, state = "success", description = "ok", created_at = "2026-09-26T10:00:00Z", creator = { type: "User", login: "leo" }) => ({
  context,
  state,
  description,
  created_at,
  creator,
});
const run = (over) =>
  gateDecision({
    prBody: body(),
    issueLabels: ["tier:quick", "ready"],
    issueState: "open",
    issueAuthorCanWrite: true,
    headRef: "issue-7-x",
    files: ["src/a.ts"],
    statuses: [],
    config,
    ...over,
  });

test("no Closes #N fails", () => {
  assert.equal(run({ prBody: body().replace("Closes #7", "") }).state, "failure");
});

test("missing or double tier label fails", () => {
  assert.match(run({ issueLabels: [] }).description, /tier/);
  assert.equal(run({ issueLabels: ["tier:quick", "tier:full"] }).state, "failure");
});

test("tier:skip with code fails", () => {
  assert.match(run({ issueLabels: ["tier:skip", "ready"] }).description, /skip paths/);
});

test("rename out of code into docs is not skip (old name passed too)", () => {
  assert.equal(run({ issueLabels: ["tier:skip", "ready"], files: ["docs/a.ts", "src/a.ts"] }).state, "failure");
});

test("tier:skip docs-only passes unattended with no reviewers", () => {
  assert.deepEqual(run({ issueLabels: ["tier:skip", "ready"], files: ["docs/a.md"] }), { state: "success", description: "unattended-eligible (tier:skip), reviews in", stage: "ready" });
});

test("contract files with 'none' fails; breaking needs the label", () => {
  assert.match(run({ files: ["contracts/x.ts"] }).description, /says none/);
  assert.match(run({ prBody: body("breaking"), files: ["contracts/x.ts"] }).description, /contract:breaking/);
});

test("quick waits for the test-hunter, then merges unattended", () => {
  assert.deepEqual(run({}).stage, "review");
  assert.equal(run({}).state, "pending");
  assert.equal(run({ statuses: [st("review/test-hunter")] }).state, "success");
});

test("a failing or skipped required review fails", () => {
  assert.equal(run({ statuses: [st("review/test-hunter", "failure")] }).state, "failure");
  assert.match(run({ statuses: [st("review/test-hunter", "success", "skipped: small")] }).description, /cannot be skipped/);
});

test("the newest status per context wins", () => {
  const statuses = [st("review/test-hunter", "failure", "bug", "2026-09-26T09:00:00Z"), st("review/test-hunter", "success", "fixed", "2026-09-26T11:00:00Z")];
  assert.equal(run({ statuses }).state, "success");
});

test("sensitive quick change waits on the owner, then passes with review/owner", () => {
  const files = [".github/workflows/x.yml"];
  const reviews = [st("review/test-hunter"), st("review/security-reviewer")];
  assert.deepEqual(run({ files, statuses: reviews }).stage, "owner");
  assert.equal(run({ files, statuses: [...reviews, st("review/owner")] }).state, "success");
});

test("full tier always waits on the owner", () => {
  assert.equal(run({ issueLabels: ["tier:full", "ready"], statuses: [st("review/test-hunter")] }).stage, "owner");
});

test("a new head without statuses has no owner approval", () => {
  assert.equal(run({ issueLabels: ["tier:full", "ready"], statuses: [] }).stage, "review");
});

// C1: strangers' issues must not reach the unattended merge path
test("an issue not labelled ready fails at the contract stage", () => {
  const d = run({ issueLabels: ["tier:quick"] });
  assert.equal(d.state, "failure");
  assert.match(d.description, /ready/);
  assert.equal(d.stage, "contract");
});

test("a closed linked issue fails", () => {
  const d = run({ issueState: "closed" });
  assert.equal(d.state, "failure");
  assert.match(d.description, /open/);
});

test("an issue author with write access passes the contract stage", () => {
  assert.equal(run({ issueAuthorCanWrite: true }).stage, "review");
});

// Fails closed: only a literal true is trust; an unknown or unread permission is not.
test("an issue author without write access fails the contract stage", () => {
  for (const canWrite of [false, undefined, null, "true", 1]) {
    const d = run({ issueAuthorCanWrite: canWrite });
    assert.equal(d.state, "failure", String(canWrite));
    assert.equal(d.stage, "contract", String(canWrite));
    assert.match(d.description, /write access/, String(canWrite));
  }
});

// I4: a lane must not be able to choose its own tier by pushing to any branch name
test("the PR head branch must match issue-<N>-*", () => {
  const d = run({ headRef: "issue-8-other" });
  assert.equal(d.state, "failure");
  assert.match(d.description, /issue-7-/);
});

test("a missing head ref fails the same way", () => {
  assert.equal(run({ headRef: undefined }).state, "failure");
});

// I3: a PR-added workflow can post statuses with GITHUB_TOKEN; only a human-posted review counts
test("a review status posted by a bot is not trusted", () => {
  const botStatus = { context: "review/test-hunter", state: "success", description: "ok", created_at: "2026-09-26T10:00:00Z", creator: { type: "Bot", login: "github-actions[bot]" } };
  assert.equal(run({ statuses: [botStatus] }).stage, "review");
});

test("a login ending in [bot] is untrusted even without creator.type", () => {
  const s = { context: "review/test-hunter", state: "success", description: "ok", created_at: "2026-09-26T10:00:00Z", creator: { login: "some-app[bot]" } };
  assert.equal(run({ statuses: [s] }).stage, "review");
});

test("a human-posted review status (creator.type User) is trusted", () => {
  const s = { context: "review/test-hunter", state: "success", description: "ok", created_at: "2026-09-26T10:00:00Z", creator: { type: "User", login: "leo" } };
  assert.equal(run({ statuses: [s] }).state, "success");
});

// E1: isBotStatus fails closed on a missing or null creator, since we cannot vouch for it as human-posted
test("isBotStatus treats a missing or null creator as untrusted", () => {
  assert.equal(isBotStatus({ context: "review/x" }), true);
  assert.equal(isBotStatus({ context: "review/x", creator: null }), true);
  assert.equal(isBotStatus({ context: "review/x", creator: { type: "User", login: "leo" } }), false);
});

test("a review status with no creator field at all is untrusted (fails closed), not treated as missing entirely", () => {
  const s = { context: "review/test-hunter", state: "success", description: "ok", created_at: "2026-09-26T10:00:00Z" };
  assert.equal(run({ statuses: [s] }).stage, "review");
});

// E2: a "linked issue" that is actually a pull request must be rejected
test("a linked issue that is actually a pull request fails at the contract stage", () => {
  const d = run({ issueIsPr: true });
  assert.equal(d.state, "failure");
  assert.equal(d.stage, "contract");
  assert.match(d.description, /pull request/);
});

// Fix round 1: Issue 2 — gateDecision fails on duplicate PR sections
test("gateDecision fails on duplicate PR template sections", () => {
  const bodyWithDups = "Closes #7\n\n## What changed\nx\n## Contract changes\nadditive\n## Tests added\nx\n## Reviewer results\nx\n## What changed\ny\n## Needs the owner\nnothing\n## Not done\nnothing\n";
  assert.equal(run({ prBody: bodyWithDups }).state, "failure");
  assert.match(run({ prBody: bodyWithDups }).description, /repeated/);
  assert.equal(run({ prBody: bodyWithDups }).stage, "contract");
});
