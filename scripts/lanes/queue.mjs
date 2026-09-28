// scripts/lanes/queue.mjs
// The owner-run lane queue (ADR 0005 as amended by ADR 0006). `planTick` decides one tick from a snapshot: which
// ready issues launch now, which lane PRs wait on the owner, and whether the queue is idle. Pure: the caller reads
// GitHub and the sessions, cleans up merged lanes and launches.
import { parseBlockedBy } from "./blockers.mjs";
import { GATE_CONTEXT } from "./lib.mjs";
import { claimedPaths, pickStartable } from "./pick.mjs";
import { inFlightIssues, START_DEFAULTS } from "./start.mjs";

const FAILED = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"]);
const labelsOf = (issue) => (issue.labels ?? []).map((l) => (typeof l === "string" ? l : l?.name));
const isOpen = (issue) => (issue.state ?? "OPEN") === "OPEN";
const branchIssue = (pr) => Number(String(pr.headRefName ?? "").match(/^issue-(\d+)-/)?.[1] ?? NaN);
const sessionIssue = (s) => Number(String(s.cwd ?? "").match(/(?:^|[\\/])issue-(\d+)-[^\\/]*(?:[\\/]|$)/)?.[1] ?? NaN);

// Why a lane PR waits on the owner, or null: a failing check or review, a failing lanes/gate, or a gate waiting on
// review/owner. Mirrors status.mjs's stages; the gate's description falls back to `gateDescription`, which
// `gh pr list` leaves out of the rollup.
function ownerWait(pr) {
  const rollup = pr.statusCheckRollup ?? [];
  const failing = rollup
    .filter((c) => c.context !== GATE_CONTEXT && (FAILED.has(c.conclusion) || FAILED.has(c.state)))
    .map((c) => c.name ?? c.context);
  if (failing.length) return `failing: ${failing.join(", ")}`;
  const gate = rollup.find((c) => c.context === GATE_CONTEXT);
  if (!gate) return null;
  const description = gate.description || pr.gateDescription || "";
  if (gate.state === "FAILURE" || gate.state === "ERROR") return description || "lanes/gate failed";
  if (gate.state !== "SUCCESS" && description.startsWith("waiting on owner")) return description;
  return null;
}

// Why a ready issue cannot be a candidate, or null. Blockers count as open only when open in the snapshot.
function refusal(issue, openNumbers) {
  if (labelsOf(issue).filter((l) => l?.startsWith("tier:")).length !== 1) return "no single tier:* label";
  const { blockedBy, error } = parseBlockedBy(issue.body ?? "");
  if (error) return error;
  const open = blockedBy.filter((b) => openNumbers.has(b));
  return open.length ? `blocked by ${open.map((b) => `#${b}`).join(", ")}` : null;
}

/**
 * One queue tick. Pure: no I/O.
 * @param {{
 *   issues: { number: number, state?: string, labels?: (string | { name: string })[], body?: string }[],
 *   prs: { number: number, headRefName?: string, files?: (string | { path: string })[], statusCheckRollup?: object[],
 *     gateDescription?: string }[],
 *   sessions: { kind: string, cwd: string }[],
 *   maxLanes?: number,
 *   softPaths?: (string | RegExp)[],
 * }} input every open issue (`state` defaults to OPEN; closed entries are ignored), every open PR, and the background
 *   sessions from `claude agents --json`; `maxLanes` and `softPaths` default to start.mjs's
 * @returns {{ launch: number[], waiting: { number: number, reason: string }[], idle: boolean, lines: string[] }}
 *   `launch` in priority order; `waiting` by PR number, for lane PRs only
 */
export function planTick({ issues = [], prs = [], sessions = [], maxLanes = START_DEFAULTS.maxLanes, softPaths = START_DEFAULTS.softPaths }) {
  const openIssues = issues.filter(isOpen);
  const openNumbers = new Set(openIssues.map((i) => i.number));
  const lanePrs = prs.filter((pr) => Number.isInteger(branchIssue(pr)));
  // A session is a leftover once its issue has closed and it has no open PR; cleanup removes it.
  const withPr = new Set(lanePrs.map(branchIssue));
  const finished = sessions.map(sessionIssue).filter((n) => Number.isInteger(n) && !openNumbers.has(n) && !withPr.has(n));
  const inFlight = inFlightIssues({ prs, sessions, finished });
  const busy = new Set(inFlight);

  const skipped = [];
  const candidates = [];
  for (const issue of openIssues) {
    if (!labelsOf(issue).includes("ready") || busy.has(issue.number)) continue;
    const why = refusal(issue, openNumbers);
    if (why) skipped.push({ number: issue.number, reason: why });
    else candidates.push(issue);
  }

  const claimed = claimedPaths({ openPrs: prs, runningIssues: openIssues.filter((i) => busy.has(i.number)) });
  const { start: launch, skipped: notPicked } = pickStartable({ candidates, claimed, openIssues, maxLanes, inFlightCount: busy.size, softPaths });

  const waiting = lanePrs
    .map((pr) => ({ number: pr.number, reason: ownerWait(pr) }))
    .filter((w) => w.reason !== null)
    .sort((a, b) => a.number - b.number);
  const idle = busy.size === 0 && launch.length === 0;

  const lines = [
    ...launch.map((n) => `#${n}: launch`),
    ...[...skipped, ...notPicked].sort((a, b) => a.number - b.number).map((s) => `#${s.number}: skipped: ${s.reason}`),
    ...waiting.map((w) => `PR #${w.number}: needs the owner: ${w.reason}`),
    idle ? "idle: nothing in flight, nothing to launch" : `${busy.size} in flight, ${launch.length} to launch, ${waiting.length} waiting on the owner`,
  ];
  return { launch, waiting, idle, lines };
}
