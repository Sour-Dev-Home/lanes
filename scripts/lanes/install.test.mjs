import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { install, MANIFEST, publicFromArgs, repoIsPublic } from "./install.mjs";

test("every manifest file exists in this repo", () => {
  for (const f of MANIFEST) assert.ok(existsSync(f), f);
});

// The scripts that .claude/settings.json runs as hook commands, as repo-relative paths.
function hookScripts(settings) {
  const scripts = new Set();
  for (const groups of Object.values(settings.hooks ?? {}))
    for (const group of groups)
      for (const hook of group.hooks ?? [])
        for (const m of (hook.command ?? "").matchAll(/\$CLAUDE_PROJECT_DIR\/([^"\s]+)/g)) scripts.add(m[1]);
  return [...scripts];
}

test("#612: MANIFEST ships app-setup.mjs with the identity-check it imports, and the config registers it under install", () => {
  assert.ok(MANIFEST.includes("scripts/lanes/app-setup.mjs"));
  assert.ok(MANIFEST.includes("scripts/lanes/identity-check.mjs"));
  const install = JSON.parse(readFileSync("lanes.config.json", "utf8")).modules.entries.find((m) => m.id === "install");
  assert.ok(install.paths.includes("scripts/lanes/app-setup."));
});

test("#649: MANIFEST ships the apply workflow with the script it runs and the lib that script imports", () => {
  for (const f of [".github/workflows/lanes-workflow-apply.yml", "scripts/lanes/workflow-apply.mjs", "scripts/lanes/lib.mjs", "scripts/lanes/handover.mjs"]) assert.ok(MANIFEST.includes(f), f);
});

test("edge: #649 install copies the apply workflow byte for byte into a target", () => {
  const target = mkdtempSync(path.join(tmpdir(), "lanes-apply-"));
  try {
    const r = install(".", target);
    assert.ok(r.copied.includes(".github/workflows/lanes-workflow-apply.yml"));
    assert.equal(readFileSync(path.join(target, ".github/workflows/lanes-workflow-apply.yml"), "utf8"), readFileSync(".github/workflows/lanes-workflow-apply.yml", "utf8"));
    assert.ok(existsSync(path.join(target, "scripts/lanes/workflow-apply.mjs")));
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test("MANIFEST ships the OWASP licence, provenance note, index and every vendored sheet", () => {
  const dir = "vendor/owasp-cheatsheets";
  for (const f of ["LICENSE", "VENDORED.md", "INDEX.md"]) assert.ok(MANIFEST.includes(`${dir}/${f}`), f);
  const sheets = readdirSync(`${dir}/sheets`);
  assert.ok(sheets.length > 0);
  for (const s of sheets) assert.ok(MANIFEST.includes(`${dir}/sheets/${s}`), s);
});

test("edge: MANIFEST lists no OWASP sheet that is not vendored", () => {
  const listed = MANIFEST.filter((f) => f.startsWith("vendor/owasp-cheatsheets/sheets/"));
  assert.deepEqual(listed.map((f) => path.basename(f)).sort(), readdirSync("vendor/owasp-cheatsheets/sheets").sort());
});

test("edge: install copies the OWASP sheets byte for byte", () => {
  const target = mkdtempSync(path.join(tmpdir(), "lanes-owasp-"));
  install(".", target);
  const all = [...["LICENSE", "VENDORED.md", "INDEX.md"], ...readdirSync("vendor/owasp-cheatsheets/sheets").map((s) => `sheets/${s}`)];
  for (const f of all)
    assert.deepEqual(readFileSync(path.join(target, "vendor/owasp-cheatsheets", f)), readFileSync(path.join("vendor/owasp-cheatsheets", f)));
});

test("MANIFEST ships nothing of the retired start guard, its lexer or the approve guard (#616, ADR 0030)", () => {
  assert.ok(MANIFEST.includes(".claude/settings.json"));
  for (const gone of ["scripts/lanes/start-guard.mjs", "scripts/lanes/start-guard.test.mjs", "scripts/lanes/shell-lex.mjs",
    "scripts/lanes/shell-lex.test.mjs", "scripts/lanes/shell-lex.fixtures.mjs", "scripts/lanes/approve-guard.mjs", "scripts/lanes/approve-guard.test.mjs", ".claude/commands/approve.md", ".claude/commands/approvals.md"]) {
    assert.equal(MANIFEST.includes(gone), false, gone);
  }
});

test("every script a settings.json hook runs is in MANIFEST", () => {
  const scripts = hookScripts(JSON.parse(readFileSync(".claude/settings.json", "utf8")));
  assert.ok(scripts.includes("scripts/lanes/notify-hook.mjs"), "hook extraction found the notification hook");
  for (const s of scripts) assert.ok(MANIFEST.includes(s), `${s} is wired as a hook but not installed`);
});

test("edge: hookScripts reads every event and ignores hooks without a project script", () => {
  const settings = {
    hooks: {
      A: [{ hooks: [{ type: "command", command: 'node "$CLAUDE_PROJECT_DIR/x/a.mjs" arg' }] }],
      B: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }, { type: "command", command: "node $CLAUDE_PROJECT_DIR/b.mjs" }] }],
      C: [{}],
    },
  };
  assert.deepEqual(hookScripts(settings).sort(), ["b.mjs", "x/a.mjs"]);
  assert.deepEqual(hookScripts({}), []);
});

test("edge: hookScripts dedupes a script wired to more than one hook event", () => {
  // a script can be wired on several events and tools; a naive list (not a Set) would count it twice.
  const settings = {
    hooks: {
      UserPromptSubmit: [{ hooks: [{ type: "command", command: 'node "$CLAUDE_PROJECT_DIR/scripts/lanes/x.mjs" user-prompt-submit' }] }],
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: 'node "$CLAUDE_PROJECT_DIR/scripts/lanes/x.mjs" pre-tool-use' }] }],
    },
  };
  assert.deepEqual(hookScripts(settings), ["scripts/lanes/x.mjs"]);
});

