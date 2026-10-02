import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, statSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { findInstallationId, mintInstallationToken, runWorkflows, writeGhHosts } from "./app-token.mjs";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const keyPem = privateKey.export({ type: "pkcs8", format: "pem" });
const NOW = 1_800_000_000_000;
const b64 = (s) => Buffer.from(s, "base64url").toString();

function okFetch(calls, body = { token: "ghs_minted123", expires_at: "2026-10-01T10:00:00Z" }) {
  return async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status: 201 });
  };
}

function args(over = {}) {
  return { appId: 12345, installationId: 678, keyPem, repo: "lanes", now: () => NOW, ...over };
}

test("signs an RS256 JWT with iss, iat 60s back and exp within 10 minutes", async () => {
  const calls = [];
  await mintInstallationToken(args({ fetch: okFetch(calls) }));
  const jwt = calls[0].init.headers.Authorization.replace("Bearer ", "");
  const [h, p, s] = jwt.split(".");
  assert.deepEqual(JSON.parse(b64(h)), { alg: "RS256", typ: "JWT" });
  const claims = JSON.parse(b64(p));
  assert.equal(claims.iss, "12345");
  assert.equal(claims.iat, NOW / 1000 - 60);
  assert.ok(claims.exp === NOW / 1000 + 540 && claims.exp <= NOW / 1000 + 600);
  const v = createVerify("RSA-SHA256").update(`${h}.${p}`);
  assert.ok(v.verify(publicKey, Buffer.from(s, "base64url")));
});

test("posts to the installation token endpoint, one repository, minimum permissions", async () => {
  const calls = [];
  const out = await mintInstallationToken(args({ fetch: okFetch(calls) }));
  assert.equal(calls[0].url, "https://api.github.com/app/installations/678/access_tokens");
  assert.equal(calls[0].init.method, "POST");
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.repositories, ["lanes"]);
  assert.deepEqual(body.permissions, {
    contents: "write",
    pull_requests: "write",
    issues: "write",
    statuses: "write",
    checks: "read",
  });
  assert.ok(!("workflows" in body.permissions) && !("administration" in body.permissions));
  assert.deepEqual(out, { token: "ghs_minted123", expiresAt: "2026-10-01T10:00:00Z" });
});

test("edge: an owner/name repo is reduced to the name the API wants", async () => {
  const calls = [];
  await mintInstallationToken(args({ repo: "Sour-Dev-Home/lanes", fetch: okFetch(calls) }));
  assert.deepEqual(JSON.parse(calls[0].init.body).repositories, ["lanes"]);
});

test("edge: now may be a plain number", async () => {
  const calls = [];
  await mintInstallationToken(args({ now: NOW, fetch: okFetch(calls) }));
  const jwt = calls[0].init.headers.Authorization.replace("Bearer ", "");
  assert.equal(JSON.parse(b64(jwt.split(".")[1])).iat, NOW / 1000 - 60);
});

test("edge: bad inputs fail before any request", async () => {
  const calls = [];
  const fetch = okFetch(calls);
  for (const over of [
    { installationId: "1/../2" },
    { installationId: "" },
    { appId: "" },
    { repo: "" },
    { repo: "a/b/c" },
    { keyPem: "" },
  ]) {
    await assert.rejects(mintInstallationToken(args({ ...over, fetch })), /app-token:/);
  }
  assert.equal(calls.length, 0);
});

test("a non-2xx response fails naming the step, without echoing the body", async () => {
  const fetch = async () => new Response('{"message":"Bad credentials ghs_secretbody"}', { status: 401 });
  await assert.rejects(mintInstallationToken(args({ fetch })), (e) => {
    assert.match(e.message, /app-token: request to GitHub failed with status 401/);
    assert.ok(!e.message.includes("secretbody"));
    return true;
  });
});

test("edge: a non-2xx response with a valid-looking body still fails", async () => {
  const fetch = async () => new Response(JSON.stringify({ token: "ghs_x", expires_at: "2026-10-01T10:00:00Z" }), { status: 500 });
  await assert.rejects(mintInstallationToken(args({ fetch })), /status 500/);
});

test("a network error fails naming the step", async () => {
  const fetch = async () => {
    throw new Error("connect ECONNREFUSED");
  };
  await assert.rejects(mintInstallationToken(args({ fetch })), /app-token: request to GitHub failed/);
});

test("a malformed body never yields a partial token", async () => {
  for (const raw of ["not json", "{}", '{"token":"ghs_x"}', '{"expires_at":"2026-10-01T10:00:00Z"}', '{"token":"ghs_x","expires_at":"nope"}', '{"token":"","expires_at":"2026-10-01T10:00:00Z"}', "null"]) {
    const fetch = async () => new Response(raw, { status: 201 });
    await assert.rejects(mintInstallationToken(args({ fetch })), /app-token: malformed response from GitHub/, raw);
  }
});

