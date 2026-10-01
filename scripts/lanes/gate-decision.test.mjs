import { test } from "node:test";
import assert from "node:assert/strict";
import { compileConfig, gateDecision, isBotStatus, loadConfig, nativeCodeOwnerApproval, parseAdr, reusableReviewers, reuseBlockedBy } from "./lib.mjs";

const config = compileConfig({
  requiredChecks: ["verify"],
  paths: { skip: ["^docs/", "\\.md$"], contract: ["^contracts/"], sensitive: ["^\\.github/"], ui: ["^frontend/"], owner: ["^scripts/lanes/gate\\.mjs$"] },
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

test("a reviewed sensitive quick change merges unattended (ADR 0002)", () => {
  const files = [".github/workflows/x.yml"];
  const reviews = [st("review/test-hunter"), st("review/security-reviewer")];
  assert.deepEqual(run({ files, statuses: [st("review/test-hunter")] }), { state: "pending", description: "waiting for review/security-reviewer", stage: "review" });
  assert.deepEqual(run({ files, statuses: reviews }), { state: "success", description: "unattended-eligible (tier:quick), reviews in", stage: "ready" });
});

test("an owner-only quick change waits on the owner, then passes with review/owner", () => {
  const files = ["scripts/lanes/gate.mjs"];
  const reviews = [st("review/test-hunter")];
  assert.deepEqual(run({ files, statuses: reviews }), { state: "pending", description: "waiting on owner (/approve) (owner-only path)", stage: "owner" });
  assert.equal(run({ files, statuses: [...reviews, st("review/owner")] }).state, "success");
});

test("a skip PR on a sensitive path still fails", () => {
  assert.match(run({ issueLabels: ["tier:skip", "ready"], files: [".github/pull_request_template.md"] }).description, /skip paths/);
});

// edge: an owner-only file that is also outside the skip paths must still fail tier:skip, not wait on the owner.
// gateDecision checks skipOnly before cls.owner, so "never failing" for owner-only cannot mask this earlier failure.
test("edge: a skip PR on an owner-only, non-skip path fails (not owner-only pending)", () => {
  const d = run({ issueLabels: ["tier:skip", "ready"], files: ["scripts/lanes/gate.mjs"] });
  assert.equal(d.state, "failure");
  assert.match(d.description, /skip paths/);
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

test("full: a reviewed sensitive path passes unattended (ADR 0002)", () => {
  const files = [".github/workflows/x.yml"];
  const statuses = [st("review/test-hunter"), st("review/security-reviewer")];
  assert.equal(full({ files, statuses, verdicts: [verdict("test-hunter"), verdict("security-reviewer")] }).state, "success");
});

test("full: a sensitive path still needs the security-reviewer's status and head verdict", () => {
  const files = [".github/workflows/x.yml"];
  assert.equal(full({ files }).description, "waiting for review/security-reviewer");
  waits(full({ files, statuses: [st("review/test-hunter"), st("review/security-reviewer")] }), "no verdict for head from security-reviewer");
});

test("full: an owner-only path waits even when every review is clean", () => {
  waits(full({ files: ["scripts/lanes/gate.mjs"] }), "owner-only path");
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

// ---- #48 / ADR 0002: owner-only paths, against the repo's real lanes.config.json ----

// The repository config is on the team profile (ADR 0019); these cases pin the solo owner stage (ADR 0002).
const realTeam = loadConfig();
const real = { ...realTeam, identity: { profile: "solo" } };
const clean = (names) => ({ statuses: names.map((n) => st(`review/${n}`)), verdicts: names.map((n) => verdict(n)) });
const onReal = (tier, files, reviewers, over = {}) =>
  run({ config: real, issueLabels: [`tier:${tier}`, "ready"], headSha: HEAD, files, ...clean(reviewers), ...over });
const READY = (tier) => ({ state: "success", description: `unattended-eligible (tier:${tier}), reviews in`, stage: "ready" });

test("real config: a reviewed full PR on scripts/lanes/status.mjs merges unattended", () => {
  assert.deepEqual(onReal("full", ["scripts/lanes/status.mjs"], ["test-hunter", "security-reviewer"]), READY("full"));
});

test("real config: the same full PR on scripts/lanes/gate.mjs waits (owner-only path)", () => {
  waits(onReal("full", ["scripts/lanes/gate.mjs"], ["test-hunter", "security-reviewer"]), "owner-only path");
});

test("real config: a reviewed quick PR on .claude/commands/status.md merges unattended", () => {
  assert.deepEqual(onReal("quick", [".claude/commands/status.md"], ["test-hunter", "security-reviewer"]), READY("quick"));
});

test("real config: a PR editing .claude/commands/lane.md waits at quick and full", () => {
  for (const tier of ["quick", "full"]) waits(onReal(tier, [".claude/commands/lane.md"], ["test-hunter", "security-reviewer"]), "owner-only path");
});

test("real config: a skip PR adding docs/adr/0003-x.md waits, never fails", () => {
  waits(onReal("skip", ["docs/adr/0003-x.md"], []), "owner-only path");
});

test("real config: one owner-only file among tooling files makes the whole PR wait", () => {
  // #241: lanes.config.json (the module map) also needs the architecture-advisor.
  waits(onReal("full", ["scripts/lanes/status.mjs", "docs/USING.md", "lanes.config.json"], ["test-hunter", "security-reviewer", "architecture-advisor"]), "owner-only path");
});

test("real config: a sensitive full PR whose security verdict has an unfixed important finding waits", () => {
  const findings = [{ severity: "important", file: "scripts/lanes/status.mjs", line: 1, summary: "x", fixed: false }];
  const verdicts = [verdict("test-hunter"), verdict("security-reviewer", { findings })];
  waits(onReal("full", ["scripts/lanes/status.mjs"], ["test-hunter", "security-reviewer"], { verdicts }), "unfixed important finding from security-reviewer");
});

test("real config: review/owner success still passes anything, owner-only included", () => {
  const withOwner = (reviewers) => ({ statuses: [...reviewers.map((n) => st(`review/${n}`)), st("review/owner")], verdicts: [] });
  assert.deepEqual(onReal("full", ["scripts/lanes/gate.mjs", "lanes.config.json"], [], withOwner(["test-hunter", "security-reviewer", "architecture-advisor"])), { state: "success", description: "approved by owner", stage: "ready" });
  assert.equal(onReal("skip", ["docs/adr/0003-x.md"], [], withOwner([])).state, "success");
});

test("real config under the team profile: an owner-only path waits for a native code-owner review (ADR 0021)", () => {
  assert.equal(realTeam.identity?.profile, "team");
  const input = { config: realTeam, ...clean(["test-hunter", "security-reviewer"]), nativeApproval: { approved: false, by: null } };
  const d = onReal("full", ["scripts/lanes/gate.mjs"], ["test-hunter", "security-reviewer"], input);
  assert.deepEqual(d, { state: "pending", description: "waiting for a code-owner review in GitHub (owner-only path)", stage: "owner" });
  assert.equal(onReal("full", ["scripts/lanes/gate.mjs"], ["test-hunter", "security-reviewer"], { ...input, nativeApproval: { approved: true, by: "leo" } }).state, "success");
});

// #559: gate.mjs feeds nativeCodeOwnerApproval's result to gateDecision; these pin the pair end to end.
test("team: a code owner's approval on the head SHA passes, and a stale, author or non-owner approval stays pending without /approve", () => {
  const files = ["scripts/lanes/gate.mjs"];
  const decide = (reviews, author = "someone") =>
    onReal("full", files, ["test-hunter", "security-reviewer"], { config: realTeam, nativeApproval: nativeCodeOwnerApproval(reviews, author, HEAD, ["leo"], realTeam.identity) });
  const approve = (login, commit_id = HEAD) => ({ user: { login }, state: "APPROVED", commit_id });
  const passed = decide([approve("leo")]);
  assert.deepEqual(passed, { state: "success", description: "approved by code owner @leo", stage: "ready" });
  for (const d of [decide([approve("leo", "f".repeat(40))]), decide([approve("leo")], "leo"), decide([approve("stranger")]), decide([])]) {
    assert.equal(d.state, "pending");
    assert.equal(d.stage, "owner");
    assert.doesNotMatch(d.description, /\/approve/);
  }
});

test("team: a failed read (the approval { approved: false, by: null }) is pending, even with a review/owner status on the head", () => {
  const input = { config: realTeam, ...clean(["test-hunter", "security-reviewer"]), nativeApproval: { approved: false, by: null } };
  input.statuses = [...input.statuses, st("review/owner")];
  const d = onReal("full", ["scripts/lanes/gate.mjs"], ["test-hunter", "security-reviewer"], input);
  assert.equal(d.state, "pending");
  assert.doesNotMatch(d.description, /\/approve/);
});

test("solo: nativeApproval is ignored, so the decision is unchanged", () => {
  const files = ["scripts/lanes/gate.mjs"];
  const d = onReal("full", files, ["test-hunter", "security-reviewer"], { nativeApproval: { approved: true, by: "leo" } });
  assert.equal(d.state, "pending");
  assert.match(d.description, /waiting on owner \(\/approve\)/);
});

test("owner-only is reported before the other owner reasons", () => {
  const prBody = body("breaking").replace("## Needs the owner\nnothing", "## Needs the owner\npick a name");
  const d = onReal("full", ["scripts/lanes/gate.mjs", "contracts/x.ts"], ["test-hunter", "security-reviewer", "architecture-advisor"], {
    prBody,
    issueLabels: ["tier:full", "ready", "contract:breaking"],
  });
  waits(d, "owner-only path");
});

test("the other owner reasons are unchanged on a sensitive, non-owner-only path", () => {
  const files = ["scripts/lanes/status.mjs"];
  const reviewers = ["test-hunter", "security-reviewer"];
  const needs = body().replace("## Needs the owner\nnothing", "## Needs the owner\npick a name");
  waits(onReal("full", files, reviewers, { prBody: needs }), "needs the owner");
  waits(onReal("quick", files, reviewers, { prBody: needs }), "needs the owner");
  const breaking = { prBody: body("breaking"), issueLabels: ["tier:full", "ready", "contract:breaking"] };
  waits(onReal("full", [...files, "contracts/x.ts"], [...reviewers, "architecture-advisor"], breaking), "breaking contract change");
  waits(onReal("quick", [...files, "contracts/x.ts"], [...reviewers, "architecture-advisor"], { prBody: body("additive") }), "contract change");
  waits(onReal("full", files, reviewers, { verdicts: [verdict("test-hunter")] }), "no verdict for head from security-reviewer");
  const failed = [verdict("test-hunter"), verdict("security-reviewer", { result: "failure" })];
  waits(onReal("full", files, reviewers, { verdicts: failed }), "verdict from security-reviewer is not success");
  assert.equal(onReal("full", [...files, "contracts/x.ts"], [...reviewers, "architecture-advisor"], { prBody: body("additive") }).state, "success");
});

test("edge: a config without paths.owner never reports owner-only", () => {
  const legacy = compileConfig({ requiredChecks: ["verify"], paths: { skip: ["^docs/"], contract: [], sensitive: ["^scripts/"], ui: [] } });
  assert.equal(full({ config: legacy, files: ["scripts/lanes/gate.mjs"], ...clean(["test-hunter", "security-reviewer"]) }).state, "success");
});

// ---- #45: accepted ADRs on the default branch that govern a changed file require the architecture-advisor ----

const adrText = (n, status, governs) =>
  `# ${String(n).padStart(4, "0")}: ADR ${n}\n\nStatus: ${status}\n\n## Context\n\nx\n\n## Decision\n\nx\n\n## Decisions for the owner\n\nnothing\n\n## Consequences\n\nx\n\n## Governs\n\n${governs.map((g) => `- ${g}`).join("\n")}\n`;
const adrOf = (n, governs, status = "accepted") => parseAdr(adrText(n, status, governs));
const ADRS = [adrOf(3, ["src/"])];

// #241: governing a changed file no longer requires the advisor; changing an ADR, the module map or an Interface
// contract path does.
test("a governed file alone no longer makes the gate wait for the architecture-advisor", () => {
  assert.deepEqual(full({ adrs: ADRS, files: ["src/a.ts"] }), READY("full"));
  assert.deepEqual(run({ adrs: ADRS, files: ["src/a.ts"], statuses: [st("review/test-hunter")] }), READY("quick"));
});

test("an Interface contract path in the diff makes the gate wait for the architecture-advisor, then pass once it is in", () => {
  const over = { adrs: ADRS, files: ["src/a.ts"], interfaceContract: "`src/a.ts` exports `f`" };
  assert.deepEqual(full(over), { state: "pending", description: "waiting for review/architecture-advisor", stage: "review" });
  assert.deepEqual(full({ ...over, ...clean(["test-hunter", "architecture-advisor"]) }), READY("full"));
  assert.equal(run({ ...over, statuses: [st("review/test-hunter")] }).description, "waiting for review/architecture-advisor");
  assert.deepEqual(full({ ...over, interfaceContract: "none" }), READY("full"));
});

test("full: an architecture change also needs the architecture-advisor's verdict for the head", () => {
  const statuses = [st("review/test-hunter"), st("review/architecture-advisor")];
  const over = { files: ["src/a.ts"], interfaceContract: "`src/a.ts`" };
  waits(full({ ...over, statuses, verdicts: [verdict("test-hunter")] }), "no verdict for head from architecture-advisor");
});

test("an architecture change that is not a contract file leaves the contract checks alone", () => {
  // 'Contract changes: none' and the quick-tier contract blocker key off paths.contract only.
  const over = { files: ["src/a.ts", "docs/adr/0003-new.md"], prBody: body("none"), ...clean(["test-hunter", "architecture-advisor"]) };
  assert.deepEqual(run(over), READY("quick"));
  assert.deepEqual(run({ ...over, interfaceContract: "`src/a.ts`" }), READY("quick"));
  assert.equal(run({ ...over, files: ["contracts/x.ts"] }).description, "contract files changed but 'Contract changes' says none");
  waits(run({ ...over, files: ["contracts/x.ts"], prBody: body("additive") }), "contract change");
});

test("edge: reusableReviewers sees the Interface contract the gate sees", () => {
  const inputs = { issueLabels: ["tier:full", "ready"], files: ["src/a.ts"], statuses: [], config };
  assert.deepEqual(reusableReviewers(inputs), ["test-hunter"]);
  assert.deepEqual(reusableReviewers({ ...inputs, interfaceContract: "`src/a.ts`" }), ["test-hunter", "architecture-advisor"]);
});

test("a diff touching only ungoverned files is unchanged", () => {
  assert.deepEqual(full({ adrs: ADRS, files: ["lib/a.ts"] }), READY("full"));
});

test("a superseded ADR is ignored", () => {
  assert.deepEqual(full({ adrs: [adrOf(3, ["src/"], "superseded by 0004")], files: ["src/a.ts"] }), READY("full"));
});

test("a PR adding an ADR requires the advisor, though the ADR is not on the default branch yet", () => {
  // The gate's adrs come from the default branch; #241 keys off the PR's docs/adr file in its file list instead.
  const files = ["docs/adr/0003-new.md", "src/a.ts"];
  assert.equal(full({ adrs: [], files }).description, "waiting for review/architecture-advisor");
  assert.deepEqual(full({ adrs: [], files, ...clean(["test-hunter", "architecture-advisor"]) }), READY("full"));
});

test("tier skip on a governed file is unchanged: no reviewers", () => {
  const governsDocs = [adrOf(3, ["docs/"])];
  assert.deepEqual(run({ adrs: governsDocs, issueLabels: ["tier:skip", "ready"], files: ["docs/a.md"] }), READY("skip"));
});

test("a tier:skip PR adding an ADR still waits on the owner (ADR 0002 owner-only path)", () => {
  const d = onReal("skip", ["docs/adr/0003-new.md"], [], { adrs: [adrOf(1, ["docs/adr/"])] });
  assert.deepEqual(d, { state: "pending", description: "waiting on owner (/approve) (owner-only path)", stage: "owner" });
});

test("edge: without adrs the gate decides as before", () => {
  assert.deepEqual(full({ files: ["src/a.ts"] }), READY("full"));
});

// #36: the gate enforces the linked issue's "Blocked by", after the contract checks and before the reviewer checks.
const blockers = (open = [], unreadable = [], extra = {}) => ({ ok: open.length === 0 && unreadable.length === 0, open, unreadable, ...extra });

test("no blockers leaves the decision unchanged", () => {
  const skip = { issueLabels: ["tier:skip", "ready"], files: ["docs/a.md"] };
  assert.deepEqual(run({ ...skip, blockers: blockers() }), run(skip));
  assert.deepEqual(run({ blockers: blockers() }), run({}));
});

test("one open blocker keeps the gate pending at stage blocked", () => {
  assert.deepEqual(run({ issueLabels: ["tier:skip", "ready"], files: ["docs/a.md"], blockers: blockers([3]) }), {
    state: "pending",
    description: "waiting for blocker #3 (open)",
    stage: "blocked",
  });
});

test("several open blockers are all named", () => {
  assert.equal(run({ blockers: blockers([3, 4]) }).description, "waiting for blocker #3 (open), #4");
});

test("an unreadable blocker fails closed, even alongside an open one", () => {
  assert.deepEqual(run({ blockers: blockers([], [9]) }), { state: "failure", description: "cannot check blockers of #7: #9 unreadable", stage: "blocked" });
  assert.equal(run({ blockers: blockers([3], [9, 10]) }).description, "cannot check blockers of #7: #9, #10 unreadable");
});

test("the blocker check runs after the contract checks", () => {
  const d = run({ prBody: body("breaking"), files: ["contracts/x.ts"], blockers: blockers([3]) });
  assert.equal(d.state, "failure");
  assert.match(d.description, /contract:breaking/);
});

test("the blocker check runs before the reviewer and owner checks", () => {
  assert.equal(run({ statuses: [st("review/test-hunter", "failure"), st("review/owner")], blockers: blockers([3]) }).stage, "blocked");
});

test("edge: a blocker report that is not ok but names nothing, or is malformed, fails closed", () => {
  for (const b of [{ ok: false, open: [], unreadable: [] }, { ok: false }, null, "none", { ok: "yes", open: [], unreadable: [] }, { ok: true, open: [3], unreadable: [] }]) {
    const d = run({ blockers: b });
    assert.notEqual(d.state, "success", JSON.stringify(b));
    assert.equal(d.stage, "blocked", JSON.stringify(b));
  }
  assert.match(run({ blockers: null }).description, /^cannot check blockers of #7/);
});

test("edge: a blocker report's own error is shown", () => {
  assert.equal(run({ blockers: { ok: false, open: [], unreadable: [], error: "missing: blocked by" } }).description, "cannot check blockers of #7: missing: blocked by");
});

// #154: the #25 test-hunter reuse, generalised to the security-reviewer and the architecture-advisor
const both = { files: [".github/w.yml", "contracts/a.md"], prBody: body("additive") };
const reusedFrom = (sha, ...names) => names.map((n) => ({ sha, status: st(`review/${n}`) }));
const fullBoth = (over) =>
  full({
    ...both,
    statuses: [st("review/test-hunter")],
    verdicts: [verdict("test-hunter"), verdict("security-reviewer", { sha: OLD }), verdict("architecture-advisor", { sha: OLD })],
    reused: reusedFrom(OLD, "security-reviewer", "architecture-advisor"),
    ...over,
  });
const NOTE = ", reused security-reviewer+architecture-advisor from bbbbbbb";

test("reuses a security-reviewer and an architecture-advisor success from an earlier commit, with their verdicts there", () => {
  assert.deepEqual(fullBoth({}), { state: "success", description: `unattended-eligible (tier:full), reviews in${NOTE}`, stage: "ready" });
});

test("the description says reused <reviewer> from <sha7>, grouped by the reviewed commit", () => {
  const one = fullBoth({
    statuses: [st("review/test-hunter"), st("review/architecture-advisor")],
    verdicts: [verdict("test-hunter"), verdict("architecture-advisor"), verdict("security-reviewer", { sha: OLD })],
    reused: reusedFrom(OLD, "security-reviewer"),
  });
  assert.equal(one.description, "unattended-eligible (tier:full), reviews in, reused security-reviewer from bbbbbbb");
  const other = "c".repeat(40);
  const two = fullBoth({
    statuses: [],
    verdicts: [verdict("test-hunter", { sha: other }), verdict("security-reviewer", { sha: OLD }), verdict("architecture-advisor", { sha: OLD })],
    reused: [...reusedFrom(other, "test-hunter"), ...reusedFrom(OLD, "security-reviewer", "architecture-advisor")],
  });
  assert.equal(two.description, `unattended-eligible (tier:full), reviews in, reused test-hunter from ccccccc${NOTE}`);
});

test("a reused failure is never turned into a pass, as a status or as a verdict comment", () => {
  for (const state of ["failure", "pending", "error"]) {
    const d = fullBoth({ reused: [{ sha: OLD, status: st("review/security-reviewer", state) }, ...reusedFrom(OLD, "architecture-advisor")] });
    assert.equal(d.description, "waiting for review/security-reviewer", state);
  }
  const comment = fullBoth({ verdicts: [verdict("test-hunter"), verdict("security-reviewer", { sha: OLD, result: "failure" }), verdict("architecture-advisor", { sha: OLD })] });
  assert.equal(comment.state, "pending");
  assert.equal(comment.description, `waiting on owner (/approve) (verdict from security-reviewer is not success)${NOTE}`);
  const finding = { severity: "important", file: "a", line: 1, summary: "s", fixed: false };
  const unfixed = fullBoth({ verdicts: [verdict("test-hunter"), verdict("security-reviewer", { sha: OLD }), verdict("architecture-advisor", { sha: OLD, findings: [finding] })] });
  assert.equal(unfixed.description, `waiting on owner (/approve) (unfixed important finding from architecture-advisor)${NOTE}`);
});

test("a reused status brings along only its own reviewer's verdict for the reused commit", () => {
  // The security-reviewer's verdict at OLD does not stand in for the architecture-advisor's, nor the test-hunter's.
  const d = fullBoth({ verdicts: [verdict("test-hunter"), verdict("security-reviewer", { sha: OLD }), verdict("architecture-advisor", { sha: "c".repeat(40) })] });
  assert.equal(d.description, `waiting on owner (/approve) (no verdict for head from architecture-advisor)${NOTE}`);
  const hunter = fullBoth({ verdicts: [verdict("test-hunter", { sha: OLD }), verdict("security-reviewer", { sha: OLD }), verdict("architecture-advisor", { sha: OLD })] });
  assert.match(hunter.description, /no verdict for head from test-hunter/);
});

test("review/owner is never reused, nor the ui-reviewer", () => {
  const owner = run({ files: ["scripts/lanes/gate.mjs"], statuses: [st("review/test-hunter")], reused: [{ sha: OLD, status: st("review/owner") }] });
  assert.equal(owner.description, "waiting on owner (/approve) (owner-only path)");
  const ui = run({ files: ["frontend/a.tsx"], statuses: [st("review/test-hunter")], reused: [{ sha: OLD, status: st("review/ui-reviewer") }] });
  assert.equal(ui.description, "waiting for review/ui-reviewer");
});

test("edge: a reused status for a reviewer the head already has a trusted status for is ignored", () => {
  const d = fullBoth({ statuses: [st("review/test-hunter"), st("review/security-reviewer", "failure"), st("review/architecture-advisor")] });
  assert.equal(d.description, "review/security-reviewer is failure");
});

test("edge: malformed reused entries are dropped one by one, never the whole list trusted or refused", () => {
  const good = reusedFrom(OLD, "architecture-advisor");
  for (const bad of [
    null,
    "x",
    { sha: OLD },
    { sha: "nope", status: st("review/security-reviewer") },
    { sha: OLD, status: st("review/security-reviewer", "success", "ok", "2026-09-26T10:00:00Z", { type: "Bot", login: "github-actions[bot]" }) },
    { sha: OLD, status: st("review/security-reviewers") },
  ]) {
    const d = fullBoth({ reused: [bad, ...good] });
    assert.equal(d.description, "waiting for review/security-reviewer", JSON.stringify(bad));
  }
  // Two entries for the same reviewer: neither is trusted over the other.
  const dup = fullBoth({ reused: [...reusedFrom(OLD, "security-reviewer"), ...reusedFrom("c".repeat(40), "security-reviewer"), ...good] });
  assert.equal(dup.description, "waiting for review/security-reviewer");
  assert.equal(fullBoth({ reused: [] }).description, "waiting for review/security-reviewer");
});

const reuseAdr = (n, status, ...governs) => parseAdr(`# ${n}: t\n\nStatus: ${status}\n\n## Governs\n\n${governs.map((g) => `- ${g}`).join("\n")}\n`);
const REUSE_ADRS = [reuseAdr("0003", "accepted", "src/"), reuseAdr("0008", "accepted", "scripts/lanes/lib.mjs"), reuseAdr("0009", "superseded by 0010", "src/a.ts")];

test("reuseBlockedBy: a change to the reviewer's own brief since the review blocks reuse, for every reusable reviewer", () => {
  for (const r of ["test-hunter", "security-reviewer", "architecture-advisor"]) {
    assert.equal(reuseBlockedBy(r, [`.claude/agents/${r}.md`], ["src/a.ts"], REUSE_ADRS), `.claude/agents/${r}.md`, r);
    assert.equal(reuseBlockedBy(r, [".claude/agents/ui-reviewer.md", "README.md", "src/b.ts"], ["src/a.ts"], []), null, r);
  }
  // The checklists a lane hands the test-hunter are what it checks against too.
  for (const f of ["vendor/agent-skills/references/definition-of-done.md", "vendor/agent-skills/references/testing-patterns.md"]) {
    assert.equal(reuseBlockedBy("test-hunter", [f], ["src/a.ts"], []), f);
  }
});

test("reuseBlockedBy: the security checklist or any OWASP cheat sheet blocks only the security-reviewer's reuse", () => {
  for (const f of ["vendor/agent-skills/references/security-checklist.md", "vendor/owasp-cheatsheets/Input_Validation.md", "vendor/owasp-cheatsheets/deep/x.md"]) {
    assert.equal(reuseBlockedBy("security-reviewer", [f], ["src/a.ts"], []), f);
    assert.equal(reuseBlockedBy("architecture-advisor", [f], ["src/a.ts"], []), null, f);
  }
  assert.equal(reuseBlockedBy("security-reviewer", ["vendor/owasp-cheatsheets-old/x.md", "vendor/agent-skills/references/other.md"], ["src/a.ts"], []), null);
});

test("reuseBlockedBy: an ADR governing the PR's files blocks the architecture-advisor's reuse; others do not", () => {
  assert.equal(reuseBlockedBy("architecture-advisor", ["docs/adr/0003-src.md"], ["src/a.ts"], REUSE_ADRS), "docs/adr/0003-src.md");
  assert.equal(reuseBlockedBy("architecture-advisor", ["docs/adr/0008-map.md"], ["src/a.ts"], REUSE_ADRS), null);
  assert.equal(reuseBlockedBy("architecture-advisor", ["docs/adr/0008-map.md"], ["src/a.ts", "scripts/lanes/lib.mjs"], REUSE_ADRS), "docs/adr/0008-map.md");
  // An ADR superseded since the review still governed what the advisor checked against.
  assert.equal(reuseBlockedBy("architecture-advisor", ["docs/adr/0009-old.md"], ["src/a.ts"], REUSE_ADRS), "docs/adr/0009-old.md");
  assert.equal(reuseBlockedBy("security-reviewer", ["docs/adr/0003-src.md"], ["src/a.ts"], REUSE_ADRS), null);
});

test("edge: reuseBlockedBy fails closed on an ADR it cannot tie to a number, and on unreadable input", () => {
  assert.equal(reuseBlockedBy("architecture-advisor", ["docs/adr/README.md"], ["src/a.ts"], REUSE_ADRS), "docs/adr/README.md");
  assert.equal(reuseBlockedBy("architecture-advisor", ["docs/adr/new-thing.md"], ["src/a.ts"], [{ error: "bad" }]), "docs/adr/new-thing.md");
  assert.equal(reuseBlockedBy("architecture-advisor", ["docs/adr/diagram.png"], ["src/a.ts"], REUSE_ADRS), null);
  assert.equal(reuseBlockedBy("architecture-advisor", ["docs\\adr\\0003-src.md"], ["src/a.ts"], REUSE_ADRS), "docs\\adr\\0003-src.md");
  for (const changed of [null, undefined, "x", [1]]) assert.notEqual(reuseBlockedBy("security-reviewer", changed, ["src/a.ts"], []), null, JSON.stringify(changed));
  assert.notEqual(reuseBlockedBy("owner", [], [], []), null);
  assert.notEqual(reuseBlockedBy("ui-reviewer", [], [], []), null);
  assert.equal(reuseBlockedBy("test-hunter", [], ["src/a.ts"], REUSE_ADRS), null);
});

// edge: not named by the acceptance criteria or the lane's edge: cases, which only exercise reuse end-to-end through
// gateDecision/evaluatePr; reusableReviewers is the direct generalisation from #25's single-reviewer testHunterReusable
// and had no unit test of its own naming more than one candidate, or excluding a required reviewer that is never reusable.
test("reusableReviewers: every required, reusable reviewer missing a trusted head status is a candidate; the ui-reviewer never is", () => {
  const uiFull = { issueLabels: ["tier:full", "ready"], files: ["frontend/a.tsx", ".github/w.yml", "contracts/a.md"], statuses: [], config };
  assert.deepEqual(reusableReviewers(uiFull), ["test-hunter", "security-reviewer", "architecture-advisor"]);
  // The head already has a trusted status for two of them: only the third remains a candidate.
  const partial = { ...uiFull, statuses: [st("review/test-hunter"), st("review/security-reviewer")] };
  assert.deepEqual(reusableReviewers(partial), ["architecture-advisor"]);
  // No tier, or a tier that needs none of the reusable reviewers: no candidates.
  assert.deepEqual(reusableReviewers({ ...uiFull, issueLabels: ["tier:skip"] }), []);
  assert.deepEqual(reusableReviewers({ issueLabels: ["tier:quick", "ready"], files: ["src/a.ts"], statuses: [], config }), ["test-hunter"]);
});

test("edge: gateDecision stays pure with blockers (same input, same output, input untouched)", () => {
  const b = blockers([3]);
  const copy = structuredClone(b);
  assert.deepEqual(run({ blockers: b }), run({ blockers: b }));
  assert.deepEqual(b, copy);
});
