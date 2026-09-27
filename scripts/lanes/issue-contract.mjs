// scripts/lanes/issue-contract.mjs
// Checks a task issue against the task contract and sets its labels: tier:<tier> and `ready` when complete.
// Run by .github/workflows/issue-contract.yml. Inputs: REPO, ISSUE_NUMBER, ISSUE_BODY, ISSUE_LABELS_JSON, ISSUE_AUTHOR,
// GH_TOKEN.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { authorCanWrite, parseIssueForm } from "./lib.mjs";

export const MARKER = "<!-- lanes:issue-contract -->";

/**
 * @param {string} body the issue body
 * @param {string[]} labels the issue's current labels
 * @param {boolean} [canWrite] whether the issue author has write, maintain or admin permission; only true trusts
 */
export function issuePlan(body, labels, canWrite) {
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
  if (laneFiled || canWrite !== true) {
    // R2: hand-adding `ready` will not help here — the gate itself rejects an issue not opened by someone with write
    // access, whatever labels it carries — so the real path is a maintainer opening the task themselves.
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

export function findExistingComment(repo, issueNumber, marker, run = gh) {
  const existing = run(["api", "--paginate", `repos/${repo}/issues/${issueNumber}/comments`, "--jq", `.[] | select(.body | startswith("${marker}")) | .id`]).trim().split("\n")[0];
  return existing;
}

/** `run` takes full `gh` arguments; tests pass a fake. */
export function main(env = process.env, run = gh) {
  const { REPO: repo, ISSUE_NUMBER: n } = env;
  const labels = JSON.parse(env.ISSUE_LABELS_JSON || "[]");
  // Only a task form needs the permission lookup; a plain issue is left alone without an extra API call.
  if (!issuePlan(env.ISSUE_BODY, labels, false).isTask) return;
  const canWrite = authorCanWrite((args) => run(["api", ...args]), repo, env.ISSUE_AUTHOR);
  const plan = issuePlan(env.ISSUE_BODY, labels, canWrite);
  const edit = ["issue", "edit", n, "-R", repo];
  if (plan.add.length) edit.push("--add-label", plan.add.join(","));
  if (plan.remove.length) edit.push("--remove-label", plan.remove.join(","));
  if (edit.length > 5) run(edit);
  const existing = findExistingComment(repo, n, MARKER, run);
  if (existing) run(["api", `repos/${repo}/issues/comments/${existing}`, "-X", "PATCH", "-f", `body=${plan.comment}`]);
  else run(["api", `repos/${repo}/issues/${n}/comments`, "-f", `body=${plan.comment}`]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
