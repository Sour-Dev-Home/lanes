import { test } from "node:test";
import assert from "node:assert/strict";
import { join, relative, resolve } from "node:path";
import { parseOwnerPatterns } from "./lib.mjs";
import { initMain, parseArgs } from "./init.mjs";

const NAMES = ["installed", "secret", "labels", "main-ruleset", "identity", "app-key", "app-installed", "codeowners", "code-owner-ruleset", "workflows-environment", "verify-job"];
const FIX = { link: "https://github.com/acme/widgets/settings" };

/** A state where each listed name is missing and the rest done. */
const itemsMissing = (...missing) => NAMES.map((name) => (missing.includes(name) ? { name, done: false, reason: `${name} is missing`, fix: FIX } : { name, done: true, reason: "ok" }));

/**
 * A fake world. `states` is the list of states the successive `state()` calls return (the last repeats);
 * `onRun` may return a result for a command, or a function to mutate what comes next.
 */
const SOURCE_APP_ID = 5140388;
const LANES_CONFIG = JSON.stringify({ requiredChecks: ["verify"], identity: { profile: "team", app: { id: SOURCE_APP_ID } } });
const SET_UP_PACKAGE = JSON.stringify({ name: "widgets", scripts: { test: "x", setup: "mine", preflight: "mine" } });

const TARGET = resolve("../widgets");

/** An in-memory disk: initial target files by repo-relative path, plus the lanes clone's config (a set-up repository unless `fs` says otherwise). */
function memoryFiles(initial) {
  const map = new Map([[join("root", "lanes.config.json"), LANES_CONFIG], ...Object.entries(initial).map(([rel, text]) => [join(TARGET, rel), text])]);
  const writes = [];
  return {
    map,
    writes,
    read: (abs) => map.get(abs),
    write: (abs, content) => {
      writes.push(relative(TARGET, abs).replaceAll("\\", "/"));
      map.set(abs, content);
    },
  };
}
const targetFile = (w, rel) => w.files.map.get(join(TARGET, rel));
const SET_UP_FILES = { ".github/CODEOWNERS": "/CLAUDE.md @acme\n", "package.json": SET_UP_PACKAGE, "lanes.config.json": '{"requiredChecks":["verify"]}' };

function world({ states, runResults = {}, answers = ["done"], owner = "acme", repo = "acme/widgets", exists = () => true, fs = SET_UP_FILES, login = "acme" } = {}) {
  const calls = [];
  const out = [];
  let n = 0;
  const asked = [];
  const files = memoryFiles(fs);
  let repoReads = 0;
  const deps = {
    lanesRoot: "root",
    exists,
    readFile: files.read,
    writeFile: files.write,
    loginOf: () => login,
    print: (s) => out.push(s),
    repoOf: () => {
      repoReads++;
      return repo;
    },
    ownerOf: () => owner,
    state: () => states[Math.min(n++, states.length - 1)],
    run: (cmd, args, { cwd }) => {
      calls.push({ cmd, script: args[0] && args[0].split(/[\\/]/).pop(), args, cwd });
      const key = args[0].split(/[\\/]/).pop() + (args.includes("--workflows") ? " --workflows" : "");
      return runResults[key] ?? { status: 0 };
    },
    ask: async (q) => {
      asked.push(q);
      return answers.shift() ?? "";
    },
  };
  return { deps, calls, out, asked, files, repoReads: () => repoReads, text: () => out.join("\n") };
}

const scripts = (w) => w.calls.map((c) => c.script + (c.args.includes("--workflows") ? " --workflows" : ""));

test("parseArgs: a path, or --new with its options", () => {
  assert.equal(parseArgs(["../repo"]).path, "../repo");
  const o = parseArgs(["--new", "widgets", "--private", "--license", "mit", "--org", "acme", "--dry-run"]);
  assert.deepEqual([o.name, o.isPrivate, o.license, o.org, o.dryRun], ["widgets", true, "mit", "acme", true]);
});

