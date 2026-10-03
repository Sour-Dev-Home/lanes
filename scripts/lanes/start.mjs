// scripts/lanes/start.mjs
// The launch helpers the owner's queue (queue.mjs) uses: launchLane, the team-profile steps and the token refresher
// (`--refresh-token`, spawned by the queue). `/start` is retired (ADR 0030): the queue is the only launcher, and this
// file refuses a command-line run from a Claude session or a lane worktree (launchRefusal).
import { execFileSync, spawn } from "node:child_process";
import { accessSync, appendFileSync, closeSync, constants as fsConstants, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { mintInstallationToken, writeGhHosts } from "./app-token.mjs";
import { TIERS, laneIssueOf, parseIdentity } from "./lib.mjs";

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

const MAX_LANES_LIMIT = 10;
// A lane PATH with more entries than this is reported at launch (#416).
const PATH_NOTE_ABOVE = 60;
// A model name is one word that cannot start with `-`, so claude never reads it as a flag.
const MODEL_NAME = /^[^\s-]\S*$/;

/**
 * The `start` block of a parsed lanes.config.json, each missing key (or the whole block) filled from START_DEFAULTS.
 * Throws when maxLanes is not a whole number from 1 to 10, softPaths is not an array of valid regex strings, or
 * models is not an object mapping tiers (skip, quick, full) to model names.
 * It also carries `identity`, checked first (ADR 0025): `{ profile: "team", app: { id, installationId, botLogin } }`
 * (lib's parseIdentity). Throws TEAM_REQUIRED_MESSAGE for a missing config, identity or profile, or a profile but team.
 * @returns {{ maxLanes: number, softPaths: string[], models: { skip?: string, quick?: string, full?: string }, identity: { profile: "team", app: { id: number, installationId: number, botLogin: string } } }}
 */
export function startConfig(raw) {
  const identity = parseIdentity(raw?.identity);
  return { ...startBlock(raw?.start), identity };
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
    out = execFileSync("git", ["--exec-path"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
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
      return { failed: `key file unreadable: ${keyFile}` };
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

/**
 * #612 (ADR 0025 part 7): the App key's path. An explicit LANES_APP_KEY_FILE wins; otherwise `~/.lanes/<slug>.pem`, the
 * slug being `identity.app.botLogin` without `[bot]`. Undefined when neither is known.
 * @param {{ env: Record<string, string|undefined>, identity?: { app?: { botLogin?: string } }, home: string }} o
 */
export function resolveKeyFile({ env, identity, home }) {
  if (env.LANES_APP_KEY_FILE) return env.LANES_APP_KEY_FILE;
  const login = identity?.app?.botLogin;
  if (typeof login !== "string") return undefined;
  const slug = login.replace(/\[bot\]$/, "");
  return /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(slug) ? join(home, ".lanes", `${slug}.pem`) : undefined;
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
      throw new Error(`key file unreadable: ${file}`);
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

const reason = (err) => String(err?.stderr || err?.message || err).trim().split("\n")[0];

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
  if (scopeNamesWorkflows(scope)) notes.push(WORKFLOW_NOTE(n));
  const lane = prepareTeam(n, identity, deps, env ?? process.env);
  if (lane.failed) return { id: null, failed: true, lines: [...notes, `#${n}: launch failed: team profile: ${lane.failed}`] };
  const launchEnvFor = lane.env;
  // One attempt only: a launch that printed no id may still have started, and a retry could start it twice.
  let id = null;
  let why = "no session id in output";
  try {
    id = parseSessionId(deps.claude(launchArgs(n, { tier, models, opus, settings: lane.settings, strictMcp: Boolean(lane.settings) }), launchEnvFor ? { cwd, env: launchEnvFor } : { cwd }));
  } catch (err) {
    why = reason(err);
  }
  if (!id) {
    removeQuietly(deps.team, lane.dir);
    return { id: null, failed: true, lines: [...notes, `#${n}: launch failed: ${why}, not retried`] };
  }
  const reaperFailed = startReaper(n, id, deps, root);
  const refresherFailed = startRefresher(n, id, lane, identity, deps, root);
  const marked = markRunning(n, deps);
  return { id, failed: false, lines: [...notes, `#${n} → ${id}`, ...(reaperFailed ? [reaperFailed] : []), ...(refresherFailed ? [refresherFailed] : []), ...(marked.includes(": label not set: ") ? [marked] : [])] };
}

const gh = (args) => execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
// The main checkout, even when run from a worktree: the parent of the shared .git directory.
const repoRoot = () => dirname(execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8", windowsHide: true }).trim());
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
const defaultKeyFile = () => resolveKeyFile({ env: process.env, identity: readConfig()?.identity, home: homedir() });
const team = {
  keyFile: defaultKeyFile,
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
      windowsHide: true,
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
      windowsHide: true,
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
  const remint = makeRemint({ args, keyFile: defaultKeyFile, readFile: (file) => readFileSync(file, "utf8"), mint: mintInstallationToken, writeHosts: writeGhHosts });
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

export const LAUNCH_REFUSAL = "lanes are launched only by the owner's queue in their own terminal (ADR 0030)";

/**
 * ADR 0030 parts 1 and 3: the one refusal shared by the queue and this file's command line. Returns LAUNCH_REFUSAL when
 * `env` has CLAUDECODE or CLAUDE_CODE_CHILD_SESSION set (any non-empty value), or when `file` (the script's own
 * `import.meta.url` or path, never the working directory) lies under a `.claude/worktrees/` directory; else null.
 */
export function launchRefusal(env, file) {
  if (env.CLAUDECODE || env.CLAUDE_CODE_CHILD_SESSION) return LAUNCH_REFUSAL;
  if (file === undefined) return null;
  // The URL's own path, not fileURLToPath: that throws for a URL whose path is not a local one on this platform.
  const path = String(file).startsWith("file:") ? decodeURIComponent(new URL(file).pathname) : String(file);
  // Case-insensitive: Windows and default macOS filesystems ignore case in a path.
  return /(^|\/)\.claude\/worktrees\//i.test(path.replaceAll("\\", "/")) ? LAUNCH_REFUSAL : null;
}

/**
 * Whether the module at `url` is the script node was started with (`argv1`). Real paths on both sides: Node resolves
 * `import.meta.url` through symlinks (macOS's tmpdir /var is /private/var), but `process.argv[1]` keeps the path as typed.
 * False with no `argv1` or a path that cannot be resolved.
 */
export function isEntryScript(argv1, url) {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(url));
  } catch {
    return false;
  }
}

if (isEntryScript(process.argv[1], import.meta.url)) {
  const refused = launchRefusal(process.env, import.meta.url);
  if (refused) {
    console.error(refused);
    process.exitCode = 2;
  } else if (process.argv[2] === "--refresh-token") {
    process.exitCode = await runRefresher(process.argv.slice(3));
  } else {
    console.error("start.mjs has no command line besides --refresh-token; the queue (node scripts/lanes/queue.mjs) launches lanes");
    process.exitCode = 2;
  }
}