test("edge: every local module a hook script imports is in MANIFEST", () => {
  for (const s of hookScripts(JSON.parse(readFileSync(".claude/settings.json", "utf8"))))
    for (const m of readFileSync(s, "utf8").matchAll(/^import .* from "(\.{1,2}\/[^"]+)";$/gm)) {
      const dep = path.posix.join(path.posix.dirname(s), m[1]);
      assert.ok(MANIFEST.includes(dep), `${s} imports ${dep}, which is not installed`);
    }
});

// The repo scripts a command file tells Claude to run, as repo-relative paths.
function commandScripts(text) {
  return [...new Set([...text.matchAll(/\bscripts\/[\w./-]+\.mjs\b/g)].map((m) => m[0]))];
}

// Scripts a copied command names that are deliberately not installed, with the reason.
// Empty today: every script a copied command runs ships with it.
const COMMAND_SCRIPT_EXCEPTIONS = new Map();

// Command-run scripts (as [commandFile, fileText] pairs) that are neither in the manifest
// nor a listed exception, each reported as "<commandFile> runs <script>".
function missingCommandScripts(commandTexts, manifest, exceptions) {
  const missing = [];
  for (const [c, text] of commandTexts)
    for (const s of commandScripts(text))
      if (!manifest.includes(s) && !exceptions.has(s)) missing.push(`${c} runs ${s}`);
  return missing;
}

// The local modules a script imports, statically or with a dynamic import(), as repo-relative paths.
function localImports(file, text) {
  const specs = [...text.matchAll(/\bfrom\s+"(\.{1,2}\/[^"]+)"|\bimport\(\s*"(\.{1,2}\/[^"]+)"\s*\)/g)];
  return specs.map((m) => path.posix.join(path.posix.dirname(file), m[1] ?? m[2]));
}

test("MANIFEST ships the dashboard page's three files", () => {
  for (const f of ["index.html", "app.js", "style.css"]) assert.ok(MANIFEST.includes(`dashboard/${f}`), f);
});

test("MANIFEST includes cleanup.mjs", () => {
  assert.ok(MANIFEST.includes("scripts/lanes/cleanup.mjs"));
});

test("MANIFEST ships lessons.mjs and the module it imports, but no lesson fragment", () => {
  assert.ok(MANIFEST.includes("scripts/lanes/lessons.mjs"));
  assert.ok(MANIFEST.includes("scripts/lanes/modules.mjs"));
  assert.deepEqual(MANIFEST.filter((f) => f.startsWith("docs/lessons.d")), []);
});

