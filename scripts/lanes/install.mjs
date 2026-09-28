// Copies the lanes workflow into another repository: node scripts/lanes/install.mjs <target-dir> [--force]
// Existing files are kept unless --force. Afterwards edit the target's lanes.config.json paths for its layout.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MANIFEST = [
  "lanes.config.json",
  ".github/ISSUE_TEMPLATE/task.yml",
  ".github/ISSUE_TEMPLATE/config.yml",
  ".github/pull_request_template.md",
  ".github/workflows/lanes-gate.yml",
  ".github/workflows/issue-contract.yml",
  ".github/workflows/security.yml",
  ".githooks/pre-push",
  ".claude/settings.json",
  ".claude/agents/test-hunter.md",
  ".claude/agents/security-reviewer.md",
  ".claude/agents/ui-reviewer.md",
  ".claude/agents/architecture-advisor.md",
  ".claude/commands/lane.md",
  ".claude/commands/status.md",
  ".claude/commands/approve.md",
  ".claude/commands/adr.md",
  ".claude/commands/health.md",
  ".claude/commands/night.md",
  ".claude/commands/plan-issues.md",
  ".claude/skills/api-and-interface-design/SKILL.md",
  ".claude/skills/code-review-and-quality/SKILL.md",
  ".claude/skills/debugging-and-error-recovery/SKILL.md",
  ".claude/skills/frontend-ui-engineering/SKILL.md",
  ".claude/skills/incremental-implementation/SKILL.md",
  ".claude/skills/planning-and-task-breakdown/SKILL.md",
  ".claude/skills/security-and-hardening/SKILL.md",
  ".claude/skills/test-driven-development/SKILL.md",
  "vendor/agent-skills/LICENSE",
  "vendor/agent-skills/VENDORED.md",
  "vendor/agent-skills/references/accessibility-checklist.md",
  "vendor/agent-skills/references/definition-of-done.md",
  "vendor/agent-skills/references/security-checklist.md",
  "vendor/agent-skills/references/testing-patterns.md",
  ".gitignore",
  ".gitattributes",
  "scripts/preflight.mjs",
  "scripts/lanes/lib.mjs",
  "scripts/lanes/gate.mjs",
  "scripts/lanes/issue-contract.mjs",
  "scripts/lanes/post-review.mjs",
  "scripts/lanes/reviewers.mjs",
  "scripts/lanes/status.mjs",
  "scripts/lanes/setup-repo.mjs",
  "scripts/lanes/delivery-metrics.mjs",
  "scripts/lanes/approve-guard.mjs",
  "scripts/lanes/start-guard.mjs",
  "scripts/lanes/notify-hook.mjs",
  "scripts/lanes/blockers.mjs",
  "scripts/lanes/pick.mjs",
  "scripts/lanes/cleanup.mjs",
  "scripts/lanes/review-metrics.mjs",
  "docs/USING.md",
];

export function install(source, target, { force = false } = {}) {
  const copied = [];
  const skipped = [];
  for (const rel of MANIFEST) {
    const to = path.join(target, rel);
    if (existsSync(to) && !force) {
      skipped.push(rel);
      continue;
    }
    mkdirSync(path.dirname(to), { recursive: true });
    copyFileSync(path.join(source, rel), to);
    copied.push(rel);
  }
  return { copied, skipped };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const target = process.argv[2];
  if (!target) throw new Error("usage: install.mjs <target-dir> [--force]");
  const r = install(".", target, { force: process.argv.includes("--force") });
  console.log(`copied ${r.copied.length}, kept ${r.skipped.length} existing${r.skipped.length ? `: ${r.skipped.join(", ")}` : ""}`);
  console.log("Next: edit lanes.config.json, add `setup` and `preflight` npm scripts, then run setup-repo.mjs (owner).");
}
