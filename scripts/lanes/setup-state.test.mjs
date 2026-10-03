import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { LABELS } from "./setup-repo.mjs";
import { setupState, formatSetupState, setupStateMain } from "./setup-state.mjs";

const REPO = "acme/widgets";
const HOME = "/home/x";
const TARGET = "/work/widgets";
const APP = { id: 1, installationId: 42, botLogin: "widgets-lanes[bot]" };
const CONFIG = JSON.stringify({ identity: { profile: "team", app: APP } });

const ok = (value) => ({ status: 0, stdout: typeof value === "string" ? value : JSON.stringify(value), stderr: "" });
const bad = { status: 1, stdout: "", stderr: "SECRET-ERROR-TEXT" };

/** A fully set-up world; a test overrides one answer. `routes` maps "args joined" to a result. */
function world(over = {}) {
  const calls = [];
  const files = {
    "lanes.lock.json": "{}",
    "lanes.config.json": CONFIG,
    ".github/CODEOWNERS": "* @acme",
    ".github/workflows/verify.yml": "name: verify\njobs:\n  verify:\n    runs-on: ubuntu-latest\n",
    ...over.files,
  };
  const env = "repos/acme/widgets/environments/lanes-workflow-apply";
  const routes = {
    "secret list -R acme/widgets --json name": ok([{ name: "PII_PATTERNS" }]),
    "label list -R acme/widgets --json name --limit 200": ok(LABELS.map((l) => ({ name: l.name }))),
    "api repos/acme/widgets/rulesets": ok([{ id: 7, name: "main (lanes)", enforcement: "active" }]),
    "api repos/acme/widgets/rulesets/7": ok({ id: 7, enforcement: "active", rules: [{ type: "pull_request", parameters: { require_code_owner_review: true } }] }),
    "api user/installations": ok({ installations: [{ id: 42 }] }),
    "api user/installations/42/repositories?per_page=100": ok({ repositories: [{ full_name: REPO }] }),
    [`api ${env}`]: ok({ protection_rules: [{ type: "required_reviewers", reviewers: [{ type: "User" }] }], deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } }),
    [`api ${env}/deployment-branch-policies`]: ok({ branch_policies: [{ name: "main", type: "branch" }] }),
    [`api ${env}/secrets`]: ok({ secrets: [{ name: "LANES_WORKFLOWS_KEY" }] }),
    ...over.routes,
  };
  const run = (cmd, args) => {
    calls.push([cmd, ...args]);
    const r = routes[args.join(" ")];
    if (cmd !== "gh" || !r) return bad;
    return r;
  };
  const present = new Set([...Object.keys(files).map((f) => join(TARGET, f)), join(HOME, ".lanes", "widgets-lanes.pem"), ...(over.present ?? [])]);
  const gone = new Set((over.gone ?? []).map((f) => join(TARGET, f)).concat((over.goneHome ?? []).map((f) => join(HOME, f))));
  const exists = (p) => present.has(p) && !gone.has(p);
  const read = (p) => {
    const rel = p.slice(TARGET.length + 1).replaceAll("\\", "/");
    if (!(rel in files)) throw new Error("ENOENT");
    return files[rel];
  };
  const list = (dir) => Object.keys(files).filter((f) => f.startsWith(`${dir.slice(TARGET.length + 1).replaceAll("\\", "/")}/`)).map((f) => f.split("/").pop());
  return { calls, deps: { run, exists, read, list, home: HOME, target: TARGET, repo: REPO } };
}

const byName = (items) => Object.fromEntries(items.map((i) => [i.name, i]));

test("a fully set-up repository is done on every item, in the contract's order", () => {
  const items = setupState(world().deps);
  assert.deepEqual(items.map((i) => i.name), ["installed", "secret", "labels", "main-ruleset", "identity", "app-key", "app-installed", "codeowners", "code-owner-ruleset", "workflows-environment", "verify-job"]);
  for (const i of items) assert.equal(i.done, true, `${i.name}: ${i.reason}`);
  assert.ok(items.every((i) => !("fix" in i)));
});

test("installed: missing lanes.lock.json is not done, with the install command", () => {
  const i = byName(setupState(world({ gone: ["lanes.lock.json"] }).deps)).installed;
  assert.equal(i.done, false);
  assert.match(i.fix.command, /install\.mjs/);
});

test("secret: PII_PATTERNS missing, and an API error, are not done; the fix never holds a value", () => {
  const missing = byName(setupState(world({ routes: { "secret list -R acme/widgets --json name": ok([{ name: "OTHER" }]) } }).deps)).secret;
  assert.equal(missing.done, false);
  assert.match(missing.fix.command, /gh secret set PII_PATTERNS/);
  assert.match(missing.fix.link, /settings\/secrets\/actions/);
  const err = byName(setupState(world({ routes: { "secret list -R acme/widgets --json name": bad } }).deps)).secret;
  assert.equal(err.done, false);
  assert.match(err.reason, /could not be read/);
  assert.doesNotMatch(JSON.stringify(err), /SECRET-ERROR-TEXT/);
});

