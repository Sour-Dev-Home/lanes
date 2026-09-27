import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { MANIFEST } from "./install.mjs";
import {
  parseArgs,
  privateBlockers,
  licenseHolder,
  mitLicense,
  starterConfig,
  starterPackageJson,
  hasVerifyTriggers,
  planProject,
  runPlan,
  shellWord,
  SECRET_NAME,
} from "./new-project.mjs";

const HOLDER = "Example Holder";
const lanesRoot = path.resolve("fixture-root", "lanes");
const files = {
  verifyYml: readFileSync(".github/workflows/verify.yml", "utf8"),
  lanesConfig: JSON.parse(readFileSync("lanes.config.json", "utf8")),
  lanesLicense: `MIT License\n\nCopyright (c) 2025 ${HOLDER}\n\nPermission is hereby granted...\n`,
};
const plan = (over = {}) => planProject({ name: "demo", org: "acme", isPrivate: false, lanesRoot, files, year: 2026, ...over });
const idx = (steps, pred) => steps.findIndex(pred);
const isRun = (cmd, ...prefix) => (s) => s.kind === "run" && s.cmd === cmd && prefix.every((p, i) => s.args[i] === p);

// Criterion 1: create the org repo, clone next to lanes, install the template, starter config, verify.yml, npm scripts
test("parseArgs reads the name and flags, public and MIT by default", () => {
  assert.deepEqual(parseArgs(["demo"]), { name: "demo", isPrivate: false, license: "mit", dryRun: false });
  assert.deepEqual(parseArgs(["demo", "--private", "--license", "mit", "--dry-run"]), { name: "demo", isPrivate: true, license: "mit", dryRun: true });
  assert.throws(() => parseArgs([]), /usage/);
  assert.throws(() => parseArgs(["bad/name"]), /name/);
  assert.throws(() => parseArgs(["demo", "--license", "gpl"]), /license/);
  assert.throws(() => parseArgs(["demo", "--license"]), /license/);
  assert.throws(() => parseArgs(["demo", "--force"]), /unknown/);
});

test("the plan creates a public org repo by default and a private one with --private", () => {
  const pub = plan().find(isRun("gh", "repo", "create"));
  assert.deepEqual(pub.args.slice(0, 4), ["repo", "create", "acme/demo", "--public"]);
  const priv = plan({ isPrivate: true }).find(isRun("gh", "repo", "create"));
  assert.ok(priv.args.includes("--private") && !priv.args.includes("--public"));
});

test("--private is refused unless the org has Enterprise Cloud (merge queue) and Advanced Security (CodeQL)", () => {
  assert.equal(privateBlockers({ type: "Organization", plan: { name: "enterprise" }, advanced_security_enabled_for_new_repositories: true }).length, 0);
  assert.equal(privateBlockers({ type: "Organization", plan: { name: "free" }, advanced_security_enabled_for_new_repositories: true }).length, 1);
  assert.equal(privateBlockers({ type: "Organization", plan: { name: "enterprise" } }).length, 1);
  // unknown (the plan is only visible to org owners) counts as missing: fail closed
  assert.equal(privateBlockers({ type: "Organization" }).length, 2);
  assert.ok(privateBlockers(null).length > 0);
});

test("the repo is cloned next to lanes and the template installed into it", () => {
  const steps = plan();
  const target = path.resolve(lanesRoot, "..", "demo");
  const clone = steps.find(isRun("gh", "repo", "clone"));
  assert.deepEqual(clone.args, ["repo", "clone", "acme/demo", target]);
  const install = steps.find((s) => s.kind === "install");
  assert.deepEqual([install.source, install.target], [lanesRoot, target]);
  assert.ok(idx(steps, (s) => s === clone) < idx(steps, (s) => s === install));
});

test("the template manifest includes the skills and the vendored agent-skills", () => {
  for (const f of [".claude/skills/test-driven-development/SKILL.md", ".claude/skills/incremental-implementation/SKILL.md", "vendor/agent-skills/VENDORED.md", "vendor/agent-skills/LICENSE", "vendor/agent-skills/references/definition-of-done.md", ".gitignore", ".gitattributes"]) {
    assert.ok(MANIFEST.includes(f), f);
  }
});