test("MANIFEST ships validate.mjs and lib.mjs, which it imports", () => {
  assert.ok(MANIFEST.includes("scripts/lanes/validate.mjs"));
  assert.ok(MANIFEST.includes("scripts/lanes/lib.mjs"));
});

test("every script a copied command file runs is in MANIFEST, or a listed exception", () => {
  const commands = MANIFEST.filter((f) => /^\.claude\/commands\/[^/]+\.md$/.test(f));
  assert.ok(commands.includes(".claude/commands/health.md"), "found the copied command files");
  const texts = commands.map((c) => [c, readFileSync(c, "utf8")]);
  assert.deepEqual(
    missingCommandScripts(texts, MANIFEST, COMMAND_SCRIPT_EXCEPTIONS),
    [],
    "these scripts are run by an installed command but not installed"
  );
});

test("edge: every exception really is left out of MANIFEST", () => {
  for (const s of COMMAND_SCRIPT_EXCEPTIONS.keys()) assert.ok(!MANIFEST.includes(s), `${s} is installed; drop the exception`);
});

test("edge: missingCommandScripts skips a listed exception but still flags an unlisted missing script", () => {
  const texts = [["cmd.md", "node scripts/lanes/cleanup.mjs\nnode scripts/lanes/ghost.mjs\nnode scripts/lanes/also-ghost.mjs"]];
  const exceptions = new Map([["scripts/lanes/ghost.mjs", "deliberately external"]]);
  assert.deepEqual(missingCommandScripts(texts, MANIFEST, exceptions), ["cmd.md runs scripts/lanes/also-ghost.mjs"]);
});

test("edge: every local module an installed script imports, even lazily, is in MANIFEST", () => {
  const missing = [];
  for (const s of MANIFEST.filter((f) => f.endsWith(".mjs")))
    for (const dep of localImports(s, readFileSync(s, "utf8")))
      if (!MANIFEST.includes(dep)) missing.push(`${s} imports ${dep}`);
  assert.deepEqual(missing, []);
});

test("edge: commandScripts finds inline, fenced and repeated script paths and ignores others", () => {
  const text = [
    "Run `node scripts/lanes/status.mjs --json`.",
    "```",
    "node scripts/lanes/cleanup.mjs --apply",
    "node scripts/lanes/status.mjs",
    "```",
    "See scripts/lanes/README.md and docs/x.mjs.",
  ].join("\n");
  assert.deepEqual(commandScripts(text), ["scripts/lanes/status.mjs", "scripts/lanes/cleanup.mjs"]);
  assert.deepEqual(commandScripts(""), []);
});

test("edge: localImports reads static, multi-line and dynamic imports and skips packages", () => {
  const text = [
    'import { a } from "./lib.mjs";',
    "import {",
    "  b,",
    '} from "../preflight.mjs";',
    'import fs from "node:fs";',
    'const { c } = await import("./cleanup.mjs");',
  ].join("\n");
  assert.deepEqual(localImports("scripts/lanes/status.mjs", text), [
    "scripts/lanes/lib.mjs",
    "scripts/preflight.mjs",
    "scripts/lanes/cleanup.mjs",
  ]);
});

test("edge: a fresh install writes the deny-rule settings.json and no guard, lexer or approve files", () => {
  const target = mkdtempSync(path.join(tmpdir(), "lanes-"));
  install(".", target, {});
  const settings = readFileSync(path.join(target, ".claude/settings.json"), "utf8");
  assert.ok(JSON.parse(settings).permissions.deny.includes("Bash(claude --bg:*)"));
  assert.doesNotMatch(settings, /start-guard/);
  for (const gone of ["start-guard.mjs", "shell-lex.mjs"]) assert.equal(existsSync(path.join(target, "scripts/lanes", gone)), false, gone);
  assert.equal(existsSync(path.join(target, "scripts/lanes/approve-guard.mjs")), false);
  assert.equal(existsSync(path.join(target, ".claude/commands/approve.md")), false);
});

test("install copies the manifest and never overwrites without force", () => {
  const target = mkdtempSync(path.join(tmpdir(), "lanes-"));
  mkdirSync(path.join(target, "docs"), { recursive: true });
  writeFileSync(path.join(target, "lanes.config.json"), "{}");
  const r = install(".", target, {});
  assert.ok(r.skipped.includes("lanes.config.json"));
  assert.equal(readFileSync(path.join(target, "lanes.config.json"), "utf8"), "{}");
  assert.ok(existsSync(path.join(target, "scripts/lanes/gate.mjs")));
  assert.equal(install(".", target, { force: true }).skipped.length, 0);
});

