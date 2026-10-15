// Copies the lanes workflow into another repository: node scripts/lanes/install.mjs <target-dir> [--force]
// Existing files are kept unless --force. Afterwards edit the target's lanes.config.json paths for its layout.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  ".github/workflows/lanes-workflow-apply.yml",
  ".github/workflows/lanes-control.yml",
  ".github/workflows/lanes-review-ping.yml",
  ".githooks/pre-push",
  ".claude/settings.json",
  ".claude/agents/test-hunter.md",
  ".claude/agents/security-reviewer.md",
  ".claude/agents/ui-reviewer.md",
  ".claude/agents/architecture-advisor.md",
  ".claude/commands/lane.md",
  ".claude/commands/status.md",
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
  "vendor/owasp-cheatsheets/LICENSE",
  "vendor/owasp-cheatsheets/VENDORED.md",
  "vendor/owasp-cheatsheets/INDEX.md",
  "vendor/owasp-cheatsheets/sheets/Authentication_Cheat_Sheet.md",
  "vendor/owasp-cheatsheets/sheets/Authorization_Cheat_Sheet.md",
  "vendor/owasp-cheatsheets/sheets/CI_CD_Security_Cheat_Sheet.md",
  "vendor/owasp-cheatsheets/sheets/Content_Security_Policy_Cheat_Sheet.md",
  "vendor/owasp-cheatsheets/sheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.md",
  "vendor/owasp-cheatsheets/sheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.md",
  "vendor/owasp-cheatsheets/sheets/Docker_Security_Cheat_Sheet.md",
  "vendor/owasp-cheatsheets/sheets/Input_Validation_Cheat_Sheet.md",
  "vendor/owasp-cheatsheets/sheets/Logging_Cheat_Sheet.md",
  "vendor/owasp-cheatsheets/sheets/Nodejs_Security_Cheat_Sheet.md",
  "vendor/owasp-cheatsheets/sheets/OAuth2_Cheat_Sheet.md",
  "vendor/owasp-cheatsheets/sheets/OS_Command_Injection_Defense_Cheat_Sheet.md",
  "vendor/owasp-cheatsheets/sheets/REST_Security_Cheat_Sheet.md",
  "vendor/owasp-cheatsheets/sheets/Secrets_Management_Cheat_Sheet.md",
  "vendor/owasp-cheatsheets/sheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.md",
  "vendor/owasp-cheatsheets/sheets/Session_Management_Cheat_Sheet.md",
  ".gitignore",
  ".gitattributes",
  "scripts/preflight.mjs",
  "scripts/lanes/lib.mjs",
  "scripts/lanes/gate.mjs",
  "scripts/lanes/issue-contract.mjs",
  "scripts/lanes/post-review.mjs",
  "scripts/lanes/reviewers.mjs",
  "scripts/lanes/status.mjs",
  "scripts/lanes/queue.mjs",
  "scripts/lanes/start.mjs",
  "scripts/lanes/reap.mjs",
  "scripts/lanes/app-token.mjs",
  "scripts/lanes/health.mjs",
  "scripts/lanes/scope-tests.mjs",
  "scripts/lanes/affected-tests.mjs",
  "scripts/lanes/setup-repo.mjs",
  "scripts/lanes/delivery-metrics.mjs",
  "scripts/lanes/graphql-lib.mjs",
  "scripts/lanes/notify-hook.mjs",
  "scripts/lanes/blockers.mjs",
  "scripts/lanes/identity-check.mjs",
  "scripts/lanes/app-setup.mjs",
  "scripts/lanes/handover.mjs",
  "scripts/lanes/workflow-apply.mjs",
  "scripts/lanes/control.mjs",
  "scripts/lanes/pick.mjs",
  "scripts/lanes/paths.mjs",
  "scripts/lanes/cleanup.mjs",
  "scripts/lanes/consolidate.mjs",
  "scripts/lanes/lane-cost.mjs",
  "scripts/lanes/review-metrics.mjs",
  "scripts/lanes/modules.mjs",
  "scripts/lanes/structure-report.mjs",
  "scripts/lanes/lessons.mjs",
  "scripts/lanes/validate.mjs",
  "scripts/lanes/snapshot.mjs",
  "contracts/snapshot.schema.json",
  ".github/workflows/dashboard.yml",
  "dashboard/index.html",
  "dashboard/app.js",
  "dashboard/style.css",
  "docs/USING.md",
];

