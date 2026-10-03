import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
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

// #36: closing an issue re-evaluates the PRs it was blocking, under the workflow's existing rules.
test("lanes-gate also runs on issues closed, passing the issue number to the gate", () => {
  const yml = readFileSync(".github/workflows/lanes-gate.yml", "utf8");
  assert.match(yml, /\n  issues:\n    types: \[closed\]\n/);
  assert.match(yml, /ISSUE_NUMBER: \$\{\{ github\.event\.issue\.number \}\}/);
});

// #82 (ADR 0004) adds issues: write, for the owner-approval comment; scripts/gate-workflow.test.mjs pins it too.
test("lanes-gate keeps its permissions to reading, posting statuses and issue comments, with none added for the issues trigger", () => {
  const yml = readFileSync(".github/workflows/lanes-gate.yml", "utf8");
  const perms = /\npermissions:\n((?: {2}\S.*\n)+)/.exec(yml);
  assert.ok(perms, "expected a top-level permissions block");
  assert.deepEqual(perms[1].trim().split("\n").map((l) => l.trim()).sort(), ["contents: read", "issues: write", "pull-requests: write", "statuses: write"]);
  assert.equal((yml.match(/permissions:/g) ?? []).length, 1, "no job-level permissions");
});

// #561 (ADR 0021): a native review pings the default branch's gate without a PR's own workflow deciding anything.
test("lanes-review-ping runs on pull_request_review with no permissions, checkout, secrets or action, and one no-op step", () => {
  const yml = readFileSync(".github/workflows/lanes-review-ping.yml", "utf8");
  assert.match(yml, /^name: lanes-review-ping$/m);
  assert.match(yml, /\non:\n {2}pull_request_review:\n {4}types: \[submitted, edited, dismissed\]\n/);
  assert.match(yml, /\npermissions: \{\}\n/);
  assert.doesNotMatch(yml, /actions\/checkout|uses:|secrets\.|GH_TOKEN|GITHUB_TOKEN/);
  assert.equal((yml.match(/^\s+- run: /gm) ?? []).length, 1);
  assert.deepEqual(yml.match(/^\s+- run: .*/gm), ["      - run: echo ping"]);
});

