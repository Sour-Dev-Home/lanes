// scripts/lanes/setup-repo.mjs
// OWNER ONLY. Configures a GitHub repo for lanes: merge settings, labels, CodeQL default setup, and the main ruleset.
// Usage: node scripts/lanes/setup-repo.mjs <owner/repo>
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DEFAULT_REQUIRED_CHECKS = ["verify", "security", "lanes/gate"];

/**
 * #747: a raw read of requiredChecks. loadConfig also refuses a team config with no CODEOWNERS (ADR 0031), but in init's
 * order CODEOWNERS is committed after this script runs, and the ruleset only needs the check names.
 */
export function readRequiredChecks(file = "lanes.config.json") {
  try {
    const list = JSON.parse(readFileSync(file, "utf8"))?.requiredChecks;
    if (Array.isArray(list) && list.length > 0 && list.every((c) => typeof c === "string" && c !== "")) return list;
  } catch {
    // a missing or unreadable file means the defaults
  }
  return DEFAULT_REQUIRED_CHECKS;
}

export const LABELS = [
  { name: "tier:skip", color: "c5def5", description: "Docs, config or tests only" },
  { name: "tier:quick", color: "fbca04", description: "UI or a small fix" },
  { name: "tier:full", color: "d93f0b", description: "Logic, data, APIs or security" },
  { name: "ready", color: "0e8a16", description: "Task contract complete; a lane may start" },
  { name: "contract:breaking", color: "b60205", description: "This task may break an interface contract" },
  { name: "digest", color: "5319e7", description: "The nightly digest thread" },
  { name: "lane-filed", color: "bfd4f2", description: "A lane's own follow-up; needs the owner to remove this label before it can become ready" },
  { name: "needs-owner", color: "fef2c0", description: "A lane stopped and needs the owner; see its last comment" },
];

/** The GitHub Actions app's fixed integration id (I3): pins a required check so only a status it posted can satisfy it. */
const GITHUB_ACTIONS_APP_ID = 15368;

export function buildRuleset(requiredChecks, enforcement = "active") {
  return {
    name: "main (lanes)",
    target: "branch",
    enforcement,
    conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
    bypass_actors: [],
    rules: [
      { type: "deletion" },
      { type: "non_fast_forward" },
      {
        type: "pull_request",
        parameters: {
          required_approving_review_count: 0,
          dismiss_stale_reviews_on_push: false,
          require_code_owner_review: false,
          require_last_push_approval: false,
          required_review_thread_resolution: false,
          allowed_merge_methods: ["squash"],
        },
      },
      {
        type: "required_status_checks",
        parameters: {
          strict_required_status_checks_policy: false,
          required_status_checks: requiredChecks.map((context) => ({ context, integration_id: GITHUB_ACTIONS_APP_ID })),
        },
      },
      {
        type: "merge_queue",
        parameters: {
          check_response_timeout_minutes: 60,
          grouping_strategy: "ALLGREEN",
          max_entries_to_build: 5,
          max_entries_to_merge: 5,
          merge_method: "SQUASH",
          min_entries_to_merge: 1,
          min_entries_to_merge_wait_minutes: 1,
        },
      },
      {
        type: "code_scanning",
        parameters: { code_scanning_tools: [{ tool: "CodeQL", security_alerts_threshold: "high_or_higher", alerts_threshold: "errors" }] },
      },
    ],
  };
}

const gh = (args, input) => execFileSync("gh", args, { encoding: "utf8", input, stdio: [input ? "pipe" : "ignore", "pipe", "pipe"], windowsHide: true });

/** The id of an existing ruleset with this name, or null. Never create a second "main (lanes)" ruleset (M6). */
export function findRulesetId(rulesets, name) {
  const match = (Array.isArray(rulesets) ? rulesets : []).find((r) => r?.name === name);
  return match ? match.id : null;
}

/** The enforcement of an existing ruleset with this name, or undefined. An existing ruleset's enforcement is never changed (#762). */
export function existingEnforcement(rulesets, name) {
  return (Array.isArray(rulesets) ? rulesets : []).find((r) => r?.name === name)?.enforcement;
}

/**
 * Whether the default branch already holds lanes-gate.yml. `lanes-gate.yml` runs on `pull_request_target` and `merge_group`, which GitHub
 * runs only from the default branch, so before it lands an active ruleset requiring `lanes/gate` blocks the adoption PR (#762).
 * Only a 404 (no file) or 409 (empty repository) means absent; any other failure throws rather than guess.
 */
export function gateOnDefaultBranch(ghFn, repo) {
  try {
    ghFn(["api", `repos/${repo}/contents/.github/workflows/lanes-gate.yml`]);
    return true;
  } catch (err) {
    const text = `${err?.stderr ?? ""}${err?.message ?? ""}`;
    if (/HTTP (404|409)|Not Found|repository is empty/i.test(text)) return false;
    throw err;
  }
}