test("edge: parseArgs rejects bad usage", () => {
  assert.throws(() => parseArgs([]), /usage/);
  assert.throws(() => parseArgs(["a", "b"]), /usage/);
  assert.throws(() => parseArgs(["a", "--new", "b"]), /usage/);
  assert.throws(() => parseArgs(["--new"]), /invalid repository name/);
  assert.throws(() => parseArgs(["--new", ".."]), /invalid repository name/);
  assert.throws(() => parseArgs(["--new", "--private"]), /invalid repository name/);
  assert.throws(() => parseArgs(["--new", "-x"]), /invalid repository name/);
  assert.throws(() => parseArgs(["--new", "x", "--license", "gpl"]), /only mit/);
  assert.throws(() => parseArgs(["--new", "x", "--org", "a b"]), /invalid --org/);
  assert.throws(() => parseArgs(["--new", "x", "--bogus"]), /unknown option/);
  assert.throws(() => parseArgs(["../repo", "--private"]), /go with --new/);
});

test("edge: bad usage exits 2 and runs nothing", async () => {
  const w = world({ states: [itemsMissing()] });
  assert.equal(await initMain([], w.deps), 2);
  assert.equal(w.calls.length, 0);
});

test("a fresh existing repository runs every step in order and ends with the checklist", async () => {
  const w = world({
    states: [
      itemsMissing("installed", "secret", "labels", "main-ruleset", "identity", "app-key", "app-installed", "codeowners", "code-owner-ruleset", "workflows-environment", "verify-job"), // initial
      itemsMissing("secret", "labels", "main-ruleset", "identity", "app-key", "app-installed", "codeowners", "code-owner-ruleset", "workflows-environment", "verify-job"), // after install
      itemsMissing("labels", "main-ruleset", "identity", "app-key", "app-installed", "codeowners", "code-owner-ruleset", "workflows-environment", "verify-job"), // after the secret
      itemsMissing("identity", "app-key", "app-installed", "codeowners", "code-owner-ruleset", "workflows-environment", "verify-job"), // after setup-repo
      itemsMissing("codeowners", "code-owner-ruleset", "workflows-environment", "verify-job"), // after app-setup
      itemsMissing("codeowners", "code-owner-ruleset"), // final
    ],
  });
  const code = await initMain(["../widgets"], w.deps);
  assert.equal(code, 1);
  assert.deepEqual(scripts(w), ["install.mjs", "setup-repo.mjs", "app-setup.mjs", "app-setup.mjs --workflows"]);
  assert.equal(w.calls[0].cwd, "root");
  assert.ok(w.calls[0].args[1].endsWith("widgets"));
  assert.deepEqual(w.calls.slice(1).map((c) => c.cwd).filter((c, i, a) => a.indexOf(c) === i).length, 1);
  assert.deepEqual(w.calls[1].args, [join("scripts", "lanes", "setup-repo.mjs"), "acme/widgets"]);
  assert.match(w.text(), /gh secret set PII_PATTERNS -R acme\/widgets/);
  assert.match(w.text(), /codeowners: codeowners is missing/);
  assert.match(w.text(), /What is left \(2\)/);
  assert.match(w.text(), /open https:\/\/github\.com\/acme\/widgets\/settings/);
});

// #747: an existing repository gets CODEOWNERS and the npm scripts before setup-repo, and a copied lanes config stops init.
const FRESH_FILES = { "package.json": JSON.stringify({ name: "widgets", scripts: { test: "x" } }), "lanes.config.json": '{"requiredChecks":["verify"]}' };
const freshStates = () => [
  itemsMissing("secret", "labels", "main-ruleset", "identity", "app-key", "app-installed", "codeowners", "code-owner-ruleset", "workflows-environment"),
  itemsMissing("labels", "main-ruleset", "identity", "app-key", "app-installed", "codeowners", "code-owner-ruleset", "workflows-environment"),
  itemsMissing("identity", "app-key", "app-installed", "codeowners", "code-owner-ruleset", "workflows-environment"),
  itemsMissing("codeowners", "code-owner-ruleset", "workflows-environment"),
  itemsMissing("codeowners", "code-owner-ruleset"),
];

