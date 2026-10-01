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
import { accessSync, appendFileSync, closeSync, constants as fsConstants, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { mintInstallationToken, writeGhHosts } from "./app-token.mjs";
import { main as checkBlockers } from "./blockers.mjs";
import { cleanupMerged } from "./cleanup.mjs";
import { TIERS, laneIssueOf, parseIdentity, parseIssueForm } from "./lib.mjs";
import { claimedPaths, pickStartable } from "./pick.mjs";
import { SAFE_SESSION_ID, idleLaneRecovery, idleLaneSession, laneWorktree, worktreeUnsaved } from "./status.mjs";
import { issuePaths, pathsOverlap } from "./paths.mjs";
import { grantPath, grantRefusal, readGrant } from "./start-guard.mjs";

export const START_DEFAULTS = Object.freeze({
  maxLanes: 8,
  softPaths: Object.freeze(["^docs/USING\\.md$", "^README\\.md$", "^lanes\\.config\\.json$"]),
  models: Object.freeze({}),
});
// #390: the budget config lives in lane-cost.mjs, which the installed status.mjs already imports (start.mjs is not installed).
export { BUDGET_DEFAULTS, budgetConfig } from "./lane-cost.mjs";

// #483: `.lanes/starts.jsonl` (git-ignored, never posted) holds one line per issue /start or the queue decided on, and
// only these fields: `at`, `issue`, `outcome` (started | skipped), `reason` (skipped only) and, for an overlap, `with`.
// No path, title or prompt text, the same rule as costs.jsonl. status.mjs --starts reads it.
export const START_REASONS = Object.freeze(["overlap", "cap", "blocked", "in-flight", "not-ready", "other"]);

/** Which START_REASONS a skip's text is, and for an overlap the first other issue or PR it names. Pure. */
export function classifySkip(text) {
  const why = String(text);
  const overlap = /^overlaps (?:running )?#(\d+)/.exec(why);
  if (overlap) return { reason: "overlap", with: Number(overlap[1]) };
  if (/^cap of \d+ lanes/.test(why)) return { reason: "cap" };
  if (/^blocked by /.test(why)) return { reason: "blocked" };
  if (/^already in flight/.test(why)) return { reason: "in-flight" };
  if (/^(not open|lacks ready|needs-owner|assigned to |no single tier)/.test(why)) return { reason: "not-ready" };
  return { reason: "other" };
}

/** The log lines for one run: `started` issues and `skipped` ones (`{ number, reason }`, the reason as printed). Pure. */
export function startDecisions({ started = [], skipped = [], at }) {
  return [
    ...started.map((issue) => ({ at, issue, outcome: "started" })),
    ...skipped.map((s) => ({ at, issue: s.number, outcome: "skipped", ...classifySkip(s.reason) })),
  ];
}

/** Appends `lines` to `<root>/.lanes/starts.jsonl`; throws only when the file cannot be written. */
export function appendStarts(root, lines) {
  if (!lines.length) return;
  const dir = join(root, ".lanes");
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, "starts.jsonl"), lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
}

// Best-effort: `deps.recordStarts(root, lines)` is absent in tests that do not look at the log, and a failed write is
// swallowed, so recording never changes a launch.
function recordDecisions(deps, root, decisions) {
  try {
    deps.recordStarts?.(root, decisions);
  } catch {
    // The log is evidence for phase 2, not a gate.
  }
}

const MAX_LANES_LIMIT = 10;
// A lane PATH with more entries than this is reported at launch (#416).
const PATH_NOTE_ABOVE = 60;
// A model name is one word that cannot start with `-`, so claude never reads it as a flag.
const MODEL_NAME = /^[^\s-]\S*$/;
const PR_LIMIT = 1000;
const ISSUE_LIMIT = 1000;

/**
 * The `start` block of a parsed lanes.config.json, each missing key (or the whole block) filled from START_DEFAULTS.
 * Throws when maxLanes is not a whole number from 1 to 10, softPaths is not an array of valid regex strings, or
 * models is not an object mapping tiers (skip, quick, full) to model names.
 * It also carries `identity` (ADR 0019 part 1) when the file sets one: `{ profile: "solo" }` or
 * `{ profile: "team", app: { id, installationId, botLogin } }` (lib's parseIdentity; botLogin is required under team); a
 * missing key leaves it out, which is solo. Throws on any other shape.
 * @returns {{ maxLanes: number, softPaths: string[], models: { skip?: string, quick?: string, full?: string }, identity?: { profile: "solo" | "team", app?: { id: number, installationId: number, botLogin?: string } } }}
 */
export function startConfig(raw) {
  const identity = parseIdentity(raw?.identity);
  const config = startBlock(raw?.start);
  return identity ? { ...config, identity } : config;
}

