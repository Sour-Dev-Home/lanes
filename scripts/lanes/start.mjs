// scripts/lanes/start.mjs
// /start: checks each requested issue the way /lane does and launches the rest as background lanes.
// Usage: node scripts/lanes/start.mjs <N> [<N> ...]. Exit 0: every requested issue launched. 1: something was
// refused or failed to launch. 2: bad arguments or config, or the lanes in flight could not be counted (nothing launched).
// Or: node scripts/lanes/start.mjs --auto [--go]. Picks from every ready issue with pickStartable and prints the plan;
// only --go launches it. Exit 0: printed (and, with --go, every pick launched). 1: a launch failed. 2: as above.
// The cap and the soft paths come from the `start` block of lanes.config.json.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { main as checkBlockers } from "./blockers.mjs";
import { parseIssueForm } from "./lib.mjs";
import { claimedPaths, pickStartable } from "./pick.mjs";
import { issuePaths, pathsOverlap } from "./status.mjs";

export const START_DEFAULTS = Object.freeze({ maxLanes: 8, softPaths: Object.freeze(["^docs/USING\\.md$", "^README\\.md$"]) });
const MAX_LANES_LIMIT = 10;
const PR_LIMIT = 1000;
const ISSUE_LIMIT = 1000;

/**
 * The `start` block of a parsed lanes.config.json, each missing key (or the whole block) filled from START_DEFAULTS.
 * Throws when maxLanes is not a whole number from 1 to 10, or softPaths is not an array of valid regex strings.
 * @returns {{ maxLanes: number, softPaths: string[] }}
 */
export function startConfig(raw) {
  const start = raw?.start;
  if (start === undefined) return { maxLanes: START_DEFAULTS.maxLanes, softPaths: [...START_DEFAULTS.softPaths] };
  if (start === null || typeof start !== "object" || Array.isArray(start)) throw new Error("lanes.config.json: start must be an object");
  // A key present as null is a typo, not an absent key, so only a missing key takes the default.
  const maxLanes = start.maxLanes === undefined ? START_DEFAULTS.maxLanes : start.maxLanes;
  if (!Number.isInteger(maxLanes) || maxLanes < 1 || maxLanes > MAX_LANES_LIMIT) {
    throw new Error(`lanes.config.json: start.maxLanes must be a whole number from 1 to ${MAX_LANES_LIMIT}, got ${JSON.stringify(start.maxLanes)}`);
  }
  const softPaths = start.softPaths === undefined ? START_DEFAULTS.softPaths : start.softPaths;
  if (!Array.isArray(softPaths) || softPaths.some((s) => typeof s !== "string")) throw new Error("lanes.config.json: start.softPaths must be an array of regex strings");
  for (const source of softPaths) {
    try {
      new RegExp(source);
    } catch {
      throw new Error(`lanes.config.json: start.softPaths: invalid regex ${JSON.stringify(source)}`);
    }
  }
  return { maxLanes, softPaths: [...softPaths] };
}

/** The claude arguments for one lane. No permission-mode flag: a lane runs under the owner's normal settings. */
export const launchArgs = (n) => ["--bg", `/lane ${n}`];

// ANSI escape sequences: CSI (colours, cursor moves) and OSC (e.g. hyperlinks), ended by BEL or ESC \.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/** The session id from `claude --bg` output (`backgrounded · <id>`), or null when none was printed. Colour is ignored. */
export function parseSessionId(output) {
  return String(output ?? "").replace(ANSI, "").match(/backgrounded · ([\w-]+)/)?.[1] ?? null;
}

const branchIssue = (name) => String(name ?? "").match(/^issue-(\d+)-/)?.[1];
const sessionIssue = (s) => (s.kind === "background" ? String(s.cwd ?? "").match(/(?:^|[\\/])issue-(\d+)-[^\\/]*(?:[\\/]|$)/)?.[1] : undefined);

/**
 * The issues with a lane in flight: open PRs from `issue-<N>-` branches, plus background sessions whose cwd is
 * (inside) an `issue-<N>-` worktree, except sessions of a `finished` issue (its PR merged or the issue closed), which
 * are idle leftovers. Each issue counts once.
 * @param {{ prs: { headRefName: string }[], sessions: { kind: string, cwd: string }[], finished?: number[] }} input
 * @returns {number[]} ascending
 */
