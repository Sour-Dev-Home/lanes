// scripts/lanes/start.mjs
// /start: removes merged lanes (cleanup.mjs), then checks each requested issue the way /lane does and launches the
// rest as background lanes.
// Usage: node scripts/lanes/start.mjs <N> [<N> ...]. Exit 0: every requested issue launched. 1: something was
// refused or failed to launch. 2: bad arguments or config, or the lanes in flight could not be counted (nothing launched).
// Or: node scripts/lanes/start.mjs --auto [--go]. Picks from every ready issue with pickStartable and prints the plan;
// only --go launches it. Exit 0: printed (and, with --go, every pick launched). 1: a launch failed. 2: as above.
// The cap and the soft paths come from the `start` block of lanes.config.json.
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { main as checkBlockers } from "./blockers.mjs";
import { cleanupMerged } from "./cleanup.mjs";
import { TIERS, parseIssueForm } from "./lib.mjs";
import { claimedPaths, pickStartable } from "./pick.mjs";
import { issuePaths, pathsOverlap } from "./paths.mjs";
import { grantPath, grantRefusal, readGrant } from "./start-guard.mjs";

export const START_DEFAULTS = Object.freeze({
  maxLanes: 8,
  softPaths: Object.freeze(["^docs/USING\\.md$", "^README\\.md$"]),
  models: Object.freeze({}),
});
const MAX_LANES_LIMIT = 10;
// A model name is one word that cannot start with `-`, so claude never reads it as a flag.
const MODEL_NAME = /^[^\s-]\S*$/;
const PR_LIMIT = 1000;
const ISSUE_LIMIT = 1000;

/**
 * The `start` block of a parsed lanes.config.json, each missing key (or the whole block) filled from START_DEFAULTS.
 * Throws when maxLanes is not a whole number from 1 to 10, softPaths is not an array of valid regex strings, or
 * models is not an object mapping tiers (skip, quick, full) to model names.
 * @returns {{ maxLanes: number, softPaths: string[], models: { skip?: string, quick?: string, full?: string } }}
 */
export function startConfig(raw) {
  const start = raw?.start;
  if (start === undefined) return { maxLanes: START_DEFAULTS.maxLanes, softPaths: [...START_DEFAULTS.softPaths], models: {} };
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
  return { maxLanes, softPaths: [...softPaths], models: startModels(start.models) };
}

// start.models, validated and copied; no models when the key is missing.
function startModels(models) {
  if (models === undefined) return {};
  if (models === null || typeof models !== "object" || Array.isArray(models)) {
    throw new Error("lanes.config.json: start.models must be an object mapping skip, quick or full to a model name");
  }
  const copy = {};
  for (const [tier, model] of Object.entries(models)) {
    if (!TIERS.includes(tier)) throw new Error(`lanes.config.json: start.models: unknown tier ${JSON.stringify(tier)}, expected one of ${TIERS.join(", ")}`);
    if (typeof model !== "string" || !MODEL_NAME.test(model)) {
      throw new Error(`lanes.config.json: start.models.${tier} must be a model name (one word, not starting with -), got ${JSON.stringify(model)}`);
    }
    copy[tier] = model;
  }
  return copy;
}

/**
 * The claude arguments for one lane: `--name lane-<n>`, so `claude agents` shows which issue a session works, then
 * `--model <name>` before `/lane <n>` when start.models has a model for the issue's tier, and none otherwise. No
 * permission-mode flag: a lane runs under the owner's normal settings.
 * @param {number} n
 * @param {{ tier?: string, models?: { skip?: string, quick?: string, full?: string }, opus?: boolean }} [options] tier
 *   without `tier:`; opus (the issue's `model:opus` label) launches on Opus over the tier's model
 */
export function launchArgs(n, { tier, models = {}, opus = false } = {}) {
  const model = opus ? "opus" : TIERS.includes(tier) && Object.hasOwn(models, tier) ? models[tier] : undefined;
  const named = ["--bg", "--name", `lane-${n}`];
  return model ? [...named, "--model", model, `/lane ${n}`] : [...named, `/lane ${n}`];
}

