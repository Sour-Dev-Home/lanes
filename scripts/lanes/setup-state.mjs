// scripts/lanes/setup-state.mjs
// #713: reads a target repository's lanes setup without changing anything and reports, per first-run item, whether it is
// done and, if not, the exact fix (a settings link or a command), so a guided `init` can skip what is done.
// Usage: node scripts/lanes/setup-state.mjs <target-dir>. Exit 0: every item done. 1: otherwise. 2: bad usage.
// Read-only: every gh call is `gh api <path>` (GET), `gh secret list` or `gh label list`. It never reads the App key's
// contents, never prints a secret value or token, and keeps no error text from a failed call.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { repoChecks } from "./identity-check.mjs";
import { parseIdentity } from "./lib.mjs";
import { LABELS } from "./setup-repo.mjs";

const ENVIRONMENT = "lanes-workflow-apply";
const SECRET = "LANES_WORKFLOWS_KEY";
const RULESET = "main (lanes)";
const SLUG = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const NAMES = ["installed", "secret", "labels", "main-ruleset", "identity", "app-key", "app-installed", "codeowners", "code-owner-ruleset", "workflows-environment", "verify-job"];

/** Runs a gh call; any throw or non-zero exit is `undefined`, so no error text (which may hold a secret) is kept. */
function ghOut(run, target, args) {
  try {
    const r = run("gh", args, { cwd: target });
    return r && r.status === 0 ? String(r.stdout ?? "") : undefined;
  } catch {
    return undefined;
  }
}

function ghJson(run, target, args) {
  const out = ghOut(run, target, args);
  if (out === undefined) return undefined;
  try {
    return JSON.parse(out);
  } catch {
    return undefined;
  }
}

const done = (reason) => ({ done: true, reason });
const missing = (reason, fix) => ({ done: false, reason, fix });

