// scripts/lanes/identity-check.mjs
// #552: /lane step 0 as one allowed, prompt-free command. Under the team profile it checks that the lane holds only its
// own App credentials, printing one redacted JSON line and never a token, password, URL or local path.
// Usage: node scripts/lanes/identity-check.mjs (no arguments). Exit 0: solo, or every team check passed. 1: otherwise.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseIdentity } from "./lib.mjs";

// gh's token-source line for an account whose token sits in a lane's own GH_CONFIG_DIR (start.mjs makes
// `lanes-gh-<issue>-<random>` under the temp folder); only the issue number is ever printed.
const LANE_SOURCE = /\(([^()\r\n]*[\\/])?lanes-gh-([1-9]\d*)-[A-Za-z0-9]+[\\/]hosts\.yml\)\s*$/;
// `gh setup-git` and teamLaneVars write `!gh auth git-credential`, possibly with a path (quoted when it has spaces) to
// gh; no shell chaining before it.
const GH_HELPER = /^!(?:"[^"]*[\\/]gh(?:\.exe)?"|(?:[^\s"';&|`$<>()]*[\\/])?gh(?:\.exe)?)\s+auth\s+git-credential\s*$/;

const pass = (reason) => ({ pass: true, reason });
const fail = (reason) => ({ pass: false, reason });
const lines = (s) => String(s ?? "").split(/\r?\n/);

/** Runs `run`, turning a throw into a failed result with no message, so no error text (which may hold a secret) is kept. */
function safeRun(run, cmd, args, opts) {
  try {
    const r = run(cmd, args, opts) ?? {};
    return { stdout: String(r.stdout ?? ""), stderr: String(r.stderr ?? ""), status: r.status ?? 1 };
  } catch {
    return { stdout: "", stderr: "", status: null };
  }
}

function checkGhDir(run) {
  const r = safeRun(run, "gh", ["auth", "status"]);
  if (r.status !== 0) return fail(r.status === null ? "gh auth status could not run" : `gh auth status exited ${r.status}`);
  // Older gh prints the status on stderr, newer on stdout.
  const accounts = lines(`${r.stdout}\n${r.stderr}`).filter((l) => /Logged in to /.test(l));
  if (!accounts.length) return fail("gh auth status names no account");
  const sources = accounts.map((l) => l.match(LANE_SOURCE));
  if (sources.some((m) => !m)) return fail("an account's token is not from a lanes-gh-<N>-* directory");
  const issues = [...new Set(sources.map((m) => m[2]))];
  if (issues.length > 1) return fail("accounts from more than one lanes-gh directory");
  return pass(`token from lanes-gh-${issues[0]}-*`);
}

function checkPush(run) {
  const r = safeRun(run, "git", ["remote", "get-url", "--push", "origin"]);
  if (r.status !== 0) return fail("git remote get-url failed");
  const url = r.stdout.trim();
  if (!url.startsWith("https://")) return fail("push URL is not https");
  // A token embedded in the URL would bypass the credential helper; never print the URL itself.
  if (/^https:\/\/[^/]*@/.test(url)) return fail("push URL carries credentials");
  return pass("https");
}

/** The helpers git would use, honouring that an empty value (an empty line) resets the list. */
function effectiveHelpers(output) {
  if (!output) return [];
  let list = [];
  // git ends each value with a newline; drop the last one so it is not read as an empty value.
  for (const v of lines(output.replace(/\r?\n$/, ""))) list = v.trim() === "" ? [] : [...list, v.trim()];
  return list;
}

