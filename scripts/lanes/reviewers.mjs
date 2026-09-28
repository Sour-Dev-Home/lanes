// scripts/lanes/reviewers.mjs
// Prints the reviewers this branch's diff needs for a tier: node scripts/lanes/reviewers.mjs <skip|quick|full> [issue]
// Then `ADRs: NNNN, ...` naming the accepted ADRs (from docs/adr in this working tree) that govern the diff.
// With an issue number, that issue's Interface contract (read with `gh issue view`) counts too, as in the gate (#241):
// a path it names that the diff changes needs the architecture-advisor. An unreadable issue is an error, never "none".
// The diff is origin/main...HEAD plus uncommitted work (staged, unstaged, untracked but not ignored), so running
// before the first commit never under-reports (#17). An empty diff exits 1 with a message on stderr (#124).
import { execFileSync } from "node:child_process";
import { interfaceContractOf, loadAdrs, loadConfig, reviewersReport, TIERS } from "./lib.mjs";

const [tier, issue] = process.argv.slice(2);
const usage = `usage: reviewers.mjs <${TIERS.join("|")}> [issue-number]`;
if (!TIERS.includes(tier)) throw new Error(usage);
if (issue !== undefined && !/^[1-9]\d*$/.test(issue)) throw new Error(usage);

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).split("\0").filter(Boolean);
// -z keeps paths unquoted. --name-status -z is STATUS\0path\0, or STATUS\0old\0new\0 for a rename or copy;
// both names count, like the gate does.
function namesFromStatus(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length; ) {
    const paths = /^[RC]/.test(tokens[i]) ? 2 : 1;
    out.push(...tokens.slice(i + 1, i + 1 + paths));
    i += 1 + paths;
  }
  return out;
}
const files = [
  ...namesFromStatus(git("diff", "--name-status", "-z", "origin/main...HEAD")),
  ...namesFromStatus(git("diff", "--name-status", "-z", "HEAD")),
  ...git("ls-files", "--others", "--exclude-standard", "-z"),
];
// Nothing committed and nothing uncommitted: run too early, so refuse rather than print a bare test-hunter (#124).
if (files.length === 0) {
  console.error("reviewers.mjs: no diff to review over origin/main (commit or make changes first)");
  process.exit(1);
}
const interfaceContract =
  issue === undefined ? "" : interfaceContractOf(execFileSync("gh", ["issue", "view", issue, "--json", "body", "--jq", ".body"], { encoding: "utf8" }));
console.log(reviewersReport(tier, [...new Set(files)], loadConfig(), loadAdrs(), interfaceContract));