// GitHub Pages sites are public even for a private repository (ADR 0012), so this workflow is only live in a public one.
const DASHBOARD_WORKFLOW = ".github/workflows/dashboard.yml";
const LOCK = "lanes.lock.json";
const CONFIG = "lanes.config.json";

/**
 * A target's lanes.config.json: this repo's required checks and generic path rules, and nothing about lanes itself (no
 * modules, identity, metrics or thresholds), so the scripts' defaults apply until the adopter sets their own.
 */
export function starterConfig(lanesConfig) {
  const { requiredChecks, paths } = structuredClone(lanesConfig);
  // ADR 0034 part 5: an adopter's PRs are not all lane PRs, so the gate passes the others on a code-owner review.
  return { requiredChecks, paths, gate: { nonLanePrs: true } };
}

/** The shipped files an adopter may leave out with `install.skip` in lanes.config.json (ADR 0034 part 1). */
export const OPTIONAL = [".github/workflows/security.yml", ".github/workflows/dashboard.yml"];

/**
 * The `install.skip` list of the target's lanes.config.json; empty when the file, the key or readable JSON is missing.
 * @throws {Error} when it is not a list of strings, or names a file outside OPTIONAL: nothing is written then.
 */
export function readInstallSkip(target) {
  let config;
  try {
    config = JSON.parse(readFileSync(path.join(target, CONFIG), "utf8"));
  } catch {
    return [];
  }
  const skip = config?.install?.skip;
  if (skip === undefined) return [];
  if (!Array.isArray(skip) || skip.some((s) => typeof s !== "string")) throw new Error(`${CONFIG}: install.skip must be a list of strings`);
  const bad = skip.find((s) => !OPTIONAL.includes(s));
  if (bad !== undefined) throw new Error(`${CONFIG}: install.skip names ${JSON.stringify(bad)}, which is not optional (optional: ${OPTIONAL.join(", ")})`);
  return skip;
}

/** The lines lanes needs in an adopter's .gitignore (#772): the queue's own files must never make the checkout look dirty. */
export const GITIGNORE_LINES = [".lanes/"];
const GITIGNORE_COMMENT = "# lanes";

