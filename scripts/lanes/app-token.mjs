/**
 * Mints a short-lived GitHub App installation token for this repository only (ADR 0019 part 2), with no npm
 * dependency. The key and the JWT never reach an error message, a log or the console: every failure names its step
 * and nothing else.
 */
import { createSign } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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

/** Returns `{ token, expiresAt }` or throws an error naming the failed step. */
export async function mintInstallationToken({ appId, installationId, keyPem, repo, fetch = globalThis.fetch, now = Date.now }) {
  if (!/^\d+$/.test(String(appId ?? ""))) throw new Error("app-token: appId must be numeric");
  if (!/^\d+$/.test(String(installationId ?? ""))) throw new Error("app-token: installationId must be numeric");
  if (typeof keyPem !== "string" || !keyPem.trim()) throw new Error("app-token: no private key given");
  const name = String(repo ?? "").split("/");
  const repoName = name.length <= 2 ? name[name.length - 1] : "";
  if (!/^[A-Za-z0-9._-]+$/.test(repoName)) throw new Error("app-token: repo must be a repository name");

  const jwt = signJwt(appId, keyPem, typeof now === "function" ? now() : now);
  let res;
  let text;
  try {
    res = await fetch(`${API}/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "lanes-app-token",
      },
      body: JSON.stringify({ repositories: [repoName], permissions: PERMISSIONS }),
    });
    text = await res.text();
  } catch {
    throw new Error("app-token: request to GitHub failed");
  }
  if (!res.ok) throw new Error(`app-token: request to GitHub failed with status ${res.status}`);

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
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