/** The enforcement a new lanes ruleset starts with: disabled until lanes-gate is on the default branch. */
export const startingEnforcement = (ghFn, repo) => (gateOnDefaultBranch(ghFn, repo) ? "active" : "disabled");

export const OWNER_REVIEW_RULESET = "main (lanes owner review)";

/** GitHub's built-in repository role "Admin" (role id 5). */
const ADMIN_ROLE_ID = 5;

/**
 * ADR 0034 part 2: the code-owner rule alone, with repository admins able to bypass it in `pull_request` mode (the owner's
 * bypass box on an own PR). Never `always`: a bypass of this ruleset leaves `main (lanes)`'s checks and merge queue in force.
 */
export function buildOwnerReviewRuleset(enforcement = "active") {
  return {
    name: OWNER_REVIEW_RULESET,
    target: "branch",
    enforcement,
    conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
    bypass_actors: [{ actor_id: ADMIN_ROLE_ID, actor_type: "RepositoryRole", bypass_mode: "pull_request" }],
    rules: [
      {
        type: "pull_request",
        parameters: {
          required_approving_review_count: 0,
          dismiss_stale_reviews_on_push: false,
          require_code_owner_review: true,
          require_last_push_approval: false,
          required_review_thread_resolution: false,
          allowed_merge_methods: ["squash"],
        },
      },
    ],
  };
}

/** A raw read of `gate.nonLanePrs` (true only for a literal true), like readRequiredChecks: init runs this before the config is validated. */
export function readNonLanePrs(file = "lanes.config.json") {
  try {
    return JSON.parse(readFileSync(file, "utf8"))?.gate?.nonLanePrs === true;
  } catch {
    return false;
  }
}

/**
 * Creates or updates the lanes rulesets and returns the log lines. Key off: today's single ruleset, updated by id. Key on: with
 * neither ruleset present, both are created; an existing lanes ruleset is never changed, and the manual steps are printed (ADR 0034).
 */
export function configureRulesets(ghFn, repo, checks, nonLanePrs, log = console.log) {
  const existing = JSON.parse(ghFn(["api", `repos/${repo}/rulesets`]));
  const name = buildRuleset(checks).name;
  const id = findRulesetId(existing, name);
  const post = (body) => ghFn(["api", `repos/${repo}/rulesets`, "-X", "POST", "--input", "-"], JSON.stringify(body));
  if (!nonLanePrs) {
    const enforcement = id ? (existingEnforcement(existing, name) ?? "active") : startingEnforcement(ghFn, repo);
    const body = buildRuleset(checks, enforcement);
    if (id) ghFn(["api", `repos/${repo}/rulesets/${id}`, "-X", "PUT", "--input", "-"], JSON.stringify(body));
    else post(body);
    log(`configured ${repo}: settings, ${LABELS.length} labels, CodeQL, ruleset ${id ? "updated" : "created"} (${enforcement})`);
    return;
  }
  const ownerId = findRulesetId(existing, OWNER_REVIEW_RULESET);
  const base = `https://github.com/${repo}/settings/rules`;
  if (id === null && ownerId === null) {
    const enforcement = startingEnforcement(ghFn, repo);
    post(buildRuleset(checks, enforcement));
    post(buildOwnerReviewRuleset(enforcement));
    log(`configured ${repo}: settings, ${LABELS.length} labels, CodeQL, rulesets "${name}" and "${OWNER_REVIEW_RULESET}" created (${enforcement})`);
    return;
  }
  log(`configured ${repo}: settings, ${LABELS.length} labels, CodeQL; an existing lanes ruleset is never changed`);
  if (id !== null && ownerId !== null) return;
  log(`gate.nonLanePrs is on, so the code-owner rule belongs in its own ruleset (ADR 0034). Two manual steps:`);
  if (id !== null) log(`  1. open ${base}/${id} and remove the code-owner rule ("Require review from Code Owners") from "${name}"`);
  if (ownerId === null) log(`  2. create "${OWNER_REVIEW_RULESET}" at ${base}/new?target=branch: default branch, only "Require a pull request" with "Require review from Code Owners" and 0 approvals, bypass list: the Repository admin role, mode "For pull requests only"`);
  if (id === null) log(`  "${OWNER_REVIEW_RULESET}" exists but "${name}" does not: create it at ${base}/new?target=branch (docs/USING.md lists its rules)`);
}

function main(repo = process.argv[2]) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo ?? "")) throw new Error("usage: setup-repo.mjs <owner/repo>");
  gh(["repo", "edit", repo, "--enable-auto-merge", "--delete-branch-on-merge", "--enable-squash-merge", "--enable-merge-commit=false", "--enable-rebase-merge=false"]);
  for (const l of LABELS) gh(["label", "create", l.name, "-R", repo, "--color", l.color, "--description", l.description, "--force"]);
  gh(["api", `repos/${repo}/code-scanning/default-setup`, "-X", "PATCH", "-f", "state=configured"]);
  configureRulesets(gh, repo, readRequiredChecks(), readNonLanePrs());
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