test("#747: a repository with no CODEOWNERS and no npm scripts gets both before setup-repo, and the checklist says to commit them", async () => {
  const w = world({ states: freshStates(), fs: FRESH_FILES, login: "octo" });
  assert.equal(await initMain(["../widgets"], w.deps), 1);
  assert.deepEqual(w.files.writes, [".github/CODEOWNERS", "package.json"]);
  const owners = targetFile(w, ".github/CODEOWNERS");
  assert.doesNotThrow(() => parseOwnerPatterns(owners));
  const patterns = parseOwnerPatterns(owners).map((p) => p.pattern);
  for (const p of ["/.github/", "/.claude/", "/scripts/lanes/", "/lanes.config.json", "/lanes.lock.json", "/CLAUDE.md", "/package.json", "/package-lock.json"]) assert.ok(patterns.includes(p), p);
  assert.ok(owners.split("\n").filter((l) => l && !l.startsWith("#")).every((l) => l.endsWith(" @octo")));
  const pkg = JSON.parse(targetFile(w, "package.json"));
  assert.equal(pkg.scripts.setup, "git config core.hooksPath .githooks");
  assert.equal(pkg.scripts.preflight, "node scripts/preflight.mjs");
  assert.equal(pkg.scripts.test, "x");
  assert.match(w.text(), /CODEOWNERS.*owner should review and commit it/i);
  assert.match(w.text(), /commit these files:[\s\S]*\.github\/CODEOWNERS[\s\S]*package\.json/);
});

test("#747: CODEOWNERS and package.json are written before setup-repo runs", async () => {
  const w = world({ states: freshStates(), fs: FRESH_FILES });
  let writesAtSetupRepo;
  const run = w.deps.run;
  w.deps.run = (cmd, args, o) => {
    if (args[0].endsWith("setup-repo.mjs")) writesAtSetupRepo = [...w.files.writes];
    return run(cmd, args, o);
  };
  await initMain(["../widgets"], w.deps);
  assert.deepEqual(writesAtSetupRepo, [".github/CODEOWNERS", "package.json"]);
});

test("#747: an existing CODEOWNERS and existing npm scripts are never replaced, and nothing is listed to commit", async () => {
  const w = world({ states: freshStates() });
  await initMain(["../widgets"], w.deps);
  assert.deepEqual(w.files.writes, []);
  assert.equal(targetFile(w, "package.json"), SET_UP_PACKAGE);
  assert.doesNotMatch(w.text(), /commit these files/);
});

test("edge: only the missing npm script is added, and the package.json indent is kept", async () => {
  const pkg = `${JSON.stringify({ name: "w", scripts: { setup: "mine" } }, null, 4)}\n`;
  const w = world({ states: freshStates(), fs: { ...SET_UP_FILES, "package.json": pkg } });
  await initMain(["../widgets"], w.deps);
  const out = targetFile(w, "package.json");
  assert.equal(JSON.parse(out).scripts.setup, "mine");
  assert.equal(JSON.parse(out).scripts.preflight, "node scripts/preflight.mjs");
  assert.match(out, /\n {4}"name"/);
});

test("edge: a target with no package.json, or an unreadable one, is left alone and says so", async () => {
  for (const bad of [undefined, "{nope"]) {
    const fs = { ".github/CODEOWNERS": "/CLAUDE.md @acme\n", "lanes.config.json": '{"requiredChecks":["verify"]}' };
    if (bad !== undefined) fs["package.json"] = bad;
    const w = world({ states: freshStates(), fs });
    await initMain(["../widgets"], w.deps);
    assert.deepEqual(w.files.writes, []);
    assert.match(w.text(), /package\.json/);
  }
});

test("edge: when the gh user cannot be read, init stops before writing or running anything", async () => {
  for (const login of [null, "", "bad login;rm"]) {
    const w = world({ states: freshStates(), fs: FRESH_FILES, login });
    assert.equal(await initMain(["../widgets"], w.deps), 1);
    assert.deepEqual(w.files.writes, []);
    assert.deepEqual(w.calls.filter((c) => c.script !== "install.mjs"), []);
    assert.match(w.text(), /gh auth login/);
  }
});

