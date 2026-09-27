import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PATH_PATTERNS } from "../preflight.mjs";

test("lanes-gate always runs the default branch's scripts, never the PR's", () => {
  const yml = readFileSync(".github/workflows/lanes-gate.yml", "utf8");
  assert.match(yml, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
});

// I3: a PR must not be able to rewrite its own gate via the workflow YAML
test("lanes-gate triggers on pull_request_target, not pull_request, so a PR cannot alter its own gate job", () => {
  const yml = readFileSync(".github/workflows/lanes-gate.yml", "utf8");
  assert.match(yml, /\n  pull_request_target:\n/);
  assert.doesNotMatch(yml, /\n  pull_request:\n/);
});

// C1: strangers' issues must not be labelled ready by the issue-contract check
// Trust is the author's repository write access, looked up by login; author_association hides private org members.
test("issue-contract passes the issue author's login to the script, not their association", () => {
  const yml = readFileSync(".github/workflows/issue-contract.yml", "utf8");
  assert.match(yml, /ISSUE_AUTHOR: \$\{\{ github\.event\.issue\.user\.login \}\}/);
  assert.doesNotMatch(yml, /author_association/);
});

// R2: removing lane-filed (or hand-adding ready) must re-run the contract check
test("issue-contract triggers on opened, edited, labeled and unlabeled", () => {
  const yml = readFileSync(".github/workflows/issue-contract.yml", "utf8");
  const match = /issues:\s*\n\s*types: \[([^\]]+)\]/.exec(yml);
  assert.ok(match, "expected an `issues: types: [...]` trigger");
  const types = match[1].split(",").map((t) => t.trim());
  assert.deepEqual(types.sort(), ["edited", "labeled", "opened", "unlabeled"]);
});

// I6: verify must also run on push to main, so delivery-metrics has data and night/health can read its status
test("verify runs on push to main, not just pull_request and merge_group", () => {
  const yml = readFileSync(".github/workflows/verify.yml", "utf8");
  assert.match(yml, /push:\n\s*branches: \[main\]/);
});

// M6: the security scan must not choke on filenames with spaces or newlines
test("security.yml uses NUL-separated file lists", () => {
  const yml = readFileSync(".github/workflows/security.yml", "utf8");
  assert.match(yml, /git ls-files -z \| grep -zvE/);
  assert.match(yml, /xargs -0 -r grep/);
});

test("lanes-gate ignores its own status events", () => {
  const yml = readFileSync(".github/workflows/lanes-gate.yml", "utf8");
  assert.match(yml, /github\.event\.context != 'lanes\/gate'/);
});

test("lanes-gate concurrency group is keyed by head commit, not PR number, so pull_request and status runs serialize", () => {
  const yml = readFileSync(".github/workflows/lanes-gate.yml", "utf8");
  assert.match(yml, /group: lanes-gate-\$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.event\.sha/);
});

test("issue-contract concurrency group is keyed by issue number to serialize edits on the same issue", () => {
  const yml = readFileSync(".github/workflows/issue-contract.yml", "utf8");
  assert.match(yml, /group: issue-contract-\$\{\{ github\.event\.issue\.number \}\}/);
});

test("settings: the owner's approval always asks; reviewers are allowed; no force push", () => {
  const s = JSON.parse(readFileSync(".claude/settings.json", "utf8"));
  assert.ok(s.permissions.ask.includes("Bash(node scripts/lanes/post-review.mjs owner:*)"));
  assert.ok(!s.permissions.allow.some((r) => r.includes("post-review.mjs owner")));
  assert.ok(s.permissions.allow.includes("Bash(node scripts/lanes/post-review.mjs --file:*)"));
  assert.ok(s.permissions.allow.includes("Bash(node scripts/lanes/post-review.mjs test-hunter:*)"));
  assert.ok(s.permissions.deny.includes("Bash(git push --force:*)"));
  // agent-skills is this repo's practice layer; two process frameworks must not compete (owner, 2026-09-26).
  assert.equal(s.enabledPlugins["superpowers@superpowers-marketplace"], false);
});

// I8: `npm run setup` (the pre-push hook) must be runnable without a permission prompt
test("settings: npm run setup and the delivery-metrics script are allowed", () => {
  const s = JSON.parse(readFileSync(".claude/settings.json", "utf8"));
  assert.ok(s.permissions.allow.includes("Bash(npm run setup)"));
  assert.ok(s.permissions.allow.includes("Bash(node scripts/lanes/delivery-metrics.mjs:*)"));
});

// I5: the reviewer agents /lane spawns must ship in the repo, fresh-eyes and on sonnet
const AGENTS = ["test-hunter", "security-reviewer", "ui-reviewer", "architecture-advisor"];