// The tier of an issue from its label names (`tier:quick` → `quick`), or undefined.
const tierOf = (labels) => labels.find((l) => l.startsWith("tier:"))?.slice("tier:".length);

// The model:* labels of an issue: whether `model:opus` is set, and the other model:* labels, which are ignored.
// Only the one literal label selects a model, so a label can never pass an arbitrary string to `claude --model`.
function modelLabels(labels = []) {
  const model = labels.filter((l) => l.startsWith("model:"));
  return { opus: model.includes("model:opus"), ignored: model.filter((l) => l !== "model:opus") };
}

// ANSI escape sequences: CSI (colours, cursor moves) and OSC (e.g. hyperlinks), ended by BEL or ESC \.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/**
 * #337: the environment a lane launches with. On Windows, Git's `usr\bin` and `mingw64\bin` go ahead of the inherited
 * PATH so the POSIX tools resolve; `gitExecPath` is the output of `git --exec-path` (`<git>/mingw64/libexec/git-core`),
 * or empty when git could not be run. Other platforms, and Windows without a usable Git, get `env` back unchanged
 * (`note` says why in the second case). Never mutates `env`.
 */
export function launchEnv(env, platform, gitExecPath) {
  if (platform !== "win32") return { env, note: null };
  if (!gitExecPath) return { env, note: "PATH not adjusted: git not found" };
  const parts = win32.normalize(gitExecPath.trim()).split(win32.sep).filter(Boolean);
  const n = parts.length;
  if (n < 4 || parts[n - 1] !== "git-core" || parts[n - 2] !== "libexec" || parts[n - 3].toLowerCase() !== "mingw64" || !/^[a-z]:$/i.test(parts[0])) {
    return { env, note: `PATH not adjusted: unexpected git --exec-path: ${gitExecPath.trim()}` };
  }
  // A bare drive (`C:`) needs its separator back, or `C:usr\bin` would be drive-relative. A `;` would split the entry.
  const root = parts.slice(0, n - 3).join(win32.sep) + (n === 4 ? win32.sep : "");
  if (root.includes(";")) return { env, note: `PATH not adjusted: unexpected git --exec-path: ${gitExecPath.trim()}` };
  const tools = [win32.join(root, "usr", "bin"), win32.join(root, "mingw64", "bin")].join(";");
  const key = Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "Path";
  return { env: { ...env, [key]: env[key] ? `${tools};${env[key]}` : tools }, note: null };
}