test("labels: every setup-repo label is needed; one missing, and an API error, are not done", () => {
  const names = LABELS.map((l) => ({ name: l.name }));
  const w = world({ routes: { "label list -R acme/widgets --json name --limit 200": ok(names.slice(1)) } });
  const i = byName(setupState(w.deps)).labels;
  assert.equal(i.done, false);
  assert.ok(i.reason.includes(LABELS[0].name));
  assert.match(i.fix.command, /setup-repo\.mjs acme\/widgets/);
  const err = byName(setupState(world({ routes: { "label list -R acme/widgets --json name --limit 200": bad } }).deps)).labels;
  assert.equal(err.done, false);
});

test("main-ruleset: absent, inactive and an API error are not done", () => {
  const key = "api repos/acme/widgets/rulesets";
  assert.equal(byName(setupState(world({ routes: { [key]: ok([]) } }).deps))["main-ruleset"].done, false);
  const inactive = byName(setupState(world({ routes: { [key]: ok([{ id: 7, name: "main (lanes)", enforcement: "disabled" }]) } }).deps))["main-ruleset"];
  assert.equal(inactive.done, false);
  assert.match(inactive.fix.command, /setup-repo\.mjs/);
  const err = byName(setupState(world({ routes: { [key]: bad } }).deps))["main-ruleset"];
  assert.equal(err.done, false);
  assert.match(err.reason, /could not be read/);
});

test("identity: missing or malformed identity.app in lanes.config.json is not done", () => {
  const none = byName(setupState(world({ files: { "lanes.config.json": "{}" } }).deps));
  assert.equal(none.identity.done, false);
  assert.match(none.identity.fix.command, /app-setup\.mjs/);
  const broken = byName(setupState(world({ files: { "lanes.config.json": "{nope" } }).deps));
  assert.equal(broken.identity.done, false);
  assert.match(broken.identity.reason, /could not be read/);
  assert.equal(none["app-key"].done, false);
  assert.equal(none["app-installed"].done, false);
});

test("app-key: ~/.lanes/<slug>.pem missing is not done and its contents are never read", () => {
  const w = world({ goneHome: [".lanes/widgets-lanes.pem"] });
  const i = byName(setupState(w.deps))["app-key"];
  assert.equal(i.done, false);
  assert.match(i.fix.command, /app-setup\.mjs/);
  const reads = [];
  const w2 = world();
  const deps = { ...w2.deps, read: (p) => (reads.push(p), w2.deps.read(p)) };
  setupState(deps);
  assert.ok(!reads.some((p) => p.endsWith(".pem")));
});

test("app-installed, codeowners and code-owner-ruleset reuse repoChecks: missing and API error", () => {
  const missing = byName(setupState(world({ routes: { "api user/installations/42/repositories?per_page=100": ok({ repositories: [] }) }, gone: [".github/CODEOWNERS"], files: {} }).deps));
  assert.equal(missing["app-installed"].done, false);
  assert.match(missing["app-installed"].fix.link, /apps\/widgets-lanes\/installations\/new/);
  assert.equal(missing.codeowners.done, false);
  assert.match(missing.codeowners.fix.link, /acme\/widgets\/new\/main/);
  const err = byName(setupState(world({ routes: { "api user/installations": bad, "api repos/acme/widgets/rulesets": bad } }).deps));
  assert.equal(err["app-installed"].done, false);
  assert.match(err["app-installed"].reason, /could not be checked/);
  assert.equal(err["code-owner-ruleset"].done, false);
  const noOwnerReview = byName(setupState(world({ routes: { "api repos/acme/widgets/rulesets/7": ok({ enforcement: "active", rules: [{ type: "pull_request", parameters: { require_code_owner_review: false } }] }) } }).deps));
  assert.equal(noOwnerReview["code-owner-ruleset"].done, false);
  assert.match(noOwnerReview["code-owner-ruleset"].fix.link, /settings\/rules/);
});

