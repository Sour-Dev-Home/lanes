// scripts/lanes/pick.mjs
// Chooses which ready, unblocked issues can start now without touching files other work already claims. Pure: the
// callers read GitHub and the sessions and pass the data in.
import { parseIssueForm } from "./lib.mjs";
import { issuePaths, pathsOverlap } from "./status.mjs";

const formOf = (issue) => parseIssueForm(issue?.body ?? "").fields;
const prFiles = (pr) => (pr.files ?? []).map((f) => (typeof f === "string" ? f : f?.path)).filter(Boolean);
const branchIssue = (pr) => Number(String(pr.headRefName ?? "").match(/^issue-(\d+)-/)?.[1] ?? NaN);

/**
 * The paths running work already claims: each open lane PR's changed files (`by` its PR number), and the Scope and
 * contract paths of each running issue that has no open PR yet (`by` its issue number). A running issue counts as
 * having a PR when an open PR's branch is `issue-<N>-...`.
 * @param {{
 *   openPrs?: { number: number, headRefName?: string, files?: (string | { path: string })[] }[],
 *   runningIssues?: { number: number, body?: string }[],
 * }} input
 * @returns {{ path: string, by: number }[]}
 */
export function claimedPaths({ openPrs = [], runningIssues = [] }) {
  const withPr = new Set(openPrs.map(branchIssue));
  return [
    ...openPrs.flatMap((pr) => prFiles(pr).map((path) => ({ path, by: pr.number }))),
    ...runningIssues.filter((i) => !withPr.has(i.number)).flatMap((i) => issuePaths(formOf(i)).map((path) => ({ path, by: i.number }))),
  ];
}

// How many open issues `number` blocks, directly or through others. Cycle-safe: each issue counts once.
function blockedCount(number, dependents) {
  const seen = new Set([number]);
  const queue = [number];
  while (queue.length) {
    for (const d of dependents.get(queue.shift()) ?? []) {
      if (!seen.has(d)) {
        seen.add(d);
        queue.push(d);
      }
    }
  }
  return seen.size - 1;
}

// The first of `mine` that overlaps any of `theirs`, or undefined.
const overlapOn = (mine, theirs) => mine.find((p) => pathsOverlap([p], theirs));

/**
 * Which candidates to start. Candidates are taken in priority order (more open issues transitively blocked first,
 * then the lower number); each starts unless its Scope names no paths, it overlaps a claimed path or an issue
 * already picked, or the cap is reached. Paths matching a `softPaths` regex never count as overlaps.
 * @param {{
 *   candidates: { number: number, body?: string }[],
 *   claimed: { path: string, by: number }[],
 *   openIssues: { number: number, body?: string }[],
 *   maxLanes: number,
 *   inFlightCount: number,
 *   softPaths?: (string | RegExp)[],
 * }} input
 * @returns {{ start: number[], skipped: { number: number, reason: string }[] }} both in priority order
 */
export function pickStartable({ candidates, claimed, openIssues, maxLanes, inFlightCount, softPaths = [] }) {
  const soft = softPaths.map((s) => (s instanceof RegExp ? s : new RegExp(s)));
  const hard = (paths) => paths.filter((p) => !soft.some((re) => re.test(p)));

  const dependents = new Map();
  for (const issue of openIssues) {
    for (const b of formOf(issue).blockedBy) dependents.set(b, [...(dependents.get(b) ?? []), issue.number]);
  }

  const unique = [...new Map(candidates.map((c) => [c.number, c])).values()];
  const ranked = unique
    .map((c) => ({ number: c.number, form: formOf(c), weight: blockedCount(c.number, dependents) }))
    .sort((a, b) => b.weight - a.weight || a.number - b.number);

  let slots = Math.max(0, maxLanes - inFlightCount);
  const start = [];
  const skipped = [];
  const picked = [];
  for (const { number, form } of ranked) {
    const skip = (reason) => skipped.push({ number, reason });
    if (issuePaths({ scope: form.scope }).length === 0) {
      skip("scope names no paths");
      continue;
    }
    const paths = hard(issuePaths(form));
    const claim = claimed.filter((c) => c.by !== number && hard([c.path]).length).find((c) => overlapOn(paths, [c.path]));
    if (claim) {
      skip(`overlaps running #${claim.by} on ${overlapOn(paths, [claim.path])}`);
      continue;
    }
    const other = picked.find((p) => overlapOn(paths, p.paths));
    if (other) {
      skip(`overlaps #${other.number} on ${overlapOn(paths, other.paths)}`);
      continue;
    }
    if (slots === 0) {
      skip(`cap of ${maxLanes} lanes reached`);
      continue;
    }
    slots--;
    start.push(number);
    picked.push({ number, paths });
  }
  return { start, skipped };
}