test("#747: a target holding lanes' own config stops init before any GitHub step and changes nothing", async () => {
  const copied = JSON.stringify({ identity: { profile: "team", app: { id: SOURCE_APP_ID } }, modules: {} });
  const w = world({ states: freshStates(), fs: { ...FRESH_FILES, "lanes.config.json": copied } });
  assert.equal(await initMain(["../widgets"], w.deps), 1);
  assert.equal(w.repoReads(), 0);
  assert.equal(w.calls.length, 0);
  assert.equal(w.asked.length, 0);
  assert.deepEqual(w.files.writes, []);
  assert.match(w.text(), /lanes\.config\.json/);
  assert.match(w.text(), /delete it/i);
  assert.match(w.text(), /starter/i);
});

test("edge: a config with another App id, no identity or unparseable JSON does not trigger the copied-config stop", async () => {
  for (const cfg of [JSON.stringify({ identity: { app: { id: 1 } } }), "{}", "{nope"]) {
    const w = world({ states: freshStates(), fs: { ...SET_UP_FILES, "lanes.config.json": cfg } });
    await initMain(["../widgets"], w.deps);
    assert.ok(w.calls.length > 0, cfg);
  }
});

test("a fully set-up repository runs no step and prints the all-done checklist", async () => {
  const w = world({ states: [itemsMissing()] });
  assert.equal(await initMain(["../widgets"], w.deps), 0);
  assert.equal(w.calls.length, 0);
  assert.equal(w.asked.length, 0);
  assert.match(w.text(), /All done/);
  assert.match(w.text(), /installed: done/);
});

test("a partial state runs only the missing steps", async () => {
  const w = world({ states: [itemsMissing("labels", "main-ruleset", "workflows-environment"), itemsMissing("workflows-environment"), itemsMissing()] });
  assert.equal(await initMain(["../widgets"], w.deps), 0);
  assert.deepEqual(scripts(w), ["setup-repo.mjs", "app-setup.mjs --workflows"]);
  assert.equal(w.asked.length, 0);
});

test("edge: one missing label alone still runs setup-repo, and a lone missing ruleset too", async () => {
  for (const name of ["labels", "main-ruleset"]) {
    const w = world({ states: [itemsMissing(name), itemsMissing()] });
    assert.equal(await initMain(["../widgets"], w.deps), 0);
    assert.deepEqual(scripts(w), ["setup-repo.mjs"]);
  }
});

test("--new runs new-project with its flags, then continues from the state", async () => {
  const w = world({ states: [itemsMissing("identity", "app-key", "app-installed", "codeowners", "code-owner-ruleset", "workflows-environment"), itemsMissing("codeowners", "code-owner-ruleset", "workflows-environment"), itemsMissing("codeowners", "code-owner-ruleset")], exists: () => false });
  const code = await initMain(["--new", "widgets", "--private", "--license", "mit"], w.deps);
  assert.equal(code, 1);
  assert.deepEqual(scripts(w), ["new-project.mjs", "app-setup.mjs", "app-setup.mjs --workflows"]);
  assert.deepEqual(w.calls[0].args, [join("scripts", "lanes", "new-project.mjs"), "widgets", "--private", "--license", "mit"]);
  assert.equal(w.calls[0].cwd, "root");
});

test("--new skips new-project when the project is already installed", async () => {
  const w = world({ states: [itemsMissing()], exists: () => true });
  assert.equal(await initMain(["--new", "widgets"], w.deps), 0);
  assert.equal(w.calls.length, 0);
});

test("edge: --new with an --org that is not the lanes owner is refused before any step", async () => {
  const w = world({ states: [itemsMissing()], exists: () => false });
  assert.equal(await initMain(["--new", "widgets", "--org", "other"], w.deps), 2);
  assert.equal(w.calls.length, 0);
  assert.match(w.text(), /under acme/);
});