test("a key that cannot sign fails naming the step", async () => {
  const calls = [];
  await assert.rejects(mintInstallationToken(args({ keyPem: "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----", fetch: okFetch(calls) })), /app-token: could not sign the JWT/);
  assert.equal(calls.length, 0);
});

test("the key and the JWT never reach an error message or the console", async () => {
  const seen = [];
  const spy = (orig) => (...a) => {
    seen.push(a.join(" "));
    return true;
  };
  const so = process.stdout.write, se = process.stderr.write;
  process.stdout.write = spy();
  process.stderr.write = spy();
  const errors = [];
  try {
    const calls = [];
    await mintInstallationToken(args({ fetch: okFetch(calls) }));
    const jwt = calls[0].init.headers.Authorization.replace("Bearer ", "");
    for (const fetch of [
      async (u, init) => {
        errors.push(init.headers.Authorization);
        return new Response(`denied ${init.headers.Authorization}`, { status: 403 });
      },
      async (u, init) => {
        throw new Error(`boom ${init.headers.Authorization}`);
      },
    ]) {
      try {
        await mintInstallationToken(args({ fetch }));
      } catch (e) {
        errors.push(e.message, String(e.stack), String(e.cause ?? ""));
      }
    }
    try {
      await mintInstallationToken(args({ keyPem: keyPem.slice(0, 120), fetch: okFetch([]) }));
    } catch (e) {
      errors.push(e.message, String(e.stack), String(e.cause ?? ""));
    }
    const body = keyPem.split("\n").filter((l) => l && !l.startsWith("-----"))[0];
    const leaked = [...errors.slice(1).filter((x) => !x.startsWith("Bearer ")), ...seen];
    for (const text of leaked) {
      assert.ok(!text.includes(body), "key material leaked");
      assert.ok(!text.includes(jwt.split(".")[2]), "jwt signature leaked");
      assert.ok(!text.includes("Bearer eyJ"), "jwt leaked");
    }
  } finally {
    process.stdout.write = so;
    process.stderr.write = se;
  }
  assert.equal(seen.length, 0);
});

