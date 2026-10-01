// scripts/lanes/identity-check.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { identityCheck } from "./identity-check.mjs";

const TOKEN = "ghs_FAKEfakeFAKEfakeFAKEfakeFAKEfake0123";
const OTHER = "gho_OWNERownerOWNERownerOWNERowner9876";
const LANE_DIR = "C:\\Users\\someone\\AppData\\Local\\Temp\\lanes-gh-552-nfIElz";
const TEAM = JSON.stringify({ identity: { profile: "team", app: { id: 1, installationId: 2, botLogin: "x[bot]" } } });

const authOk = [
  "github.com",
  `  ✓ Logged in to github.com account  (${LANE_DIR}\\hosts.yml)`,
  "  - Active account: true",
  "  - Git operations protocol: https",
  `  - Token: ghs_************`,
].join("\n");

/** A fake command runner: each `cmd args...` key maps to `{ stdout, stderr, status }` (status defaults to 0). */
function fakeRun(overrides = {}) {
  const table = {
    "gh auth status": { stdout: authOk },
    "gh auth token": { stdout: `${TOKEN}\n` },
    "git remote get-url --push origin": { stdout: "https://github.com/Owner/repo.git\n" },
    "git config --get-all credential.helper": { stdout: "\n!gh auth git-credential\n" },
    "git credential fill": { stdout: `protocol=https\nhost=github.com\nusername=x-access-token\npassword=${TOKEN}\n` },
    ...overrides,
  };
  const calls = [];
  const run = (cmd, args, opts = {}) => {
    const key = [cmd, ...args].join(" ");
    calls.push({ key, opts });
    const r = table[key];
    if (r === undefined) throw new Error(`unexpected command: ${key}`);
    if (r instanceof Error) throw r;
    return { stdout: "", stderr: "", status: 0, ...r };
  };
  return { run, calls };
}

const check = ({ config = TEAM, env = {}, run = fakeRun() } = {}) => {
  const result = identityCheck({ readConfig: () => config, run: run.run, env });
  return { ...result, parsed: JSON.parse(result.line), calls: run.calls };
};

const failed = (parsed) => Object.entries(parsed.checks ?? {}).filter(([, c]) => !c.pass).map(([k]) => k);

/** No secret text, from any fake, ever reaches the printed line. */
function assertNoSecret(line) {
  for (const s of [TOKEN, OTHER, "ghs_FAKE", "gho_OWNER", "oauth_token", "password=", "Users\\someone", "hunter2"]) {
    assert.ok(!line.includes(s), `output leaked ${s}: ${line}`);
  }
}

test("solo prints only the profile and exits 0, running no command", () => {
  const r = check({ config: JSON.stringify({ identity: { profile: "solo" } }) });
  assert.equal(r.code, 0);
  assert.equal(r.line, '{"profile":"solo"}');
  assert.equal(r.calls.length, 0);
});

test("a config without an identity key is solo", () => {
  const r = check({ config: "{}" });
  assert.equal(r.code, 0);
  assert.equal(r.line, '{"profile":"solo"}');
});

test("a passing team run prints one JSON line with every check passing", () => {
  const r = check();
  assert.equal(r.code, 0, r.line);
  assert.equal(r.line.split("\n").length, 1);
  assert.equal(r.parsed.profile, "team");
  assert.deepEqual(Object.keys(r.parsed.checks).sort(), ["credential", "env", "ghDir", "push"]);
  assert.deepEqual(failed(r.parsed), []);
  assert.match(r.parsed.checks.ghDir.reason, /lanes-gh-552-\*/);
  assert.match(r.parsed.checks.credential.reason, new RegExp(`length ${TOKEN.length}`));
  assertNoSecret(r.line);
});

test("credential fill is asked for https://github.com with no terminal prompt", () => {
  const r = check();
  const fill = r.calls.find((c) => c.key === "git credential fill");
  assert.equal(fill.opts.input, "protocol=https\nhost=github.com\n\n");
  assert.equal(fill.opts.env.GIT_TERMINAL_PROMPT, "0");
});

test("fails ghDir when gh auth status names the owner's own config", () => {
  const status = authOk.replace(`${LANE_DIR}\\hosts.yml`, "C:\\Users\\someone\\AppData\\Roaming\\GitHub CLI\\hosts.yml");
  const r = check({ run: fakeRun({ "gh auth status": { stdout: status } }) });
  assert.equal(r.code, 1);
  assert.deepEqual(failed(r.parsed), ["ghDir"]);
  assertNoSecret(r.line);
});