export function inFlightIssues({ prs, sessions, finished = [] }) {
  const done = new Set(finished);
  const found = new Set();
  for (const pr of prs) {
    const n = branchIssue(pr.headRefName);
    if (n) found.add(Number(n));
  }
  for (const s of sessions) {
    const n = sessionIssue(s);
    if (n && !done.has(Number(n))) found.add(Number(n));
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
 *   maxLanes?: number,
 * }} input issues in request order; `error` marks one that could not be read; `maxLanes` is start.maxLanes
 * @returns {{ launch: number[], refused: { number: number, reason: string }[] }} both in request order
 */
export function planStart({ issues, inFlight, overlaps, maxLanes = START_DEFAULTS.maxLanes }) {
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

  let slots = maxLanes - busy.size;
  const launch = [];
  for (const n of candidates) {
    if (reasons.has(n)) continue;
    if (slots > 0) {
      launch.push(n);
      slots--;
    } else reasons.set(n, `cap of ${maxLanes} lanes in flight`);
  }
  const refused = issues.filter((i) => reasons.has(i.number)).map((i) => ({ number: i.number, reason: reasons.get(i.number) }));
  return { launch, refused };
}

const reason = (err) => String(err?.stderr || err?.message || err).trim().split("\n")[0];

const USAGE = "usage: start.mjs <issue number> [<issue number> ...], or start.mjs --auto [--go]";

// The open PRs (with `fields`) and the issues with a lane in flight. Throws when either cannot be read.
function readInFlight(deps, fields) {
  const root = deps.root();
  const prs = JSON.parse(deps.gh(["pr", "list", "--state", "open", "--limit", String(PR_LIMIT), "--json", fields]));
  // A truncated list could hide a lane in flight and let the cap be passed, so refuse instead.
  if (prs.length >= PR_LIMIT) throw new Error(`${PR_LIMIT}+ open PRs: too many to count lanes in flight`);
  const sessions = JSON.parse(deps.claude(["agents", "--json", "--cwd", root], { cwd: root }));
  return { prs, inFlight: inFlightIssues({ prs, sessions, finished: finishedIssues(deps, prs, sessions) }) };
}

// The issues of sessions with no open PR whose lane is finished: a merged `issue-<N>-` PR, or the issue closed.
// Throws when the merged PRs cannot be read. An issue that cannot be read is not finished, so it keeps its slot.
function finishedIssues(deps, prs, sessions) {
  const open = new Set(prs.map((pr) => Number(branchIssue(pr.headRefName))));
  const idle = [...new Set(sessions.map(sessionIssue).filter(Boolean).map(Number))].filter((n) => !open.has(n));
  if (!idle.length) return [];
  // A truncated list only misses merged PRs; the issue's own state is still checked below.
  const merged = JSON.parse(deps.gh(["pr", "list", "--state", "merged", "--limit", String(PR_LIMIT), "--json", "headRefName"]));
  const mergedIssues = new Set(merged.map((pr) => Number(branchIssue(pr.headRefName))));
  return idle.filter((n) => {
    if (mergedIssues.has(n)) return true;
    try {
      return JSON.parse(deps.gh(["issue", "view", String(n), "--json", "state"])).state === "CLOSED";
    } catch {
      return false;
    }
  });
}

