// scripts/lanes/app-setup.mjs
// #612, ADR 0025 parts 7 and 8: one command creates, installs and configures the lanes GitHub App through GitHub's
// App manifest flow. Usage: node scripts/lanes/app-setup.mjs [--org <org>]
// It serves a form on 127.0.0.1 only; the owner presses GitHub's own buttons (create, then install). The key goes to
// ~/.lanes/<slug>.pem before any config is written, and neither the key nor a token is ever printed.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setupChecksMain } from "./identity-check.mjs";

/** ADR 0019's permissions, exactly: no workflows, no administration. */
export const PERMISSIONS = { contents: "write", pull_requests: "write", issues: "write", statuses: "write", checks: "read", metadata: "read" };

const SLUG = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const ORG = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

/** The manifest GitHub's new-App page receives. */
export function buildManifest({ port, name }) {
  const local = `http://127.0.0.1:${port}`;
  return {
    name,
    url: "https://github.com",
    redirect_url: `${local}/redirect`,
    setup_url: `${local}/setup`,
    public: false,
    hook_attributes: { active: false },
    default_permissions: { ...PERMISSIONS },
  };
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** The page with the manifest form; the owner presses the button, which posts to GitHub. */
export function formPage({ manifest, state, org }) {
  const action = org ? `https://github.com/organizations/${org}/settings/apps/new` : "https://github.com/settings/apps/new";
  return `<!doctype html><meta charset="utf-8"><title>lanes: create the GitHub App</title>
<p>This creates the lanes GitHub App (private, no webhook, no workflows permission). GitHub asks you to confirm.</p>
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
 * (async), plus `done: true` once the config is written.
 */
export function createHandler(deps) {
  let app = null;
  let finished = false;
  const bad = (status, why) => page(status, why);
  return async function handle({ method, url, host }) {
    if (host !== `127.0.0.1:${deps.port()}`) return bad(400, "wrong host");
    if (method !== "GET") return bad(405, "method not allowed");
    const u = new URL(url, "http://127.0.0.1");
    if (u.pathname === "/") {
      const manifest = buildManifest({ port: deps.port(), name: deps.name });
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
  const fd = openSync(join(dir, `${slug}.pem`), "wx", 0o600);
  try {
    writeSync(fd, pem);
  } finally {
    closeSync(fd);
  }
}

/** Parses argv (after the script): `{ org }` or null when malformed. */
export function parseArgs(argv) {
  if (argv.length === 0) return { org: undefined };
  if (argv.length === 2 && argv[0] === "--org" && ORG.test(argv[1])) return { org: argv[1] };
  return null;
}

async function realConvert(code) {
  const res = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, { method: "POST", headers: { accept: "application/vnd.github+json" } });
  if (!res.ok) throw new Error(`status ${res.status}`);
  const j = await res.json();
  return { id: j.id, slug: j.slug, pem: j.pem };
}

async function main(argv) {
  const args = parseArgs(argv);
  if (!args) {
    console.error("usage: node scripts/lanes/app-setup.mjs [--org <org>]");
    return 2;
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
    readConfig();
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
    port: () => port,
    name: `lanes-${randomBytes(3).toString("hex")}`,
    convert: realConvert,
    saveKey: (slug, pem) => saveKey(slug, pem),
    readConfig,
    writeConfig: (obj) => writeFileSync("lanes.config.json", `${JSON.stringify(obj, null, 2)}\n`),
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
  console.log("Checking the rest of the setup:");
  setupChecksMain();
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