test("lanes-gate also runs on workflow_run of lanes-review-ping, still on the default branch's scripts", () => {
  const yml = readFileSync(".github/workflows/lanes-gate.yml", "utf8");
  assert.match(yml, /\n {2}workflow_run:\n {4}workflows: \[lanes-review-ping\]\n {4}types: \[completed\]\n/);
  assert.match(yml, /pull_request_target:/);
  assert.match(yml, /\n {2}merge_group:/);
  assert.match(yml, /\n {2}workflow_dispatch:/);
  assert.match(yml, /\n {2}issues:\n {4}types: \[closed\]/);
  assert.match(yml, /\n {2}status:\n/);
  assert.match(yml, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
});

test("lanes-gate checks out only the default branch and runs only gate.mjs, for every trigger", () => {
  const yml = readFileSync(".github/workflows/lanes-gate.yml", "utf8");
  assert.equal((yml.match(/actions\/checkout@/g) ?? []).length, 1);
  assert.deepEqual(yml.match(/- run: .*/g), ["- run: node scripts/lanes/gate.mjs"]);
});

test("USING.md's Lane → lane row says the gate enforces Blocked by, not only /lane", () => {
  const row = readFileSync("docs/USING.md", "utf8").split("\n").find((l) => l.startsWith("| Lane → lane |"));
  assert.ok(row, "expected the Lane → lane row");
  assert.match(row, /`lanes\/gate` enforces "Blocked by"/);
});

test("lanes-gate concurrency group has a key for issues events", () => {
  const yml = readFileSync(".github/workflows/lanes-gate.yml", "utf8");
  assert.match(yml, /group: lanes-gate-.*github\.event\.issue\.number/);
});

test("issue-contract concurrency group is keyed by issue number to serialize edits on the same issue", () => {
  const yml = readFileSync(".github/workflows/issue-contract.yml", "utf8");
  assert.match(yml, /group: issue-contract-\$\{\{ github\.event\.issue\.number \}\}/);
});

test("settings: no guard hook is wired, the owner's approval is never allowed by a rule; reviewers are allowed; no force push", () => {
  const s = JSON.parse(readFileSync(".claude/settings.json", "utf8"));
  assert.doesNotMatch(JSON.stringify(s.hooks), /approve-guard|start-guard/);
  assert.deepEqual(Object.keys(s.hooks), ["Notification"], "ADR 0030: only the Notification hook stays");
  assert.ok(!(s.permissions.ask ?? []).some((r) => r.includes("post-review.mjs owner")));
  assert.ok(!s.permissions.allow.some((r) => r.includes("post-review.mjs owner") || r.includes("post-review.mjs:")));
  assert.ok(s.permissions.allow.includes("Bash(node scripts/lanes/post-review.mjs --file:*)"));
  assert.ok(s.permissions.allow.includes("Bash(node scripts/lanes/post-review.mjs test-hunter:*)"));
  assert.ok(s.permissions.deny.includes("Bash(git push --force:*)"));
  // agent-skills is this repo's practice layer; two process frameworks must not compete (owner, 2026-09-26).
  assert.equal(s.enabledPlugins["superpowers@superpowers-marketplace"], false);
});

// ADR 0030 parts 2 and 4: the deny list holds exact-prefix rules, each in its Bash and PowerShell form.
const DENY_BASH = [
  "git push --force:*", "git push -f:*", "git push --force-with-lease:*",
  "claude --bg:*", "claude --background:*",
  "node scripts/lanes/queue.mjs:*", "node ./scripts/lanes/queue.mjs:*",
  "node scripts/lanes/start.mjs:*", "node ./scripts/lanes/start.mjs:*",
  "git tag:*", "git push --tags:*", "git push --follow-tags:*", "git push origin v*:*",
];
const DENY_POWERSHELL_EXTRA = [
  "node scripts\\lanes\\queue.mjs:*", "node .\\scripts\\lanes\\queue.mjs:*",
  "node scripts\\lanes\\start.mjs:*", "node .\\scripts\\lanes\\start.mjs:*",
];

test("settings: permissions.deny lists every ADR 0030 rule in its Bash and PowerShell forms, and no more", () => {
  const { deny } = JSON.parse(readFileSync(".claude/settings.json", "utf8")).permissions;
  const want = [
    ...DENY_BASH.map((r) => `Bash(${r})`),
    ...[...DENY_BASH.slice(3), ...DENY_POWERSHELL_EXTRA].map((r) => `PowerShell(${r})`),
  ];
  assert.deepEqual([...deny].sort(), want.sort());
  assert.equal(new Set(deny).size, deny.length, "no rule twice");
});

test("settings: every deny rule ends in a trailing :* and has no wildcard mid-pattern, but the ADR's tag-push prefix v*", () => {
  const { deny } = JSON.parse(readFileSync(".claude/settings.json", "utf8")).permissions;
  for (const rule of deny) {
    const body = rule.replace(/^(Bash|PowerShell)\(/, "").replace(/\)$/, "");
    assert.ok(body.endsWith(":*"), `${rule} ends in :*`);
    assert.equal(body.slice(0, -2).replace(/ v\*$/, "").includes("*"), false, `${rule} has a mid-pattern wildcard`);
  }
});

// I8: `npm run setup` (the pre-push hook) must be runnable without a permission prompt
test("settings: npm run setup and the delivery-metrics script are allowed", () => {
  const s = JSON.parse(readFileSync(".claude/settings.json", "utf8"));
  assert.ok(s.permissions.allow.includes("Bash(npm run setup)"));
  assert.ok(s.permissions.allow.includes("Bash(node scripts/lanes/delivery-metrics.mjs:*)"));
});

// #15: /lane step 2 checks blockers with blockers.mjs, which must run without a permission prompt
test("settings: the blockers script is allowed", () => {
  const s = JSON.parse(readFileSync(".claude/settings.json", "utf8"));
  assert.ok(s.permissions.allow.includes("Bash(node scripts/lanes/blockers.mjs:*)"));
});

test("lane.md step 2 runs blockers.mjs and stops on any non-zero exit", () => {
  const step2 = readFileSync(".claude/commands/lane.md", "utf8").match(/^2\. [\s\S]*?(?=^3\. )/m)[0];
  assert.match(step2, /`node scripts\/lanes\/blockers\.mjs \$ARGUMENTS`/);
  assert.match(step2, /non-zero exit/);
  assert.doesNotMatch(step2, /gh issue view <N> --json state/);
});

// #45: when reviewers.mjs names governing ADRs, the lane hands their paths on and the advisor checks the diff against them
test("lane.md step 6 tells a lane to record rounds in each verdict's metrics, failed runs included", () => {
  const step6 = readFileSync(".claude/commands/lane.md", "utf8").replace(/\r\n/g, "\n").match(/^6\. [\s\S]*?(?=^7\. )/m)[0].replace(/\s+/g, " ");
  assert.match(step6, /"metrics": \{ "tier", "minutes", "tokens", "rounds" \}/);
  assert.match(step6, /`rounds` is the number of runs of that reviewer for this verdict, failed ones included/);
});

test("lane.md step 6 hands the architecture-advisor the governing ADRs' paths when reviewers.mjs prints ADRs:", () => {
  const step6 = readFileSync(".claude/commands/lane.md", "utf8").replace(/\r\n/g, "\n").match(/^6\. [\s\S]*?(?=^7\. )/m)[0].replace(/\s+/g, " ");
  assert.match(step6, /When `reviewers\.mjs` also prints `ADRs: NNNN, \.\.\.`/);
  assert.match(step6, /give the architecture-advisor each one's path \(`docs\/adr\/NNNN-\*\.md`\)/);
});

test("architecture-advisor.md reads the given ADRs and fails the verdict when the diff contradicts an accepted ADR's Decision", () => {
  const text = readFileSync(".claude/agents/architecture-advisor.md", "utf8").replace(/\s+/g, " ");
  assert.match(text, /If you were given ADR paths \(`docs\/adr\/NNNN-\*\.md`\)[^.]*\. Read each one's Decision in full/);
  assert.match(text, /`verdict` must be `"failure"` if [^.]*, or if the diff contradicts the Decision of an accepted ADR you were given/);
});

// edge: a lane could edit the ADR file in its own PR to make the diff look compliant; the advisor must read
// the Decision from the default branch, not the PR's copy, or that dodge would go uncaught
test("architecture-advisor.md reads each given ADR's Decision from the default branch, not the PR's own copy", () => {
  const text = readFileSync(".claude/agents/architecture-advisor.md", "utf8").replace(/\s+/g, " ");
  assert.match(text, /on the default branch \(`git show origin\/main:<path>`\), since the PR's copy may differ/);
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

// ADR 0004: a new way to reach the owner approval is a minor follow-up; a regression stays critical
function acceptedRiskRule(name) {
  const text = readFileSync(`.claude/agents/${name}.md`, "utf8").replace(/\r\n/g, "\n");
  const match = text.match(/^Accepted risk \(ADR 0004\b[^)]*\):[\s\S]*?(?=\n\n|(?![\s\S]))/m);
  assert.ok(match, `${name}: no "Accepted risk (ADR 0004 ...):" paragraph`);
  return match[0].replace(/\s+/g, " ");
}

for (const name of ["security-reviewer", "test-hunter"]) {
  test(`${name} states ADR 0004's accepted-risk rule: new bypasses minor with a lane-filed follow-up, regressions critical`, () => {
    const rule = acceptedRiskRule(name);
    assert.match(rule, /docs\/adr\/0004-approve-guard-accepted-risk\.md/);
    assert.match(rule, /`post-review\.mjs owner`/);
    assert.match(rule, /`review\/owner`/);
    // within one sentence: a dot only counts as a sentence end when whitespace follows it (post-review.mjs has one)
    const sentence = (a, b) => new RegExp(`${a}(?:[^.]|\\.\\S)*${b}`);
    assert.match(rule, sentence("newly found way", "`post-review\\.mjs owner`(?:[^.]|\\.\\S)*`review/owner`(?:[^.]|\\.\\S)*\\bis `minor`"));
    assert.match(rule, sentence("follow-up issue", "`lane-filed`"));
    assert.match(rule, sentence("regression", "\\bis `critical`"));
    assert.match(rule, sentence("previously caught", "now passes"));
  });
}

test("the ADR 0004 rule is the same in both briefs", () => {
  assert.equal(acceptedRiskRule("security-reviewer"), acceptedRiskRule("test-hunter"));
});

// ADR 0030: the same rule for the deny rules and script refusals (start.mjs, queue.mjs, claude --bg, release tags)
function startGuardRule(name) {
  const text = readFileSync(`.claude/agents/${name}.md`, "utf8").replace(/\r\n/g, "\n");
  assert.doesNotMatch(text, /ADR 0007/, `${name}: the ADR 0007 paragraph is replaced`);
  const match = text.match(/^Accepted risk \(ADR 0030\b[^)]*\):[\s\S]*?(?=\n\n|(?![\s\S]))/m);
  assert.ok(match, `${name}: no "Accepted risk (ADR 0030 ...):" paragraph`);
  return match[0].replace(/\s+/g, " ");
}

for (const name of ["security-reviewer", "test-hunter"]) {
  test(`${name} states ADR 0030's accepted-risk rule for the deny rules: new bypasses minor with a lane-filed follow-up, regressions critical`, () => {
    const rule = startGuardRule(name);
    assert.match(rule, /docs\/adr\/0030-retire-start-guard-and-start\.md/);
    assert.match(rule, /`start\.mjs`/);
    assert.match(rule, /`queue\.mjs`/);
    assert.match(rule, /`claude --bg`/);
    const sentence = (a, b) => new RegExp(`${a}(?:[^.]|\\.\\S)*${b}`);
    assert.match(rule, sentence("newly found way", "`start\\.mjs`(?:[^.]|\\.\\S)*`queue\\.mjs`(?:[^.]|\\.\\S)*`claude --bg`(?:[^.]|\\.\\S)*\\bis `minor`"));
    assert.match(rule, sentence("follow-up issue", "`lane-filed`"));
    assert.match(rule, sentence("regression", "\\bis `critical`"));
    assert.match(rule, sentence("rules or refusals list now passes", ""));
  });
}

test("the ADR 0007 rule is the same in both briefs", () => {
  assert.equal(startGuardRule("security-reviewer"), startGuardRule("test-hunter"));
});

test("the ADR 0030 paragraph sits right after ADR 0004's in both briefs", () => {
  for (const name of ["security-reviewer", "test-hunter"]) {
    const text = readFileSync(`.claude/agents/${name}.md`, "utf8").replace(/\r\n/g, "\n");
    const first = text.indexOf("Accepted risk (ADR 0004");
    const second = text.indexOf("Accepted risk (ADR 0030");
    assert.ok(first >= 0 && second > first, `${name}: ADR 0030 paragraph must follow ADR 0004's`);
    assert.match(text.slice(first, second), /^[^\n]+(?:\n[^\n]+)*\n\n$/, `${name}: one paragraph between them`);
  }
});

test("the reviewer agents are installed into other repos", () => {
  const installText = readFileSync("scripts/lanes/install.mjs", "utf8");
  for (const name of AGENTS) assert.match(installText, new RegExp(`\\.claude/agents/${name}\\.md`), name);
});

test("every command file has a description", () => {
  for (const name of ["lane", "status", "adr", "health", "night", "plan-issues"]) {
    assert.match(readFileSync(`.claude/commands/${name}.md`, "utf8"), /^---\ndescription: .+/, name);
  }
});

// #616: the owner's /approve and /approvals commands and their guard are retired (ADR 0025); team approves in GitHub.
test("approve.md, approvals.md and approve-guard.mjs are gone", () => {
  for (const f of [".claude/commands/approve.md", ".claude/commands/approvals.md", "scripts/lanes/approve-guard.mjs", "scripts/lanes/approve-guard.test.mjs"]) {
    assert.equal(existsSync(f), false, f);
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

// One numbered step of lane.md, with line breaks and runs of spaces collapsed to one space.
const laneStep = (n) => laneText().replace(/\r\n/g, "\n").match(new RegExp(`\\n${n}\\. [\\s\\S]*?\\n${n + 1}\\. `))[0].replace(/\s+/g, " ");

// #105: a lane waits on the CI checks only, bounded, then reads lanes/gate once; it never watches the gate itself
test("lane.md step 7 waits only on the CI checks, not lanes/gate, with pipefail and at most 15 minutes, then reads the gate once", () => {
  const step7 = laneStep(7);
  assert.match(step7, /set -o pipefail/);
  const secs = step7.match(/timeout (\d+)/);
  assert.ok(secs, "step 7 bounds the wait with timeout");
  assert.ok(Number(secs[1]) > 0 && Number(secs[1]) <= 900, `timeout ${secs[1]} is over 15 minutes`);
  assert.match(step7, /gh run watch <id> --exit-status/);
  assert.match(step7, /select\(\.workflowName != "lanes-gate"\)/);
  assert.match(step7, /read `lanes\/gate`'s state and description on the PR head once/);
});

test("lane.md step 7 never pushes with --no-verify: a refusing hook stops the lane, comments the output and notifies", () => {
  const step7 = laneStep(7);
  assert.match(step7, /Never push with `--no-verify`, or skip a git hook any other way/);
  assert.match(step7, /stop, comment the hook's output on the PR or issue, and notify/);
});

test("lane.md step 7 writes every body and message to a file, never a heredoc or long quoted argument", () => {
  const step7 = laneStep(7);
  assert.match(step7, /Write every PR body, issue body, comment and commit message to a file with the Write tool/);
  assert.match(step7, /`--body-file <file>` or `git commit -F <file>`, never through a heredoc or a long quoted argument/);
});

test("lane.md step 7 runs a missing review the gate waits for, posts it, and reads the gate again", () => {
  const step7 = laneStep(7);
  assert.match(step7, /`waiting for review\/<name>`/);
  assert.match(step7, /run that reviewer as in step 6, post its verdict with `post-review\.mjs`, and read the gate again/);
});

test("lane.md step 6 posts a verdict with an unfixed critical or important finding as failure, never holds it back", () => {
  const step6 = laneStep(6);
  assert.match(step6, /A verdict with an unfixed critical or important finding is still posted, as `failure`/);
  assert.match(step6, /the gate reports the finding instead of waiting/);
});

test("lane.md step 7 stops at once on `waiting on owner (/approve)`, reports it and notifies, instead of watching", () => {
  const step7 = laneStep(7);
  assert.match(step7, /`waiting on owner \(\/approve\)`/);
  assert.match(step7, /stop right away/);
  assert.match(step7, /report "waiting on your \/approve"/);
  assert.match(step7, /needs \/approve: <the lanes\/gate reason>/);
});

test("lane.md step 7 stops at once on `waiting for a code-owner review in GitHub`, reports it with the PR URL and notifies", () => {
  const step7 = laneStep(7).replace(/\s+/g, " ");
  assert.match(step7, /`waiting for a code-owner review in GitHub`/);
  assert.match(step7, /report "waiting on your review in GitHub" with the gate's reason and the PR URL/);
  assert.match(step7, /needs your GitHub review: <the lanes\/gate reason>/);
});

test("edge: lane.md step 7 keeps the solo `/approve` branch unchanged beside the team one", () => {
  const step7 = laneStep(7);
  assert.match(step7, /`waiting on owner \(\/approve\)`: stop right away, report "waiting on your \/approve" with the gate's reason, and\s+notify `lanes #<N>: needs \/approve: <the lanes\/gate reason>`/);
});

test("CLAUDE.md rule 9 names each PR waiting for a code-owner review with its review link, and no /approve", () => {
  const rule9 = readFileSync("CLAUDE.md", "utf8").match(/^9\. [\s\S]*$/m)[0].replace(/\s+/g, " ");
  assert.match(rule9, /name each PR waiting for a code-owner review with its review link/);
  assert.doesNotMatch(rule9, /solo|\/approve/);
});

// #617 (ADR 0025 part 11): the written record matches the code
test("ADRs 0004 and 0015 are superseded by 0025; 0002, 0007 and 0019 each carry one dated 0025 note", () => {
  for (const f of ["0004-approve-guard-accepted-risk", "0015-owner-input"]) {
    assert.match(readFileSync(`docs/adr/${f}.md`, "utf8"), /^Status: superseded by 0025$/m);
  }
  for (const f of ["0002-owner-only-paths", "0007-start-guard-accepted-risk", "0019-team-identity-profile"]) {
    const text = readFileSync(`docs/adr/${f}.md`, "utf8");
    assert.match(text, /^Status: accepted$/m);
    assert.equal(text.match(/^\*Amended 2026-10-02 by ADR 0025 part 11:/gm)?.length, 1, f);
  }
});

test("USING.md and SECURITY.md carry no solo profile, /approve or /approvals text", () => {
  for (const f of ["docs/USING.md", "docs/SECURITY.md"]) {
    const text = readFileSync(f, "utf8").replace(/\(adr\/[^)]*\)/g, "");
    assert.doesNotMatch(text, /\bsolo\b|\/approve|\/approvals|approve[- ]guard|review\/owner|one GitHub account|own GitHub account/i, f);
  }
});

test("USING.md, SECURITY.md, OPERATIONS.md and README.md carry no /start and no start-guard (ADR 0030)", () => {
  for (const f of ["docs/USING.md", "docs/SECURITY.md", "docs/OPERATIONS.md", "README.md"]) {
    const text = readFileSync(f, "utf8").replace(/\(adr\/[^)]*\)/g, "");
    assert.doesNotMatch(text, /\/start\b|start[- ]guard/i, f);
  }
  const using = readFileSync("docs/USING.md", "utf8").replace(/\s+/g, " ");
  assert.match(using, /the queue \(below\) is the only launcher/);
  assert.match(using, /remove its `ready` label or press Pause/);
  assert.match(readFileSync("docs/SECURITY.md", "utf8"), /\[0030\]\(adr\/0030-retire-start-guard-and-start\.md\)/);
});

test("ADRs 0005, 0007, 0017 and 0025 carry a dated amendment note citing ADR 0030", () => {
  for (const f of ["0005-owner-run-lane-queue", "0007-start-guard-accepted-risk", "0017-ci-release-softpaths", "0025-retire-solo-profile"]) {
    assert.match(readFileSync(`docs/adr/${f}.md`, "utf8"), /\*Amended 2026-10-02 by ADR 0030:/, f);
  }
});

test("the retire-solo history note records the owner's words, the removals with line counts, what stayed and the setup", () => {
  const text = readFileSync("docs/history/2026-10-01-retire-solo-profile.md", "utf8");
  assert.match(text, /I do not want to maintain it/);
  assert.match(text, /3,546 deleted/);
  assert.match(text, /## What stayed/);
  assert.match(text, /app-setup\.mjs/);
  assert.doesNotMatch(text, /[A-Za-z]:\\|\/Users\//);
});

test("CLAUDE.md rules 6 and 7 follow ADR 0025: the owner's GitHub review, the App as the one setup", () => {
  const text = readFileSync("CLAUDE.md", "utf8").replace(/\s+/g, " ");
  assert.match(text, /`\/plan-issues`, the queue and the GitHub review are the owner's; never run, imitate or work around them from a lane, a schedule or another session\. A denial or refusal is reported, never routed around\./);
  assert.match(text, /the queue skips an issue whose Scope names none/);
  assert.doesNotMatch(text, /`\/start`/);
  assert.match(text, /Lanes act as the App bot \(ADR 0019\)/);
  assert.doesNotMatch(text, /solo|`\/approve`|approve guard|approve-guard/i);
});

test("lane.md step 7 reports a failed CI check by name, never a success", () => {
  const step7 = laneStep(7);
  assert.match(step7, /a failed or cancelled CI check, report it by name/);
  assert.match(step7, /never report success/);
});

test("edge: lane.md step 7 never runs gh pr checks --watch, which also waits on lanes/gate and cannot end while it waits on the owner", () => {
  assert.doesNotMatch(laneStep(7), /`gh pr checks [^`]*--watch/);
});

test("edge: lane.md step 7's commands use no loop or bash -c, which a worktree session refuses around gh", () => {
  // The commands to run, not the prose that names what to avoid (`bash -c`).
  const commands = laneStep(7).match(/`(gh|set|timeout) [^`]*`/g).join(" ");
  assert.doesNotMatch(commands, /bash -c|\bfor \w+ in\b|\buntil\b|\bwhile\b/);
});

test("edge: lane.md step 7 never pipes gh pr checks into tail or head, which hides a failed check's exit code", () => {
  assert.doesNotMatch(laneStep(7), /gh pr checks[^`]*\|\s*(tail|head)\b/);
});

test("edge: lane.md step 7 treats a wait that times out as unsettled, not as passed", () => {
  assert.match(laneStep(7), /exit 124[^.]*did not settle/i);
});

test("edge: lane.md step 7 re-lists runs once for a check that has no run yet, so a lane never hangs on a not-yet-started check", () => {
  assert.match(laneStep(7), /list again once if a check `gh pr checks` shows has no run yet/);
});

test("lane.md loads PushNotification via ToolSearch and caps each notification at one short `lanes #N:` line", () => {
  const lane = laneText();
  assert.match(lane, /ToolSearch/);
  assert.match(lane, /PushNotification/);
  assert.match(lane, /under\s+200 characters/);
  assert.match(lane, /`lanes #<PR or issue>: /);
});

// #37: a queued PR needs nothing from the owner, so step 7 only notifies when the gate waits on them
test("lane.md step 7 notifies only `needs /approve` with the gate reason once checks settle, never `queued to merge`", () => {
  const step7 = laneText().match(/\n7\. [\s\S]*?\n8\. /)[0];
  assert.match(step7, /checks settle/);
  assert.doesNotMatch(step7, /queued to merge/);
  assert.match(step7, /needs \/approve: <the lanes\/gate reason>/);
});

// #37: a lane stuck on a prompt cannot notify, so the harness's Notification hook does it
test("settings: the Notification hook runs notify-hook.mjs with node, for lane stops and completions", () => {
  const s = JSON.parse(readFileSync(".claude/settings.json", "utf8"));
  const entries = s.hooks.Notification ?? [];
  assert.equal(entries.length, 1);
  assert.equal(entries[0].matcher, "permission_prompt|agent_needs_input|elicitation_dialog|agent_completed");
  const [hook] = entries[0].hooks;
  assert.equal(hook.type, "command");
  assert.ok(hook.command.startsWith("node "), hook.command);
  assert.match(hook.command, /scripts\/lanes\/notify-hook\.mjs"?$/);
  assert.doesNotMatch(hook.command, /\bsh\b|bash|&&|\|/);
});

test("lane.md step 9 notifies `CI failed twice` before stopping", () => {
  const step9 = laneText().match(/\n9\. [\s\S]*?\n10\. /)[0];
  assert.match(step9, /CI failed twice: <cause>, see #<PR>/);
});

test("lane.md prefixes gh pr create, gh pr edit and gh issue create with MSYS_NO_PATHCONV=1 for --title or --body", () => {
  const line = laneText().split("\n").find((l) => l.includes("MSYS_NO_PATHCONV=1"));
  assert.ok(line, "lane.md names MSYS_NO_PATHCONV=1");
  for (const cmd of ["`gh pr create`", "`gh pr edit`", "`gh issue create`", "`--title`", "`--body`", "Git Bash"]) assert.ok(line.includes(cmd), `missing ${cmd}`);
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
  // an unattended run must never stall on the notification
  assert.match(night, /would need a\s+permission prompt, skip the notification/);
});

// security review of #28: notification text leaves the machine, so it must not carry paths, output or secrets
test("notification text never carries a path, output, secret or personal data", () => {
  assert.match(laneText(), /never a file\s+path, command or CI output, secret, token or personal data/);
  assert.match(readFileSync(".claude/commands/night.md", "utf8"), /never a path, output, secret or personal data/);
});

// #29: acceptance criteria are a minimum; lanes and the test-hunter test edge cases beyond them
test("lane.md step 5 treats the criteria as a minimum and lists edge-case tests as `edge: <case>`", () => {
  const step5 = laneText().match(/\n5\. [\s\S]*?\n6\. /)[0];
  assert.match(step5, /criteria are a\s+minimum/);
  assert.match(step5, /empty, boundary, malformed and\s+error inputs/);
  assert.match(step5, /"Tests added" as `edge: <case>`/);
});

// #136: a lane that finds every criterion already met on origin/main takes the issue out of the ready pool
const laneAlreadyMet = () => laneText().replace(/\r\n/g, "\n").match(/\n4c\. [\s\S]*?\n5\. /)[0].replace(/\s+/g, " ");

test("lane.md step 4c: criteria all met on origin/main are commented with evidence, then ready comes off and needs-owner goes on", () => {
  const step = laneAlreadyMet();
  assert.match(step, /every acceptance criterion is already met on `origin\/main`/);
  assert.match(step, /comments the evidence \(each criterion with the file, test or commit that meets it\)/);
  assert.match(step, /removes the `ready` label and adds `needs-owner`/);
  assert.match(step, /stops without a worktree change or PR/);
});

test("edge: lane.md step 4c creates needs-owner with gh label create only when it is missing, and never closes the issue", () => {
  const step = laneAlreadyMet();
  assert.match(step, /`gh label create needs-owner`[^.]*only if it is missing/);
  assert.match(step, /never closes the issue/);
});

test("edge: lane.md step 4c comments before it removes ready, so the evidence is on record even if the relabel fails", () => {
  const step = laneAlreadyMet();
  assert.ok(step.indexOf("comments the evidence") < step.indexOf("removes the `ready` label"));
});

// #666: a lane that stops for the owner says why on its issue (or PR), then takes the issue out of the running pool
const flatLane = () => laneText().replace(/\r\n/g, "\n");
const laneStopRule = () => flatLane().match(/\nStop comment \(#666\): [\s\S]*?\n0\. /)[0].replace(/\s+/g, " ");
const laneNumbered = (from, to) => flatLane().match(new RegExp(`\\n${from}\\. [\\s\\S]*?\\n${to}\\. `))[0].replace(/\s+/g, " ");

test("lane.md stop rule: every owner stop after step 1 comments `Lane stopped: <reason>` on the issue or PR, then swaps the labels", () => {
  const rule = laneStopRule();
  assert.match(rule, /comments on its issue \(on its PR when one exists\)/);
  assert.match(rule, /`Lane stopped: <reason>`/);
  assert.match(rule, /the cause and the owner's next step/);
  assert.match(rule, /removes `ready` and `lane:running` and adds `needs-owner`/);
  assert.match(rule, /`gh label create needs-owner`[^.]*only if it is missing/);
  assert.match(rule, /"A lane stopped and needs the owner; see its last comment"/);
});

test("lane.md stop rule: the label swap comes after the comment, so the cause is on record even if the relabel fails", () => {
  const rule = laneStopRule();
  assert.ok(rule.indexOf("comments on its issue") < rule.indexOf("removes `ready` and `lane:running`"));
});

test("lane.md stop rule: the comment holds no absolute path, transcript or personal data", () => {
  assert.match(laneStopRule(), /no absolute local path, no session transcript and no personal data/);
});

test("lane.md stop rule: steps 1 and 2 still do nothing on GitHub", () => {
  const rule = laneStopRule();
  assert.match(rule, /Steps 0, 1 and 2 do nothing on GitHub/);
  assert.match(laneNumbered("1", "2"), /Stop and report/);
});

test("lane.md step 4: a wrong or missing contract files the issue, then comments `Lane stopped: contract` with #N and the owner's steps, without editing the issue", () => {
  const step = laneNumbered("4", "4b");
  assert.match(step, /file a new task issue for the contract/);
  assert.match(step, /comments on its own issue before it stops/);
  assert.match(step, /`Lane stopped: contract`/);
  assert.match(step, /the filed issue as `#N`/);
  assert.match(step, /remove `lane-filed` from `#N`; add `#N` to this issue's "Blocked by"; then remove `needs-owner`/);
  assert.match(step, /never edits the issue's text/);
  assert.ok(step.indexOf("file a new task issue") < step.indexOf("comments on its own issue"));
});

test("lane.md step 5: a file outside Scope needed only because of a file this lane adds stops with `Lane stopped: Scope needs <paths>`, never a separate issue", () => {
  const step = laneNumbered("5", "6");
  assert.match(step, /`npm test` needs a file outside Scope only because of a file this lane adds/);
  assert.match(step, /does not file a separate issue for it/);
  assert.match(step, /`Lane stopped: Scope needs <paths>`/);
  assert.match(step, /each path and the check that needs it/);
  assert.match(step, /the owner extends this issue's Scope/);
});

test("lane.md step 4c: its needs-owner description matches the label list's", () => {
  assert.match(laneAlreadyMet(), /A lane stopped and needs the owner; see its last comment/);
});

test("test-hunter.md adds a case beyond the criteria and listed edge cases, or says in the summary why none apply", () => {
  const hunter = readFileSync(".claude/agents/test-hunter.md", "utf8");
  const flat = hunter.replace(/\s+/g, " ");
  assert.match(flat, /at least one test for a case not covered by the criteria or the listed `edge:` cases/);
  assert.match(flat, /state in the verdict `summary` why none apply/);
  const example = JSON.parse(hunter.match(/```json\n([\s\S]*?)\n```/)[1]);
  assert.match(example.summary, /^Extra case: \S/);
});

// #635: the gate notes files outside Scope; the template and the lane explain each one
test("the PR template has an Outside Scope section and lane.md step 7 tells the lane to fill it", () => {
  const section = readFileSync(".github/pull_request_template.md", "utf8").replace(/\r\n/g, "\n").match(/## Outside Scope\n([\s\S]*?)(\n## |$)/)[1];
  assert.match(section, /nothing/);
  assert.match(section, /One line per changed file/);
  assert.match(laneStep(7), /"Outside Scope" with one line per changed file outside the issue's Scope "In" saying why, or "nothing"/);
});

test("the PR template's Tests added comment mentions `edge:` lines", () => {
  const section = readFileSync(".github/pull_request_template.md", "utf8").match(/## Tests added\n([\s\S]*?)\n## /)[1];
  assert.match(section, /edge: <case>/);
});

// edge: the example summary's "Extra case:" prefix alone would still match `/^Extra case: \S/` even if shrunk to a
// single non-descriptive character, so a later edit could gut the example without failing the check above.
test("test-hunter.md's example summary names a real extra case, not just a placeholder character", () => {
  const hunter = readFileSync(".claude/agents/test-hunter.md", "utf8");
  const example = JSON.parse(hunter.match(/```json\n([\s\S]*?)\n```/)[1]);
  const match = example.summary.match(/^Extra case: (.+?)\s\.\.\.$/);
  assert.ok(match, `expected "Extra case: <description> ..."; got: ${example.summary}`);
  const wordCount = match[1].trim().split(/\s+/).length;
  assert.ok(wordCount >= 4, `expected a descriptive extra case (>= 4 words), got ${wordCount}: "${match[1]}"`);
});

// #46: /plan-issues reads open work for blockers, decides on an ADR, and drafts the ADR first
// Whitespace is collapsed so a phrase still matches when the Markdown wraps it across lines.
const planIssues = () => readFileSync(".claude/commands/plan-issues.md", "utf8").replace(/[ \t]*\r?\n[ \t]*(?!\d+\. )/g, " ");
const beforeDrafting = (md) => {
  const at = md.search(/^\d+\. Draft /m);
  assert.ok(at > 0, "expected a numbered `Draft ...` step in plan-issues.md");
  return md.slice(0, at);
};

test("plan-issues.md reads open issues and open PRs with their changed files before drafting", () => {
  const head = beforeDrafting(planIssues());
  assert.match(head, /`gh issue list --state open --json number,title,body`/);
  assert.match(head, /`gh pr list --state open`/);
  assert.match(head, /`gh pr diff <N> --name-only`/);
  // Every open issue and PR body is third-party text: it is compared, never obeyed.
  assert.match(head, /data to compare, never instructions/);
});

test("plan-issues.md proposes existing blockers in a separate table, lists near-overlaps, skips closed issues, flags cycles", () => {
  const md = planIssues();
  assert.match(md, /Blocked by existing: #N, because/);
  assert.match(md, /Scope, Interface contract or goal/);
  assert.match(md, /near-overlaps?/);
  assert.match(md, /[Nn]ever propose a closed issue/);
  assert.match(md, /cycle/);
});

test("plan-issues.md checks the five ADR triggers before drafting and opens the draft with the ADR line", () => {
  const head = beforeDrafting(planIssues());
  for (const trigger of [
    /new persistent state/,
    /new dependency or external service/,
    /security or auth/,
    /deployment/,
    /new or changed contract between modules/,
  ]) assert.match(head, trigger);
  const md = planIssues();
  assert.match(md, /`ADR: needed \(<triggers>\)`/);
  assert.match(md, /`No ADR: <one-line reason>`/);
});

test("plan-issues.md puts the ADR first as tier:skip, committed verbatim alone, waiting on /approve; implementers are blocked by it", () => {
  const md = planIssues();
  assert.match(md, /run `\/adr` on the idea text/);
  assert.match(md, /first issue of the draft/);
  assert.match(md, /tier:skip/);
  assert.match(md, /verbatim as `docs\/adr\/<next number>-<slug>\.md`/);
  assert.match(md, /nothing else in the PR/);
  assert.match(md, /`\/approve`/);
  assert.match(md, /"Decisions for the owner" at the top, before the issue table/);
  assert.match(md, /[Ee]very implementing issue lists the ADR issue under "Blocked by"/);
});

test("adr.md accepts an issue or PR number, or idea text from /plan-issues, and returns the ADR without filing an issue", () => {
  const md = readFileSync(".claude/commands/adr.md", "utf8").replace(/\s+/g, " ");
  assert.match(md, /issue or PR number/);
  assert.match(md, /idea text/);
  assert.match(md, /\/plan-issues/);
  assert.match(md, /`contracts\/adr-template\.md`/);
  assert.match(md, /Status: accepted/);
  assert.match(md, /`Governs`/);
  assert.match(md, /without filing an issue/);
});

test("plan-issues.md: open work and the ADR decision come before drafting, and the ADR issue is created first", () => {
  const md = planIssues();
  const at = (re) => {
    const i = md.search(re);
    assert.ok(i >= 0, `expected ${re} in plan-issues.md`);
    return i;
  };
  assert.ok(at(/gh issue list --state open/) < at(/five triggers/));
  assert.ok(at(/five triggers/) < at(/^\d+\. When an ADR is needed/m));
  assert.ok(at(/^\d+\. When an ADR is needed/m) < at(/^\d+\. Draft /m));
  assert.match(md, /the ADR issue first/);
});

// #131 (ADR 0008): the module map decides which module each drafted issue lives in.
const draftStep = () => {
  const md = planIssues();
  const at = md.search(/^\d+\. Draft /m);
  assert.ok(at >= 0, "expected a numbered `Draft ...` step in plan-issues.md");
  const rest = md.slice(at);
  const next = rest.slice(1).search(/^\d+\. /m);
  return next < 0 ? rest : rest.slice(0, next + 1);
};

test("plan-issues.md step 5 notes the modules an issue touches, lets one issue span modules, and puts a contract issue first only when consumed", () => {
  const step = draftStep();
  assert.match(step, /`modules` key in `lanes\.config\.json`/);
  assert.match(step, /module map exists/);
  assert.match(step, /notes the module\s+or modules it touches/);
  assert.match(step, /a note in the draft, not a field of the Task form/);
  assert.match(step, /One issue may span modules when the change is one feature/);
  assert.match(step, /a contract issue comes first only when another issue in the plan, or open work, consumes the interface it defines/);
  // No such check exists in issue-contract.mjs, so the old rule must be gone.
  assert.doesNotMatch(step, /exactly one module/);
  assert.doesNotMatch(step, /issue-contract\.mjs/);
  // With no map the step must not invent modules.
  assert.match(step, /no `modules` key[^.]*skip this/);
});

test("plan-issues.md step 5 sizes issues at roughly 100 to 300 changed lines, guards and gate near 200, and cites the measurement", () => {
  const step = draftStep().replace(/\s+/g, " ");
  assert.match(step, /roughly 100 to 300 changed lines, tests included/);
  assert.match(step, /changes to the gate \(`gate\.mjs`, `lib\.mjs`'s gate decision\) near 200/);
  assert.doesNotMatch(step, /-guard\.mjs|shell-lex/);
  assert.match(step, /split anything over 300/);
  assert.match(step, /merge related changes smaller than about 100 lines into one issue/);
  assert.match(step, /unless they need different tiers or one is a contract another issue consumes/);
  assert.match(step, /docs\/history\/2026-09-30-lane-size-and-cost\.md/);
  // edge: the old 50-to-150 range and 30-line merge floor contradict the new numbers.
  assert.doesNotMatch(step, /50 to 150/);
  assert.doesNotMatch(step, /fewer than about 30 lines/);
});

test("plan-issues.md step 4 commits the ADR in the one implementing issue's PR, and is unchanged for two or more", () => {
  const md = planIssues();
  const at = md.search(/^\d+\. When an ADR is needed/m);
  const step = md.slice(at).split(/^\d+\. /m)[1].replace(/\s+/g, " ");
  assert.match(step, /exactly one implementing issue, the ADR is committed in that issue's PR/);
  assert.match(step, /byte-identical to the approved text/);
  assert.match(step, /no separate tier:skip ADR issue/);
  assert.match(step, /two or more implementing issues, this step is unchanged/);
});

test("plan-issues.md step 5 checks open issues for the same files before drafting and proposes extending one", () => {
  const step = draftStep();
  assert.match(step, /[Bb]efore drafting a new issue, check the open issues from step 2/);
  assert.match(step, /changes the same files for a related goal/);
  assert.match(step, /propose extending it instead/);
  assert.match(step, /#145 was merged into #105/);
});

// #203: Scope must include the files the criteria force a lane to change (#82 missed both kinds).
test("plan-issues.md step 5: the issue creating a new file registers its prefix in lanes.config.json; no separate module-map issue", () => {
  const step = draftStep().replace(/\s+/g, " ");
  assert.match(step, /the issue that creates a new file the map does not claim adds the file's prefix \(for example `scripts\/lanes\/release\.`\) to the named module's `paths` in `lanes\.config\.json` and lists `lanes\.config\.json` in its Scope "In"/);
  assert.match(step, /there is no separate issue for it/);
  assert.doesNotMatch(step, /Module map: register/);
  // edge: the rule applies only with a module map.
  assert.ok(
    step.indexOf("With a module map, the issue that creates a new file") >= 0,
    "the registration rule must sit inside the with-a-map clause",
  );
});

test("plan-issues.md step 6 no longer lists a module-map issue in the draft's issue table", () => {
  const md = planIssues();
  const at = md.search(/^\d+\. Show the owner the draft/m);
  assert.ok(at >= 0, "expected a `Show the owner the draft` step");
  const step = md.slice(at).split(/^\d+\. /m)[1].replace(/\s+/g, " ");
  assert.doesNotMatch(step, /module-map issue/);
});

test("ADR 0008 carries the 2026-10-01 amendment: sized by lines, may span modules, issue-contract check withdrawn", () => {
  const adr = readFileSync("docs/adr/0008-module-map.md", "utf8").replace(/\s+/g, " ");
  assert.match(adr, /## Amendment \(2026-10-01\)/);
  assert.match(adr, /sized by changed lines, not by module, and may span modules/);
  assert.match(adr, /never implemented and is withdrawn/);
});

// #634: one helper finds the tests a draft affects or pins, instead of the planner's own grep.
test("plan-issues.md step 5 runs scope-tests.mjs per issue, adds each listed test to Scope \"In\" and shows them in the draft", () => {
  const step = draftStep().replace(/\s+/g, " ");
  assert.match(step, /run `node scripts\/lanes\/scope-tests\.mjs --paths <path>\.\.\. --strings <text>\.\.\.`/);
  assert.match(step, /the issue's Scope "In" paths/);
  assert.match(step, /every string, command, path or permission the criteria change \(workflow lines included, such as a `verify\.yml` step\)/);
  assert.match(step, /add each listed test to Scope "In"/);
  assert.match(step, /show the added tests in the draft/);
  assert.doesNotMatch(step, /Always grep the existing tests/);
});

// edge: the helper run is unconditional, so it must not sit inside the module-map-only skip clause.
test("plan-issues.md step 5 scope-tests run is unconditional, not gated on a module map", () => {
  const step = draftStep();
  assert.match(step, /Always run `node scripts\/lanes\/scope-tests\.mjs/);
  assert.ok(
    step.indexOf("Always run `node scripts/lanes/scope-tests.mjs") > step.indexOf("With no `modules` key, skip this."),
    "the helper run must come after the module-map skip clause so `skip this` cannot swallow it",
  );
});

test("plan-issues.md steps are numbered 1..N without gaps or repeats", () => {
  const steps = [...planIssues().matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));
  assert.ok(steps.length > 0);
  assert.deepEqual(steps, steps.map((_, i) => i + 1));
});

test("adr.md's argument-hint names both modes", () => {
  const hint = readFileSync(".claude/commands/adr.md", "utf8").match(/^argument-hint: (.+)$/m)[1];
  assert.match(hint, /issue-or-pr-number/);
  assert.match(hint, /idea text/);
});

// Edge case beyond the listed criteria: the pre-existing issue-or-PR-number mode is edited by this same diff
// (to add the template/format wording) but no other test pins its behavior, so a careless edit could silently
// make it stop filing its own issue/PR or drop the link back, and nothing above would catch it.
test("adr.md's issue-or-PR-number mode still files its own issue and PR and links back, unlike the idea-text mode", () => {
  const [numberMode, ideaMode] = readFileSync(".claude/commands/adr.md", "utf8")
    .replace(/\s+/g, " ")
    .split(/\*\*Idea text from/);
  assert.match(numberMode, /in its own tier:skip task issue and PR/);
  assert.match(numberMode, /link it from #\$ARGUMENTS/);
  assert.doesNotMatch(ideaMode, /link it from #\$ARGUMENTS/);
  assert.match(ideaMode, /without filing an issue or opening a PR yourself/);
});

// #115: /health and /status run the lanes scripts from an up-to-date main, so a stale checkout never reports
// or acts with old code. Each file's pull step comes before its first lanes script run. (/start is retired, #675.)
const commandText = (name) => readFileSync(`.claude/commands/${name}.md`, "utf8").replace(/\s+/g, " ");

for (const name of ["health", "status"]) {
  test(`${name}.md pulls main with --ff-only, only on a clean main, before running any lanes script`, () => {
    const md = commandText(name);
    const pull = md.indexOf("git pull --ff-only");
    assert.ok(pull >= 0, "no git pull --ff-only step");
    assert.ok(pull < md.indexOf("node scripts/lanes/"), "the pull must come before the first lanes script run");
    assert.match(md, /`git branch --show-current` prints `main` and `git status --porcelain` prints nothing/);
  });

  test(`${name}.md reports a failed fast-forward and carries on instead of stopping`, () => {
    assert.match(commandText(name), /If the pull fails, report its error in one line and carry on/);
  });

  test(`${name}.md prints one stale-scripts line and carries on when not on a clean main`, () => {
    assert.match(
      commandText(name),
      /Otherwise print one line, `lanes scripts may be stale: this checkout is not a clean main`, and carry on/,
    );
  });
}

// #232: CI also runs the suite on Windows and on Node 24
const verifyYml = () => readFileSync(".github/workflows/verify.yml", "utf8");

test("verify.yml's test job matrix covers ubuntu-latest on Node 22 and 24, and windows-latest on Node 22", () => {
  const yml = verifyYml();
  assert.match(yml, /- os: ubuntu-latest\n\s+node: 22\n/);
  assert.match(yml, /- os: ubuntu-latest\n\s+node: 24\n/);
  assert.match(yml, /- os: windows-latest\n\s+node: 22\n/);
  assert.match(yml, /run: node scripts\/lanes\/test-retry\.mjs/);
});

// edge: the matrix must hold exactly the three named entries, not grow an unlisted fourth combination
// (e.g. windows + node 24 as a required leg) that the acceptance criteria's substring checks would miss.
test("verify.yml's matrix has exactly three entries, and none is informational", () => {
  const yml = verifyYml();
  assert.equal((yml.match(/^\s*- os: /gm) ?? []).length, 3);
  assert.doesNotMatch(yml, /informational/);
});

// #232: a final job named verify needs the matrix and fails when any required entry fails
test("verify.yml's final job is named verify, needs the test matrix, and fails the required check when it doesn't succeed", () => {
  const yml = verifyYml();
  assert.match(yml, /\n {2}verify:\n {4}needs: \[test, test-macos\]\n {4}if: always\(\)\n/);
  assert.match(yml, /needs\.test\.result != 'success'/);
});

// #413: pull requests run the affected tests, the queue and main run everything, macOS runs at merge only
test("verify.yml's pull_request step runs npm run test:files over affected-tests.mjs's files (#621), or npm test on ALL, with enough history", () => {
  const yml = verifyYml();
  assert.match(yml, /fetch-depth: 0/);
  assert.match(yml, /- if: github\.event_name == 'pull_request'\n\s+shell: bash\n/);
  assert.match(yml, /node scripts\/lanes\/affected-tests\.mjs "origin\/\$BASE_REF"/);
  assert.match(yml, /BASE_REF: \$\{\{ github\.base_ref \}\}/);
  assert.match(yml, /"\$files" = "ALL" \]; then\n\s+npm test\n\s+else\n\s+npm run test:files -- \$files\n/);
});

test("edge: verify.yml treats an empty affected-tests answer as ALL, never as a bare node --test", () => {
  assert.match(verifyYml(), /\[ -z "\$files" \] \|\| \[ "\$files" = "ALL" \]/);
});

test("verify.yml runs the full suite through test-retry.mjs on merge_group and push whatever affected-tests.mjs would print (#637)", () => {
  const yml = verifyYml();
  assert.match(yml, /- if: github\.event_name != 'pull_request'\n\s+run: node scripts\/lanes\/test-retry\.mjs\n/);
  // test-retry.mjs is never the pull_request step
  assert.equal((yml.match(/test-retry\.mjs/g) ?? []).length, 2);
  // the affected-tests call sits only under the pull_request condition
  assert.equal((yml.match(/affected-tests\.mjs/g) ?? []).length, 1);
  const before = yml.slice(0, yml.indexOf("affected-tests.mjs"));
  assert.match(before.slice(before.lastIndexOf("- if:")), /github\.event_name == 'pull_request'/);
});

test("verify.yml's macOS job runs the full suite through test-retry.mjs on Node 22 on merge_group and push only, and verify treats it as required except when skipped on pull_request", () => {
  const yml = verifyYml();
  assert.match(yml, /\n {2}test-macos:\n {4}if: github\.event_name != 'pull_request'\n {4}runs-on: macos-latest\n/);
  const job = yml.slice(yml.indexOf("  test-macos:"), yml.indexOf("  verify:"));
  assert.match(job, /node-version: 22\n/);
  assert.match(job, /- run: node scripts\/lanes\/test-retry\.mjs\n/);
  assert.match(yml, /needs\.test-macos\.result != 'success' && \(github\.event_name != 'pull_request' \|\| needs\.test-macos\.result != 'skipped'\)/);
});

// #249: the windows entry is promoted to required: no continue-on-error anywhere, so a Windows failure fails
// needs.test.result and with it the required verify check
test("verify.yml's windows entry is required: no continue-on-error, so a windows failure blocks the merge", () => {
  const yml = verifyYml();
  assert.doesNotMatch(yml, /continue-on-error/);
  assert.doesNotMatch(yml, /Informational until/);
  assert.match(yml, /- os: windows-latest\n\s+node: 22\n/);
});

test("verify.yml's matrix uses fail-fast: false, so one failing entry does not cancel the others", () => {
  assert.match(verifyYml(), /strategy:\n {6}fail-fast: false\n/);
});

test("verify.yml pins actions/checkout and actions/setup-node by full commit SHA with a version comment, and keeps contents: read", () => {
  const yml = verifyYml();
  assert.match(yml, /uses: actions\/checkout@[0-9a-f]{40} # v\d+/);
  assert.match(yml, /uses: actions\/setup-node@[0-9a-f]{40} # v\d+/);
  assert.match(yml, /\npermissions:\n {2}contents: read\n/);
});

// #232: Dependabot keeps the SHA-pinned Actions current, grouped into one PR, nothing else
test("dependabot.yml updates github-actions weekly, grouped into one PR, and declares no other ecosystem", () => {
  const yml = readFileSync(".github/dependabot.yml", "utf8");
  assert.match(yml, /package-ecosystem: "github-actions"/);
  assert.match(yml, /interval: "weekly"/);
  assert.match(yml, /groups:\n {6}github-actions:/);
  assert.equal((yml.match(/package-ecosystem:/g) ?? []).length, 1);
});

// edge: the verify job must run even when the test job fails outright, or a required check would go missing
// (skipped) instead of reporting failure, which a branch-protection ruleset would not catch as a block.
test("edge: verify.yml's final job runs on always(), so a hard test failure reports as a failed check, not a skipped one", () => {
  assert.match(verifyYml(), /\n {2}verify:\n {4}needs: \[test, test-macos\]\n {4}if: always\(\)\n/);
});

// #238: /lane hands lessons to reviewers and records fragments; /health proposes checks for recurring patterns
const flatFile = (p) => readFileSync(p, "utf8").replace(/\r\n/g, "\n").replace(/\s+/g, " ");
const lessonsLaneStep = (n, next) => readFileSync(".claude/commands/lane.md", "utf8").replace(/\r\n/g, "\n").match(new RegExp(`^${n}\\. [\\s\\S]*?(?=^${next}\\. )`, "m"))[0].replace(/\s+/g, " ");

test("lane.md step 4b runs lessons.mjs --paths on the Scope and gives the output to the test-hunter and security reviewer", () => {
  const s = lessonsLaneStep("4b", "4c");
  assert.match(s, /node scripts\/lanes\/lessons\.mjs --paths <the issue's Scope paths>/);
  assert.match(s, /test-hunter and security reviewer/);
  assert.match(s, /known patterns to look for/);
});

test("lane.md step 5 loops on validate.mjs for a validate: criterion, tables the attempts under it, and stops on exit 2 with the best value", () => {
  const s = lessonsLaneStep("5", "6");
  assert.match(s, /`validate:` criterion/);
  assert.match(s, /node scripts\/lanes\/validate\.mjs --issue \$ARGUMENTS --criterion <index>/);
  assert.match(s, /until it exits 0 or 2/);
  assert.match(s, /attempt table under that criterion in "What changed"/);
  assert.match(s, /exit 2 reports the best value and stops/);
});

test("lane.md step 1 makes a spike issue findings only: no test-first, and the PR adds only a findings file or an ADR draft", () => {
  const s = lessonsLaneStep("1", "2");
  assert.match(s, /labelled `spike`/);
  assert.match(s, /skips test-first/);
  assert.match(s, /adds only a findings file or an ADR draft/);
});

test("lane.md step 6 writes a docs/lessons.d fragment per fixed critical or important finding and runs lessons.mjs --check", () => {
  const s = lessonsLaneStep("6", "7");
  assert.match(s, /severity critical or important and `fixed: true`/);
  assert.match(s, /docs\/lessons\.d\/<area>-<pattern>-<issue>\.md/);
  assert.match(s, /reusing an existing pattern slug/);
  assert.match(s, /node scripts\/lanes\/lessons\.mjs --check/);
  assert.match(s, /gate does not require fragments/);
});

test("health.md runs lessons.mjs --recurring and files a lane-filed quick Task per pattern without an open lesson:<area>/<pattern> issue", () => {
  const s = flatFile(".claude/commands/health.md");
  assert.match(s, /node scripts\/lanes\/lessons\.mjs --recurring/);
  assert.match(s, /lesson:<area>\/<pattern>/);
  assert.match(s, /`lane-filed` Task issue \(tier quick\)/);
  assert.match(s, /not the architecture advisor/);
});

// #242: one weekly advisor pass checks the week's merged changes against the ADRs that govern them
test("health.md step 8 hands the same advisor spawn the week's merged files with their governing ADRs and files at most 3 ADR-drift issues", () => {
  const s = flatFile(".claude/commands/health.md");
  assert.match(s, /files changed by lane PRs merged in the window/);
  assert.match(s, /gh pr list --state merged --json files/);
  assert.match(s, /accepted ADRs governing each/);
  assert.match(s, /at most 3 ADR-drift issues/);
  assert.match(s, /naming the ADR and the file/);
  assert.match(s, /same spawn as the structural report/);
  assert.match(s, /not a second subagent/);
});

// #354: entering by `path` prompts the owner and leaves the session cwd at the repo root; `name` does neither
test("lane.md step 3 creates the worktree with the EnterWorktree tool's `name` (issue-$ARGUMENTS-<short-slug>)", () => {
  const step3 = laneStep(3).replace(/\s+/g, " ");
  assert.match(step3, /EnterWorktree tool's `name` parameter set to `issue-\$ARGUMENTS-<short-slug>`/);
});

test("lane.md step 3 renames the branch with the single command git branch -m issue-$ARGUMENTS-<short-slug> before any other work", () => {
  const step3 = laneStep(3).replace(/\s+/g, " ");
  assert.equal(step3.split("git branch -m").length - 1, 1);
  assert.ok(step3.includes("`git branch -m issue-$ARGUMENTS-<short-slug>`"));
  assert.match(step3, /before any other work/);
  assert.ok(step3.indexOf("git branch -m") < step3.indexOf("npm run setup"));
});

test("lane.md keeps git worktree add -b as the fallback outside Claude Code and never enters a worktree by path", () => {
  const text = readFileSync(".claude/commands/lane.md", "utf8").replace(/\s+/g, " ");
  const step3 = laneStep(3).replace(/\s+/g, " ");
  assert.match(step3, /Outside Claude Code \(no EnterWorktree\)/);
  assert.ok(step3.includes("git worktree add -b issue-$ARGUMENTS-<short-slug> .claude/worktrees/issue-$ARGUMENTS-<short-slug> origin/main"));
  assert.doesNotMatch(text, /EnterWorktree[^.]*`path`/);
  assert.doesNotMatch(text, /enter it with the EnterWorktree/);
});

// #476: an existing issue-<N> worktree is resumed, never duplicated; entering it by path prompts the owner, so the
// lane stops and notifies instead (the #354/#366 finding, which this pins as the chosen wording).
test("lane.md step 3 lists worktrees first and stops for an existing or several issue worktrees instead of making a second", () => {
  const step3 = laneStep(3);
  assert.ok(step3.indexOf("git worktree list") > -1 && step3.indexOf("git worktree list") < step3.indexOf("`name` parameter"));
  assert.match(step3, /never make a second one/);
  assert.match(step3, /notify `lanes #\$ARGUMENTS: resume the existing worktree`/);
  assert.match(step3, /several worktrees for the issue/);
  assert.match(laneText().replace(/\s+/g, " "), /3b\. Resuming \(#444, #476\)[^]*Never open a second PR/);
});

test("lane.md step 3 runs npm run setup, then the POSIX tools check, in the worktree", () => {
  const step3 = laneStep(3);
  const setup = step3.indexOf("npm run setup");
  const check = step3.indexOf("command -v head ls wc grep");
  assert.ok(setup > -1 && check > setup);
});

// #327: guidance on how to read and wait, so lanes and reviewers take fewer turns
test("lane.md has a Working economically block: batch calls, narrow reads, narrow tests, one blocking wait, Edit not Write", () => {
  const text = readFileSync(".claude/commands/lane.md", "utf8").replace(/\s+/g, " ");
  assert.match(text, /Working economically/);
  assert.match(text, /independent tool calls in one turn/);
  assert.match(text, /reuse it rather than calling `gh issue view` again/);
  assert.match(text, /`grep -n` or Grep and read only that range/);
  assert.match(text, /run only the changed test file while iterating/);
  assert.match(text, /one blocking command \(`gh run watch <id>`\), never a polling loop/);
  assert.match(text, /Edit, not Write/);
});

test("lane.md never watches lanes/gate: the one blocking wait is gh run watch, not gh pr checks --watch", () => {
  const text = readFileSync(".claude/commands/lane.md", "utf8").replace(/\s+/g, " ");
  assert.match(text, /never give `gh pr checks` a `--watch`/);
  assert.doesNotMatch(text, /one blocking command \([^)]*gh pr checks <N> --watch/);
});

test("test-hunter, security-reviewer and architecture-advisor start from git diff --stat and never run the full diff twice", () => {
  for (const name of ["test-hunter", "security-reviewer", "architecture-advisor"]) {
    const text = readFileSync(`.claude/agents/${name}.md`, "utf8").replace(/\s+/g, " ");
    assert.match(text, /start from `git diff --stat origin\/main\.\.\.HEAD`/, name);
    assert.match(text, /read `git diff origin\/main\.\.\.HEAD -- <file>` only for the files in your remit/, name);
    assert.match(text, /never run the full diff twice/, name);
    assert.match(text, /read files by range, not whole/, name);
  }
});

test("lane.md step 3 checks the POSIX tools after setup, records the PATH shape, stops, and never prefixes export PATH", () => {
  const step3 = readFileSync(".claude/commands/lane.md", "utf8").match(/^3\. [\s\S]*?(?=^4\. )/m)[0].replace(/\s+/g, " ");
  assert.match(step3, /`command -v head ls wc grep` as its own command/);
  assert.match(step3, /\.lanes\/logs\/path-\$ARGUMENTS\.txt/);
  assert.match(step3, /number of PATH entries/);
  assert.match(step3, /`\/usr\/bin` and `\/mingw64\/bin`/);
  assert.match(step3, /never the full PATH/);
  assert.match(step3, /lanes #\$ARGUMENTS: shell PATH broken/);
  assert.match(step3, /Never prefix commands with `export PATH=…` or change PATH/);
});

const SCRATCH_RULE =
  "scratch, probe and fuzz files go in `.lanes/scratch/` inside the lane's worktree (already gitignored) and are deleted before the verdict; never write outside the lane's worktree, and never into another checkout of the repository.";

const PROBE_RULE =
  "Keep guard probe payloads out of the Bash command text, since the guards scan it: write the cases with the Write tool where you have it, otherwise hand the probe to the test-hunter, and never retry a refused heredoc. A guard refusal of a probe is noted in the verdict, never rephrased or obfuscated to get past it.";

for (const agent of ["security-reviewer", "test-hunter"]) {
  test(`${agent} keeps scratch and probe files in .lanes/scratch/, never another checkout`, () => {
    const md = readFileSync(`.claude/agents/${agent}.md`, "utf8").replace(/\s+/g, " ");
    assert.ok(md.includes(SCRATCH_RULE), `${agent}.md lacks the scratch-file rule`);
    assert.ok(!md.includes("os.tmpdir()"), `${agent}.md still names os.tmpdir()`);
  });

  test(`${agent} keeps guard probe payloads out of Bash text and notes refusals`, () => {
    const md = readFileSync(`.claude/agents/${agent}.md`, "utf8").replace(/\s+/g, " ");
    assert.ok(md.includes(PROBE_RULE), `${agent}.md lacks the probe-payload rule`);
  });
}

// A CODEOWNERS pattern as a regex, for the gitignore-style forms .github/CODEOWNERS uses: a leading or inner slash
// anchors it to the root, a trailing slash matches a directory's contents, `*` stays within one path segment, and a
// pattern that names a directory also covers everything under it.
function codeownersRegex(pattern) {
  const dir = pattern.endsWith("/");
  const core = pattern.replace(/^\/|\/$/g, "");
  const anchored = pattern.startsWith("/") || core.includes("/");
  const body = core.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*");
  return new RegExp(`${anchored ? "^" : "(^|/)"}${body}${dir ? "/" : "(/|$)"}`);
}

// ADR 0026 part 1: the queue holds the App key and re-executes what it pulls, so every file it loads is an owner path.
// The closure is queue.mjs, every relative module it imports (static, re-exported or dynamic with a literal), and every
// scripts/lanes script a file in it spawns (spelled `join(root, "scripts", "lanes", "x.mjs")`, as start.mjs does; a path
// inside a message string is not a spawn), each with its .test.mjs file.
export function queueClosure(entry = "scripts/lanes/queue.mjs") {
  const seen = new Set();
  const todo = [entry];
  const refs = (text) => [
    ...[...text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["'](\.\.?\/[^"']+\.mjs)["']/g)].map((m) => ["relative", m[1]]),
    ...[...text.matchAll(/"scripts",\s*"lanes",\s*"([\w.-]+\.mjs)"/g)].map((m) => ["lanes", m[1]]),
  ];
  while (todo.length) {
    const file = todo.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const dir = file.slice(0, file.lastIndexOf("/"));
    for (const [kind, ref] of refs(readFileSync(file, "utf8").replace(/^\s*\/\/.*$/gm, ""))) {
      const next = kind === "lanes" ? `scripts/lanes/${ref}` : new URL(ref, `file:///${dir}/`).pathname.slice(1);
      if (existsSync(next)) todo.push(next);
    }
  }
  for (const file of [...seen]) if (!file.endsWith(".test.mjs") && existsSync(file.replace(/\.mjs$/, ".test.mjs"))) seen.add(file.replace(/\.mjs$/, ".test.mjs"));
  return [...seen].sort();
}

test("every file in the queue's import and spawn closure is an owner path, with its test (ADR 0026)", () => {
  const owner = JSON.parse(readFileSync("lanes.config.json", "utf8")).paths.owner.map((s) => new RegExp(s));
  const closure = queueClosure();
  for (const f of ["scripts/lanes/queue.mjs", "scripts/lanes/queue.test.mjs", "scripts/lanes/start.mjs", "scripts/lanes/reap.mjs", "scripts/lanes/lib.mjs"]) assert.ok(closure.includes(f), `the closure misses ${f}: the computation is broken`);
  const uncovered = closure.filter((f) => !owner.some((r) => r.test(f)));
  assert.deepEqual(uncovered, [], `queue.mjs loads these files but paths.owner does not match them: ${uncovered.join(", ")}`);
});

test("edge: queueClosure follows a literal dynamic import, a re-export and a spawned script path, and ignores comments", () => {
  assert.ok(queueClosure().includes("scripts/lanes/cleanup.mjs"), "status.mjs's dynamic import of cleanup.mjs");
  assert.ok(queueClosure().includes("scripts/lanes/lane-cost.mjs"), "start.mjs's re-export");
  assert.ok(queueClosure().includes("scripts/lanes/reap.mjs"), "start.mjs's spawn of reap.mjs");
  assert.ok(!queueClosure().includes("scripts/lanes/gate-decision.mjs"));
});

// ADR 0019 part 6: CODEOWNERS lists exactly the owner-only paths, so a native code-owner review covers what /approve does (#520).
test("CODEOWNERS covers exactly the files paths.owner covers", () => {
  const entries = readFileSync(".github/CODEOWNERS", "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  for (const e of entries) assert.match(e, /^\S+ @SourE-dev$/, `CODEOWNERS line not owned by the owner alone: ${e}`);
  const owners = entries.map((e) => codeownersRegex(e.split(" ")[0]));
  const owner = JSON.parse(readFileSync("lanes.config.json", "utf8")).paths.owner.map((s) => new RegExp(s));
  const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean);
  const samples = [".env.local", "x/.env", "a/auth/x.js", "secret/x", "secrets/x", "deploy/x", "sub/CLAUDE.md", "sub/yarn.lock", "sub/pnpm-lock.yaml", "package-lock.json", "lanes.lock.json"];
  for (const f of samples) assert.ok(owner.some((r) => r.test(f)), `sample ${f} is not an owner path; update the samples`);
  const paths = [...tracked, ...samples];
  for (const f of paths) {
    assert.equal(owners.some((r) => r.test(f)), owner.some((r) => r.test(f)), `CODEOWNERS and paths.owner disagree on ${f}`);
  }
  // Every entry on both sides is exercised, so a typo in one no path reaches cannot hide: add a sample for a new one.
  entries.forEach((e, i) => assert.ok(paths.some((f) => owners[i].test(f)), `no tracked file or sample reaches CODEOWNERS entry ${e}; add a sample`));
  owner.forEach((r) => assert.ok(paths.some((f) => r.test(f)), `no tracked file or sample reaches paths.owner ${r.source}; add a sample`));
});

// ADR 0029 part 4: the one-click apply workflow
const applyYml = () => readFileSync(".github/workflows/lanes-workflow-apply.yml", "utf8");
const jobBlock = (yml, name) => new RegExp(`\\n  ${name}:\\n([\\s\\S]*?)(?=\\n  [a-z][a-z-]*:\\n|$)`).exec(yml)?.[1] ?? "";

test("lanes-workflow-apply triggers only on issue_comment created", () => {
  const yml = applyYml();
  assert.match(yml, /\non:\n  issue_comment:\n    types: \[created\]\n/);
  assert.doesNotMatch(yml, /\n  (push|pull_request|pull_request_target|workflow_dispatch|workflow_run|schedule):/);
});

test("lanes-workflow-apply has the filter job without an environment and the apply job behind the environment", () => {
  const yml = applyYml();
  const filter = jobBlock(yml, "filter");
  const apply = jobBlock(yml, "apply");
  assert.ok(filter && apply, "expected a filter and an apply job");
  assert.doesNotMatch(filter, /environment:/);
  assert.doesNotMatch(filter, /secrets\./);
  assert.match(apply, /needs: filter/);
  assert.match(apply, /if: needs\.filter\.outputs\.go == 'true'/);
  assert.match(apply, /environment: lanes-workflow-apply/);
});

test("lanes-workflow-apply grants nothing at the top and the filter job only contents and pull-requests read", () => {
  const yml = applyYml();
  assert.match(yml, /\npermissions: \{\}\n/);
  assert.match(jobBlock(yml, "filter"), /permissions:\n      contents: read\n      pull-requests: read\n/);
  assert.match(jobBlock(yml, "apply"), /permissions:\n      contents: read\n/);
  assert.doesNotMatch(yml, /: write/);
});

test("lanes-workflow-apply serialises per PR and cancels an older waiting run", () => {
  const yml = applyYml();
  assert.match(yml, /concurrency:\n(  #.*\n)*  group: lanes-workflow-apply-\$\{\{ github\.event\.issue\.number \}\}-/);
  assert.match(yml, /\n  cancel-in-progress: true/);
});

test("edge: lanes-workflow-apply gives a non-bot commenter its own group so it cannot cancel a pending approval", () => {
  const group = /\n  group: (.*)/.exec(applyYml())[1];
  assert.match(group, /endsWith\(github\.event\.comment\.user\.login, '\[bot\]'\) && 'bot' \|\| github\.run_id/);
});

test("lanes-workflow-apply pins every action to a full commit SHA, as the other workflows do", () => {
  const uses = [...applyYml().matchAll(/uses: (\S+)/g)].map((m) => m[1]);
  assert.ok(uses.length >= 4);
  for (const u of uses) assert.match(u, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, u);
});

test("lanes-workflow-apply checks out the default branch, never the PR head, and keeps no credentials", () => {
  const yml = applyYml();
  const refs = [...yml.matchAll(/\n\s+ref: (.*)/g)].map((m) => m[1]);
  assert.equal(refs.length, 2, "both jobs check out");
  for (const ref of refs) assert.equal(ref, "${{ github.event.repository.default_branch }}");
  assert.doesNotMatch(yml, /head\.(sha|ref)|refs\/pull|pull_request\.head/);
  assert.equal([...yml.matchAll(/persist-credentials: false/g)].length, 2);
});

test("lanes-workflow-apply passes comment and PR fields through env: only, never into a run script", () => {
  const yml = applyYml();
  // A `${{ }}` inside a `run:` value would be shell interpolation; none may appear there.
  const runs = [...yml.matchAll(/\n\s+run: (\|\n(?:\s{10,}.*\n?)+|.*)/g)].map((m) => m[1]);
  assert.ok(runs.length >= 3, "expected the filter and two apply run steps");
  for (const r of runs) assert.doesNotMatch(r, /\$\{\{/, r.slice(0, 60));
  assert.match(yml, /COMMENT_BODY: \$\{\{ github\.event\.comment\.body \}\}/);
  assert.match(yml, /COMMENT_LOGIN: \$\{\{ github\.event\.comment\.user\.login \}\}/);
  assert.match(yml, /LANES_COMMENT_ID: \$\{\{ github\.event\.comment\.id \}\}/);
  assert.match(yml, /LANES_PR: \$\{\{ github\.event\.issue\.number \}\}/);
  assert.match(yml, /APP_KEY: \$\{\{ secrets\.LANES_WORKFLOWS_KEY \}\}/);
});

test("lanes-workflow-apply runs workflow-apply.mjs filter and apply and mints through app-token.mjs, not an inline script", () => {
  const yml = applyYml();
  assert.match(yml, /run: node scripts\/lanes\/workflow-apply\.mjs filter/);
  assert.match(yml, /run: node scripts\/lanes\/workflow-apply\.mjs apply/);
  assert.match(yml, /run: node scripts\/lanes\/app-token\.mjs workflows\n/);
  assert.doesNotMatch(yml, /node --input-type|createSign|GITHUB_ENV/);
  assert.match(yml, /vars\.LANES_WORKFLOWS_APP_ID/);
});

test("edge: lanes-workflow-apply reads the key only in the apply job", () => {
  const yml = applyYml();
  assert.doesNotMatch(jobBlock(yml, "filter"), /LANES_WORKFLOWS/);
  assert.equal([...yml.matchAll(/secrets\.[A-Z_]+/g)].length, 1);
});

// #694: GitHub can refuse a push for a workflow file the branch does not touch, when main has moved
test("lane.md step 7 merges origin/main and pushes again when a push is refused for a workflow file the range does not touch, and reports it in the PR", () => {
  const step7 = laneStep(7);
  assert.match(step7, /refused for a workflow file the range does not touch/);
  assert.match(step7, /git merge origin\/main/);
  assert.match(step7, /push again/);
  assert.match(step7, /report the refusal in the PR/);
});
