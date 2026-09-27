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

test("full tier without verdict comments waits on the owner", () => {
  assert.equal(run({ issueLabels: ["tier:full", "ready"], statuses: [st("review/test-hunter")] }).stage, "owner");
});

// #27: a clean full-tier PR merges unattended on trusted, head-bound verdicts
const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);
const verdict = (reviewer, { sha = HEAD, result = "success", findings = [] } = {}) => ({
  reviewer,
  sha,
  verdict: { reviewer, verdict: result, summary: "s", criteria: [], findings },
});
const full = (over) =>
  run({ issueLabels: ["tier:full", "ready"], headSha: HEAD, statuses: [st("review/test-hunter")], verdicts: [verdict("test-hunter")], ...over });
const waits = (d, reason) => {
  assert.equal(d.state, "pending");
  assert.equal(d.stage, "owner");
  assert.equal(d.description, `waiting on owner (/approve) (${reason})`);
};

test("a clean full PR passes unattended", () => {
  assert.deepEqual(full({}), { state: "success", description: "unattended-eligible (tier:full), reviews in", stage: "ready" });
});

test("full: 'Needs the owner' accepts nothing case-insensitively with a trailing period", () => {
  for (const v of ["Nothing", "NOTHING.", "nothing."]) {
    assert.equal(full({ prBody: body().replace("## Needs the owner\nnothing", `## Needs the owner\n${v}`) }).state, "success", v);
  }
});

test("full: anything else in 'Needs the owner' waits", () => {
  waits(full({ prBody: body().replace("## Needs the owner\nnothing", "## Needs the owner\ndecide the name") }), "needs the owner");
  waits(full({ prBody: body().replace("## Needs the owner\nnothing", "## Needs the owner\nnothing, but check X") }), "needs the owner");
});

test("full: a sensitive path waits", () => {
  const files = [".github/workflows/x.yml"];
  const statuses = [st("review/test-hunter"), st("review/security-reviewer")];
  waits(full({ files, statuses, verdicts: [verdict("test-hunter"), verdict("security-reviewer")] }), "sensitive path");
});

test("full: a breaking contract change waits; additive passes", () => {
  const files = ["contracts/x.ts"];
  const statuses = [st("review/test-hunter"), st("review/architecture-advisor")];
  const verdicts = [verdict("test-hunter"), verdict("architecture-advisor")];
  const labels = ["tier:full", "ready", "contract:breaking"];
  waits(full({ prBody: body("breaking"), issueLabels: labels, files, statuses, verdicts }), "breaking contract change");
  assert.equal(full({ prBody: body("additive"), files, statuses, verdicts }).state, "success");
});

test("full: a required reviewer without a verdict for the head waits", () => {
  waits(full({ verdicts: [] }), "no verdict for head from test-hunter");
  waits(full({ verdicts: undefined }), "no verdict for head from test-hunter");
});

test("full: a failure verdict waits", () => {
  waits(full({ verdicts: [verdict("test-hunter", { result: "failure" })] }), "verdict from test-hunter is not success");
});

test("full: an unfixed critical or important finding waits; minor or fixed ones do not", () => {
  for (const severity of ["critical", "important"]) {
    const findings = [{ severity, file: "a", line: 1, summary: "x", fixed: false }];
    waits(full({ verdicts: [verdict("test-hunter", { findings })] }), `unfixed ${severity} finding from test-hunter`);
  }
  const ok = [
    { severity: "minor", summary: "x", fixed: false },
    { severity: "critical", summary: "x", fixed: true },
  ];
  assert.equal(full({ verdicts: [verdict("test-hunter", { findings: ok })] }).state, "success");
});

test("full: an unfixed finding with an odd-cased or unknown severity waits (fails closed)", () => {
  for (const severity of ["Critical", "IMPORTANT", "blocker", undefined]) {
    const findings = [{ severity, summary: "x", fixed: false }];
    assert.equal(full({ verdicts: [verdict("test-hunter", { findings })] }).stage, "owner", String(severity));
  }
  assert.equal(full({ verdicts: [verdict("test-hunter", { findings: [{ severity: "Minor", summary: "x", fixed: false }] })] }).state, "success");
});

test("full: an unfixed finding in a non-required reviewer's head verdict also waits", () => {
  const findings = [{ severity: "important", summary: "x", fixed: false }];
  waits(full({ verdicts: [verdict("test-hunter"), verdict("ui-reviewer", { result: "failure", findings })] }), "unfixed important finding from ui-reviewer");
});

test("full: a verdict for an older SHA is ignored", () => {
  waits(full({ verdicts: [verdict("test-hunter", { sha: OLD })] }), "no verdict for head from test-hunter");
});

test("full: an old-format verdict without a SHA is ignored", () => {
  waits(full({ verdicts: [verdict("test-hunter", { sha: null })] }), "no verdict for head from test-hunter");
});

test("full: a head SHA compare is case-insensitive, and a missing head SHA matches nothing", () => {
  assert.equal(full({ headSha: HEAD.toUpperCase() }).state, "success");
  waits(full({ headSha: undefined, verdicts: [verdict("test-hunter", { sha: null })] }), "no verdict for head from test-hunter");
});

test("full: the newest verdict per reviewer for the head wins", () => {
  const older = verdict("test-hunter", { result: "failure" });
  assert.equal(full({ verdicts: [older, verdict("test-hunter")] }).state, "success");
  waits(full({ verdicts: [verdict("test-hunter"), older] }), "verdict from test-hunter is not success");
});

// No kept verdict may carry an unfixed finding: a finding cannot be fixed without a new commit, so a same-head re-post
// that drops it goes to the owner rather than merging unattended.
test("full: an unfixed finding in an earlier verdict for the same head still waits", () => {
  const findings = [{ severity: "critical", file: "a", line: 1, summary: "x", fixed: false }];
  const older = verdict("test-hunter", { result: "failure", findings });
  waits(full({ verdicts: [older, verdict("test-hunter")] }), "unfixed critical finding from test-hunter");
});

test("full: a trusted success status is still required even with a verdict comment", () => {
  assert.equal(full({ statuses: [] }).stage, "review");
});

test("full: review/owner success still passes a blocked PR", () => {
  const d = full({ verdicts: [], statuses: [st("review/test-hunter"), st("review/owner")] });
  assert.deepEqual(d, { state: "success", description: "approved by owner", stage: "ready" });
});

test("full: a blocked PR is never a failure", () => {
  const prBody = body().replace("## Needs the owner\nnothing", "## Needs the owner\nyes");
  assert.equal(full({ prBody, verdicts: [] }).state, "pending");
});

test("quick and skip PRs that need the owner wait", () => {
  const prBody = body().replace("## Needs the owner\nnothing", "## Needs the owner\npick a name");
  waits(run({ prBody, statuses: [st("review/test-hunter")] }), "needs the owner");
  waits(run({ prBody, issueLabels: ["tier:skip", "ready"], files: ["docs/a.md"] }), "needs the owner");
  assert.equal(run({ prBody, statuses: [st("review/test-hunter"), st("review/owner")] }).state, "success");
});

test("gateDecision does not mutate its verdicts input", () => {
  const verdicts = Object.freeze([Object.freeze(verdict("test-hunter", { result: "failure" })), Object.freeze(verdict("test-hunter"))]);
  assert.equal(full({ verdicts }).state, "success");
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
