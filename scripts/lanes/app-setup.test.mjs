// scripts/lanes/app-setup.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PERMISSIONS, WORKFLOWS_PERMISSIONS, buildManifest, confirmAndCreateEnvironment, createHandler, formPage, parseArgs, provisionApp, saveKey, workflowsPlan } from "./app-setup.mjs";

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

test("parseArgs accepts none, --org <name> and --workflows (with or without --org), nothing else", () => {
  assert.deepEqual(parseArgs([]), { org: undefined, workflows: false });
  assert.deepEqual(parseArgs(["--org", "acme"]), { org: "acme", workflows: false });
  assert.deepEqual(parseArgs(["--workflows"]), { org: undefined, workflows: true });
  assert.deepEqual(parseArgs(["--workflows", "--org", "acme"]), { org: "acme", workflows: true });
  assert.deepEqual(parseArgs(["--org", "acme", "--workflows"]), { org: "acme", workflows: true });
  for (const bad of [["--org"], ["--org", "a/b"], ["--org", ""], ["--x"], ["--org", "a", "b"], ["--workflows", "--workflows"], ["--workflows", "--org"]]) assert.equal(parseArgs(bad), null, bad.join(" "));
});

// ---- --workflows (#648, ADR 0029 parts 1 to 3) ----

const KEYMARK = "SECRETKEYBODY";

/** A fake gh: records every call (args and stdin) and fails the call whose first args match `failOn`. */
function fakeGh({ failOn, login = "owner-login", id = 99 } = {}) {
  const calls = [];
  const gh = (args, input) => {
    calls.push({ args, input });
    const joined = args.join(" ");
    if (failOn && joined.includes(failOn)) return { status: 1, stdout: "", stderr: `boom ${KEYMARK}` };
    if (joined === "api user --jq .login") return { status: 0, stdout: `${login}\n` };
    if (joined === "api user --jq .id") return { status: 0, stdout: `${id}\n` };
    if (joined.startsWith("repo view")) return { status: 0, stdout: "acme/widgets\n" };
    return { status: 0, stdout: "" };
  };
  return { gh, calls };
}
const adminCalls = (calls) => calls.filter((c) => c.args.includes("PUT") || c.args.includes("POST") || c.args[0] === "secret" || c.args[0] === "variable");

test("the workflows manifest has exactly contents write, workflows write and metadata read, private, hook inactive", () => {
  const m = buildManifest({ port: 4000, name: "n", permissions: WORKFLOWS_PERMISSIONS });
  assert.deepEqual(m.default_permissions, { contents: "write", workflows: "write", metadata: "read" });
  assert.equal(m.public, false);
  assert.deepEqual(m.hook_attributes, { active: false });
  assert.equal(m.redirect_url, "http://127.0.0.1:4000/redirect");
  assert.equal(m.setup_url, "http://127.0.0.1:4000/setup");
  assert.equal(buildManifest({ port: 1, name: "n" }).default_permissions.workflows, undefined);
});

test("the plan names the environment, reviewer, main-only branch policy, secret and variable before anything is asked", () => {
  const text = workflowsPlan({ repo: "acme/widgets", login: "owner-login" }).join("\n");
  for (const want of ["lanes-workflow-apply", "owner-login", "main", "LANES_WORKFLOWS_KEY", "LANES_WORKFLOWS_APP_ID", "acme/widgets"]) assert.ok(text.includes(want), want);
});

test("edge: any answer but y creates nothing", async () => {
  for (const answer of ["", "n", "N", "yes", " ", "Y ", "no"]) {
    const { gh, calls } = fakeGh();
    const out = [];
    const r = await confirmAndCreateEnvironment({ gh, ask: async () => answer, print: (l) => out.push(l) });
    assert.equal(r.ok, false, JSON.stringify(answer));
    assert.deepEqual(adminCalls(calls), [], JSON.stringify(answer));
  }
});

test("the plan is printed before the question, and the question before the first admin call", async () => {
  const { gh, calls } = fakeGh();
  const order = [];
  const r = await confirmAndCreateEnvironment({
    gh: (a, i) => {
      if (a.includes("PUT") || a.includes("POST")) order.push("admin");
      return gh(a, i);
    },
    ask: async () => {
      order.push("ask");
      return "y";
    },
    print: (l) => order.push(l.includes("lanes-workflow-apply") ? "plan" : "line"),
  });
  assert.equal(r.ok, true);
  assert.ok(order.indexOf("plan") < order.indexOf("ask"));
  assert.ok(order.indexOf("ask") < order.indexOf("admin"));
  void calls;
});

