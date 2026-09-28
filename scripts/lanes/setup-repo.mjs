// scripts/lanes/setup-repo.mjs
// OWNER ONLY. Configures a GitHub repo for lanes: merge settings, labels, CodeQL default setup, and the main ruleset.
// Usage: node scripts/lanes/setup-repo.mjs <owner/repo>
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./lib.mjs";

export const LABELS = [
  { name: "tier:skip", color: "c5def5", description: "Docs, config or tests only" },
  { name: "tier:quick", color: "fbca04", description: "UI or a small fix" },
  { name: "tier:full", color: "d93f0b", description: "Logic, data, APIs or security" },
  { name: "ready", color: "0e8a16", description: "Task contract complete; a lane may start" },
  { name: "contract:breaking", color: "b60205", description: "This task may break an interface contract" },
  { name: "digest", color: "5319e7", description: "The nightly digest thread" },
  { name: "lane-filed", color: "bfd4f2", description: "A lane's own follow-up; needs the owner to remove this label before it can become ready" },
  { name: "needs-owner", color: "fef2c0", description: "A lane found nothing to build; the owner closes or rewrites it" },
];

/** The GitHub Actions app's fixed integration id (I3): pins a required check so only a status it posted can satisfy it. */
const GITHUB_ACTIONS_APP_ID = 15368;

export function buildRuleset(requiredChecks) {
  return {
    name: "main (lanes)",
    target: "branch",
    enforcement: "active",
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

const gh = (args, input) => execFileSync("gh", args, { encoding: "utf8", input, stdio: [input ? "pipe" : "ignore", "pipe", "pipe"] });

/** The id of an existing ruleset with this name, or null. Never create a second "main (lanes)" ruleset (M6). */
export function findRulesetId(rulesets, name) {
  const match = (Array.isArray(rulesets) ? rulesets : []).find((r) => r?.name === name);
  return match ? match.id : null;
}

function main(repo = process.argv[2]) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo ?? "")) throw new Error("usage: setup-repo.mjs <owner/repo>");
  gh(["repo", "edit", repo, "--enable-auto-merge", "--delete-branch-on-merge", "--enable-squash-merge", "--enable-merge-commit=false", "--enable-rebase-merge=false"]);
  for (const l of LABELS) gh(["label", "create", l.name, "-R", repo, "--color", l.color, "--description", l.description, "--force"]);
  gh(["api", `repos/${repo}/code-scanning/default-setup`, "-X", "PATCH", "-f", "state=configured"]);
  const ruleset = buildRuleset(loadConfig().requiredChecks);
  const existing = JSON.parse(gh(["api", `repos/${repo}/rulesets`]));
  const id = findRulesetId(existing, ruleset.name);
  if (id) gh(["api", `repos/${repo}/rulesets/${id}`, "-X", "PUT", "--input", "-"], JSON.stringify(ruleset));
  else gh(["api", `repos/${repo}/rulesets`, "-X", "POST", "--input", "-"], JSON.stringify(ruleset));
  console.log(`configured ${repo}: settings, ${LABELS.length} labels, CodeQL, ruleset ${id ? "updated" : "created"}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