/** The names of the `jobs:` keys and their `name:` values in one workflow file's text (a line scan, no YAML parser). */
function jobNames(text) {
  const names = new Set();
  let inJobs = false;
  let job;
  for (const line of String(text).split(/\r?\n/)) {
    if (/^jobs:\s*$/.test(line)) {
      inJobs = true;
      continue;
    }
    if (/^\S/.test(line) && !line.startsWith("#")) inJobs = false;
    if (!inJobs) continue;
    const key = line.match(/^ {2}([A-Za-z0-9_-]+):\s*(#.*)?$/);
    if (key) {
      job = key[1];
      names.add(job);
      continue;
    }
    const name = job && line.match(/^ {4}name:\s*["']?([^"'#]*?)["']?\s*(#.*)?$/);
    if (name) names.add(name[1]);
  }
  return names;
}

/**
 * @param {{ run: (cmd: string, args: string[], opts?: object) => { status: number, stdout: string }, exists: (path: string) => boolean,
 *   home: string, target: string, repo: string, read?: (path: string) => string, list?: (dir: string) => string[] }} o
 *   `run`, `exists`, `read` and `list` are injected so tests touch no network or disk.
 * @returns {{ name: string, done: boolean, reason: string, fix?: { link?: string, command?: string } }[]}
 */
export function setupState({ run, exists, home, target, repo, read = (p) => readFileSync(p, "utf8"), list = (d) => readdirSync(d) }) {
  const base = `https://github.com/${repo}`;
  const results = {};
  const gh = (args) => ghJson(run, target, args);

  results.installed = exists(join(target, "lanes.lock.json"))
    ? done("lanes.lock.json present")
    : missing("lanes.lock.json is missing", { command: "node scripts/lanes/install.mjs <target-dir>" });

  const secrets = gh(["secret", "list", "-R", repo, "--json", "name"]);
  if (!Array.isArray(secrets)) results.secret = missing("the repository secrets could not be read", { link: `${base}/settings/secrets/actions` });
  else if (secrets.some((s) => s?.name === "PII_PATTERNS")) results.secret = done("PII_PATTERNS present");
  else results.secret = missing("the PII_PATTERNS secret is missing", { link: `${base}/settings/secrets/actions`, command: `gh secret set PII_PATTERNS -R ${repo}` });

  const labels = gh(["label", "list", "-R", repo, "--json", "name", "--limit", "200"]);
  const labelFix = { command: `node scripts/lanes/setup-repo.mjs ${repo}` };
  if (!Array.isArray(labels)) results.labels = missing("the labels could not be read", labelFix);
  else {
    const have = new Set(labels.map((l) => l?.name));
    const lacking = LABELS.map((l) => l.name).filter((n) => !have.has(n));
    results.labels = lacking.length ? missing(`missing labels: ${lacking.join(", ")}`, labelFix) : done("every lanes label present");
  }

  const rulesets = gh(["api", `repos/${repo}/rulesets`]);
  const mainFix = { link: `${base}/settings/rules`, command: `node scripts/lanes/setup-repo.mjs ${repo}` };
  if (!Array.isArray(rulesets)) results["main-ruleset"] = missing("the rulesets could not be read", mainFix);
  else if (rulesets.some((r) => r?.name === RULESET && r.enforcement === "active")) results["main-ruleset"] = done(`ruleset ${RULESET} active`);
  else results["main-ruleset"] = missing(`no active ruleset named ${RULESET}`, mainFix);

  let app;
  const appFix = { command: "node scripts/lanes/app-setup.mjs" };
  try {
    app = parseIdentity(JSON.parse(read(join(target, "lanes.config.json"))).identity).app;
    results.identity = done("identity.app present");
  } catch (err) {
    results.identity = err?.teamRequired || err instanceof Error && /identity/.test(err.message)
      ? missing("identity.app is missing or invalid in lanes.config.json", appFix)
      : missing("lanes.config.json could not be read", appFix);
  }
  const slug = typeof app?.botLogin === "string" ? app.botLogin.replace(/\[bot\]$/, "") : "";
  const noApp = "identity.app is not set, so the App cannot be checked";

  if (!app || !SLUG.test(slug)) results["app-key"] = missing(noApp, appFix);
  else results["app-key"] = exists(join(home, ".lanes", `${slug}.pem`)) ? done("App key present") : missing(`the App key ~/.lanes/${slug}.pem is missing`, appFix);

  const checks = Object.fromEntries(
    repoChecks({ run: (cmd, args) => run(cmd, args, { cwd: target }), exists: (p) => exists(join(target, p)), repo, slug: slug || "", installationId: app?.installationId }).map((c) => [c.name, c]),
  );
  const fromCheck = (c) => (c.pass ? done(c.reason) : missing(c.reason, { link: c.fix.link }));
  results["app-installed"] = app && SLUG.test(slug) ? fromCheck(checks.installed) : missing(noApp, appFix);
  results.codeowners = fromCheck(checks.codeowners);
  results["code-owner-ruleset"] = fromCheck(checks.ruleset);

  results["workflows-environment"] = workflowsEnvironment(gh, repo, base);
  results["verify-job"] = verifyJob({ exists, read, list, target, base });

  return NAMES.map((name) => ({ name, ...results[name] }));
}

function workflowsEnvironment(gh, repo, base) {
  const fix = { link: `${base}/settings/environments`, command: "node scripts/lanes/app-setup.mjs --workflows" };
  const path = `repos/${repo}/environments/${ENVIRONMENT}`;
  const env = gh(["api", path]);
  if (!env || typeof env !== "object") return missing(`the ${ENVIRONMENT} environment does not exist or could not be read`, fix);
  const rules = Array.isArray(env.protection_rules) ? env.protection_rules : [];
  if (!rules.some((r) => r?.type === "required_reviewers" && Array.isArray(r.reviewers) && r.reviewers.length > 0)) return missing(`${ENVIRONMENT} has no required reviewer`, fix);
  if (env.deployment_branch_policy?.custom_branch_policies !== true) return missing(`${ENVIRONMENT} does not limit deployment to selected branches`, fix);
  const policies = gh(["api", `${path}/deployment-branch-policies`]);
  if (!Array.isArray(policies?.branch_policies)) return missing(`the ${ENVIRONMENT} branch policies could not be read`, fix);
  if (policies.branch_policies.length !== 1 || policies.branch_policies[0]?.name !== "main") return missing(`${ENVIRONMENT} must allow the main branch only`, fix);
  const secrets = gh(["api", `${path}/secrets`]);
  if (!Array.isArray(secrets?.secrets)) return missing(`the ${ENVIRONMENT} secrets could not be read`, fix);
  if (!secrets.secrets.some((s) => s?.name === SECRET)) return missing(`${ENVIRONMENT} lacks the secret ${SECRET}`, fix);
  return done(`${ENVIRONMENT} has a required reviewer, a main-only policy and ${SECRET}`);
}

function verifyJob({ exists, read, list, target, base }) {
  const fix = { link: `${base}/new/main?filename=.github/workflows/verify.yml` };
  const dir = join(target, ".github", "workflows");
  let files;
  try {
    if (!exists(dir) && !exists(join(dir, "verify.yml"))) throw new Error("none");
    files = list(dir).filter((f) => /\.ya?ml$/.test(f));
  } catch {
    return missing("the workflows folder could not be read", fix);
  }
  for (const f of files) {
    try {
      if (jobNames(read(join(dir, f))).has("verify")) return done(`a job named verify is in ${f}`);
    } catch {
      // an unreadable file cannot prove the job; keep looking
    }
  }
  return missing("no workflow has a job named verify", fix);
}

/** One line per item: `name: done`, or `name: missing: <reason>` with its fix. */
export function formatSetupState(items) {
  return items
    .map((i) => {
      if (i.done) return `${i.name}: done`;
      const fix = [i.fix?.link && `open ${i.fix.link}`, i.fix?.command && `run: ${i.fix.command}`].filter(Boolean);
      return `${i.name}: missing: ${i.reason}${fix.length ? `; ${fix.join("; ")}` : ""}`;
    })
    .join("\n");
}

const realRun = (cmd, args, { cwd } = {}) => {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", timeout: 20000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  if (r.error) throw r.error;
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
};

/** Runs the report for `argv = [target]`. Returns the exit code; `deps` are the injected pieces, defaulting to the real ones. */
export function setupStateMain(argv, deps = {}) {
  const { run = realRun, exists = existsSync, home = homedir(), print = console.log, ...rest } = deps;
  if (argv.length !== 1) {
    print("usage: node scripts/lanes/setup-state.mjs <target-dir>");
    return 2;
  }
  const target = argv[0];
  let repo = deps.repo;
  if (!repo) {
    const out = ghOut(run, target, ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
    repo = out?.trim();
  }
  if (!repo || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) {
    print("the repository could not be read: run gh auth login and check the target is a GitHub repository");
    return 1;
  }
  const items = setupState({ ...rest, run, exists, home, target, repo });
  print(formatSetupState(items));
  return items.every((i) => i.done) ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = setupStateMain(process.argv.slice(2));