function startBlock(start) {
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
export function launchArgs(n, { tier, models = {}, opus = false, settings, strictMcp = false } = {}) {
  const model = opus ? "opus" : TIERS.includes(tier) && Object.hasOwn(models, tier) ? models[tier] : undefined;
  // #544: --strict-mcp-config with no --mcp-config loads no MCP server, so a team lane holds no owner credential through one.
  const named = ["--bg", "--name", `lane-${n}`, ...(settings ? ["--settings", settings] : []), ...(strictMcp ? ["--strict-mcp-config"] : [])];
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
  // #416: exact duplicate entries (case-insensitive, as on Windows) are dropped, the first kept and the order too.
  const seen = new Set();
  const entries = (env[key] ? `${tools};${env[key]}` : tools).split(";").filter((e) => {
    if (e === "") return true;
    const id = e.toLowerCase();
    return seen.has(id) ? false : (seen.add(id), true);
  });
  const note = entries.length > PATH_NOTE_ABOVE ? `PATH has ${entries.length} entries (${seen.size} unique)` : null;
  return { env: { ...env, [key]: entries.join(";") }, note };
}

// The launch environment for this machine: asks git where it lives; a git that cannot run counts as not found.
export function localLaunchEnv() {
  let out = "";
  try {
    out = execFileSync("git", ["--exec-path"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch {}
  return launchEnv(process.env, process.platform, out);
}

// ADR 0019 part 3: what a team lane never inherits. Matched case-insensitively, as Windows environment names are.
// One source (#540): the launcher env drops these, and the settings `env` blanks or sets each exact name, so they cannot drift.
export const TEAM_SCRUBBED_NAMES = ["LANES_APP_KEY_FILE", "GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GH_CONFIG_DIR", "GIT_ASKPASS", "SSH_ASKPASS", "GIT_TERMINAL_PROMPT", "GITHUB_PERSONAL_ACCESS_TOKEN", "SSH_AUTH_SOCK", "GIT_SSH", "GIT_SSH_COMMAND", "GH_HOST", "GH_REPO", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"];
// Prefix families cannot be enumerated: the known names below are blanked in the settings `env`, and any other name
// in them can only matter through git config, which GIT_CONFIG_GLOBAL/SYSTEM (empty) leave with gh's helper alone.
const TEAM_SCRUBBED_PREFIXES = ["GIT_CONFIG_", "GIT_CREDENTIAL", "GCM_"];
const TEAM_KNOWN_PREFIXED = ["GIT_CONFIG_PARAMETERS", "GIT_CONFIG_NOSYSTEM", "GIT_CREDENTIAL_HELPER", "GCM_INTERACTIVE", "GCM_CREDENTIAL_STORE", "GCM_PROVIDER", "GCM_AUTHORITY", "GCM_GUI_PROMPT"];
const TEAM_SCRUBBED = [...TEAM_SCRUBBED_NAMES.map((n) => new RegExp(`^${n}$`, "i")), ...TEAM_SCRUBBED_PREFIXES.map((p) => new RegExp(`^${p}`, "i"))];

/** Whether `dir` is a lane directory `makeDir` creates: `lanes-gh-<issue>-*` directly under the OS temp folder, not a link. */
export function isLaneGhDir(dir, tmp, isLink = () => false) {
  const parts = String(dir).split(/[\\/]+/).filter(Boolean);
  const base = parts.pop() ?? "";
  const parent = String(dir).slice(0, String(dir).length - base.length).replace(/[\\/]+$/, "");
  const norm = (p) => String(p).replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
  return /^lanes-gh-[1-9]\d*-[A-Za-z0-9]+$/.test(base) && norm(parent) === norm(tmp) && !isLink(dir);
}

/**
 * ADR 0019 parts 3 and 4: the environment a team lane launches with. Credentials and git credential settings are
 * removed, `GH_CONFIG_DIR` is the lane's own directory (holding the minted token), git reads an empty config file, and
 * the only credential helper is `gh auth git-credential`. Never mutates `env`.
 * @param {Record<string, string | undefined>} env
 * @param {{ ghDir: string, emptyConfig: string }} lane
 */
export function teamLaneEnv(env, { ghDir, emptyConfig, commit }) {
  const kept = Object.fromEntries(Object.entries(env).filter(([k]) => !TEAM_SCRUBBED.some((re) => re.test(k))));
  return { ...kept, ...teamLaneVars({ ghDir, emptyConfig, commit }) };
}

/**
 * #553: GitHub's standard identity for an App bot, `<bot user id>+<login>@users.noreply.github.com`, so a team lane's
 * commits are credited to the bot. Null when the id is not a positive whole number.
 */
export function botCommitIdentity(login, id) {
  const n = typeof id === "number" ? id : /^\d+$/.test(String(id ?? "").trim()) ? Number(String(id).trim()) : NaN;
  if (typeof login !== "string" || !login || !Number.isSafeInteger(n) || n < 1) return null;
  return { name: login, email: `${n}+${login}@users.noreply.github.com` };
}

/**
 * #540: the variables a team lane sets, apart from what it scrubs. `origin` is ssh in the repository's own
 * `.git/config`, which GIT_CONFIG_GLOBAL does not override, so git is told to rewrite both ssh forms of github.com to
 * https (where `gh auth git-credential` answers) and `GIT_SSH_COMMAND` fails, so a push never reaches the owner's key.
 */
export function teamLaneVars({ ghDir, emptyConfig, commit }) {
  // #553: git config is empty for a team lane, so the bot's commit identity comes from the environment.
  const identity = commit ? { GIT_AUTHOR_NAME: commit.name, GIT_AUTHOR_EMAIL: commit.email, GIT_COMMITTER_NAME: commit.name, GIT_COMMITTER_EMAIL: commit.email } : {};
  return {
    ...identity,
    GH_CONFIG_DIR: ghDir,
    GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_CONFIG_SYSTEM: emptyConfig,
    // The first, empty value resets any helper list; the second is the only helper.
    GIT_CONFIG_COUNT: "4",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "credential.helper",
    GIT_CONFIG_VALUE_1: "!gh auth git-credential",
    GIT_CONFIG_KEY_2: "url.https://github.com/.insteadOf",
    GIT_CONFIG_VALUE_2: "git@github.com:",
    GIT_CONFIG_KEY_3: "url.https://github.com/.insteadOf",
    GIT_CONFIG_VALUE_3: "ssh://git@github.com/",
    GIT_SSH_COMMAND: 'echo "lanes: ssh is disabled for a team lane" >&2; exit 1',
    GIT_TERMINAL_PROMPT: "0",
  };
}

// Names a launcher's env removes from a team lane; in settings `env` (which cannot unset) they are blanked instead,
// except those the lane sets (teamLaneVars comes last and overrides).
const TEAM_BLANKED = [...TEAM_SCRUBBED_NAMES, ...TEAM_KNOWN_PREFIXED];

/**
 * #540: the `--settings` content that carries the team environment into a `claude --bg` session. A background session
 * is started by a host that holds the owner's environment, so the launcher's `env` does not reach the session's tools;
 * a settings file's `env` is applied to the session's tool processes. Holds no secret.
 */
export function teamLaneSettings({ ghDir, emptyConfig, commit }) {
  // #544, #549: a best-effort backstop behind --strict-mcp-config, should an MCP server load another way. `mcp__github`
  // is the documented `mcp__<server>` permission form; the bare `mcp__*` wildcard is not documented, so it is only an extra.
  return { env: { ...Object.fromEntries(TEAM_BLANKED.map((k) => [k, ""])), ...teamLaneVars({ ghDir, emptyConfig, commit }) }, permissions: { deny: ["mcp__github", "mcp__*"] } };
}

// Launcher side of the team profile for lane n: checks the key, makes the lane's directory and mints into it. Returns
// `{ env, dir, repo }`, or `{ failed: <step> }` with the directory removed: it never falls back to the owner's environment.
// `deps.team` (keyFile, readable, repo, makeDir, removeDir, mintInto, botUserId, writeSettings) is absent where team is
// not supported.
function prepareTeam(n, identity, deps, baseEnv) {
  const team = deps.team;
  if (!team) return { failed: "not supported here" };
  let repo;
  try {
    const keyFile = team.keyFile();
    if (!keyFile) return { failed: "LANES_APP_KEY_FILE is not set" };
    try {
      team.readable(keyFile);
    } catch {
      return { failed: "key file unreadable" };
    }
    try {
      repo = team.repo();
    } catch {
      return { failed: "repository name unknown" };
    }
    let lane;
    try {
      lane = team.makeDir(n);
    } catch {
      return { failed: "could not create the lane's config directory" };
    }
    try {
      team.mintInto({ issue: n, appId: identity.app.id, installationId: identity.app.installationId, repo, dir: lane.dir });
    } catch (err) {
      removeQuietly(team, lane.dir);
      return { failed: `token mint failed: ${reason(err)}` };
    }
    // #553: the bot's commit identity needs its user id, read with the lane's own fresh token; no id, no launch, and
    // never the owner's identity in its place.
    let commit = null;
    try {
      commit = botCommitIdentity(identity.app.botLogin, team.botUserId({ dir: lane.dir, login: identity.app.botLogin }));
    } catch {
      commit = null;
    }
    if (!commit) {
      removeQuietly(team, lane.dir);
      return { failed: "could not read the App bot's user id for its commit identity" };
    }
    // The launcher's env does not reach a --bg session's tools (#540), so the team environment is also delivered as
    // a settings file; a lane that cannot have it never launches.
    const settings = join(lane.dir, "settings.json");
    try {
      team.writeSettings(settings, teamLaneSettings({ ghDir: lane.dir, emptyConfig: lane.emptyConfig, commit }));
    } catch {
      removeQuietly(team, lane.dir);
      return { failed: "could not deliver the team settings to the lane" };
    }
    return { env: teamLaneEnv(baseEnv, { ghDir: lane.dir, emptyConfig: lane.emptyConfig, commit }), dir: lane.dir, repo, settings };
  } catch {
    return { failed: "unexpected error" };
  }
}

function removeQuietly(team, dir) {
  try {
    team.removeDir(dir);
  } catch {
    // A leftover temp directory holds only an expiring token.
  }
}

/** How often the refresher re-mints: installation tokens last an hour (ADR 0019 part 4). */
export const REFRESH_MS = 45 * 60 * 1000;

/**
 * The refresher's loop: each interval, end when the lane's session is gone (or idle and not blocked, as the reaper
 * counts it), else re-mint into the lane's hosts.yml. A session list that cannot be read, or a failed re-mint, is logged
 * and tried again next interval; the old token stays valid until it expires.
 * @param {{ session: string, intervalMs: number, sessions: () => { id?: string, status?: string, state?: string }[], remint: () => Promise<void>, sleep: (ms: number) => Promise<void>, log: (line: string) => void }} o
 * @returns {Promise<string>} why it ended
 */
export async function refreshLoop({ session, intervalMs, sessions, remint, sleep, log }) {
  for (;;) {
    await sleep(intervalMs);
    let list = null;
    try {
      list = sessions();
    } catch (err) {
      log(`session list not read: ${reason(err)}`);
    }
    if (list) {
      const mine = list.find((s) => s?.id === session);
      if (!mine || (mine.status === "idle" && mine.state !== "blocked")) return "session ended";
    }
    try {
      await remint();
    } catch (err) {
      log(`token refresh failed: ${reason(err)}`);
    }
  }
}

/** The one re-mint step: reads the key file, mints a token for this repo and rewrites the lane's hosts.yml. */
export function makeRemint({ args, keyFile, readFile, mint, writeHosts }) {
  return async () => {
    const file = keyFile();
    if (!file) throw new Error("LANES_APP_KEY_FILE is not set");
    let keyPem;
    try {
      keyPem = readFile(file);
    } catch {
      throw new Error("key file unreadable");
    }
    const { token } = await mint({ appId: args.app, installationId: args.installation, keyPem, repo: args.repo });
    writeHosts(args.dir, token);
  };
}

/** Parses the refresher's command line (after `--refresh-token`), or null when it is malformed. */
export function refreshArgs(argv) {
  const opts = {};
  let once = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--once") {
      once = true;
      continue;
    }
    if (!["--issue", "--session", "--dir", "--app", "--installation", "--repo"].includes(argv[i]) || argv[i] in opts || argv[i + 1] === undefined) return null;
    opts[argv[i]] = argv[(i += 1)];
  }
  const whole = (v) => /^[1-9]\d*$/.test(v ?? "");
  if (!whole(opts["--issue"]) || !whole(opts["--app"]) || !whole(opts["--installation"]) || !opts["--session"] || !opts["--dir"] || !/^[A-Za-z0-9._-]+$/.test(opts["--repo"] ?? "")) return null;
  return { issue: Number(opts["--issue"]), session: opts["--session"], dir: opts["--dir"], app: Number(opts["--app"]), installation: Number(opts["--installation"]), repo: opts["--repo"], once };
}

// Spawns lane n's owner-side refresher, detached and unref'd like the reaper, logging to the same per-issue log. It is a
// node process, not a claude session, so it is never counted as a lane (#494). Returns null or the line saying why not.
function startRefresher(n, id, team, identity, deps, root) {
  let log;
  try {
    log = deps.reaperLog(root, n);
    const child = deps.spawn(
      process.execPath,
      [join(root, "scripts", "lanes", "start.mjs"), "--refresh-token", "--issue", String(n), "--session", id, "--dir", team.dir, "--app", String(identity.app.id), "--installation", String(identity.app.installationId), "--repo", team.repo],
      { cwd: root, detached: true, stdio: ["ignore", log.fd, log.fd], windowsHide: true },
    );
    child.on("error", () => {});
    if (child.pid === undefined) return `#${n}: token refresher not started: no process started`;
    child.unref();
    return null;
  } catch (err) {
    return `#${n}: token refresher not started: ${reason(err)}`;
  } finally {
    try {
      log?.close();
    } catch {
      // The child holds its own copy of the log's descriptor.
    }
  }
}

/** The session id from `claude --bg` output (`backgrounded · <id>`), or null when none was printed. Colour is ignored. */
export function parseSessionId(output) {
  return String(output ?? "").replace(ANSI, "").match(/backgrounded · ([\w-]+)/)?.[1] ?? null;
}

const branchIssue = (name) => String(name ?? "").match(/^issue-(\d+)-/)?.[1];
// A session's issue by its `lane-<N>` name, else its `issue-<N>[-<slug>]` worktree folder (lib.mjs's laneIssueOf, #341).
// An entry with no `kind` is not a background session here, as before.
const sessionIssue = (s) => (s?.kind === "background" ? (laneIssueOf(s) ?? undefined) : undefined);

// The newest session of issue `n`'s lane, or null when none is listed.
function newestLaneSession(sessions, n) {
  let newest = null;
  for (const s of sessions) {
    if (Number(laneIssueOf(s)) !== n || (newest && (newest.startedAt ?? 0) > (s.startedAt ?? 0))) continue;
    newest = s;
  }
  return newest;
}

/**
 * #444: whether issue `n`'s lane session is dead: none is listed, or the newest one is idle with no prompt pending
 * (the same test recovery uses for a lane that ended). A busy or blocked session is alive. Pure.
 * @param {{ kind?: string, id?: string, startedAt?: number, status?: string, state?: string }[]} sessions
 * @param {number} n
 * @returns {{ dead: boolean, session: object | null }} `session` is the newest one, or null when none is listed
 */
export function deadLaneSession(sessions, n) {
  const newest = newestLaneSession(sessions, n);
  return { dead: !newest || (newest.status === "idle" && newest.state !== "blocked"), session: newest };
}

/**
 * The issues with a lane in flight: open PRs from `issue-<N>-` branches, plus background sessions named `lane-<N>` or
 * whose cwd is (inside) an `issue-<N>` or `issue-<N>-<slug>` worktree, except sessions of a `finished` issue (its PR merged or the issue closed), which
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

// #522: gh's `assignees` as logins. An entry with no readable login still counts as a claim, and a non-list value is
// one too: fail closed, never read a malformed field as unassigned.
function assigneeLogins(raw) {
  if (raw === undefined || raw === null) return [];
  return (Array.isArray(raw) ? raw : [null]).map((a) => a?.login || "unknown");
}

// The first reason this issue cannot start on its own, or null. `blockers` is blockers.mjs's `{ code, message }`.
function refusal(issue) {
  if (issue.error) return issue.error;
  if (issue.state !== "OPEN") return "not open";
  if (!issue.labels.includes("ready")) return "lacks ready";
  // A lane found nothing to build and handed it to the owner (#136); it waits for them to close or rewrite it.
  if (issue.labels.includes("needs-owner")) return "needs-owner";
  // #522: the owner claims an issue it will do itself by assigning it.
  if (issue.assignees?.length) return `assigned to ${issue.assignees.join(", ")}`;
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
  return { prs, sessions, inFlight: inFlightIssues({ prs, sessions, finished: finishedIssues(deps, prs, sessions) }) };
}

// #444: "already in flight" for an issue whose only lane is an open PR with no live session says so, and how to resume it.
// #571: with no open PR, a newest session that is idle is a stalled lane: name it and the recovery /status gives too.
function inFlightReason(n, prs, sessions, runGit) {
  const pr = prs.find((p) => Number(branchIssue(p.headRefName)) === n);
  if (!pr) {
    const s = newestLaneSession(sessions, n);
    if (!s || typeof s.id !== "string" || !SAFE_SESSION_ID.test(s.id) || !idleLaneSession(s)) return "already in flight";
    return `already in flight: lane session ${s.id} is idle with no PR; ${idleLaneRecovery(s.id, n, worktreeUnsaved(laneWorktree(s.cwd, n), runGit))}`;
  }
  if (!deadLaneSession(sessions, n).dead) return "already in flight";
  return `already in flight: dead lane with open PR #${pr.number} and no live session; run the queue (node scripts/lanes/queue.mjs) in your terminal to resume it in its worktree once, if its checks or reviews are still owed and nothing there is unsaved`;
}

// The issues of sessions with no open PR whose lane is finished: a merged `issue-<N>-` PR, or the issue closed.
// Throws when the merged PRs cannot be read. An issue that cannot be read is not finished, so it keeps its slot.
function finishedIssues(deps, prs, sessions) {
  const open = new Set(prs.map((pr) => Number(branchIssue(pr.headRefName))));
  const idle = [...new Set(sessions.map(sessionIssue).filter(Boolean))].filter((n) => !open.has(n));
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

export const RUNNING_LABEL = "lane:running";

// ADR 0014: marks issue n as having a running lane, from the owner's side (a lane never gets a write path). Adds
// RUNNING_LABEL, creating the label once when the repository has none, and returns one line: `#n: lane:running set`,
// or `#n: label not set: <reason>`. It never throws, so a label failure never changes a launch. `deps` needs `gh`.
export function markRunning(n, deps) {
  const add = () => deps.gh(["issue", "edit", String(n), "--add-label", RUNNING_LABEL]);
  try {
    try {
      add();
    } catch (err) {
      if (!/not found/i.test(`${err?.stderr ?? ""}\n${err?.message ?? ""}`)) throw err;
      deps.gh(["label", "create", RUNNING_LABEL, "--description", "A lane is running for this issue (set by /start and the queue)"]);
      add();
    }
    return `#${n}: ${RUNNING_LABEL} set`;
  } catch (err) {
    return `#${n}: label not set: ${reason(err)}`;
  }
}

// `.lanes/reap/<n>.log` under root, created as needed and opened for appending, as { fd, close }.
export function reaperLog(root, n) {
  const dir = join(root, ".lanes", "reap");
  mkdirSync(dir, { recursive: true });
  const fd = openSync(join(dir, `${n}.log`), "a");
  return { fd, close: () => closeSync(fd) };
}

const WORKFLOW_DIR = ".github/workflows/";
const WORKFLOW_NOTE = (n) => `#${n}: Scope names .github/workflows/: the lane opens its PR without the workflow change and hands it over in a PR comment`;

/** True when a Scope path list names `.github/workflows/` or a file under it (ADR 0023 part 5). */
export function scopeNamesWorkflows(paths) {
  return Array.isArray(paths) && paths.some((p) => typeof p === "string" && (p.startsWith(WORKFLOW_DIR) || p === WORKFLOW_DIR.slice(0, -1)));
}

/**
 * Launches one lane, one attempt, on its tier's model, and starts its reaper (and, under team, its token refresher)
 * once it returns a session id. /start and the owner-run queue both launch through this one function (#556).
 * `labels` (the issue's label names) supplies the model:opus override; an ignored model:* label is logged once. `env`
 * is the launch environment (`launchEnv()`'s env, or undefined for the inherited one) and `envNote` its note. The
 * session starts in `cwd` (default `root`); the reaper and refresher run from `root`, the main checkout. Under team
 * the lane launches with only the App's credentials, or not at all (ADR 0019). `deps` needs `claude`, `spawn`,
 * `reaperLog`, `gh`, and `team` under team. Never throws for a launch or preparation failure.
 * @returns {{ id: string | null, failed: boolean, lines: string[] }}
 */
export function launchLane(n, deps, { tier, models, labels, identity, root, cwd = root, env, envNote = null, scope = [] }) {
  const { opus, ignored } = modelLabels(labels);
  // A label name is untrusted text: control characters (ANSI escapes, newlines) become `?` in the log line.
  const notes = ignored.map((l) => `#${n}: ignored label ${l.replace(/[\x00-\x1f\x7f-\x9f]/g, "?")}`);
  if (envNote) notes.push(`#${n}: ${envNote}`);
  // ADR 0023 part 5: informational only; the lane's own diff check acts, and the issue still launches.
  if (identity?.profile === "team" && scopeNamesWorkflows(scope)) notes.push(WORKFLOW_NOTE(n));
  let lane = null;
  if (identity?.profile === "team") {
    lane = prepareTeam(n, identity, deps, env ?? process.env);
    if (lane.failed) return { id: null, failed: true, lines: [...notes, `#${n}: launch failed: team profile: ${lane.failed}`] };
  }
  const launchEnvFor = lane ? lane.env : env;
  // One attempt only: a launch that printed no id may still have started, and a retry could start it twice.
  let id = null;
  let why = "no session id in output";
  try {
    id = parseSessionId(deps.claude(launchArgs(n, { tier, models, opus, settings: lane?.settings, strictMcp: Boolean(lane?.settings) }), launchEnvFor ? { cwd, env: launchEnvFor } : { cwd }));
  } catch (err) {
    why = reason(err);
  }
  if (!id) {
    if (lane) removeQuietly(deps.team, lane.dir);
    return { id: null, failed: true, lines: [...notes, `#${n}: launch failed: ${why}, not retried`] };
  }
  const reaperFailed = startReaper(n, id, deps, root);
  const refresherFailed = lane ? startRefresher(n, id, lane, identity, deps, root) : null;
  const marked = markRunning(n, deps);
  return { id, failed: false, lines: [...notes, `#${n} → ${id}`, ...(reaperFailed ? [reaperFailed] : []), ...(refresherFailed ? [refresherFailed] : []), ...(marked.includes(": label not set: ") ? [marked] : [])] };
}

// Launches each issue from the repository root through launchLane (`tiers`: issue → tier, `labels`: issue → label
// names). Returns issue → lines, and whether any launch failed.
function launchAll(numbers, deps, { tiers, models, labels, identity, scopes = new Map() }) {
  const lines = new Map();
  let failed = false;
  const root = numbers.length ? deps.root() : null;
  const { env, note: envNote } = numbers.length && deps.launchEnv ? deps.launchEnv() : { env: undefined, note: null };
  for (const n of numbers) {
    const launched = launchLane(n, deps, { tier: tiers.get(n), models, labels: labels.get(n), identity, root, env, envNote, scope: scopes.get(n) ?? [] });
    lines.set(n, launched.lines);
    if (launched.failed) failed = true;
  }
  return { lines, failed };
}

// --auto: every ready issue is checked the way /lane does, then pickStartable chooses among the rest against the
// paths open PRs change and running lanes claim. Prints the plan; launches it only with `go`.
function autoStart(go, deps, { maxLanes, softPaths, models, identity }) {
  let prs, sessions, inFlight, openIssues;
  try {
    ({ prs, sessions, inFlight } = readInFlight(deps, "number,headRefName,files"));
    openIssues = JSON.parse(deps.gh(["issue", "list", "--state", "open", "--limit", String(ISSUE_LIMIT), "--json", "number,labels,body,assignees"]));
    // A blocker missing from a truncated list would not rank, and a running issue's claim would be lost.
    if (openIssues.length >= ISSUE_LIMIT) throw new Error(`${ISSUE_LIMIT}+ open issues: too many to plan from`);
  } catch (err) {
    return { code: 2, lines: [`cannot gather the plan, nothing launched: ${reason(err)}`] };
  }

  const labelsOf = (issue) => (issue.labels ?? []).map((l) => l.name);
  const loginsOf = (issue) => assigneeLogins(issue.assignees);
  const ready = openIssues.filter((i) => labelsOf(i).includes("ready"));
  if (!ready.length) return { code: 0, lines: ["no ready issues to start"] };

  const busy = new Set(inFlight);
  const skipped = [];
  const candidates = [];
  for (const issue of ready) {
    const why = busy.has(issue.number)
      ? inFlightReason(issue.number, prs, sessions, deps.git)
      : refusal({ state: "OPEN", labels: labelsOf(issue), assignees: loginsOf(issue), blockers: checkBlockers([String(issue.number)], deps.gh) });
    if (why) skipped.push({ number: issue.number, reason: why });
    else candidates.push(issue);
  }
  const claimed = claimedPaths({ openPrs: prs, runningIssues: openIssues.filter((i) => busy.has(i.number)) });
  const { start, skipped: notPicked } = pickStartable({ candidates, claimed, openIssues, maxLanes, inFlightCount: busy.size, softPaths });
  const allSkipped = [...skipped, ...notPicked].sort((a, b) => a.number - b.number);
  const skipLines = allSkipped.map((s) => `#${s.number}: skipped: ${s.reason}`);

  if (!go) {
    const trailer = start.length ? `dry run, nothing launched: /start --auto --go launches the ${start.length} marked would start` : "dry run: nothing to start";
    return { code: 0, lines: [...start.map((n) => `#${n}: would start`), ...skipLines, trailer] };
  }
  const tiers = new Map(candidates.map((i) => [i.number, tierOf(labelsOf(i))]));
  const labels = new Map(candidates.map((i) => [i.number, labelsOf(i)]));
  const scopes = new Map(candidates.map((i) => [i.number, issuePaths(parseIssueForm(i.body ?? "").fields)]));
  const { lines, failed } = launchAll(start, deps, { tiers, models, labels, identity, scopes });
  recordDecisions(deps, deps.root(), startDecisions({ started: start, skipped: allSkipped, at: new Date(deps.now()).toISOString() }));
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
export function main(argv, deps = { gh, claude, root: repoRoot, config: readConfig, cleanup: cleanupMerged, spawn, reaperLog, session, grantDir, now: Date.now, launchEnv: localLaunchEnv, recordStarts: appendStarts, team }) {
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
  let prs, inFlight, sessions;
  try {
    ({ prs, inFlight, sessions } = readInFlight(deps, "number,headRefName,files"));
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
      view = JSON.parse(deps.gh(["issue", "view", String(n), "--json", "number,state,labels,body,assignees"]));
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
    issues.push({ number: n, state: view.state, labels: (view.labels ?? []).map((l) => l.name), assignees: assigneeLogins(view.assignees), blockers: checkBlockers([String(n)], deps.gh) });
  }
  // Soft paths never count, as in pickStartable for --auto.
  const soft = config.softPaths.map((s) => new RegExp(s));
  const hard = (paths) => paths.filter((p) => !soft.some((re) => re.test(p)));
  const overlaps = (a, b) => pathsOf.has(a) && pathsOf.has(b) && pathsOverlap(hard(pathsOf.get(a)), hard(pathsOf.get(b)));

  const { launch, refused } = planStart({ issues, inFlight, overlaps, running: (n) => runningOverlap.get(n) ?? null, maxLanes: config.maxLanes });
  const tiers = new Map(issues.filter((i) => i.labels).map((i) => [i.number, tierOf(i.labels)]));
  const labels = new Map(issues.filter((i) => i.labels).map((i) => [i.number, i.labels]));
  const launched = launchAll(launch, deps, { tiers, models: config.models, labels, identity: config.identity, scopes: pathsOf });
  recordDecisions(deps, deps.root(), startDecisions({ started: launch, skipped: refused, at: new Date(deps.now()).toISOString() }));
  const why = (r) => (r.reason === "already in flight" ? inFlightReason(r.number, prs, sessions, deps.git) : r.reason);
  const lines = new Map([...refused.map((r) => [r.number, [`#${r.number}: refused: ${why(r)}`]]), ...launched.lines]);
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

// ADR 0019: the real team-profile steps, all on the owner's side. `mintInto` runs this file's `--refresh-token --once`
// in a child so the launch stays synchronous; the child reads the key from the owner's own environment. Exported as
// `teamSteps` for the queue (#556).
const selfPath = fileURLToPath(import.meta.url);
const team = {
  keyFile: () => process.env.LANES_APP_KEY_FILE,
  readable: (file) => accessSync(file, fsConstants.R_OK),
  repo: () => gh(["repo", "view", "--json", "name", "--jq", ".name"]).trim(),
  // A fresh directory under the OS temp folder: outside the repository and every worktree, owner-only where modes exist.
  makeDir: (n) => {
    const dir = mkdtempSync(join(tmpdir(), `lanes-gh-${n}-`));
    const emptyConfig = join(dir, "empty.gitconfig");
    writeFileSync(emptyConfig, "");
    return { dir, emptyConfig };
  },
  removeDir: (dir) => rmSync(dir, { recursive: true, force: true }),
  writeSettings: (file, settings) => writeFileSync(file, JSON.stringify(settings, null, 2)),
  mintInto: ({ issue, appId, installationId, repo, dir }) => {
    execFileSync(process.execPath, [selfPath, "--refresh-token", "--once", "--issue", String(issue), "--session", "mint-only", "--dir", dir, "--app", String(appId), "--installation", String(installationId), "--repo", repo], {
      env: process.env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    });
  },
  // #553: the bot's numeric user id, asked with the lane's freshly minted token only (its own GH_CONFIG_DIR, no
  // owner token variables), so the answer never comes from the owner's login.
  botUserId: ({ dir, login }) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !TEAM_SCRUBBED.some((re) => re.test(k))));
    return execFileSync("gh", ["api", `users/${encodeURIComponent(login)}`, "--jq", ".id"], {
      env: { ...env, GH_CONFIG_DIR: dir },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    }).trim();
  },
};
export { team as teamSteps };

// `--refresh-token`: the owner-side refresher (or, with --once, a single mint). Not grant-gated: it only rewrites the
// lane's own hosts.yml from the owner's key file, and it prints a failure's step only, never the key or a token.
async function runRefresher(argv) {
  const args = refreshArgs(argv);
  if (!args) {
    console.error("usage: start.mjs --refresh-token --issue <N> --session <id> --dir <dir> --app <id> --installation <id> --repo <name> [--once]");
    return 2;
  }
  if (!isLaneGhDir(args.dir, tmpdir(), (d) => lstatSync(d).isSymbolicLink())) {
    console.error("refusing: --dir is not a lane config directory");
    return 2;
  }
  const remint = makeRemint({ args, keyFile: () => process.env.LANES_APP_KEY_FILE, readFile: (file) => readFileSync(file, "utf8"), mint: mintInstallationToken, writeHosts: writeGhHosts });
  if (args.once) {
    try {
      await remint();
      return 0;
    } catch (err) {
      console.error(reason(err));
      return 1;
    }
  }
  const log = (line) => console.log(`${new Date().toISOString()} #${args.issue}: ${line}`);
  const why = await refreshLoop({
    session: args.session,
    intervalMs: REFRESH_MS,
    sessions: () => {
      const agents = JSON.parse(execFileSync("claude", ["agents", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000, windowsHide: true }));
      if (!Array.isArray(agents)) throw new Error("not a list");
      return agents;
    },
    remint,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log,
  });
  log(`refresher exits: ${why}`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === "--refresh-token") {
  process.exitCode = await runRefresher(process.argv.slice(3));
} else if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { code, lines } = main(process.argv.slice(2));
  for (const line of lines) console.log(line);
  process.exitCode = code;
}