test("the plan writes a starter lanes.config.json, verify.yml and package.json with the npm scripts", () => {
  const writes = Object.fromEntries(plan().filter((s) => s.kind === "write").map((s) => [s.file, s.content]));
  const config = JSON.parse(writes["lanes.config.json"]);
  assert.deepEqual(config.requiredChecks, ["verify", "security", "lanes/gate"]);
  assert.equal(config.metrics.mainWorkflow, "verify.yml");
  assert.ok(hasVerifyTriggers(writes[".github/workflows/verify.yml"]));
  const pkg = JSON.parse(writes["package.json"]);
  assert.equal(pkg.name, "demo");
  for (const s of ["test", "setup", "preflight", "status"]) assert.ok(pkg.scripts[s], s);
  assert.equal(pkg.scripts.setup, "git config core.hooksPath .githooks");
});

test("starterConfig keeps the gate's checks and paths; starterPackageJson is private ESM", () => {
  const c = starterConfig(files.lanesConfig);
  assert.deepEqual(c.paths, files.lanesConfig.paths);
  assert.equal(c.metrics.fragmentsDir, null);
  const pkg = starterPackageJson("demo");
  assert.equal(pkg.type, "module");
  assert.equal(pkg.private, true);
});

test("hasVerifyTriggers requires pull_request, merge_group and push to main, and a job named verify", () => {
  assert.ok(hasVerifyTriggers(files.verifyYml));
  assert.equal(hasVerifyTriggers(files.verifyYml.replace("merge_group:", "")), false);
  assert.equal(hasVerifyTriggers(files.verifyYml.replace(/push:\s*\n\s*branches: \[main\]/, "")), false);
  assert.equal(hasVerifyTriggers(files.verifyYml.replace("  verify:", "  build:")), false);
  assert.throws(() => plan({ files: { ...files, verifyYml: "on: push" } }), /verify\.yml/);
});

// Criterion 2: LICENSE (MIT by default), holder from the lanes LICENSE, never printed
test("licenseHolder reads the copyright holder and never echoes the file on failure", () => {
  assert.equal(licenseHolder(files.lanesLicense), HOLDER);
  assert.equal(licenseHolder("Copyright (c) 2024-2026 Some One\n"), "Some One");
  assert.throws(() => licenseHolder("secret text without a line"), (e) => !e.message.includes("secret text"));
});

test("the LICENSE step writes MIT with the holder and this year, but its description omits the holder", () => {
  assert.match(mitLicense(2026, HOLDER), /^MIT License\n\nCopyright \(c\) 2026 Example Holder\n/);
  const lic = plan().find((s) => s.kind === "write" && s.file === "LICENSE");
  assert.ok(lic.content.includes(HOLDER));
  assert.ok(!lic.say.includes(HOLDER));
  for (const s of plan()) assert.ok(!s.say.includes(HOLDER), s.say);
});

// Criterion 3: npm run setup, one commit (signing left to git config), push main before any ruleset
test("setup runs, then exactly one commit without overriding signing, then push, all before setup-repo", () => {
  const steps = plan();
  const setup = idx(steps, isRun("npm", "run", "setup"));
  const commits = steps.filter(isRun("git", "commit"));
  const commit = idx(steps, isRun("git", "commit"));
  const push = idx(steps, isRun("git", "push"));
  const setupRepo = idx(steps, (s) => s.kind === "run" && s.args.some((a) => a.endsWith("setup-repo.mjs")));
  assert.equal(commits.length, 1);
  for (const a of commits[0].args) assert.ok(!/gpg|no-verify|^-c$/.test(a), a);
  assert.deepEqual(steps[push].args, ["push", "-u", "origin", "main"]);
  assert.ok(setup >= 0 && setup < commit && commit < push && push < setupRepo);
  // nothing before the push touches rulesets
  for (const s of steps.slice(0, push)) assert.ok(!(s.args ?? []).some((a) => /rulesets|setup-repo/.test(a)), s.say);
});