// The launch environment for this machine: asks git where it lives; a git that cannot run counts as not found.
function localLaunchEnv() {
  let out = "";
  try {
    out = execFileSync("git", ["--exec-path"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch {}
  return launchEnv(process.env, process.platform, out);
}

/** The session id from `claude --bg` output (`backgrounded · <id>`), or null when none was printed. Colour is ignored. */
export function parseSessionId(output) {
  return String(output ?? "").replace(ANSI, "").match(/backgrounded · ([\w-]+)/)?.[1] ?? null;
}

const branchIssue = (name) => String(name ?? "").match(/^issue-(\d+)-/)?.[1];
// A lane's worktree folder is `issue-<N>-<slug>`, or bare `issue-<N>` when the lane skipped the slug (#134).
const sessionIssue = (s) => (s.kind === "background" ? String(s.cwd ?? "").match(/(?:^|[\\/])issue-(\d+)(?:-[^\\/]*)?(?:[\\/]|$)/)?.[1] : undefined);

/**
 * The issues with a lane in flight: open PRs from `issue-<N>-` branches, plus background sessions whose cwd is
 * (inside) an `issue-<N>` or `issue-<N>-<slug>` worktree, except sessions of a `finished` issue (its PR merged or the issue closed), which
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
  // A lane found nothing to build and handed it to the owner (#136); it waits for them to close or rewrite it.
  if (issue.labels.includes("needs-owner")) return "needs-owner";
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
 *   running?: (n: number) => string | null,
 *   maxLanes?: number,
 * }} input issues in request order; `error` marks one that could not be read; `running` gives the reason an issue
 *   overlaps running work (open lane PRs, running lanes), or null; `maxLanes` is start.maxLanes
 * @returns {{ launch: number[], refused: { number: number, reason: string }[] }} both in request order
 */
export function planStart({ issues, inFlight, overlaps, running = () => null, maxLanes = START_DEFAULTS.maxLanes }) {
  const reasons = new Map();
  const busy = new Set(inFlight);
  for (const issue of issues) {
    const reason = refusal(issue) ?? (busy.has(issue.number) ? "already in flight" : running(issue.number));
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

// Spawns lane n's reaper (ADR 0010): `node scripts/lanes/reap.mjs --issue n --session id` from the root, detached,
// its output appended to `.lanes/reap/<n>.log`, and unref'd so it outlives this process. Returns null, or the line
// saying why it did not start; it never throws, so a reaper failure never fails the launch. `deps` needs `spawn` and
// `reaperLog`; /start and the owner-run queue both call this one function.
export function startReaper(n, id, deps, root) {
  let log;
  try {
    log = deps.reaperLog(root, n);
    const child = deps.spawn(process.execPath, [join(root, "scripts", "lanes", "reap.mjs"), "--issue", String(n), "--session", id], {
      cwd: root,
      detached: true,
      stdio: ["ignore", log.fd, log.fd],
      windowsHide: true,
    });
    // A spawn that cannot start returns a child with no pid and emits `error` later; that error is reported here
    // instead, and the listener keeps it from crashing start.mjs.
    child.on("error", () => {});
    if (child.pid === undefined) return `#${n}: reaper not started: no process started`;
    child.unref();
    return null;
  } catch (err) {
    return `#${n}: reaper not started: ${reason(err)}`;
  } finally {
    // The child holds its own copy of the log's descriptor.
    try {
      log?.close();
    } catch {
      // Nothing to do: the reaper already has the log or never started.
    }
  }
}

// `.lanes/reap/<n>.log` under root, created as needed and opened for appending, as { fd, close }.
export function reaperLog(root, n) {
  const dir = join(root, ".lanes", "reap");
  mkdirSync(dir, { recursive: true });
  const fd = openSync(join(dir, `${n}.log`), "a");
  return { fd, close: () => closeSync(fd) };
}

// Launches each issue from the repository root, one attempt each, on its tier's model (`tiers`: issue → tier), and
// starts a reaper for each lane that returned a session id. Returns issue → lines, and whether any launch failed.
// `labels` (issue → label names) supplies the model:opus override; an ignored model:* label is logged once.
function launchAll(numbers, deps, { tiers, models, labels }) {
  const lines = new Map();
  let failed = false;
  const root = numbers.length ? deps.root() : null;
  const { env, note: envNote } = numbers.length && deps.launchEnv ? deps.launchEnv() : { env: undefined, note: null };
  for (const n of numbers) {
    const { opus, ignored } = modelLabels(labels.get(n));
    // A label name is untrusted text: control characters (ANSI escapes, newlines) become `?` in the log line.
    const notes = ignored.map((l) => `#${n}: ignored label ${l.replace(/[\x00-\x1f\x7f-\x9f]/g, "?")}`);
    if (envNote) notes.push(`#${n}: ${envNote}`);
    // One attempt only: a launch that printed no id may still have started, and a retry could start it twice.
    let id = null;
    let why = "no session id in output";
    try {
      id = parseSessionId(deps.claude(launchArgs(n, { tier: tiers.get(n), models, opus }), env ? { cwd: root, env } : { cwd: root }));
    } catch (err) {
      why = reason(err);
    }
    if (id) {
      const reaperFailed = startReaper(n, id, deps, root);
      lines.set(n, [...notes, `#${n} → ${id}`, ...(reaperFailed ? [reaperFailed] : [])]);
    } else {
      lines.set(n, [...notes, `#${n}: launch failed: ${why}, not retried`]);
      failed = true;
    }
  }
  return { lines, failed };
}

// --auto: every ready issue is checked the way /lane does, then pickStartable chooses among the rest against the
// paths open PRs change and running lanes claim. Prints the plan; launches it only with `go`.
function autoStart(go, deps, { maxLanes, softPaths, models }) {
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
  const tiers = new Map(candidates.map((i) => [i.number, tierOf(labelsOf(i))]));
  const labels = new Map(candidates.map((i) => [i.number, labelsOf(i)]));
  const { lines, failed } = launchAll(start, deps, { tiers, models, labels });
  return { code: failed ? 1 : 0, lines: [...start.flatMap((n) => lines.get(n)), ...skipLines] };
}

/**
 * Checks this session's /start grant, removes merged lanes, then reads the issues, plans and launches, and deletes
 * the grant. `deps` holds fakes in tests: `gh(args)` and `claude(args, { cwd })` return stdout, `root()` the main
 * repository root, `config()` the parsed lanes.config.json (undefined when there is none), `cleanup({ dryRun })`
 * cleanupMerged's lines, `spawn(cmd, args, options)` a child_process.spawn child, `reaperLog(root, n)` lane n's reaper
 * log opened for appending, as `{ fd, close }`, `session()` this session's id, `grantDir()` the directory of grant
 * files, `now()` the time in ms, and optionally `removeGrant(file)`. Returns the exit code and the lines to print,
 * cleanup's first.
 */
export function main(argv, deps = { gh, claude, root: repoRoot, config: readConfig, cleanup: cleanupMerged, spawn, reaperLog, session, grantDir, now: Date.now, launchEnv: localLaunchEnv }) {
  const args = argv.map((a) => String(a).replace(/^#/, ""));
  const auto = args[0] === "--auto";
  if (auto ? args.length > 2 || (args.length === 2 && args[1] !== "--go") : !args.length || args.some((a) => !/^[1-9]\d*$/.test(a))) {
    return { code: 2, lines: [USAGE] };
  }
  const go = args[1] === "--go";

  // ADR 0007: whatever reached this script, it launches nothing without the owner's fresh /start for these arguments.
  const sessionId = deps.session();
  const file = grantPath(deps.grantDir(), sessionId);
  // A repeated number launches once, so it is compared once.
  const run = auto ? { auto: go ? "go" : "dry" } : { issues: [...new Set(args.map(Number))] };
  const refused = grantRefusal(file ? readGrant(file) : null, sessionId, run, deps.now());
  if (refused) return { code: 2, lines: [`nothing launched: ${refused}`] };
  // Claimed by an atomic rename before anything runs, so of two overlapping runs only one gets it (#217). The claimed
  // copy is checked again in case the owner typed a new /start between the check above and the rename.
  const claimed = `${file}.claimed-${randomUUID()}`;
  try {
    renameSync(file, claimed);
  } catch (err) {
    return { code: 2, lines: [`nothing launched: ${err.code === "ENOENT" ? "the /start grant was already used by another run" : `the /start grant could not be claimed: ${reason(err)}`}`] };
  }
  const changed = grantRefusal(readGrant(claimed), sessionId, run, deps.now());
  if (changed) {
    try {
      if (!existsSync(file)) renameSync(claimed, file);
    } catch {
      // The grant stays claimed and unused; the owner types /start again.
    }
    return { code: 2, lines: [`nothing launched: ${changed}`] };
  }

  let result;
  let notRemoved = null;
  try {
    result = startRun(auto, go, args, deps);
  } finally {
    // Single use, even when the run stopped early: a second run needs the owner's /start again.
    try {
      (deps.removeGrant ?? rmSync)(claimed);
    } catch (err) {
      notRemoved = reason(err);
    }
  }
  if (notRemoved === null) return result;
  return { code: Math.max(result.code, 1), lines: [...result.lines, `the /start grant could not be removed: ${notRemoved}`] };
}

// The run once the grant is accepted: config, cleanup, then the plan and its launches.
function startRun(auto, go, args, deps) {
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
  // Merged lanes go first, so their sessions no longer count as in flight; only --auto without --go is a dry run.
  const cleaned = cleanupLines(deps, auto && !go);
  const { code, lines } = auto ? autoStart(go, deps, config) : startIssues(args, deps, config);
  return { code, lines: [...cleaned, ...lines] };
}

// cleanupMerged's lines, best-effort: a throw, or a step it reports failed, becomes `cleanup failed: <reason>`, and
// never changes the start run's plan or exit code.
function cleanupLines(deps, dryRun) {
  try {
    const lines = deps.cleanup({ dryRun });
    if (!Array.isArray(lines)) throw new Error("cleanup returned no lines");
    return lines.map((line) => (line.startsWith("failed ") ? `cleanup failed: ${line.slice("failed ".length)}` : line));
  } catch (err) {
    return [`cleanup failed: ${reason(err)}`];
  }
}

// <N...>: checks each requested issue the way /lane does and launches what passes.
function startIssues(args, deps, config) {
  const numbers = [...new Set(args.map(Number))];
  let prs, inFlight;
  try {
    ({ prs, inFlight } = readInFlight(deps, "number,headRefName,files"));
  } catch (err) {
    return { code: 2, lines: [`cannot count lanes in flight, nothing launched: ${reason(err)}`] };
  }
  // A running lane without a PR claims its issue's Scope, so the open issues' bodies are needed as in --auto.
  let openIssues;
  try {
    openIssues = JSON.parse(deps.gh(["issue", "list", "--state", "open", "--limit", String(ISSUE_LIMIT), "--json", "number,body"]));
    if (openIssues.length >= ISSUE_LIMIT) throw new Error(`${ISSUE_LIMIT}+ open issues: too many to read running lanes`);
  } catch (err) {
    return { code: 2, lines: [`cannot check running lanes, nothing launched: ${reason(err)}`] };
  }
  const claimed = claimedPaths({ openPrs: prs, runningIssues: openIssues.filter((i) => inFlight.includes(i.number)) });

  const issues = [];
  const pathsOf = new Map();
  const runningOverlap = new Map();
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
    if (issuePaths({ scope: form.scope }).length) {
      pathsOf.set(n, issuePaths(form));
      // The same check --auto makes: pickStartable on this one issue against what running work claims.
      const { skipped } = pickStartable({ candidates: [{ number: n, body: view.body }], claimed, openIssues: [], maxLanes: 1, inFlightCount: 0, softPaths: config.softPaths });
      const hit = skipped.find((s) => s.reason.startsWith("overlaps running "));
      if (hit) runningOverlap.set(n, hit.reason);
    }
    issues.push({ number: n, state: view.state, labels: (view.labels ?? []).map((l) => l.name), blockers: checkBlockers([String(n)], deps.gh) });
  }
  // Soft paths never count, as in pickStartable for --auto.
  const soft = config.softPaths.map((s) => new RegExp(s));
  const hard = (paths) => paths.filter((p) => !soft.some((re) => re.test(p)));
  const overlaps = (a, b) => pathsOf.has(a) && pathsOf.has(b) && pathsOverlap(hard(pathsOf.get(a)), hard(pathsOf.get(b)));

  const { launch, refused } = planStart({ issues, inFlight, overlaps, running: (n) => runningOverlap.get(n) ?? null, maxLanes: config.maxLanes });
  const tiers = new Map(issues.filter((i) => i.labels).map((i) => [i.number, tierOf(i.labels)]));
  const labels = new Map(issues.filter((i) => i.labels).map((i) => [i.number, i.labels]));
  const launched = launchAll(launch, deps, { tiers, models: config.models, labels });
  const lines = new Map([...refused.map((r) => [r.number, [`#${r.number}: refused: ${r.reason}`]]), ...launched.lines]);
  return { code: refused.length || launched.failed ? 1 : 0, lines: numbers.flatMap((n) => lines.get(n)) };
}

// The grant the start guard's UserPromptSubmit hook writes: `.lanes/start/<session>.json` beside these scripts, the
// same directory the hook resolves from its own file.
const session = () => process.env.CLAUDE_CODE_SESSION_ID;
const grantDir = () => fileURLToPath(new URL("../../.lanes/start/", import.meta.url));
const gh = (args) => execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const claude = (args, { cwd, env }) => execFileSync("claude", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
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