// Launches each issue from the repository root, one attempt each. Returns issue → line, and whether any failed.
function launchAll(numbers, deps) {
  const lines = new Map();
  let failed = false;
  const root = numbers.length ? deps.root() : null;
  for (const n of numbers) {
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
  return { lines, failed };
}

// --auto: every ready issue is checked the way /lane does, then pickStartable chooses among the rest against the
// paths open PRs change and running lanes claim. Prints the plan; launches it only with `go`.
function autoStart(go, deps, { maxLanes, softPaths }) {
  let prs, inFlight, openIssues;
  try {
    ({ prs, inFlight } = readInFlight(deps, "number,headRefName,files"));
    openIssues = JSON.parse(deps.gh(["issue", "list", "--state", "open", "--limit", String(ISSUE_LIMIT), "--json", "number,labels,body"]));
    // A blocker missing from a truncated list would not rank, and a running issue's claim would be lost.
    if (openIssues.length >= ISSUE_LIMIT) throw new Error(`${ISSUE_LIMIT}+ open issues: too many to plan from`);
  } catch (err) {
    return { code: 2, lines: [`cannot gather the plan, nothing launched: ${reason(err)}`] };
  }

  const labelsOf = (issue) => (issue.labels ?? []).map((l) => l.name);
  const ready = openIssues.filter((i) => labelsOf(i).includes("ready"));
  if (!ready.length) return { code: 0, lines: ["no ready issues to start"] };

  const busy = new Set(inFlight);
  const skipped = [];
  const candidates = [];
  for (const issue of ready) {
    const why = busy.has(issue.number)
      ? "already in flight"
      : refusal({ state: "OPEN", labels: labelsOf(issue), blockers: checkBlockers([String(issue.number)], deps.gh) });
    if (why) skipped.push({ number: issue.number, reason: why });
    else candidates.push(issue);
  }
  const claimed = claimedPaths({ openPrs: prs, runningIssues: openIssues.filter((i) => busy.has(i.number)) });
  const { start, skipped: notPicked } = pickStartable({ candidates, claimed, openIssues, maxLanes, inFlightCount: busy.size, softPaths });
  const skipLines = [...skipped, ...notPicked].sort((a, b) => a.number - b.number).map((s) => `#${s.number}: skipped: ${s.reason}`);

  if (!go) {
    const trailer = start.length ? `dry run, nothing launched: /start --auto --go launches the ${start.length} marked would start` : "dry run: nothing to start";
    return { code: 0, lines: [...start.map((n) => `#${n}: would start`), ...skipLines, trailer] };
  }
  const { lines, failed } = launchAll(start, deps);
  return { code: failed ? 1 : 0, lines: [...start.map((n) => lines.get(n)), ...skipLines] };
}

/**
 * Reads the issues, plans and launches. `deps` holds fakes in tests: `gh(args)` and `claude(args, { cwd })` return
 * stdout, `root()` the main repository root, `config()` the parsed lanes.config.json (undefined when there is none).
 * Returns the exit code and the lines to print.
 */
export function main(argv, deps = { gh, claude, root: repoRoot, config: readConfig }) {
  const args = argv.map((a) => String(a).replace(/^#/, ""));
  const auto = args[0] === "--auto";
  if (auto ? args.length > 2 || (args.length === 2 && args[1] !== "--go") : !args.length || args.some((a) => !/^[1-9]\d*$/.test(a))) {
    return { code: 2, lines: [USAGE] };
  }

  let config;
  try {
    const raw = deps.config();
    try {
      config = startConfig(raw);
    } catch (err) {
      return { code: 2, lines: [`nothing launched: ${err.message}`] };
    }
  } catch (err) {
    return { code: 2, lines: [`cannot read lanes.config.json, nothing launched: ${reason(err)}`] };
  }
  if (auto) return autoStart(args[1] === "--go", deps, config);

  const numbers = [...new Set(args.map(Number))];
  let inFlight;
  try {
    ({ inFlight } = readInFlight(deps, "headRefName"));
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

  const { launch, refused } = planStart({ issues, inFlight, overlaps, maxLanes: config.maxLanes });
  const launched = launchAll(launch, deps);
  const lines = new Map([...refused.map((r) => [r.number, `#${r.number}: refused: ${r.reason}`]), ...launched.lines]);
  return { code: refused.length || launched.failed ? 1 : 0, lines: numbers.map((n) => lines.get(n)) };
}

const gh = (args) => execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const claude = (args, { cwd }) => execFileSync("claude", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
// The main checkout, even when run from a worktree: the parent of the shared .git directory.
const repoRoot = () => dirname(execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim());
// The main checkout's lanes.config.json, parsed; undefined when it does not exist (the defaults apply).
function readConfig() {
  let text;
  try {
    text = readFileSync(join(repoRoot(), "lanes.config.json"), "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return undefined;
    throw err;
  }
  return JSON.parse(text);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { code, lines } = main(process.argv.slice(2));
  for (const line of lines) console.log(line);
  process.exitCode = code;
}