function checkCredential(run, env) {
  const helpers = safeRun(run, "git", ["config", "--get-all", "credential.helper"]);
  const list = helpers.status === null ? [] : effectiveHelpers(helpers.stdout);
  if (list.length !== 1 || !GH_HELPER.test(list[0])) return fail(`credential helpers are not only gh auth git-credential (${list.length} configured)`);

  const fill = safeRun(run, "git", ["credential", "fill"], {
    input: "protocol=https\nhost=github.com\n\n",
    env: { ...env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (fill.status !== 0) return fail("git credential fill failed");
  const line = lines(fill.stdout).find((l) => l.startsWith("password="));
  const password = line ? line.slice("password=".length) : "";
  if (!password) return fail("git credential fill returned no password");

  // The password must be the lane's own gh token: compared here, never printed.
  const token = safeRun(run, "gh", ["auth", "token"]);
  const ghToken = token.status === 0 ? token.stdout.trim() : "";
  if (!ghToken) return fail(`password present, length ${password.length}; gh auth token unavailable`);
  if (password !== ghToken) return fail(`password present, length ${password.length}; not the lane's gh token`);
  return pass(`password present, length ${password.length}, from gh auth git-credential`);
}

function checkEnv(env) {
  const set = ["GH_TOKEN", "GITHUB_TOKEN"].filter((k) => typeof env[k] === "string" && env[k] !== "");
  return set.length ? fail(`${set.join(", ")} set`) : pass("GH_TOKEN and GITHUB_TOKEN empty");
}

/**
 * @param {{ readConfig: () => string, run: (cmd: string, args: string[], opts?: { input?: string, env?: object }) =>
 *   { stdout: string, stderr: string, status: number|null }, env: Record<string, string|undefined> }} deps
 *   `run` and `readConfig` are injected so tests use no real credentials.
 * @returns {{ code: 0|1, line: string }} the exit code and the one JSON line to print
 */
export function identityCheck({ readConfig, run, env }) {
  let identity;
  try {
    identity = parseIdentity(JSON.parse(readConfig()).identity);
  } catch {
    return { code: 1, line: JSON.stringify({ profile: null, error: "lanes.config.json unreadable or its identity invalid" }) };
  }
  if ((identity?.profile ?? "solo") === "solo") return { code: 0, line: JSON.stringify({ profile: "solo" }) };

  const checks = { ghDir: checkGhDir(run), push: checkPush(run), credential: checkCredential(run, env), env: checkEnv(env) };
  const ok = Object.values(checks).every((c) => c.pass);
  return { code: ok ? 0 : 1, line: JSON.stringify({ profile: "team", pass: ok, checks }) };
}

const CODEOWNERS_PATHS = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"];

const ghJson = (run, path) => {
  const r = safeRun(run, "gh", ["api", path]);
  if (r.status !== 0) return undefined;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return undefined;
  }
};

/**
 * #612 (ADR 0025 part 8): the owner-side, read-only checks after App setup. Each result is `{ name, pass, reason, fix }`;
 * `fix` (only when not passing) holds the GitHub settings `link` and, for CODEOWNERS, the `line` to add. Makes no write
 * and no admin call; a check that cannot be read fails with "could not be checked" rather than passing.
 * @param {{ run: Function, exists: (path: string) => boolean, repo: string, slug: string, installationId: number }} o
 *   `repo` is `owner/name`; `run` and `exists` are injected so tests touch no network or disk.
 */
export function repoChecks({ run, exists, repo, slug, installationId }) {
  const owner = repo.split("/")[0];
  const base = `https://github.com/${repo}`;
  const results = [];

  const hasOwners = CODEOWNERS_PATHS.some((p) => exists(p));
  results.push({
    name: "codeowners",
    pass: hasOwners,
    reason: hasOwners ? "CODEOWNERS present" : "no CODEOWNERS file",
    ...(hasOwners ? {} : { fix: { link: `${base}/new/main?filename=.github/CODEOWNERS`, line: `* @${owner}` } }),
  });

  const list = ghJson(run, `repos/${repo}/rulesets`);
  let ruleset;
  if (!Array.isArray(list)) ruleset = { pass: false, reason: "rulesets could not be checked" };
  else {
    let found = false;
    for (const rs of list) {
      const detail = ghJson(run, `repos/${repo}/rulesets/${rs?.id}`);
      const rules = Array.isArray(detail?.rules) ? detail.rules : [];
      if (detail?.enforcement === "active" && rules.some((r) => r?.type === "pull_request" && r.parameters?.require_code_owner_review === true)) {
        found = true;
        break;
      }
    }
    ruleset = { pass: found, reason: found ? "code-owner ruleset present" : "no active ruleset requires a code-owner review" };
  }
  results.push({ name: "ruleset", ...ruleset, ...(ruleset.pass ? {} : { fix: { link: `${base}/settings/rules/new?target=branch` } }) });

  const installs = ghJson(run, "user/installations");
  let installed;
  if (!Array.isArray(installs?.installations)) installed = { pass: false, reason: "installations could not be checked" };
  else if (!installs.installations.some((i) => i?.id === installationId)) installed = { pass: false, reason: "the App is not installed for this account" };
  else {
    const repos = ghJson(run, `user/installations/${installationId}/repositories?per_page=100`);
    if (!Array.isArray(repos?.repositories)) installed = { pass: false, reason: "the App's repositories could not be checked" };
    else if (repos.repositories.some((r) => r?.full_name === repo)) installed = { pass: true, reason: "the App is installed on the repository" };
    else installed = { pass: false, reason: "the App is not installed on this repository" };
  }
  results.push({ name: "installed", ...installed, ...(installed.pass ? {} : { fix: { link: `https://github.com/apps/${slug}/installations/new` } }) });
  return results;
}

/** One printable block for the failing checks: each missing item with its link and, for CODEOWNERS, the line to add. */
export function formatRepoChecks(results) {
  return results.map((c) => (c.pass ? `ok: ${c.name}: ${c.reason}` : `missing: ${c.name}: ${c.reason}\n  open ${c.fix.link}${c.fix.line ? `\n  add the line: ${c.fix.line}` : ""}`)).join("\n");
}

const realRun = (cmd, args, { input, env } = {}) => {
  const r = spawnSync(cmd, args, { input, env, encoding: "utf8", timeout: 20000, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  if (r.error) throw r.error;
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
};

/** Runs repoChecks for the repository in the current directory, as the owner (`--setup-checks`). Returns the exit code. */
export function setupChecksMain({ run = realRun, exists = existsSync, config = () => JSON.parse(readFileSync("lanes.config.json", "utf8")), print = console.log } = {}) {
  let app;
  let repo;
  try {
    app = parseIdentity(config().identity)?.app;
    const r = safeRun(run, "gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
    repo = r.status === 0 ? r.stdout.trim() : "";
  } catch {
    app = undefined;
  }
  if (!app?.botLogin || !repo) {
    print("setup checks need a team identity in lanes.config.json and a repository gh can read");
    return 1;
  }
  const results = repoChecks({ run, exists, repo, slug: app.botLogin.replace(/\[bot\]$/, ""), installationId: app.installationId });
  print(formatRepoChecks(results));
  return results.every((c) => c.pass) ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv.includes("--setup-checks")) {
  process.exitCode = setupChecksMain();
} else if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { code, line } = identityCheck({ readConfig: () => readFileSync("lanes.config.json", "utf8"), run: realRun, env: process.env });
  console.log(line);
  process.exitCode = code;
}
