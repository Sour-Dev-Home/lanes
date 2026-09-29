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

test("settings: the owner's approval is guarded by hooks, never allowed by a rule; reviewers are allowed; no force push", () => {
  const s = JSON.parse(readFileSync(".claude/settings.json", "utf8"));
  // A PreToolUse allow cannot skip an ask rule (#30), so approve-guard.mjs replaces the ask rule as the barrier.
  const hook = (event, matcher) => s.hooks[event].find((h) => h.matcher === matcher)?.hooks.map((x) => x.command).join("\n") ?? "";
  assert.match(hook("UserPromptSubmit", undefined), /scripts\/lanes\/approve-guard\.mjs" user-prompt-submit$/);
  assert.match(hook("PreToolUse", "Bash"), /scripts\/lanes\/approve-guard\.mjs" pre-tool-use$/);
  assert.ok(!(s.permissions.ask ?? []).some((r) => r.includes("post-review.mjs owner")));
  assert.ok(!s.permissions.allow.some((r) => r.includes("post-review.mjs owner") || r.includes("post-review.mjs:")));
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

// ADR 0007: the same rule for the start guard (start.mjs, queue.mjs, claude --bg)
function startGuardRule(name) {
  const text = readFileSync(`.claude/agents/${name}.md`, "utf8").replace(/\r\n/g, "\n");
  const match = text.match(/^Accepted risk \(ADR 0007\b[^)]*\):[\s\S]*?(?=\n\n|(?![\s\S]))/m);
  assert.ok(match, `${name}: no "Accepted risk (ADR 0007 ...):" paragraph`);
  return match[0].replace(/\s+/g, " ");
}

for (const name of ["security-reviewer", "test-hunter"]) {
  test(`${name} states ADR 0007's accepted-risk rule for the start guard: new bypasses minor with a lane-filed follow-up, regressions critical`, () => {
    const rule = startGuardRule(name);
    assert.match(rule, /docs\/adr\/0007-start-guard-accepted-risk\.md/);
    assert.match(rule, /`start\.mjs`/);
    assert.match(rule, /`queue\.mjs`/);
    assert.match(rule, /`claude --bg`/);
    const sentence = (a, b) => new RegExp(`${a}(?:[^.]|\\.\\S)*${b}`);
    assert.match(rule, sentence("newly found way", "`start\\.mjs`(?:[^.]|\\.\\S)*`queue\\.mjs`(?:[^.]|\\.\\S)*`claude --bg`(?:[^.]|\\.\\S)*\\bis `minor`"));
    assert.match(rule, sentence("follow-up issue", "`lane-filed`"));
    assert.match(rule, sentence("regression", "\\bis `critical`"));
    assert.match(rule, sentence("previously caught", "now passes"));
  });
}

test("the ADR 0007 rule is the same in both briefs", () => {
  assert.equal(startGuardRule("security-reviewer"), startGuardRule("test-hunter"));
});

test("the ADR 0007 paragraph sits right after ADR 0004's in both briefs", () => {
  for (const name of ["security-reviewer", "test-hunter"]) {
    const text = readFileSync(`.claude/agents/${name}.md`, "utf8").replace(/\r\n/g, "\n");
    const first = text.indexOf("Accepted risk (ADR 0004");
    const second = text.indexOf("Accepted risk (ADR 0007");
    assert.ok(first >= 0 && second > first, `${name}: ADR 0007 paragraph must follow ADR 0004's`);
    assert.match(text.slice(first, second), /^[^\n]+(?:\n[^\n]+)*\n\n$/, `${name}: one paragraph between them`);
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

// #275: /approve <N> [<N>...] approves up to 10 PRs, each with its own view, diff, SHA, owner post and merge.
test("approve.md loops over every PR number, each with its own view, diff, owner post on its own SHA, and merge", () => {
  const md = readFileSync(".claude/commands/approve.md", "utf8").replace(/\r\n/g, "\n");
  assert.match(md, /^argument-hint: <pr-number> \[<pr-number>\.\.\.\]$/m);
  const flat = md.replace(/\s+/g, " ");
  assert.match(flat, /[Ff]or each PR number <N> in `\$ARGUMENTS`, in order/);
  assert.match(flat, /at most 10 distinct/);
  assert.match(flat, /`gh pr view <N> --json title,body,headRefOid`/);
  assert.match(flat, /"Needs the owner"/);
  assert.match(flat, /"Contract changes"/);
  assert.match(flat, /`gh pr diff <N> --name-only`/);
  assert.match(flat, /`node scripts\/lanes\/post-review\.mjs owner success "approved by owner" --pr <N> --sha <that PR's headRefOid>`/);
  assert.match(flat, /never another PR's/);
  assert.match(flat, /`gh pr merge <N> --auto`/);
  assert.match(flat, /[Oo]ne PR that fails does not stop the others/);
  assert.match(flat, /report lists each PR's outcome/);
  // No step uses the whole argument list where one PR number belongs.
  assert.doesNotMatch(flat, /(pr view|pr diff|pr merge|--pr) \$ARGUMENTS/);
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

test("test-hunter.md adds a case beyond the criteria and listed edge cases, or says in the summary why none apply", () => {
  const hunter = readFileSync(".claude/agents/test-hunter.md", "utf8");
  const flat = hunter.replace(/\s+/g, " ");
  assert.match(flat, /at least one test for a case not covered by the criteria or the listed `edge:` cases/);
  assert.match(flat, /state in the verdict `summary` why none apply/);
  const example = JSON.parse(hunter.match(/```json\n([\s\S]*?)\n```/)[1]);
  assert.match(example.summary, /^Extra case: \S/);
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

test("plan-issues.md step 5 names each issue's module from the map, and adds a blocking contract issue for one spanning modules", () => {
  const step = draftStep();
  assert.match(step, /`modules` key in `lanes\.config\.json`/);
  assert.match(step, /module map exists/);
  assert.match(step, /names its module from the map/);
  assert.match(step, /exactly one module/);
  assert.match(step, /spans more than one module/);
  assert.match(step, /adds the contract issue first and lists it under "Blocked by"/);
  // ADR 0008: the spanning issue clears issue-contract.mjs only if its contract path is in the blocker's Scope.
  assert.match(step, /a note in the draft, not a field of the Task form/);
  assert.match(step, /Interface contract naming a path that the contract issue's Scope contains/);
  // With no map the step must not invent modules.
  assert.match(step, /no `modules` key[^.]*skip this/);
});

test("plan-issues.md step 5 sizes issues at roughly 50 to 150 changed lines and merges two tiny issues that share a file", () => {
  const step = draftStep();
  assert.match(step, /roughly 50 to 150 changed lines/);
  assert.match(step, /fewer than about 30 lines/);
  assert.match(step, /share a file/);
  assert.match(step, /merge them into one issue/);
  assert.match(step, /unless they need different tiers or one is a contract the other depends on/);
  // The old "100 lines or less" cap contradicts the new range, so it must be gone.
  assert.doesNotMatch(step, /roughly 100 changed lines/);
});

test("plan-issues.md step 5 checks open issues for the same files before drafting and proposes extending one", () => {
  const step = draftStep();
  assert.match(step, /[Bb]efore drafting a new issue, check the open issues from step 2/);
  assert.match(step, /changes the same files for a related goal/);
  assert.match(step, /propose extending it instead/);
  assert.match(step, /#145 was merged into #105/);
});

// #203: Scope must include the files the criteria force a lane to change (#82 missed both kinds).
test("plan-issues.md step 5 checks each new file against the module map and adds the lanes.config.json entry to Scope", () => {
  const step = draftStep();
  assert.match(step, /for each new file a draft names, check that the module map in `lanes\.config\.json` claims it/);
  assert.match(step, /add the `lanes\.config\.json` entry to Scope when it doesn't/);
  // edge: with no map there is nothing to claim a file, so the check is conditional on a map.
  assert.match(step, /With a module map, for each new file a draft names/);
});

test("plan-issues.md step 5 greps the existing tests for strings the draft changes and adds each pinning test to Scope", () => {
  const step = draftStep();
  assert.match(step, /grep the existing tests for strings the draft changes \(a permission, env name, pinned text\)/);
  assert.match(step, /add each test that pins one to Scope/);
});

// edge: the test grep is unconditional, so it must not sit inside the module-map-only skip clause.
test("plan-issues.md step 5 test grep is unconditional, not gated on a module map", () => {
  const step = draftStep();
  assert.match(step, /Always grep the existing tests/);
  assert.ok(
    step.indexOf("Always grep the existing tests") > step.indexOf("With no `modules` key, skip this."),
    "the test grep must come after the module-map skip clause so `skip this` cannot swallow it",
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

// #115: /health, /status and /start run the lanes scripts from an up-to-date main, so a stale checkout never reports
// or acts with old code. Each file's pull step comes before its first lanes script run.
const commandText = (name) => readFileSync(`.claude/commands/${name}.md`, "utf8").replace(/\s+/g, " ");

for (const name of ["health", "status", "start"]) {
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

// Edge: a lane or a schedule must stop before touching git, so start.md's refusal stays ahead of its pull step.
test("start.md still refuses a lane or a schedule before its pull step", () => {
  const md = commandText("start");
  assert.ok(md.indexOf("stop now") < md.indexOf("git pull --ff-only"));
});

// Edge (beyond the criteria): start-guard.mjs allows start.mjs only as a standalone plain command (#51). If a model
// chained the new pull step onto the start.mjs run (`git pull --ff-only && node scripts/lanes/start.mjs ...`), the
// guard would deny the whole compound command and /start would stop working. start.md must say to run the git
// commands on their own instead.
test("start.md tells the model to run its pull step on its own, never chained to the guarded start.mjs run", () => {
  assert.match(
    commandText("start"),
    /Run each of these git commands on its own, never chained to the `start\.mjs` run below/,
  );
});

// #232: CI also runs the suite on Windows and on Node 24
const verifyYml = () => readFileSync(".github/workflows/verify.yml", "utf8");

test("verify.yml's test job matrix covers ubuntu-latest on Node 22 and 24, and windows-latest on Node 22", () => {
  const yml = verifyYml();
  assert.match(yml, /- os: ubuntu-latest\n\s+node: 22\n/);
  assert.match(yml, /- os: ubuntu-latest\n\s+node: 24\n/);
  assert.match(yml, /- os: windows-latest\n\s+node: 22\n/);
  assert.match(yml, /- run: npm test/);
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
  assert.match(yml, /\n {2}verify:\n {4}needs: test\n {4}if: always\(\)\n/);
  assert.match(yml, /needs\.test\.result != 'success'/);
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
  assert.match(verifyYml(), /\n {2}verify:\n {4}needs: test\n {4}if: always\(\)\n/);
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
