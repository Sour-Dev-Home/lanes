// scripts/lanes/reviewers.mjs
// Prints the reviewers this branch's diff needs for a tier: node scripts/lanes/reviewers.mjs <skip|quick|full>
// Then `ADRs: NNNN, ...` naming the accepted ADRs (from docs/adr in this working tree) that govern the diff.
import { execFileSync } from "node:child_process";
import { loadAdrs, loadConfig, reviewersReport, TIERS } from "./lib.mjs";

const tier = process.argv[2];
if (!TIERS.includes(tier)) throw new Error(`usage: reviewers.mjs <${TIERS.join("|")}>`);
// --name-status lists both names of a rename (R100<TAB>old<TAB>new), like the gate does.
const files = execFileSync("git", ["diff", "--name-status", "origin/main...HEAD"], { encoding: "utf8" })
  .split("\n")
  .filter(Boolean)
  .flatMap((line) => line.split("\t").slice(1));
console.log(reviewersReport(tier, files, loadConfig(), loadAdrs()));