test("fails ghDir when the token comes from GH_TOKEN, even if a lane directory account is also listed", () => {
  const status = `${authOk}\n  ✓ Logged in to github.com account owner (GH_TOKEN)\n  - Active account: true`;
  const r = check({ run: fakeRun({ "gh auth status": { stdout: status } }) });
  assert.equal(r.code, 1);
  assert.ok(failed(r.parsed).includes("ghDir"));
});

test("fails ghDir when gh auth status exits non-zero (read from stderr like older gh)", () => {
  const r = check({ run: fakeRun({ "gh auth status": { stdout: "", stderr: authOk, status: 1 } }) });
  assert.equal(r.code, 1);
  assert.deepEqual(failed(r.parsed), ["ghDir"]);
});

test("edge: gh auth status with no account at all fails ghDir", () => {
  const r = check({ run: fakeRun({ "gh auth status": { stdout: "", stderr: "You are not logged into any GitHub hosts.", status: 1 } }) });
  assert.deepEqual(failed(r.parsed), ["ghDir"]);
});

test("edge: a lanes-gh name outside a hosts.yml token source does not count", () => {
  const status = "github.com\n  ✓ Logged in to github.com account lanes-gh-552-abc (keyring)\n";
  const r = check({ run: fakeRun({ "gh auth status": { stdout: status } }) });
  assert.deepEqual(failed(r.parsed), ["ghDir"]);
});

test("fails push for an ssh push URL", () => {
  const r = check({ run: fakeRun({ "git remote get-url --push origin": { stdout: "git@github.com:Owner/repo.git\n" } }) });
  assert.equal(r.code, 1);
  assert.deepEqual(failed(r.parsed), ["push"]);
  assert.ok(!r.line.includes("Owner/repo"), "the URL itself is never printed");
});

test("edge: fails push for an https URL that carries credentials, printing none of them", () => {
  const r = check({ run: fakeRun({ "git remote get-url --push origin": { stdout: `https://x:${OTHER}@github.com/Owner/repo.git\n` } }) });
  assert.deepEqual(failed(r.parsed), ["push"]);
  assertNoSecret(r.line);
});

test("edge: fails push when git remote errors (no origin)", () => {
  const r = check({ run: fakeRun({ "git remote get-url --push origin": { stdout: "", stderr: "error: No such remote 'origin'", status: 2 } }) });
  assert.deepEqual(failed(r.parsed), ["push"]);
});

test("fails credential when credential fill returns no password", () => {
  const r = check({ run: fakeRun({ "git credential fill": { stdout: "protocol=https\nhost=github.com\n" } }) });
  assert.equal(r.code, 1);
  assert.deepEqual(failed(r.parsed), ["credential"]);
});

test("fails credential when the password is not the lane's gh token, never printing either", () => {
  const r = check({ run: fakeRun({ "git credential fill": { stdout: `protocol=https\nhost=github.com\nusername=owner\npassword=${OTHER}\n` } }) });
  assert.deepEqual(failed(r.parsed), ["credential"]);
  assertNoSecret(r.line);
});

test("fails credential when another helper is configured besides gh auth git-credential", () => {
  const r = check({ run: fakeRun({ "git config --get-all credential.helper": { stdout: "manager\n!gh auth git-credential\n" } }) });
  assert.deepEqual(failed(r.parsed), ["credential"]);
});

test("edge: an empty helper value resets the list, so an earlier helper does not count", () => {
  const r = check({ run: fakeRun({ "git config --get-all credential.helper": { stdout: "manager\n\n!gh auth git-credential\n" } }) });
  assert.deepEqual(failed(r.parsed), []);
});

test("edge: a full path to gh is accepted as the helper; a shell-chained one is not", () => {
  const ok = check({ run: fakeRun({ "git config --get-all credential.helper": { stdout: '!"C:/Program Files/GitHub CLI/gh.exe" auth git-credential\n' } }) });
  assert.deepEqual(failed(ok.parsed), []);
  const chained = check({ run: fakeRun({ "git config --get-all credential.helper": { stdout: "!evil; gh auth git-credential\n" } }) });
  assert.deepEqual(failed(chained.parsed), ["credential"]);
});

test("edge: no credential helper at all fails credential", () => {
  const r = check({ run: fakeRun({ "git config --get-all credential.helper": { stdout: "", status: 1 } }) });
  assert.deepEqual(failed(r.parsed), ["credential"]);
});

