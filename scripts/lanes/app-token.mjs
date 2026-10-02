/**
 * Mints a short-lived GitHub App installation token for this repository only (ADR 0019 part 2), with no npm
 * dependency. The key and the JWT never reach an error message, a log or the console: every failure names its step
 * and nothing else.
 */
import { createSign } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const API = "https://api.github.com";
/** The minimum ADR 0019 lists: no workflows, no administration. */
const PERMISSIONS = { contents: "write", pull_requests: "write", issues: "write", statuses: "write", checks: "read" };
const b64url = (v) => Buffer.from(v).toString("base64url");

function signJwt(appId, keyPem, nowMs) {
  const iat = Math.floor(nowMs / 1000) - 60;
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: String(appId), iat, exp: iat + 60 + 540 }));
  try {
    const sig = createSign("RSA-SHA256").update(`${head}.${claims}`).sign(keyPem);
    return `${head}.${claims}.${b64url(sig)}`;
  } catch {
    // The underlying error can quote key parsing detail, so it is dropped.
    throw new Error("app-token: could not sign the JWT with the given key");
  }
}

function checkApp(appId, keyPem) {
  if (!/^\d+$/.test(String(appId ?? ""))) throw new Error("app-token: appId must be numeric");
  if (typeof keyPem !== "string" || !keyPem.trim()) throw new Error("app-token: no private key given");
}

/** One GitHub call as the App; returns the parsed JSON body or throws an error naming `step` and the status only. */
async function appRequest(fetch, url, jwt, step, init = {}) {
  let res;
  let text;
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "lanes-app-token",
      },
    });
    text = await res.text();
  } catch {
    throw new Error(`app-token: ${step} failed`);
  }
  if (!res.ok) throw new Error(`app-token: ${step} failed with status ${res.status}`);
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Looks the App's installation id up from `owner/name` (`GET /repos/{repo}/installation`, signed with the JWT). */
export async function findInstallationId({ appId, keyPem, repo, fetch = globalThis.fetch, now = Date.now }) {
  checkApp(appId, keyPem);
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(String(repo ?? ""))) throw new Error("app-token: repo must be owner/name");
  const jwt = signJwt(appId, keyPem, typeof now === "function" ? now() : now);
  const body = await appRequest(fetch, `${API}/repos/${repo}/installation`, jwt, "installation lookup");
  if (!Number.isInteger(body?.id) || body.id <= 0) throw new Error("app-token: malformed response from GitHub");
  return String(body.id);
}

/**
 * Returns `{ token, expiresAt }` or throws an error naming the failed step. By default the token carries the fixed
 * PERMISSIONS above; `ownPermissions: true` sends no `permissions` body, so the App's own permissions (`workflows:
 * write` among them) apply. A missing `installationId` is looked up from `repo`, which must then be `owner/name`.
 */
export async function mintInstallationToken({ appId, installationId, keyPem, repo, ownPermissions = false, fetch = globalThis.fetch, now = Date.now }) {
  checkApp(appId, keyPem);
  const hasId = installationId !== undefined && installationId !== null;
  if (hasId && !/^\d+$/.test(String(installationId))) throw new Error("app-token: installationId must be numeric");
  const name = String(repo ?? "").split("/");
  const repoName = name.length <= 2 ? name[name.length - 1] : "";
  if (!/^[A-Za-z0-9._-]+$/.test(repoName)) throw new Error("app-token: repo must be a repository name");
  if (!hasId && name.length !== 2) throw new Error("app-token: installationId must be numeric");

  const id = hasId ? String(installationId) : await findInstallationId({ appId, keyPem, repo, fetch, now });
  const jwt = signJwt(appId, keyPem, typeof now === "function" ? now() : now);
  const payload = ownPermissions ? { repositories: [repoName] } : { repositories: [repoName], permissions: PERMISSIONS };
  const body = await appRequest(fetch, `${API}/app/installations/${id}/access_tokens`, jwt, "request to GitHub", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  if (
    !body ||
    typeof body.token !== "string" ||
    !body.token ||
    typeof body.expires_at !== "string" ||
    Number.isNaN(Date.parse(body.expires_at))
  ) {
    throw new Error("app-token: malformed response from GitHub");
  }
  return { token: body.token, expiresAt: body.expires_at };
}

/** Writes `<dir>/hosts.yml` for github.com holding the token and nothing else (owner-only mode where supported). */
export function writeGhHosts(dir, token) {
  if (typeof token !== "string" || !/^[A-Za-z0-9_.-]+$/.test(token)) throw new Error("app-token: invalid token");
  if (typeof dir !== "string" || !dir) throw new Error("app-token: no directory given for hosts.yml");
  try {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "hosts.yml");
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `github.com:\n    oauth_token: ${token}\n`, { mode: 0o600 });
    try {
      chmodSync(tmp, 0o600);
    } catch {
      // Windows has no POSIX modes; the directory's ACL applies.
    }
    renameSync(tmp, file);
  } catch {
    throw new Error("app-token: could not write hosts.yml");
  }
}

/**
 * `node scripts/lanes/app-token.mjs workflows` (lanes-workflow-apply): reads APP_ID, APP_KEY and LANES_REPO
 * (owner/name) from the environment, mints a token with the App's own permissions, masks it, then exports it as
 * LANES_WORKFLOWS_TOKEN through GITHUB_ENV. Every failure prints its step only.
 */
export async function runWorkflows(env = process.env, { fetch, now, log = console.log, appendFile = appendFileSync } = {}) {
  const { APP_ID: appId, APP_KEY: keyPem, LANES_REPO: repo, GITHUB_ENV: envFile } = env;
  if (!envFile) throw new Error("app-token: no GITHUB_ENV to export the token to");
  const { token } = await mintInstallationToken({ appId, keyPem, repo, ownPermissions: true, fetch, now });
  if (!/^[A-Za-z0-9_.-]+$/.test(token)) throw new Error("app-token: invalid token");
  log(`::add-mask::${token}`);
  appendFile(envFile, `LANES_WORKFLOWS_TOKEN=${token}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] !== "workflows") {
    console.error("usage: app-token.mjs workflows");
    process.exit(2);
  }
  runWorkflows().catch((e) => {
    console.error(String(e?.message ?? "app-token: failed").startsWith("app-token:") ? e.message : "app-token: failed");
    process.exit(1);
  });
}
