// scripts/lanes/app-setup.mjs
// #612, ADR 0025 parts 7 and 8: one command creates, installs and configures the lanes GitHub App through GitHub's
// App manifest flow. Usage: node scripts/lanes/app-setup.mjs [--workflows] [--org <org>]
// #648, ADR 0029 parts 1 to 3: --workflows creates the second App and the lanes-workflow-apply environment instead.
// It serves a form on 127.0.0.1 only; the owner presses GitHub's own buttons (create, then install). The key goes to
// ~/.lanes/<slug>.pem before any config is written, and neither the key nor a token is ever printed.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { setupChecksMain } from "./identity-check.mjs";

/** ADR 0019's permissions, exactly: no workflows, no administration. */
export const PERMISSIONS = { contents: "write", pull_requests: "write", issues: "write", statuses: "write", checks: "read", metadata: "read" };

/** ADR 0029 part 1: the second App holds contents and workflows write and nothing else but metadata read. */
export const WORKFLOWS_PERMISSIONS = { contents: "write", workflows: "write", metadata: "read" };

const ENVIRONMENT = "lanes-workflow-apply";
const SECRET = "LANES_WORKFLOWS_KEY";
const VARIABLE = "LANES_WORKFLOWS_APP_ID";

const SLUG = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const ORG = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