// Criterion 4: pause with the exact secret command, continue with setup-repo only after the owner confirms
test("the plan pauses for the secret with the exact command, then checks it, then runs setup-repo", () => {
  const steps = plan();
  const pause = idx(steps, (s) => s.kind === "confirm");
  assert.equal(steps[pause].command, `gh secret set ${SECRET_NAME} -R acme/demo`);
  const check = idx(steps, (s) => s.kind === "check-secret");
  const setupRepo = idx(steps, (s) => s.kind === "run" && s.args.some((a) => a.endsWith("setup-repo.mjs")));
  assert.ok(pause < check && check < setupRepo);
  assert.deepEqual(steps[setupRepo].args.slice(-1), ["acme/demo"]);
  assert.equal(steps[setupRepo].cwd, path.resolve(lanesRoot, "..", "demo"));
});

function fakeEffects({ confirm = true, hasSecret = true } = {}) {
  const calls = [];
  return {
    calls,
    effects: {
      run: (s) => calls.push(["run", s.cmd, ...s.args]),
      install: (s) => calls.push(["install", s.target]),
      write: (s) => calls.push(["write", s.file]),
      confirm: async () => (calls.push(["confirm"]), confirm),
      hasSecret: () => (calls.push(["hasSecret"]), hasSecret),
      log: () => {},
    },
  };
}

test("runPlan stops before setup-repo when the owner does not confirm", async () => {
  const { calls, effects } = fakeEffects({ confirm: false });
  const r = await runPlan(plan(), { dryRun: false, effects });
  assert.equal(r.completed, false);
  assert.equal(calls.at(-1)[0], "confirm");
  assert.ok(!calls.some((c) => c.some((a) => String(a).endsWith("setup-repo.mjs"))));
});

test("runPlan stops before setup-repo when the secret is still missing after confirmation", async () => {
  const { calls, effects } = fakeEffects({ hasSecret: false });
  const r = await runPlan(plan(), { dryRun: false, effects });
  assert.equal(r.completed, false);
  assert.ok(!calls.some((c) => c.some((a) => String(a).endsWith("setup-repo.mjs"))));
});

test("runPlan runs every step, setup-repo last, when the owner confirms", async () => {
  const { calls, effects } = fakeEffects();
  const r = await runPlan(plan(), { dryRun: false, effects });
  assert.equal(r.completed, true);
  assert.ok(String(calls.at(-1).at(-2)).endsWith("setup-repo.mjs"));
});

// Criterion 5: --dry-run prints every step and changes nothing
test("a dry run prints every step and calls no effect", async () => {
  const { calls, effects } = fakeEffects();
  const lines = [];
  effects.log = (l) => lines.push(l);
  const steps = plan();
  const r = await runPlan(steps, { dryRun: true, effects });
  assert.deepEqual(calls, []);
  assert.equal(r.completed, true);
  for (const s of steps) assert.ok(lines.some((l) => l.includes(s.say)), s.say);
  assert.ok(!lines.join("\n").includes(HOLDER));
  // the exact secret command must be visible in the dry run output too, not just the step's short "say" summary
  assert.ok(lines.some((l) => l.includes(`gh secret set ${SECRET_NAME} -R acme/demo`)));
});

// Criterion 4 (printed output, not just step data): the owner actually sees the exact secret command on a real run
test("a real run logs the exact secret command before asking the owner to confirm", async () => {
  const { effects } = fakeEffects();
  const lines = [];
  effects.log = (l) => lines.push(l);
  const r = await runPlan(plan(), { dryRun: false, effects });
  assert.equal(r.completed, true);
  assert.ok(lines.some((l) => l.includes(`gh secret set ${SECRET_NAME} -R acme/demo`)));
});

// The Windows npm-shim path shells out; only plain words may reach it, or a future dynamic argument could inject.
test("shellWord passes plain words through and refuses shell metacharacters", () => {
  assert.equal(shellWord("run"), "run");
  assert.equal(shellWord("setup"), "setup");
  assert.throws(() => shellWord("run; rm -rf /"), /refusing/);
  assert.throws(() => shellWord("$(whoami)"), /refusing/);
  assert.throws(() => shellWord("a && b"), /refusing/);
});

// Criterion 6: docs/USING.md "Adopting it" leads with the one command
test("USING.md's Adopting section leads with new-project.mjs", () => {
  const doc = readFileSync("docs/USING.md", "utf8");
  const section = doc.slice(doc.indexOf("## Adopting it"));
  const firstCode = /`([^`]+)`/.exec(section.slice(section.indexOf("\n")))[1];
  assert.match(firstCode, /^node scripts\/lanes\/new-project\.mjs /);
});