test("y creates the environment with the owner as reviewer, main-only deployment branches and self-review off", async () => {
  const { gh, calls } = fakeGh();
  const r = await confirmAndCreateEnvironment({ gh, ask: async () => "y", print: () => {} });
  assert.equal(r.ok, true);
  assert.equal(r.repo, "acme/widgets");
  const put = calls.find((c) => c.args.includes("PUT"));
  assert.ok(put.args.includes("repos/acme/widgets/environments/lanes-workflow-apply"));
  const body = JSON.parse(put.input);
  assert.deepEqual(body.reviewers, [{ type: "User", id: 99 }]);
  assert.equal(body.prevent_self_review, false);
  assert.deepEqual(body.deployment_branch_policy, { protected_branches: false, custom_branch_policies: true });
  const post = calls.find((c) => c.args.includes("POST"));
  assert.ok(post.args.includes("repos/acme/widgets/environments/lanes-workflow-apply/deployment-branch-policies"));
  assert.deepEqual(JSON.parse(post.input), { name: "main", type: "branch" });
});

test("each failed environment step is reported by name and stops the run", async () => {
  for (const [failOn, step] of [["--jq .login", "reading your login"], ["repo view", "reading the repository"], ["--method PUT", "creating the environment"], ["--method POST", "restricting deployment branches to main"]]) {
    const { gh } = fakeGh({ failOn });
    const r = await confirmAndCreateEnvironment({ gh, ask: async () => "y", print: () => {} });
    assert.equal(r.ok, false, failOn);
    assert.match(r.error, new RegExp(step), failOn);
  }
});

test("provisioning pipes the key to gh secret set on stdin, never in argv, then sets the variable", () => {
  const { gh, calls } = fakeGh();
  provisionApp({ gh, repo: "acme/widgets", id: 4242, pem: PEM });
  assert.equal(calls.length, 2);
  const [secret, variable] = calls;
  assert.deepEqual(secret.args, ["secret", "set", "LANES_WORKFLOWS_KEY", "--env", "lanes-workflow-apply", "--repo", "acme/widgets"]);
  assert.equal(secret.input, PEM);
  assert.deepEqual(variable.args, ["variable", "set", "LANES_WORKFLOWS_APP_ID", "--env", "lanes-workflow-apply", "--repo", "acme/widgets", "--body", "4242"]);
  assert.equal(JSON.stringify(calls.map((c) => c.args)).includes(KEYMARK), false);
});

test("a failed secret call or variable call reports its step, and the error never carries the key", () => {
  for (const [failOn, step] of [["secret set", "setting the secret LANES_WORKFLOWS_KEY"], ["variable set", "setting the variable LANES_WORKFLOWS_APP_ID"]]) {
    const { gh } = fakeGh({ failOn });
    assert.throws(
      () => provisionApp({ gh, repo: "acme/widgets", id: 1, pem: PEM }),
      (err) => err.step === step && !String(err.message).includes(KEYMARK),
    );
  }
});

test("the workflows flow: the key is never written to disk, only handed to provision; no config is written", async () => {
  const provisioned = [];
  const calls = [];
  const handle = createHandler({
    mode: "workflows",
    state: STATE,
    org: undefined,
    port: () => 4000,
    name: "lanes-workflows-abc",
    convert: async () => ({ id: 42, slug: "my-workflows", pem: PEM }),
    saveKey: () => calls.push("saveKey"),
    provision: ({ id, pem }) => provisioned.push([id, pem]),
    readConfig: () => calls.push("readConfig"),
    writeConfig: () => calls.push("writeConfig"),
    log: (l) => calls.push(l),
  });
  const home = await handle({ method: "GET", url: "/", host: HOST });
  const manifest = JSON.parse(home.body.match(/name="manifest" value="([^"]*)"/)[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
  assert.deepEqual(manifest.default_permissions, { contents: "write", workflows: "write", metadata: "read" });
  const r = await handle({ method: "GET", url: `/redirect?code=abc&state=${STATE}`, host: HOST });
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, `https://github.com/apps/my-workflows/installations/new?state=${STATE}`);
  assert.deepEqual(provisioned, [[42, PEM]]);
  const s = await handle({ method: "GET", url: `/setup?installation_id=9&state=${STATE}`, host: HOST });
  assert.equal(s.status, 200);
  assert.equal(s.done, true);
  assert.equal(calls.some((c) => c === "saveKey" || c === "readConfig" || c === "writeConfig"), false);
  assert.equal(JSON.stringify(calls).includes(KEYMARK), false);
});

test("edge: a failed provision keeps nothing, says which step failed, and the install page is not reached", async () => {
  const logs = [];
  const handle = createHandler({
    mode: "workflows",
    state: STATE,
    port: () => 4000,
    name: "n",
    convert: async () => ({ id: 42, slug: "my-workflows", pem: PEM }),
    provision: () => {
      throw Object.assign(new Error(`failed ${KEYMARK}`), { step: "setting the secret LANES_WORKFLOWS_KEY" });
    },
    log: (l) => logs.push(l),
  });
  const r = await handle({ method: "GET", url: `/redirect?code=abc&state=${STATE}`, host: HOST });
  assert.equal(r.status, 500);
  assert.match(r.body, /setting the secret LANES_WORKFLOWS_KEY/);
  assert.equal(r.body.includes(KEYMARK) || logs.join("\n").includes(KEYMARK), false);
  assert.equal((await handle({ method: "GET", url: `/setup?installation_id=9&state=${STATE}`, host: HOST })).status, 400);
});