/** The manifest GitHub's new-App page receives. */
export function buildManifest({ port, name, permissions = PERMISSIONS }) {
  const local = `http://127.0.0.1:${port}`;
  return {
    name,
    url: "https://github.com",
    redirect_url: `${local}/redirect`,
    setup_url: `${local}/setup`,
    public: false,
    hook_attributes: { active: false },
    default_permissions: { ...permissions },
  };
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** The page with the manifest form; the owner presses the button, which posts to GitHub. */
export function formPage({ manifest, state, org }) {
  const action = org ? `https://github.com/organizations/${org}/settings/apps/new` : "https://github.com/settings/apps/new";
  const what = "workflows" in manifest.default_permissions ? "the lanes-workflows GitHub App (private, no webhook, contents and workflows write)" : "the lanes GitHub App (private, no webhook, no workflows permission)";
  return `<!doctype html><meta charset="utf-8"><title>lanes: create the GitHub App</title>
<p>This creates ${what}. GitHub asks you to confirm.</p>
<form method="post" action="${escapeHtml(action)}?state=${escapeHtml(state)}"><input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}"><button>Continue to GitHub</button></form>`;
}

const page = (status, text, extra = {}) => ({ status, headers: { "content-type": "text/html; charset=utf-8", ...extra }, body: `<!doctype html><meta charset="utf-8"><title>lanes</title><p>${escapeHtml(text)}</p>` });

function sameState(expected, given) {
  if (typeof given !== "string") return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The request handler as a pure-ish state machine. `deps`: state, org, port(), name, convert(code) (async, returns
 * `{ id, slug, pem }`), saveKey(slug, pem), readConfig(), writeConfig(obj), log(line). Returns `{ status, headers, body }`
 * (async), plus `done: true` once the config is written. With `deps.mode === "workflows"` (ADR 0029) the key goes to
 * `deps.provision({ id, pem })` instead of the disk, and no config is read or written.
 */
export function createHandler(deps) {
  let app = null;
  let finished = false;
  const workflows = deps.mode === "workflows";
  const bad = (status, why) => page(status, why);
  return async function handle({ method, url, host }) {
    if (host !== `127.0.0.1:${deps.port()}`) return bad(400, "wrong host");
    if (method !== "GET") return bad(405, "method not allowed");
    const u = new URL(url, "http://127.0.0.1");
    if (u.pathname === "/") {
      const manifest = buildManifest({ port: deps.port(), name: deps.name, permissions: workflows ? WORKFLOWS_PERMISSIONS : PERMISSIONS });
      return { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body: formPage({ manifest, state: deps.state, org: deps.org }) };
    }
    if (u.pathname === "/redirect") {
      if (!sameState(deps.state, u.searchParams.get("state"))) return bad(400, "state does not match; start again");
      const code = u.searchParams.get("code");
      if (!code || !/^[A-Za-z0-9_-]{1,200}$/.test(code)) return bad(400, "missing or malformed code");
      if (app) return bad(409, "this setup already used its code");
      let converted;
      try {
        converted = await deps.convert(code);
      } catch {
        return bad(502, "GitHub did not convert the manifest; start again");
      }
      const { id, slug, pem } = converted ?? {};
      if (!Number.isSafeInteger(id) || id < 1 || typeof slug !== "string" || !SLUG.test(slug) || typeof pem !== "string" || !pem.includes("PRIVATE KEY")) {
        return bad(502, "GitHub's answer was not an App with a key; start again");
      }
      if (workflows) {
        try {
          await deps.provision({ id, pem });
        } catch (err) {
          // The step name is ours, never gh's output, which could echo input.
          const step = typeof err?.step === "string" ? err.step : "storing the key";
          return bad(500, `Failed while ${step}; the key was not kept. Delete the App ${slug} in GitHub and run --workflows again (the ${ENVIRONMENT} environment stays and is reused).`);
        }
        app = { id, slug };
        deps.log(`App ${slug} created (id ${id}); key stored in ${ENVIRONMENT}, none on disk`);
        return { status: 302, headers: { location: `https://github.com/apps/${slug}/installations/new?state=${deps.state}` }, body: "" };
      }
      try {
        deps.saveKey(slug, pem);
      } catch {
        return bad(500, "the key could not be saved; nothing was configured");
      }
      app = { id, slug };
      deps.log(`App ${slug} created (id ${id}); key saved`);
      return { status: 302, headers: { location: `https://github.com/apps/${slug}/installations/new?state=${deps.state}` }, body: "" };
    }
    if (u.pathname === "/setup") {
      if (!sameState(deps.state, u.searchParams.get("state"))) return bad(400, "state does not match; start again");
      if (!app) return bad(400, "the App was not created in this run");
      if (finished) return bad(409, "this setup already finished");
      const raw = u.searchParams.get("installation_id");
      const installationId = /^[1-9]\d{0,14}$/.test(raw ?? "") ? Number(raw) : NaN;
      if (!Number.isSafeInteger(installationId)) return bad(400, "missing or malformed installation_id");
      if (workflows) {
        finished = true;
        deps.log(`${app.slug} is installed (installation ${installationId}); the repository is the one you chose on GitHub's page`);
        return { ...page(200, "Done. Return to the terminal."), done: true };
      }
      try {
        const config = deps.readConfig();
        deps.writeConfig({ ...config, identity: { profile: "team", app: { id: app.id, installationId, botLogin: `${app.slug}[bot]` } } });
      } catch {
        return bad(500, "lanes.config.json could not be updated");
      }
      finished = true;
      deps.log(`lanes.config.json now names ${app.slug}[bot] (installation ${installationId})`);
      return { ...page(200, "Done. Return to the terminal."), done: true };
    }
    return bad(404, "not found");
  };
}

/** Saves the key at ~/.lanes/<slug>.pem, owner-only, never overwriting. Exported with a `home` for tests. */
export function saveKey(slug, pem, home = homedir()) {
  if (!SLUG.test(slug)) throw new Error("bad slug");
  const dir = join(home, ".lanes");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${slug}.pem`);
  const fd = openSync(file, "wx", 0o600);
  try {
    writeSync(fd, pem);
  } catch (err) {
    // A partial key would block a retry through "wx"; the code is single-use, so drop it.
    try {
      rmSync(file, { force: true });
    } catch {
      // Nothing more to do.
    }
    throw err;
  } finally {
    closeSync(fd);
  }
}

/** Parses argv (after the script): `{ org, workflows }` or null when malformed. */
export function parseArgs(argv) {
  const rest = [...argv];
  let workflows = false;
  const at = rest.indexOf("--workflows");
  if (at !== -1) {
    workflows = true;
    rest.splice(at, 1);
  }
  if (rest.length === 0) return { org: undefined, workflows };
  if (rest.length === 2 && rest[0] === "--org" && ORG.test(rest[1])) return { org: rest[1], workflows };
  return null;
}

/** What `--workflows` will create, printed before the question (ADR 0029 part 3). */
export function workflowsPlan({ repo, login }) {
  return [
    `This will create, in ${repo}, using your own gh:`,
    `  environment:        ${ENVIRONMENT}`,
    `  required reviewer:  ${login}`,
    "  branch policy:      deployments from main only",
    `  secret:             ${SECRET} (the new App's private key, piped to gh, never written to disk)`,
    `  variable:           ${VARIABLE} (the new App's id)`,
    "If an environment of that name exists, its reviewer is replaced and every deployment branch policy except main is deleted; it stays if a later step fails.",
    "Creating an environment with reviewers needs repository admin. CODEOWNERS and rulesets are not touched.",
  ];
}

const stepError = (step) => Object.assign(new Error(`failed while ${step}`), { step });

/**
 * Prints the plan, asks y/N, and only on `y` creates the environment through `gh` (injected: `gh(args, input)` returns
 * `{ status, stdout }`). Returns `{ ok: true, repo }` or `{ ok: false, error }`; nothing throws.
 */
export async function confirmAndCreateEnvironment({ gh, ask, print }) {
  const read = (step, args) => {
    const r = gh(args);
    if (r.status !== 0 || !String(r.stdout).trim()) return { error: `failed while ${step}` };
    return { value: String(r.stdout).trim() };
  };
  const login = read("reading your login", ["api", "user", "--jq", ".login"]);
  if (login.error) return { ok: false, error: login.error };
  const uid = read("reading your user id", ["api", "user", "--jq", ".id"]);
  const userId = Number(uid.value);
  if (uid.error || !Number.isSafeInteger(userId) || userId < 1) return { ok: false, error: uid.error ?? "failed while reading your user id" };
  const repo = read("reading the repository", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
  if (repo.error) return { ok: false, error: repo.error };
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo.value) || repo.value.split("/").some((p) => p === "." || p === ".." || p.startsWith("-"))) return { ok: false, error: "failed while reading the repository (not owner/name)" };
  for (const line of workflowsPlan({ repo: repo.value, login: login.value })) print(line);
  if ((await ask("Create this? [y/N] ")) !== "y") return { ok: false, error: "not confirmed; nothing was created" };
  const base = `repos/${repo.value}/environments/${ENVIRONMENT}`;
  const put = gh(["api", "--method", "PUT", base, "--input", "-"], JSON.stringify({ reviewers: [{ type: "User", id: userId }], prevent_self_review: false, deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } }));
  if (put.status !== 0) return { ok: false, error: "failed while creating the environment" };
  // An environment that already existed may carry other policies: make it main-only, whatever it had.
  const policiesPath = `${base}/deployment-branch-policies`;
  const listed = gh(["api", "--paginate", policiesPath, "--jq", '.branch_policies[] | "\\(.id) \\(.type) \\(.name)"']);
  if (listed.status !== 0) return { ok: false, error: "failed while listing the deployment branch policies" };
  let hasMain = false;
  for (const line of String(listed.stdout).split("\n").filter((l) => l.trim() !== "")) {
    const m = /^([1-9]\d{0,17}) (branch|tag) (.+)$/.exec(line);
    if (!m) return { ok: false, error: "failed while listing the deployment branch policies (unreadable answer)" };
    if (m[2] === "branch" && m[3] === "main") {
      hasMain = true;
      continue;
    }
    if (gh(["api", "--method", "DELETE", `${policiesPath}/${m[1]}`]).status !== 0) return { ok: false, error: "failed while removing a deployment branch policy other than main" };
  }
  if (!hasMain) {
    const post = gh(["api", "--method", "POST", policiesPath, "--input", "-"], JSON.stringify({ name: "main", type: "branch" }));
    if (post.status !== 0) return { ok: false, error: "failed while restricting deployment branches to main" };
  }
  return { ok: true, repo: repo.value };
}

