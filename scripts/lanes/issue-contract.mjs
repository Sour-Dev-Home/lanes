// scripts/lanes/issue-contract.mjs
// Checks a task issue against the task contract and sets its labels: tier:<tier> and `ready` when complete.
// Run by .github/workflows/issue-contract.yml. Inputs: REPO, ISSUE_NUMBER, ISSUE_BODY, ISSUE_LABELS_JSON, GH_TOKEN.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseIssueForm, TRUSTED_ASSOCIATIONS } from "./lib.mjs";

export const MARKER = "<!-- lanes:issue-contract -->";

/**
 * @param {string} body the issue body
 * @param {string[]} labels the issue's current labels
 * @param {string} [authorAssociation] the issue author's association with the repo (OWNER, MEMBER, COLLABORATOR, ...)
 */
export function issuePlan(body, labels, authorAssociation) {
  if (!/^### Goal\s*$/m.test(String(body ?? "").replace(/\r\n/g, "\n"))) return { isTask: false, add: [], remove: [], comment: "" };
  const r = parseIssueForm(body);
  const tierLabels = labels.filter((l) => l.startsWith("tier:"));
  const hadReady = labels.includes("ready");
  if (!r.ok) {
    return {
      isTask: true,
      add: [],
      remove: hadReady ? ["ready"] : [],
      comment: `${MARKER}\n**Task contract incomplete**, so this issue is not ready:\n${r.errors.map((e) => `- ${e}`).join("\n")}`,
    };
  }
  const want = `tier:${r.fields.tier}`;
  const laneFiled = labels.includes("lane-filed");
  // C1: an untrusted author's issue never gets `ready`, however complete its contract.
  // I4: a lane's own follow-up (lane-filed) never gets `ready` automatically, even from the owner.
  if (laneFiled || !TRUSTED_ASSOCIATIONS.includes(authorAssociation)) {
    // R2: hand-adding `ready` will not help here — the gate itself rejects an issue not opened by an owner, member
    // or collaborator, whatever labels it carries — so the real path is a maintainer opening the task themselves.
    const why = laneFiled
      ? "a maintainer must remove the lane-filed label to approve it"
      : "a maintainer must open this task themselves; adding ready by hand will not help, since a lane also checks the issue's author";
    return {
      isTask: true,
      add: [want],
      remove: [...tierLabels.filter((l) => l !== want), ...(hadReady ? ["ready"] : [])],
      comment: `${MARKER}\nTask contract complete: tier ${r.fields.tier}, ${r.fields.criteria.length} acceptance criteria, but ${why}.`,
    };
  }
  return {
    isTask: true,
    add: [want, "ready"],
    remove: tierLabels.filter((l) => l !== want),
    comment: `${MARKER}\nTask contract complete: tier ${r.fields.tier}, ${r.fields.criteria.length} acceptance criteria.`,
  };
}

const gh = (args) => execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

export function findExistingComment(repo, issueNumber, marker) {
  const existing = gh(["api", "--paginate", `repos/${repo}/issues/${issueNumber}/comments`, "--jq", `.[] | select(.body | startswith("${marker}")) | .id`]).trim().split("\n")[0];
  return existing;
}

function main(env = process.env) {
  const { REPO: repo, ISSUE_NUMBER: n } = env;
  const plan = issuePlan(env.ISSUE_BODY, JSON.parse(env.ISSUE_LABELS_JSON || "[]"), env.AUTHOR_ASSOCIATION);
  if (!plan.isTask) return;
  const edit = ["issue", "edit", n, "-R", repo];
  if (plan.add.length) edit.push("--add-label", plan.add.join(","));
  if (plan.remove.length) edit.push("--remove-label", plan.remove.join(","));
  if (edit.length > 5) gh(edit);
  const existing = findExistingComment(repo, n, MARKER);
  if (existing) gh(["api", `repos/${repo}/issues/comments/${existing}`, "-X", "PATCH", "-f", `body=${plan.comment}`]);
  else gh(["api", `repos/${repo}/issues/${n}/comments`, "-f", `body=${plan.comment}`]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