test("workflows-environment: each of reviewer, main-only policy and the secret is required", () => {
  const env = "api repos/acme/widgets/environments/lanes-workflow-apply";
  const cases = {
    "no environment": { [env]: bad },
    "no required reviewer": { [env]: ok({ protection_rules: [], deployment_branch_policy: { custom_branch_policies: true } }) },
    "all branches": { [env]: ok({ protection_rules: [{ type: "required_reviewers", reviewers: [{}] }], deployment_branch_policy: null }) },
    "policy beyond main": { [`${env}/deployment-branch-policies`]: ok({ branch_policies: [{ name: "main" }, { name: "dev" }] }) },
    "policy list unreadable": { [`${env}/deployment-branch-policies`]: bad },
    "no key secret": { [`${env}/secrets`]: ok({ secrets: [] }) },
    "secret list unreadable": { [`${env}/secrets`]: bad },
  };
  for (const [label, routes] of Object.entries(cases)) {
    const i = byName(setupState(world({ routes }).deps))["workflows-environment"];
    assert.equal(i.done, false, label);
    assert.ok(i.reason.length > 0, label);
    assert.match(i.fix.command, /app-setup\.mjs --workflows/, label);
    assert.match(i.fix.link, /settings\/environments/, label);
  }
});

test("verify-job: a workflow job named verify is done; none, an unreadable folder and a key-only name are not", () => {
  const w = world({ files: { ".github/workflows/ci.yml": "jobs:\n  verify:\n    name: Tests\n" } });
  assert.equal(byName(setupState(w.deps))["verify-job"].done, true);
  const byDisplayName = world({ files: { ".github/workflows/verify.yml": "jobs:\n  build:\n    name: verify\n" } });
  assert.equal(byName(setupState(byDisplayName.deps))["verify-job"].done, true);
  const none = world({ files: { ".github/workflows/verify.yml": "jobs:\n  test:\n    runs-on: x\n" } });
  const i = byName(setupState(none.deps))["verify-job"];
  assert.equal(i.done, false);
  assert.ok(i.fix.link || i.fix.command);
  const unreadable = byName(setupState({ ...world().deps, list: () => { throw new Error("ENOENT"); } }))["verify-job"];
  assert.equal(unreadable.done, false);
  assert.match(unreadable.reason, /could not be read/);
});

test("edge: a thrown run is not done and carries no error text", () => {
  const w = world();
  const items = setupState({ ...w.deps, run: () => { throw new Error("TOKEN-ghp_x"); } });
  for (const name of ["secret", "labels", "main-ruleset", "app-installed", "workflows-environment"]) {
    const i = byName(items)[name];
    assert.equal(i.done, false, name);
    assert.doesNotMatch(JSON.stringify(i), /TOKEN-ghp_x/);
  }
});

test("no write: every gh call is a GET api call or a list, with no -X, -f, -F or --input", () => {
  const scenarios = [world(), world({ routes: { "api user/installations": bad } }), world({ files: { "lanes.config.json": "{}" }, gone: ["lanes.lock.json"] })];
  for (const w of scenarios) {
    setupState(w.deps);
    assert.ok(w.calls.length > 0);
    for (const [cmd, sub, ...rest] of w.calls) {
      assert.equal(cmd, "gh");
      assert.ok((sub === "api" && !rest.some((a) => /^(-X|--method|-f|-F|--field|--raw-field|--input)/.test(a))) || ((sub === "secret" || sub === "label") && rest[0] === "list"), `${sub} ${rest.join(" ")}`);
    }
  }
});

test("output holds no key, token or secret value", () => {
  const w = world({ routes: { "secret list -R acme/widgets --json name": ok([{ name: "PII_PATTERNS", value: "TOPSECRET" }]) } });
  assert.doesNotMatch(formatSetupState(setupState(w.deps)), /TOPSECRET|BEGIN .*PRIVATE/);
});

test("formatSetupState prints one done or missing line per item, with its fix", () => {
  const out = formatSetupState([{ name: "a", done: true, reason: "x" }, { name: "b", done: false, reason: "why", fix: { link: "https://l", command: "do it" } }]).split("\n");
  assert.equal(out[0], "a: done");
  assert.equal(out[1], "b: missing: why; open https://l; run: do it");
  assert.equal(out.length, 2);
});

test("setupStateMain exits 0 when all done and 1 otherwise, 2 on bad usage", () => {
  const lines = [];
  const w = world();
  const dep = (extra = {}) => ({ ...w.deps, print: (l) => lines.push(l), ...extra });
  assert.equal(setupStateMain([TARGET], dep()), 0);
  assert.equal(lines.join("\n").split("\n").length, 11);
  assert.equal(setupStateMain([TARGET], dep({ exists: () => false })), 1);
  assert.equal(setupStateMain([], dep()), 2);
  assert.equal(setupStateMain(["a", "b"], dep()), 2);
});

test("setupStateMain with no repo gh can read exits 1 with a reason, not a crash", () => {
  const lines = [];
  const w = world();
  const code = setupStateMain([TARGET], { ...w.deps, repo: undefined, run: () => bad, print: (l) => lines.push(l) });
  assert.equal(code, 1);
  assert.match(lines.join("\n"), /repository/);
});