test("writeGhHosts writes only hosts.yml with the token, never the key", () => {
  const dir = mkdtempSync(join(tmpdir(), "app-token-"));
  try {
    writeGhHosts(dir, "ghs_abc_DEF-123");
    assert.deepEqual(readdirSync(dir), ["hosts.yml"]);
    const text = readFileSync(join(dir, "hosts.yml"), "utf8");
    assert.equal(text, "github.com:\n    oauth_token: ghs_abc_DEF-123\n");
    if (process.platform !== "win32") assert.equal(statSync(join(dir, "hosts.yml")).mode & 0o777, 0o600);
    writeGhHosts(dir, "ghs_second");
    assert.match(readFileSync(join(dir, "hosts.yml"), "utf8"), /ghs_second/);
    assert.deepEqual(readdirSync(dir), ["hosts.yml"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("edge: writeGhHosts creates a missing directory and rejects a token that is not a plain token", () => {
  const base = mkdtempSync(join(tmpdir(), "app-token-"));
  try {
    const dir = join(base, "a", "b");
    writeGhHosts(dir, "ghs_ok");
    assert.ok(readFileSync(join(dir, "hosts.yml"), "utf8").includes("ghs_ok"));
    for (const bad of ["", "a\nb: c", "x y", undefined, 5]) {
      assert.throws(() => writeGhHosts(dir, bad), /app-token: invalid token/);
    }
    assert.throws(() => writeGhHosts("", "ghs_ok"), /app-token:/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("edge: writeGhHosts fails naming the step when the directory cannot be created, without the token", () => {
  const base = mkdtempSync(join(tmpdir(), "app-token-"));
  try {
    const file = join(base, "afile");
    writeFileSync(file, "x");
    assert.throws(
      () => writeGhHosts(join(file, "sub"), "ghs_secret"),
      (e) => /app-token: could not write hosts.yml/.test(e.message) && !e.message.includes("ghs_secret"),
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("edge: a body that cannot be read fails naming the step", async () => {
  const fetch = async () => ({
    ok: true,
    status: 201,
    text: async () => {
      throw new Error("stream broke");
    },
  });
  await assert.rejects(mintInstallationToken(args({ fetch })), /app-token: request to GitHub failed/);
});

test("ownPermissions sends no permissions body so the App's own permissions apply", async () => {
  const calls = [];
  await mintInstallationToken(args({ ownPermissions: true, fetch: okFetch(calls) }));
  assert.deepEqual(JSON.parse(calls[0].init.body), { repositories: ["lanes"] });
});

function lookupFetch(calls, { lookup = { status: 200, body: { id: 4242 } } } = {}) {
  return async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("/installation")) return new Response(JSON.stringify(lookup.body), { status: lookup.status });
    return new Response(JSON.stringify({ token: "ghs_minted123", expires_at: "2026-10-01T10:00:00Z" }), { status: 201 });
  };
}

test("looks the installation up from the repository with the JWT when no installationId is given", async () => {
  const calls = [];
  const out = await mintInstallationToken(args({ installationId: undefined, repo: "o/lanes", ownPermissions: true, fetch: lookupFetch(calls) }));
  assert.equal(calls[0].url, "https://api.github.com/repos/o/lanes/installation");
  assert.match(calls[0].init.headers.Authorization, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  assert.equal(calls[1].url, "https://api.github.com/app/installations/4242/access_tokens");
  assert.equal(out.token, "ghs_minted123");
});

test("a failed installation lookup names its step and status, never the body", async () => {
  const calls = [];
  const fetch = lookupFetch(calls, { lookup: { status: 404, body: { message: "ghs_secretbody" } } });
  await assert.rejects(mintInstallationToken(args({ installationId: undefined, repo: "o/lanes", fetch })), (e) => {
    assert.match(e.message, /app-token: installation lookup failed with status 404/);
    assert.ok(!e.message.includes("secretbody"));
    return true;
  });
  assert.equal(calls.length, 1, "no mint after a failed lookup");
});

test("a failed mint after a good lookup names the mint step", async () => {
  const fetch = async (url) =>
    url.endsWith("/installation") ? new Response('{"id":4242}', { status: 200 }) : new Response("nope", { status: 403 });
  await assert.rejects(mintInstallationToken(args({ installationId: undefined, repo: "o/lanes", ownPermissions: true, fetch })), /request to GitHub failed with status 403/);
});

test("workflows mode masks the token before exporting it and names only the step on failure", async () => {
  const events = [];
  const fetch = async (url) =>
    new Response(JSON.stringify(url.endsWith("/installation") ? { id: 9 } : { token: "ghs_abc", expires_at: "2026-10-01T10:00:00Z" }), { status: 200 });
  const env = { APP_ID: "1", APP_KEY: keyPem, LANES_REPO: "o/lanes", GITHUB_ENV: "env-file" };
  await runWorkflows(env, { fetch, log: (l) => events.push(["log", l]), appendFile: (f, c) => events.push(["file", f, c]) });
  assert.deepEqual(events, [["log", "::add-mask::ghs_abc"], ["file", "env-file", "LANES_WORKFLOWS_TOKEN=ghs_abc\n"]]);
  const bad = async () => new Response("secret ghs_leak", { status: 500 });
  await assert.rejects(runWorkflows(env, { fetch: bad, log() {}, appendFile() {} }), (e) => /installation lookup failed with status 500/.test(e.message) && !e.message.includes("leak"));
  await assert.rejects(runWorkflows({ ...env, GITHUB_ENV: "" }, { fetch, log() {}, appendFile() {} }), /no GITHUB_ENV/);
});

test("edge: the CLI refuses a missing mode and prints only the step when the key is bad", () => {
  const run = (a, env) => spawnSync(process.execPath, ["scripts/lanes/app-token.mjs", ...a], { env: { PATH: process.env.PATH, ...env }, encoding: "utf8" });
  assert.equal(run([], {}).status, 2);
  const bad = run(["workflows"], { APP_ID: "1", APP_KEY: "SECRETKEYTEXT", LANES_REPO: "o/lanes", GITHUB_ENV: "x" });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /app-token: could not sign the JWT/);
  assert.ok(!bad.stderr.includes("SECRETKEYTEXT") && !bad.stdout.includes("SECRETKEYTEXT"));
});

test("edge: a lookup needs owner/name, and a malformed lookup response is refused", async () => {
  const calls = [];
  await assert.rejects(mintInstallationToken(args({ installationId: undefined, repo: "lanes", fetch: lookupFetch(calls) })), /app-token:/);
  assert.equal(calls.length, 0);
  for (const body of [{}, { id: "x" }, { id: -1 }, null]) {
    await assert.rejects(
      findInstallationId({ appId: 1, keyPem, repo: "o/lanes", fetch: lookupFetch([], { lookup: { status: 200, body } }) }),
      /malformed response/,
    );
  }
});