/** Stores the new App's key and id in the environment. The key goes on stdin only; failures name the step, never the output. */
export function provisionApp({ gh, repo, id, pem }) {
  const secret = gh(["secret", "set", SECRET, "--env", ENVIRONMENT, "--repo", repo], pem);
  if (secret.status !== 0) throw stepError(`setting the secret ${SECRET}`);
  const variable = gh(["variable", "set", VARIABLE, "--env", ENVIRONMENT, "--repo", repo, "--body", String(id)]);
  if (variable.status !== 0) throw stepError(`setting the variable ${VARIABLE}`);
}

const realGh = (args, input) => {
  const r = spawnSync("gh", args, { input, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
  return { status: r.status ?? 1, stdout: r.stdout ?? "" };
};

async function realConvert(code) {
  const res = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, { method: "POST", headers: { accept: "application/vnd.github+json" } });
  if (!res.ok) throw new Error(`status ${res.status}`);
  const j = await res.json();
  return { id: j.id, slug: j.slug, pem: j.pem };
}

async function main(argv) {
  const args = parseArgs(argv);
  if (!args) {
    console.error("usage: node scripts/lanes/app-setup.mjs [--workflows] [--org <org>]");
    return 2;
  }
  let repo;
  if (args.workflows) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const env = await confirmAndCreateEnvironment({ gh: realGh, ask: (q) => rl.question(q), print: (l) => console.log(l) });
    rl.close();
    if (!env.ok) {
      console.error(env.error);
      return 1;
    }
    repo = env.repo;
  }
  const readConfig = () => {
    try {
      return JSON.parse(readFileSync("lanes.config.json", "utf8"));
    } catch (err) {
      if (err.code === "ENOENT") return {};
      throw err;
    }
  };
  try {
    // The workflows mode never reads the config, so a broken one must not fail it after the environment exists.
    if (!args.workflows) readConfig();
  } catch {
    console.error("lanes.config.json is not valid JSON; fix it first (nothing was created)");
    return 1;
  }
  const state = randomBytes(16).toString("hex");
  let port = 0;
  let resolveDone;
  const finished = new Promise((r) => (resolveDone = r));
  const handle = createHandler({
    state,
    org: args.org,
    mode: args.workflows ? "workflows" : "lanes",
    port: () => port,
    name: `lanes-${args.workflows ? "workflows-" : ""}${randomBytes(3).toString("hex")}`,
    convert: realConvert,
    provision: ({ id, pem }) => provisionApp({ gh: realGh, repo, id, pem }),
    saveKey: (slug, pem) => saveKey(slug, pem),
    readConfig,
    // Temp file then rename, so a crash cannot leave a truncated config.
    writeConfig: (obj) => {
      writeFileSync("lanes.config.json.tmp", `${JSON.stringify(obj, null, 2)}\n`);
      renameSync("lanes.config.json.tmp", "lanes.config.json");
    },
    log: (l) => console.log(l),
  });
  const server = createServer(async (req, res) => {
    const out = await handle({ method: req.method, url: req.url, host: req.headers.host });
    res.writeHead(out.status, out.headers);
    res.end(out.body);
    if (out.done) resolveDone(0);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  port = server.address().port;
  const start = `http://127.0.0.1:${port}/`;
  // No child process is spawned here (the vendored INDEX lists those), so the owner opens the page.
  console.log(`Open ${start} in your browser, then press GitHub's two buttons (create, then install).`);
  const timer = setTimeout(() => resolveDone(1), 30 * 60 * 1000);
  const code = await finished;
  clearTimeout(timer);
  server.close();
  if (code !== 0) {
    console.error("timed out waiting for GitHub; run the command again");
    return code;
  }
  if (args.workflows) {
    console.log(`Done: ${ENVIRONMENT} holds ${SECRET} and ${VARIABLE}. Install the App on this repository only (GitHub's page just asked).`);
    return 0;
  }
  console.log("Checking the rest of the setup:");
  setupChecksMain();
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
