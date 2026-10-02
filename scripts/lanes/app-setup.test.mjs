// scripts/lanes/app-setup.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PERMISSIONS, buildManifest, createHandler, formPage, parseArgs, saveKey } from "./app-setup.mjs";

const PEM = "-----BEGIN RSA PRIVATE KEY-----\nSECRETKEYBODY\n-----END RSA PRIVATE KEY-----\n";
const STATE = "a".repeat(32);
const HOST = "127.0.0.1:4000";

function harness({ convert, saveFail = false, config = { keep: 1, identity: { profile: "solo" } }, writeFail = false } = {}) {
  const calls = [];
  const logs = [];
  const handle = createHandler({
    state: STATE,
    org: undefined,
    port: () => 4000,
    name: "lanes-abc",
    convert: convert ?? (async () => ({ id: 42, slug: "my-lanes", pem: PEM })),
    saveKey: (slug, pem) => {
      calls.push(["key", slug]);
      if (saveFail) throw new Error("disk");
      void pem;
    },
    readConfig: () => config,
    writeConfig: (obj) => {
      calls.push(["config", obj]);
      if (writeFail) throw new Error("disk");
    },
    log: (l) => logs.push(l),
  });
  const get = (path, host = HOST) => handle({ method: "GET", url: path, host });
  return { get, calls, logs, handle };
}

test("the manifest carries exactly ADR 0019's permissions, is private, has no webhook and no workflows", () => {
  const m = buildManifest({ port: 4000, name: "n" });
  assert.deepEqual(m.default_permissions, { contents: "write", pull_requests: "write", issues: "write", statuses: "write", checks: "read", metadata: "read" });
  assert.deepEqual(PERMISSIONS, m.default_permissions);
  assert.equal("workflows" in m.default_permissions, false);
  assert.equal(m.public, false);
  assert.deepEqual(m.hook_attributes, { active: false });
  assert.equal(m.redirect_url, "http://127.0.0.1:4000/redirect");
  assert.equal(m.setup_url, "http://127.0.0.1:4000/setup");
});

test("the form posts the manifest and the state to GitHub's new-App page, or the org's", () => {
  const manifest = buildManifest({ port: 1, name: "n" });
  const personal = formPage({ manifest, state: STATE });
  assert.match(personal, /action="https:\/\/github\.com\/settings\/apps\/new\?state=a{32}"/);
  assert.match(formPage({ manifest, state: STATE, org: "acme" }), /action="https:\/\/github\.com\/organizations\/acme\/settings\/apps\/new\?/);
  const json = personal.match(/name="manifest" value="([^"]*)"/)[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&");
  assert.deepEqual(JSON.parse(json), manifest);
});

test("the full flow: key saved first, then the config is written with every other key kept", async () => {
  const h = harness();
  const r = await h.get(`/redirect?code=abc123&state=${STATE}`);
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, `https://github.com/apps/my-lanes/installations/new?state=${STATE}`);
  assert.deepEqual(h.calls, [["key", "my-lanes"]]);
  const s = await h.get(`/setup?installation_id=777&state=${STATE}`);
  assert.equal(s.status, 200);
  assert.equal(s.done, true);
  assert.deepEqual(h.calls.map((c) => c[0]), ["key", "config"]);
  assert.deepEqual(h.calls[1][1], { keep: 1, identity: { profile: "team", app: { id: 42, installationId: 777, botLogin: "my-lanes[bot]" } } });
});

test("a callback whose state does not match is refused and does nothing", async () => {
  const h = harness();
  for (const path of [`/redirect?code=abc&state=${"b".repeat(32)}`, "/redirect?code=abc", `/setup?installation_id=1&state=nope`, "/setup?installation_id=1"]) {
    const r = await h.get(path);
    assert.equal(r.status, 400, path);
  }
  assert.deepEqual(h.calls, []);
});

