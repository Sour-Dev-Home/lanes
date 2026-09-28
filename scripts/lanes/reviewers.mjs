// scripts/lanes/reviewers.mjs
// Prints the reviewers this branch's diff needs for a tier: node scripts/lanes/reviewers.mjs <skip|quick|full>
// Then `ADRs: NNNN, ...` naming the accepted ADRs (from docs/adr in this working tree) that govern the diff.
// The diff is origin/main...HEAD plus uncommitted work (staged, unstaged, untracked but not ignored), so running
// before the first commit never under-reports (#17). An empty diff exits 1 with a message on stderr (#124).
import { execFileSync } from "node:child_process";
import { loadAdrs, loadConfig, reviewersReport, TIERS } from "./lib.mjs";

const tier = process.argv[2];
if (!TIERS.includes(tier)) throw new Error(`usage: reviewers.mjs <${TIERS.join("|")}>`);

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
console.log(reviewersReport(tier, [...new Set(files)], loadConfig(), loadAdrs()));