test("the secret wait: runs on 'done' once the secret is there; stops on anything else", async () => {
  const ok = world({ states: [itemsMissing("secret"), itemsMissing()] });
  assert.equal(await initMain(["../widgets"], ok.deps), 0);
  assert.equal(ok.asked.length, 1);

  const no = world({ states: [itemsMissing("secret", "labels")], answers: ["later"] });
  assert.equal(await initMain(["../widgets"], no.deps), 1);
  assert.equal(no.calls.length, 0);
  assert.match(no.text(), /not confirmed/);
});

test("edge: 'done' but the secret is still missing stops before setup-repo", async () => {
  const w = world({ states: [itemsMissing("secret", "labels"), itemsMissing("secret", "labels")] });
  assert.equal(await initMain(["../widgets"], w.deps), 1);
  assert.equal(w.calls.length, 0);
  assert.match(w.text(), /still has no PII_PATTERNS/);
});

test("identity present but the key missing stops with the fix and never runs app-setup", async () => {
  const w = world({ states: [itemsMissing("app-key", "workflows-environment")] });
  assert.equal(await initMain(["../widgets"], w.deps), 1);
  assert.equal(w.calls.length, 0);
  assert.match(w.text(), /will not create a second one/);
  assert.match(w.text(), /app-key: app-key is missing/);
});

test("identity present but the App not installed stops with the install link, no app-setup", async () => {
  const w = world({ states: [itemsMissing("app-installed")] });
  assert.equal(await initMain(["../widgets"], w.deps), 1);
  assert.equal(w.calls.length, 0);
  assert.match(w.text(), /open https:\/\/github\.com\/acme\/widgets\/settings/);
});

test("a failing step stops init, names the step and its output, and later steps do not run", async () => {
  const w = world({ states: [itemsMissing("labels", "identity", "workflows-environment")], runResults: { "setup-repo.mjs": { status: 3, output: "boom: no access" } } });
  assert.equal(await initMain(["../widgets"], w.deps), 1);
  assert.deepEqual(scripts(w), ["setup-repo.mjs"]);
  assert.match(w.text(), /setup-repo\.mjs failed \(exit 3\)/);
  assert.match(w.text(), /boom: no access/);
});

test("edge: a runner that throws is a failed step, not a crash", async () => {
  const w = world({ states: [itemsMissing("installed")] });
  w.deps.run = () => {
    throw new Error("spawn node ENOENT");
  };
  assert.equal(await initMain(["../widgets"], w.deps), 1);
  assert.match(w.text(), /install\.mjs failed/);
  assert.match(w.text(), /ENOENT/);
});

test("edge: --new with an unreadable owner runs no step", async () => {
  const w = world({ states: [itemsMissing()], owner: null, exists: () => false });
  assert.equal(await initMain(["--new", "widgets"], w.deps), 1);
  assert.equal(w.calls.length, 0);
  assert.match(w.text(), /owner could not be read/);
});

test("edge: app-setup finishing without identity.app stops instead of continuing", async () => {
  const w = world({ states: [itemsMissing("identity", "app-key", "app-installed"), itemsMissing("identity", "app-key", "app-installed")] });
  assert.equal(await initMain(["../widgets"], w.deps), 1);
  assert.deepEqual(scripts(w), ["app-setup.mjs"]);
  assert.match(w.text(), /identity\.app is still missing/);
});

test("edge: the repository cannot be read", async () => {
  const w = world({ states: [itemsMissing()], repo: null });
  assert.equal(await initMain(["../widgets"], w.deps), 1);
  assert.equal(w.calls.length, 0);
});

test("--dry-run prints every step and calls no runner, state, repo lookup or prompt", async () => {
  const w = world({ states: [itemsMissing()] });
  for (const k of ["run", "state", "repoOf", "ownerOf", "ask"]) w.deps[k] = () => assert.fail(`${k} was called`);
  assert.equal(await initMain(["../widgets", "--dry-run"], w.deps), 0);
  assert.match(w.text(), /1\. .*install\.mjs/);
  assert.match(w.text(), /7\. a final setup-state checklist/);
  assert.equal(await initMain(["--new", "widgets", "--private", "--dry-run"], w.deps), 0);
  assert.match(w.text(), /new-project\.mjs widgets --private/);
});