// #278 (ADR 0012): the dashboard's script, schema and workflow ship; the workflow stays off unless the repo is public.
test("MANIFEST ships snapshot.mjs, its schema and the dashboard workflow, and what snapshot.mjs imports", () => {
  for (const f of ["scripts/lanes/snapshot.mjs", "contracts/snapshot.schema.json", ".github/workflows/dashboard.yml", "scripts/lanes/status.mjs", "scripts/lanes/lib.mjs"]) assert.ok(MANIFEST.includes(f), f);
});

test("install leaves the dashboard workflow disabled by default: an inert .disabled copy, no live workflow", () => {
  const target = mkdtempSync(path.join(tmpdir(), "lanes-"));
  const r = install(".", target, {});
  assert.ok(!existsSync(path.join(target, ".github/workflows/dashboard.yml")));
  assert.equal(readFileSync(path.join(target, ".github/workflows/dashboard.yml.disabled"), "utf8"), readFileSync(".github/workflows/dashboard.yml", "utf8"));
  assert.deepEqual(r.disabled, [".github/workflows/dashboard.yml"]);
  assert.ok(existsSync(path.join(target, "scripts/lanes/snapshot.mjs")));
  assert.ok(existsSync(path.join(target, "contracts/snapshot.schema.json")));
});

test("install enables the dashboard workflow for a public repository", () => {
  const target = mkdtempSync(path.join(tmpdir(), "lanes-"));
  const r = install(".", target, { isPublic: true });
  assert.ok(existsSync(path.join(target, ".github/workflows/dashboard.yml")));
  assert.ok(!existsSync(path.join(target, ".github/workflows/dashboard.yml.disabled")));
  assert.deepEqual(r.disabled, []);
});

test("edge: a private install never overwrites or removes a dashboard workflow the target already has", () => {
  const target = mkdtempSync(path.join(tmpdir(), "lanes-"));
  mkdirSync(path.join(target, ".github/workflows"), { recursive: true });
  writeFileSync(path.join(target, ".github/workflows/dashboard.yml"), "mine");
  const r = install(".", target, { force: true });
  assert.equal(readFileSync(path.join(target, ".github/workflows/dashboard.yml"), "utf8"), "mine");
  assert.ok(r.skipped.includes(".github/workflows/dashboard.yml"));
  assert.deepEqual(r.disabled, []);
});

test("edge: a second private install keeps the .disabled copy without --force", () => {
  const target = mkdtempSync(path.join(tmpdir(), "lanes-"));
  install(".", target, {});
  writeFileSync(path.join(target, ".github/workflows/dashboard.yml.disabled"), "edited");
  const r = install(".", target, {});
  assert.equal(readFileSync(path.join(target, ".github/workflows/dashboard.yml.disabled"), "utf8"), "edited");
  assert.ok(r.skipped.includes(".github/workflows/dashboard.yml.disabled"));
});

test("repoIsPublic reads gh's isPrivate, and treats every failure or odd answer as private", () => {
  const answer = (text) => () => text;
  assert.equal(repoIsPublic("t", answer('{"isPrivate":false}')), true);
  assert.equal(repoIsPublic("t", answer('{"isPrivate":true}')), false);
  assert.equal(repoIsPublic("t", answer("{}")), false);
  assert.equal(repoIsPublic("t", answer("not json")), false);
  assert.equal(repoIsPublic("t", answer('{"isPrivate":"false"}')), false);
  assert.equal(repoIsPublic("t", () => { throw new Error("gh not found"); }), false);
});

test("edge: --public and --private on the command line decide before gh is asked", () => {
  const never = () => { throw new Error("gh must not be asked"); };
  assert.equal(publicFromArgs(["dir", "--public"], never), true);
  assert.equal(publicFromArgs(["dir", "--private"], never), false);
  assert.throws(() => publicFromArgs(["dir", "--public", "--private"], never), /not both/);
  assert.equal(publicFromArgs(["dir"], () => '{"isPrivate":false}'), true);
});

