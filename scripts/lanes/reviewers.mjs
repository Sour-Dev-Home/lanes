// scripts/lanes/reviewers.mjs
// Prints the reviewers this branch's diff needs for a tier: node scripts/lanes/reviewers.mjs <skip|quick|full>
import { execFileSync } from "node:child_process";
import { classifyFiles, loadConfig, requiredReviewers, TIERS } from "./lib.mjs";

const tier = process.argv[2];
if (!TIERS.includes(tier)) throw new Error(`usage: reviewers.mjs <${TIERS.join("|")}>`);
// --name-status lists both names of a rename (R100<TAB>old<TAB>new), like the gate does.
const files = execFileSync("git", ["diff", "--name-status", "origin/main...HEAD"], { encoding: "utf8" })
  .split("\n")
  .filter(Boolean)
  .flatMap((line) => line.split("\t").slice(1));
const cls = classifyFiles(files, loadConfig());
if (tier === "skip" && !cls.skipOnly) console.log("NOT SKIP: the diff changes files outside the skip paths; use quick or full");
const list = requiredReviewers(tier, cls);
console.log(list.length ? list.join("\n") : "none");