test("a failed conversion saves no key and writes no config; a malformed answer does the same", async () => {
  for (const convert of [async () => { throw new Error("status 404"); }, async () => ({ id: 1, slug: "../evil", pem: PEM }), async () => ({ id: 1, slug: "ok", pem: "not a key" }), async () => ({ id: "1", slug: "ok", pem: PEM }), async () => undefined]) {
    const h = harness({ convert });
    const r = await h.get(`/redirect?code=abc&state=${STATE}`);
    assert.equal(r.status, 502);
    assert.deepEqual(h.calls, []);
    assert.equal((await h.get(`/setup?installation_id=1&state=${STATE}`)).status, 400);
    assert.deepEqual(h.calls, []);
  }
});

test("a key that cannot be saved stops before any config is written", async () => {
  const h = harness({ saveFail: true });
  assert.equal((await h.get(`/redirect?code=abc&state=${STATE}`)).status, 500);
  assert.equal((await h.get(`/setup?installation_id=1&state=${STATE}`)).status, 400);
  assert.deepEqual(h.calls, [["key", "my-lanes"]]);
});

test("edge: malformed code or installation_id, a reused code, a second setup, a bad host and a bad method", async () => {
  const h = harness();
  assert.equal((await h.get(`/redirect?state=${STATE}`)).status, 400);
  assert.equal((await h.get(`/redirect?code=a%20b&state=${STATE}`)).status, 400);
  assert.equal((await h.get(`/redirect?code=ok&state=${STATE}`, "evil.example:4000")).status, 400);
  assert.equal((await h.handle({ method: "POST", url: "/", host: HOST })).status, 405);
  assert.equal((await h.get(`/redirect?code=ok&state=${STATE}`)).status, 302);
  assert.equal((await h.get(`/redirect?code=ok&state=${STATE}`)).status, 409);
  for (const id of ["", "0", "-1", "1.5", "abc", "9".repeat(20)]) assert.equal((await h.get(`/setup?installation_id=${id}&state=${STATE}`)).status, 400, id);
  assert.equal((await h.get(`/setup?installation_id=5&state=${STATE}`)).status, 200);
  assert.equal((await h.get(`/setup?installation_id=5&state=${STATE}`)).status, 409);
  assert.equal((await h.get("/other")).status, 404);
});

test("edge: a config that cannot be written reports it", async () => {
  const h = harness({ writeFail: true });
  await h.get(`/redirect?code=abc&state=${STATE}`);
  assert.equal((await h.get(`/setup?installation_id=5&state=${STATE}`)).status, 500);
});

test("nothing printed or served contains the key", async () => {
  const h = harness();
  const out = [await h.get("/"), await h.get(`/redirect?code=abc&state=${STATE}`), await h.get(`/setup?installation_id=5&state=${STATE}`)];
  assert.equal(JSON.stringify(out).includes("SECRETKEYBODY"), false);
  assert.equal(h.logs.join("\n").includes("SECRETKEYBODY"), false);
});

test("saveKey writes ~/.lanes/<slug>.pem owner-only, refuses to overwrite and refuses a path-like slug", () => {
  const home = mkdtempSync(join(tmpdir(), "lanes-home-"));
  try {
    saveKey("my-lanes", PEM, home);
    const file = join(home, ".lanes", "my-lanes.pem");
    assert.equal(readFileSync(file, "utf8"), PEM);
    if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o077, 0);
    assert.throws(() => saveKey("my-lanes", "other", home));
    assert.equal(readFileSync(file, "utf8"), PEM);
    assert.throws(() => saveKey("../evil", PEM, home));
    assert.equal(existsSync(join(home, "evil.pem")), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("edge: a failed key write leaves no partial file, so a retry can save", () => {
  const home = mkdtempSync(join(tmpdir(), "lanes-home-"));
  try {
    assert.throws(() => saveKey("my-lanes", 12345, home));
    assert.equal(existsSync(join(home, ".lanes", "my-lanes.pem")), false);
    saveKey("my-lanes", PEM, home);
    assert.equal(readFileSync(join(home, ".lanes", "my-lanes.pem"), "utf8"), PEM);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("parseArgs accepts none or --org <name> and nothing else", () => {
  assert.deepEqual(parseArgs([]), { org: undefined });
  assert.deepEqual(parseArgs(["--org", "acme"]), { org: "acme" });
  for (const bad of [["--org"], ["--org", "a/b"], ["--org", ""], ["--x"], ["--org", "a", "b"]]) assert.equal(parseArgs(bad), null, bad.join(" "));
});
