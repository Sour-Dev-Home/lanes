// scripts/lanes/start.mjs
// /start: checks each requested issue the way /lane does and launches the rest as background lanes.
// Usage: node scripts/lanes/start.mjs <N> [<N> ...]. Exit 0: every requested issue launched. 1: something was
// refused or failed to launch. 2: bad arguments, or the lanes in flight could not be counted (nothing launched).
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { main as checkBlockers } from "./blockers.mjs";
import { parseIssueForm } from "./lib.mjs";
import { issuePaths, pathsOverlap } from "./status.mjs";

export const CAP = 3;
const PR_LIMIT = 1000;

/** The claude arguments for one lane. No permission-mode flag: a lane runs under the owner's normal settings. */
export const launchArgs = (n) => ["--bg", `/lane ${n}`];

/** The session id from `claude --bg` output (`backgrounded · <id>`), or null when none was printed. */
export function parseSessionId(output) {
  return String(output ?? "").match(/backgrounded · ([\w-]+)/)?.[1] ?? null;
}

/**
 * The issues with a lane in flight: open PRs from `issue-<N>-` branches, plus background sessions whose cwd is
 * (inside) an `issue-<N>-` worktree. Each issue counts once.
 * @param {{ prs: { headRefName: string }[], sessions: { kind: string, cwd: string }[] }} input
 * @returns {number[]} ascending
 */
export function inFlightIssues({ prs, sessions }) {
  const found = new Set();
  for (const pr of prs) {
    const m = String(pr.headRefName ?? "").match(/^issue-(\d+)-/);
    if (m) found.add(Number(m[1]));
  }
  for (const s of sessions) {
    if (s.kind !== "background") continue;
    const m = String(s.cwd ?? "").match(/(?:^|[\\/])issue-(\d+)-[^\\/]*(?:[\\/]|$)/);
    if (m) found.add(Number(m[1]));
  }
  return [...found].sort((a, b) => a - b);
}

// The first reason this issue cannot start on its own, or null. `blockers` is blockers.mjs's `{ code, message }`.
function refusal(issue) {
  if (issue.error) return issue.error;
  if (issue.state !== "OPEN") return "not open";
  if (!issue.labels.includes("ready")) return "lacks ready";
  if (issue.labels.filter((l) => l.startsWith("tier:")).length !== 1) return "no single tier:* label";
  if (issue.blockers?.code !== 0) return String(issue.blockers?.message ?? "cannot check blockers").replace(/^#\d+: /, "");
  return null;
}

/**
 * Which requested issues to launch. Pure.
 * @param {{
 *   issues: { number: number, state?: string, labels?: string[], blockers?: { code: number, message: string }, error?: string }[],
 *   inFlight: number[],
 *   overlaps: (a: number, b: number) => boolean,
 * }} input issues in request order; `error` marks one that could not be read
 * @returns {{ launch: number[], refused: { number: number, reason: string }[] }} both in request order
 */
export function planStart({ issues, inFlight, overlaps }) {
  const reasons = new Map();
  const busy = new Set(inFlight);
  for (const issue of issues) {
    const reason = refusal(issue) ?? (busy.has(issue.number) ? "already in flight" : null);
    if (reason) reasons.set(issue.number, reason);
  }

  // Only issues that could otherwise start are compared, and an overlapping pair is refused together.
  const candidates = issues.map((i) => i.number).filter((n) => !reasons.has(n));
  const overlapping = new Map(candidates.map((n) => [n, candidates.filter((m) => m !== n && overlaps(n, m))]));
  for (const [n, others] of overlapping) {
    if (others.length) reasons.set(n, `overlaps ${others.map((m) => `#${m}`).join(", ")}`);
  }

  let slots = CAP - busy.size;
  const launch = [];
  for (const n of candidates) {
    if (reasons.has(n)) continue;
    if (slots > 0) {
      launch.push(n);
      slots--;
    } else reasons.set(n, `cap of ${CAP} lanes in flight`);
  }
  const refused = issues.filter((i) => reasons.has(i.number)).map((i) => ({ number: i.number, reason: reasons.get(i.number) }));
  return { launch, refused };
}

const reason = (err) => String(err?.stderr || err?.message || err).trim().split("\n")[0];

/**
 * Reads the issues, plans and launches. `deps` holds fakes in tests: `gh(args)` and `claude(args, { cwd })` return
 * stdout, `root()` the main repository root. Returns the exit code and the lines to print.
 */
export function main(argv, deps = { gh, claude, root: repoRoot }) {
  const args = argv.map((a) => String(a).replace(/^#/, ""));
  if (!args.length || args.some((a) => !/^[1-9]\d*$/.test(a))) return { code: 2, lines: ["usage: start.mjs <issue number> [<issue number> ...]"] };
  const numbers = [...new Set(args.map(Number))];

  let inFlight;
  try {
    const root = deps.root();
    const prs = JSON.parse(deps.gh(["pr", "list", "--state", "open", "--limit", String(PR_LIMIT), "--json", "headRefName"]));
    // A truncated list could hide a lane in flight and let the cap be passed, so refuse instead.
    if (prs.length >= PR_LIMIT) throw new Error(`${PR_LIMIT}+ open PRs: too many to count lanes in flight`);
    const sessions = JSON.parse(deps.claude(["agents", "--json", "--cwd", root], { cwd: root }));
    inFlight = inFlightIssues({ prs, sessions });
  } catch (err) {
    return { code: 2, lines: [`cannot count lanes in flight, nothing launched: ${reason(err)}`] };
  }

  const issues = [];
  const pathsOf = new Map();
  for (const n of numbers) {
    let view;
    try {
      view = JSON.parse(deps.gh(["issue", "view", String(n), "--json", "number,state,labels,body"]));
    } catch {
      issues.push({ number: n, error: "not found or unreadable" });
      continue;
    }
    const form = parseIssueForm(view.body ?? "").fields;
    // As in /status: an issue whose Scope names no paths is left out of overlap comparisons.
    if (issuePaths({ scope: form.scope }).length) pathsOf.set(n, issuePaths(form));
    issues.push({ number: n, state: view.state, labels: (view.labels ?? []).map((l) => l.name), blockers: checkBlockers([String(n)], deps.gh) });
  }
  const overlaps = (a, b) => pathsOf.has(a) && pathsOf.has(b) && pathsOverlap(pathsOf.get(a), pathsOf.get(b));

  const { launch, refused } = planStart({ issues, inFlight, overlaps });
  const lines = new Map(refused.map((r) => [r.number, `#${r.number}: refused: ${r.reason}`]));
  let failed = refused.length > 0;
  const root = launch.length ? deps.root() : null;
  for (const n of launch) {
    // One attempt only: a launch that printed no id may still have started, and a retry could start it twice.
    let id = null;
    let why = "no session id in output";
    try {
      id = parseSessionId(deps.claude(launchArgs(n), { cwd: root }));
    } catch (err) {
      why = reason(err);
    }
    if (id) lines.set(n, `#${n} → ${id}`);
    else {
      lines.set(n, `#${n}: launch failed: ${why}, not retried`);
      failed = true;
    }
  }
  return { code: failed ? 1 : 0, lines: numbers.map((n) => lines.get(n)) };
}

const gh = (args) => execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const claude = (args, { cwd }) => execFileSync("claude", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
// The main checkout, even when run from a worktree: the parent of the shared .git directory.
const repoRoot = () => dirname(execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim());

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { code, lines } = main(process.argv.slice(2));
  for (const line of lines) console.log(line);
  process.exitCode = code;
}