// The lock (ADR 0016): lanes.lock.json, checked against contracts/lanes-lock.schema.json's own patterns.
const lockSchema = JSON.parse(readFileSync("contracts/lanes-lock.schema.json", "utf8"));
const sha = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");
const tmp = () => mkdtempSync(path.join(tmpdir(), "lanes-lock-"));
function validLock(lock) {
  const d = lockSchema.$defs;
  assert.deepEqual(Object.keys(lock).sort(), ["files", "version"]);
  assert.match(lock.version, new RegExp(d.semver.pattern));
  for (const [p, h] of Object.entries(lock.files)) {
    assert.match(p, new RegExp(d.repoPath.pattern), p);
    assert.match(h, new RegExp(d.sha256.pattern), p);
  }
}
const readLock = (target) => JSON.parse(readFileSync(path.join(target, "lanes.lock.json"), "utf8"));

test("package.json has a semver version and CHANGELOG.md has an entry for it", () => {
  const { version } = JSON.parse(readFileSync("package.json", "utf8"));
  assert.match(version, /^\d+\.\d+\.\d+/);
  assert.match(readFileSync("CHANGELOG.md", "utf8"), new RegExp(`^## \\[?${version.replaceAll(".", "\\.")}\\]?`, "m"));
});

test("a fresh install writes a lock with the package version and the sha256 of every file written", () => {
  const target = tmp();
  install(".", target, { isPublic: true });
  const lock = readLock(target);
  validLock(lock);
  assert.equal(lock.version, JSON.parse(readFileSync("package.json", "utf8")).version);
  assert.deepEqual(Object.keys(lock.files).sort(), MANIFEST.filter((f) => f !== "lanes.config.json").sort());
  for (const [p, h] of Object.entries(lock.files)) assert.equal(h, sha(path.join(target, p)), p);
});

test("the lock never lists itself or lanes.config.json", () => {
  const target = tmp();
  install(".", target);
  const files = Object.keys(readLock(target).files);
  assert.ok(!files.includes("lanes.lock.json") && !files.includes("lanes.config.json"));
});

test("a pre-existing file is kept and not recorded in the lock", () => {
  const target = tmp();
  mkdirSync(path.join(target, "scripts/lanes"), { recursive: true });
  writeFileSync(path.join(target, "scripts/lanes/gate.mjs"), "// mine\n");
  install(".", target);
  const lock = readLock(target);
  validLock(lock);
  assert.ok(!("scripts/lanes/gate.mjs" in lock.files));
  assert.ok("scripts/lanes/lib.mjs" in lock.files);
  assert.equal(readFileSync(path.join(target, "scripts/lanes/gate.mjs"), "utf8"), "// mine\n");
});

test("--force records the overwritten file with the shipped hash and rewrites the lock", () => {
  const target = tmp();
  mkdirSync(path.join(target, "scripts/lanes"), { recursive: true });
  writeFileSync(path.join(target, "scripts/lanes/gate.mjs"), "// mine\n");
  install(".", target);
  install(".", target, { force: true });
  const lock = readLock(target);
  validLock(lock);
  assert.equal(lock.files["scripts/lanes/gate.mjs"], sha("scripts/lanes/gate.mjs"));
});

test("edge: a second install without --force leaves an existing lock untouched", () => {
  const target = tmp();
  install(".", target);
  const lockPath = path.join(target, "lanes.lock.json");
  writeFileSync(lockPath, '{"version":"9.9.9","files":{}}\n');
  install(".", target);
  assert.equal(readFileSync(lockPath, "utf8"), '{"version":"9.9.9","files":{}}\n');
});

test("edge: a private install records the .disabled dashboard workflow under the path it wrote", () => {
  const target = tmp();
  install(".", target, { isPublic: false });
  const { files } = readLock(target);
  assert.equal(files[".github/workflows/dashboard.yml.disabled"], sha(".github/workflows/dashboard.yml"));
  assert.ok(!(".github/workflows/dashboard.yml" in files));
});

test("edge: a lock with no files written (everything kept) is still valid", () => {
  const target = tmp();
  install(".", target);
  rmSync(path.join(target, "lanes.lock.json"));
  install(".", target);
  const lock = readLock(target);
  validLock(lock);
  assert.deepEqual(lock.files, {});
});