test("edge: credential fill failing or throwing fails credential without leaking its stderr", () => {
  const r = check({ run: fakeRun({ "git credential fill": { stdout: "", stderr: `fatal: password=${OTHER}`, status: 128 } }) });
  assert.deepEqual(failed(r.parsed), ["credential"]);
  assertNoSecret(r.line);
  const thrown = check({ run: fakeRun({ "git credential fill": new Error(`spawn failed oauth_token: ${OTHER}`) }) });
  assert.deepEqual(failed(thrown.parsed), ["credential"]);
  assertNoSecret(thrown.line);
});

test("edge: gh auth token failing fails credential", () => {
  const r = check({ run: fakeRun({ "gh auth token": { stdout: "", stderr: "no oauth token", status: 1 } }) });
  assert.deepEqual(failed(r.parsed), ["credential"]);
});

test("fails env when GH_TOKEN or GITHUB_TOKEN is set, naming only the variable", () => {
  const r = check({ env: { GH_TOKEN: OTHER } });
  assert.equal(r.code, 1);
  assert.deepEqual(failed(r.parsed), ["env"]);
  assert.match(r.parsed.checks.env.reason, /GH_TOKEN/);
  assertNoSecret(r.line);
  const both = check({ env: { GITHUB_TOKEN: "hunter2", GH_TOKEN: "" } });
  assert.deepEqual(failed(both.parsed), ["env"]);
  assert.match(both.parsed.checks.env.reason, /GITHUB_TOKEN/);
  assert.doesNotMatch(both.parsed.checks.env.reason, /GH_TOKEN/);
  assertNoSecret(both.line);
});

test("edge: an empty GH_TOKEN counts as unset", () => {
  assert.deepEqual(failed(check({ env: { GH_TOKEN: "", GITHUB_TOKEN: "" } }).parsed), []);
});

test("every check failing at once still prints one line and exits 1", () => {
  const r = check({
    env: { GH_TOKEN: OTHER },
    run: fakeRun({
      "gh auth status": { stdout: "", stderr: `oauth_token: ${OTHER}`, status: 1 },
      "git remote get-url --push origin": { stdout: "git@github.com:o/r.git" },
      "git credential fill": { stdout: `password=${OTHER}\n` },
    }),
  });
  assert.equal(r.code, 1);
  assert.deepEqual(failed(r.parsed).sort(), ["credential", "env", "ghDir", "push"]);
  assertNoSecret(r.line);
});

test("edge: an unreadable or malformed config exits 1 with an error and runs nothing", () => {
  const missing = identityCheck({ readConfig: () => { throw new Error("ENOENT"); }, run: fakeRun().run, env: {} });
  assert.equal(missing.code, 1);
  assert.equal(JSON.parse(missing.line).profile, null);
  const bad = check({ config: "{not json" });
  assert.equal(bad.code, 1);
  const unknown = check({ config: JSON.stringify({ identity: { profile: "admin" } }) });
  assert.equal(unknown.code, 1);
  assert.equal(unknown.calls.length, 0);
});

const repoFile = (p) => readFileSync(fileURLToPath(new URL(`../../${p}`, import.meta.url)), "utf8");

test("criterion 2: .claude/settings.json allows exactly the identity-check command, no wider pattern", () => {
  const allow = JSON.parse(repoFile(".claude/settings.json")).permissions.allow;
  const matching = allow.filter((p) => p.includes("identity-check"));
  assert.deepEqual(matching, ["Bash(node scripts/lanes/identity-check.mjs)"]);
});

test("criterion 3: lane.md step 0 runs the one command, not the separate gh auth status and git remote", () => {
  const md = repoFile(".claude/commands/lane.md");
  const step0 = md.slice(md.indexOf("\n0. "), md.indexOf("\n1. "));
  assert.match(step0, /`node scripts\/lanes\/identity-check\.mjs`/);
  assert.doesNotMatch(step0, /`gh auth status`/);
  assert.doesNotMatch(step0, /git remote get-url/);
  assert.match(step0, /non-zero/);
  assert.match(step0, /PR body/);
  assert.match(step0, /mcp__/);
});

test("criterion 4: lanes.config.json registers identity-check in the queue module", () => {
  const { modules } = JSON.parse(repoFile("lanes.config.json"));
  const queue = modules.entries.find((m) => m.id === "queue");
  assert.ok(queue.paths.includes("scripts/lanes/identity-check."));
});

test("edge: a runner that throws on every command fails each team check, not the script", () => {
  const run = () => { throw new Error(`boom ${TOKEN}`); };
  const r = identityCheck({ readConfig: () => TEAM, run, env: {} });
  assert.equal(r.code, 1);
  assert.deepEqual(failed(JSON.parse(r.line)).sort(), ["credential", "ghDir", "push"]);
  assertNoSecret(r.line);
});
