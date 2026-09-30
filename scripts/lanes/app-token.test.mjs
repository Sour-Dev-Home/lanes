import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintInstallationToken, writeGhHosts } from "./app-token.mjs";

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
  assert.ok(claims.exp > claims.iat && claims.exp <= NOW / 1000 + 600);
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