test("each reviewer agent has Claude Code subagent frontmatter, runs on sonnet and is fresh-eyes", () => {
  for (const name of AGENTS) {
    const text = readFileSync(`.claude/agents/${name}.md`, "utf8");
    assert.match(text, /^---\nname: /, name);
    assert.match(text, /\nmodel: sonnet\n/, name);
    assert.match(text, /fresh/i, name);
    for (const pattern of PATH_PATTERNS) assert.equal(text.toLowerCase().includes(pattern.toLowerCase()), false, `${name}: ${pattern}`);
  }
});

test("the reviewer agents are installed into other repos", () => {
  const installText = readFileSync("scripts/lanes/install.mjs", "utf8");
  for (const name of AGENTS) assert.match(installText, new RegExp(`\\.claude/agents/${name}\\.md`), name);
});

test("every command file has a description", () => {
  for (const name of ["lane", "status", "approve", "adr", "health", "night", "plan-issues"]) {
    assert.match(readFileSync(`.claude/commands/${name}.md`, "utf8"), /^---\ndescription: .+/, name);
  }
});

const VENDORED_SKILLS = ["test-driven-development", "incremental-implementation", "api-and-interface-design", "planning-and-task-breakdown", "debugging-and-error-recovery", "frontend-ui-engineering", "security-and-hardening", "code-review-and-quality"];

test("the vendored agent-skills are pinned, licensed and complete", () => {
  const vendored = readFileSync("vendor/agent-skills/VENDORED.md", "utf8");
  assert.match(vendored, /2686b620fc1fed2e8f60c704839c766b8594c6b6/);
  assert.match(readFileSync("vendor/agent-skills/LICENSE", "utf8"), /MIT License/);
  for (const name of VENDORED_SKILLS) assert.match(readFileSync(`.claude/skills/${name}/SKILL.md`, "utf8"), /^---\nname: /, name);
});

test("lanes point at the practice layer", () => {
  const lane = readFileSync(".claude/commands/lane.md", "utf8");
  for (const name of ["test-driven-development", "incremental-implementation", "api-and-interface-design"]) assert.match(lane, new RegExp(name));
  assert.match(readFileSync(".claude/commands/plan-issues.md", "utf8"), /planning-and-task-breakdown/);
});

// #28: a lane pushes one notification when it finishes or needs the owner, never for routine progress
const laneText = () => readFileSync(".claude/commands/lane.md", "utf8");

test("lane.md loads PushNotification via ToolSearch and caps each notification at one short `lanes #N:` line", () => {
  const lane = laneText();
  assert.match(lane, /ToolSearch/);
  assert.match(lane, /PushNotification/);
  assert.match(lane, /under\s+200 characters/);
  assert.match(lane, /`lanes #<PR or issue>: /);
});

test("lane.md step 7 notifies once after checks settle: queued to merge, or needs /approve with the gate reason", () => {
  const step7 = laneText().match(/\n7\. [\s\S]*?\n8\. /)[0];
  assert.match(step7, /checks settle/);
  assert.match(step7, /queued to merge/);
  assert.match(step7, /needs \/approve: <the lanes\/gate reason>/);
});

test("lane.md step 9 notifies `CI failed twice` before stopping", () => {
  const step9 = laneText().match(/\n9\. [\s\S]*?\n10\. /)[0];
  assert.match(step9, /CI failed twice: <cause>, see #<PR>/);
});

test("lane.md steps 1-2 refusals notify `cannot start`", () => {
  const steps12 = laneText().match(/\n1\. [\s\S]*?\n3\. /)[0];
  assert.match(steps12, /cannot start: <reason>/);
});

test("lane.md notifies on any other stop that needs the owner, and never for routine progress", () => {
  const lane = laneText();
  assert.match(lane, /any other stop[^.]*needs? the owner/i);
  assert.match(lane, /never[^.]*routine progress/i);
});

test("no hook is added for permission-prompt notifications", () => {
  const settings = readFileSync(".claude/settings.json", "utf8");
  assert.doesNotMatch(settings, /PushNotification/);
  assert.doesNotMatch(laneText(), /permission prompt[^.]*PushNotification/i);
});

test("night.md sends a single push notification per night for its digest", () => {
  const night = readFileSync(".claude/commands/night.md", "utf8");
  assert.match(night, /PushNotification/);
  assert.match(night, /one notification per night/i);
  assert.match(night, /lanes night: /);
  // lane.md's Notify rule is unconditional, so night.md must override it where it tells lanes to follow lane.md
  const step3 = night.match(/\n3\. [\s\S]*?\n4\. /)[0];
  assert.match(step3, /except its Notify rule/);
});
