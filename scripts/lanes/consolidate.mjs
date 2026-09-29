// scripts/lanes/consolidate.mjs
// Lists merge candidates: open `ready` or `lane-filed` issues whose Scope paths overlap. Report only; it never edits an
// issue, because the owner decides every merge. Usage: node scripts/lanes/consolidate.mjs [--lane-filed]
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseIssueForm } from "./lib.mjs";
import { issuePaths, pathsOverlap } from "./paths.mjs";
import { startConfig } from "./start.mjs";

const CONSIDERED = ["ready", "lane-filed"];
const hasLabel = (issue, name) => (issue.labels ?? []).some((l) => (typeof l === "string" ? l : l?.name) === name);

/**
 * Groups of two or more open issues that share a path, transitively (A~B and B~C is one group). Issues without a
 * `ready` or `lane-filed` label, and issues whose Scope names no non-soft path, are never grouped.
 * @param {{
 *   issues: { number: number, title?: string, body?: string, labels?: ({ name: string } | string)[] }[],
 *   softPaths?: (string | RegExp)[],
 *   laneFiledOnly?: boolean,
 * }} input
 * @returns {{ issues: { number: number, title: string }[], paths: string[], laneFiled: boolean }[]} ordered by lowest issue number
 */
export function consolidateGroups({ issues, softPaths = [], laneFiledOnly = false }) {
  const soft = softPaths.map((s) => (s instanceof RegExp ? s : new RegExp(s)));
  const entries = issues
    .filter((i) => CONSIDERED.some((l) => hasLabel(i, l)))
    .map((i) => ({ issue: i, paths: issuePaths(parseIssueForm(i.body ?? "").fields).filter((p) => !soft.some((re) => re.test(p))) }))
    .filter((e) => e.paths.length > 0)
    .sort((a, b) => a.issue.number - b.issue.number);

  // Union-find over the entries: two join when their paths overlap.
  const parent = entries.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      if (pathsOverlap(entries[i].paths, entries[j].paths)) parent[find(j)] = find(i);
    }
  }
  const byRoot = new Map();
  entries.forEach((e, i) => byRoot.set(find(i), [...(byRoot.get(find(i)) ?? []), e]));

  const groups = [];
  for (const members of byRoot.values()) {
    if (members.length < 2) continue;
    // Shared paths: each path that overlaps a path of another member.
    const paths = [];
    for (const [i, m] of members.entries()) {
      const others = members.filter((_, j) => j !== i).flatMap((o) => o.paths);
      for (const p of m.paths) if (pathsOverlap([p], others) && !paths.includes(p)) paths.push(p);
    }
    groups.push({
      issues: members.map((m) => ({ number: m.issue.number, title: m.issue.title ?? "" })),
      paths: paths.sort(),
      laneFiled: members.some((m) => hasLabel(m.issue, "lane-filed")),
    });
  }
  return groups.filter((g) => !laneFiledOnly || g.laneFiled);
}

/** The report text: one block per group, or `no merge candidates`. */
export function formatGroups(groups) {
  if (groups.length === 0) return "no merge candidates";
  return groups
    .map((g) => [`Merge candidates (lane-filed: ${g.laneFiled ? "yes" : "no"}):`, ...g.issues.map((i) => `  #${i.number} ${i.title}`), `  shared paths: ${g.paths.join(", ")}`].join("\n"))
    .join("\n\n");
}

export function parseArgs(argv) {
  const rest = argv.filter((a) => a !== "--lane-filed");
  if (rest.length > 0) throw new Error(`usage: node scripts/lanes/consolidate.mjs [--lane-filed] (unknown argument ${JSON.stringify(rest[0])})`);
  return { laneFiledOnly: argv.includes("--lane-filed") };
}

const ghIssues = (label) =>
  JSON.parse(execFileSync("gh", ["issue", "list", "--state", "open", "--label", label, "--limit", "200", "--json", "number,title,labels,body"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));

export function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error(e.message);
    return 2;
  }
  try {
    const raw = existsSync("lanes.config.json") ? JSON.parse(readFileSync("lanes.config.json", "utf8")) : {};
    const seen = new Map(CONSIDERED.flatMap(ghIssues).map((i) => [i.number, i]));
    console.log(formatGroups(consolidateGroups({ issues: [...seen.values()], softPaths: startConfig(raw).softPaths, laneFiledOnly: args.laneFiledOnly })));
    return 0;
  } catch (e) {
    console.error(`consolidate: ${e.message}`);
    return 2;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main();