const ignoreKey = (line) => line.trim().replace(/^\//, "").replace(/\/$/, "");

/** The GITIGNORE_LINES an existing target .gitignore lacks (`/.lanes/` and `.lanes` count as `.lanes/`); none when it has no .gitignore. */
export function missingGitignoreLines(target) {
  const file = path.join(target, ".gitignore");
  if (!existsSync(file)) return [];
  const have = new Set(readFileSync(file, "utf8").split(/\r?\n/).map(ignoreKey));
  return GITIGNORE_LINES.filter((l) => !have.has(ignoreKey(l)));
}

/** Appends the missing lines under one comment line and changes nothing else in the file. @returns {string[]} the lines added */
export function ensureGitignoreLines(target) {
  const missing = missingGitignoreLines(target);
  if (!missing.length) return missing;
  const file = path.join(target, ".gitignore");
  const text = readFileSync(file, "utf8");
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lead = text === "" || text.endsWith("\n") ? "" : eol;
  writeFileSync(file, `${text}${lead}${[GITIGNORE_COMMENT, ...missing].join(eol)}${eol}`);
  return missing;
}

/**
 * Copies MANIFEST into `target`. Unless `isPublic`, the dashboard workflow is copied as `dashboard.yml.disabled`, which
 * GitHub ignores; renaming it turns the dashboard on. An existing `dashboard.yml` is never replaced by a disabled copy.
 * @returns {{ copied: string[], skipped: string[], disabled: string[] }} `disabled` lists the files copied disabled
 */
export function install(source, target, { force = false, isPublic = false } = {}) {
  const copied = [];
  const skipped = [];
  const disabled = [];
  const optedOut = readInstallSkip(target); // before any write: an invalid entry copies nothing
  for (const rel of MANIFEST) {
    if (optedOut.includes(rel)) continue;
    if (rel === CONFIG) {
      // #747: never lanes' own config, and never overwritten, --force included.
      const to = path.join(target, rel);
      if (existsSync(to)) {
        skipped.push(rel);
        continue;
      }
      mkdirSync(path.dirname(to), { recursive: true });
      writeFileSync(to, `${JSON.stringify(starterConfig(JSON.parse(readFileSync(path.join(source, rel), "utf8"))), null, 2)}\n`);
      copied.push(rel);
      continue;
    }
    const off = rel === DASHBOARD_WORKFLOW && !isPublic;
    if (off && existsSync(path.join(target, rel))) {
      skipped.push(rel);
      continue;
    }
    const dest = off ? `${rel}.disabled` : rel;
    const to = path.join(target, dest);
    if (existsSync(to) && !force) {
      skipped.push(dest);
      continue;
    }
    mkdirSync(path.dirname(to), { recursive: true });
    copyFileSync(path.join(source, rel), to);
    copied.push(dest);
    if (off) disabled.push(rel);
  }
  // After the lock: a .gitignore lanes copied already holds every GITIGNORE_LINES entry (a test pins it), so its hash stays valid.
  const lockPath = path.join(target, LOCK);
  if (force || !existsSync(lockPath)) writeLock(source, target, copied, lockPath);
  const gitignore = ensureGitignoreLines(target);
  return { copied, skipped, disabled, gitignore, optedOut };
}

/** lanes.lock.json (contracts/lanes-lock.schema.json): the version and the sha256 of each file written, never the lock or the config. */
function writeLock(source, target, copied, lockPath) {
  const { version } = JSON.parse(readFileSync(path.join(source, "package.json"), "utf8"));
  const files = {};
  for (const dest of copied.filter((f) => f !== "lanes.config.json").sort())
    files[dest] = createHash("sha256").update(readFileSync(path.join(target, dest))).digest("hex");
  writeFileSync(lockPath, `${JSON.stringify({ version, files }, null, 2)}\n`);
}

const ghRepoView = (target) => execFileSync("gh", ["repo", "view", "--json", "isPrivate"], { cwd: target, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000, windowsHide: true });

/** True only when gh says the target's repository is not private; any failure or odd answer counts as private. */
export function repoIsPublic(target, run = ghRepoView) {
  try {
    return JSON.parse(run(target)).isPrivate === false;
  } catch {
    return false;
  }
}

/** `--public` or `--private` decides; without either, gh is asked. */
export function publicFromArgs(argv, run = ghRepoView) {
  const [isPublic, isPrivate] = [argv.includes("--public"), argv.includes("--private")];
  if (isPublic && isPrivate) throw new Error("--public and --private are exclusive: pass one, not both");
  if (isPublic || isPrivate) return isPublic;
  return repoIsPublic(argv[0], run);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const target = process.argv[2];
  if (!target) throw new Error("usage: install.mjs <target-dir> [--force] [--public|--private]");
  let r;
  try {
    r = install(".", target, { force: process.argv.includes("--force"), isPublic: publicFromArgs([target, ...process.argv.slice(3)]) });
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  if (r.optedOut.length) console.log(`left out by install.skip: ${r.optedOut.join(", ")}`);
  console.log(`copied ${r.copied.length}, kept ${r.skipped.length} existing${r.skipped.length ? `: ${r.skipped.join(", ")}` : ""}`);
  if (r.gitignore.length) console.log(`added to .gitignore: ${r.gitignore.join(", ")}`);
  if (r.disabled.length) console.log("The dashboard workflow is disabled (the repository is private or unknown); rename dashboard.yml.disabled to enable it. Pages sites are public.");
  console.log("Next: edit lanes.config.json paths for your layout, add `setup` and `preflight` npm scripts, then run setup-repo.mjs (owner).");
}
