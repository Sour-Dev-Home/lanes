import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { install, MANIFEST } from "./install.mjs";

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
  for (const f of ["INDEX.md", "sheets/Input_Validation_Cheat_Sheet.md"])
    assert.deepEqual(readFileSync(path.join(target, "vendor/owasp-cheatsheets", f)), readFileSync(path.join("vendor/owasp-cheatsheets", f)));
});

test("MANIFEST includes the approve guard", () => {
  assert.ok(MANIFEST.includes("scripts/lanes/approve-guard.mjs"));
});

test("every script a settings.json hook runs is in MANIFEST", () => {
  const scripts = hookScripts(JSON.parse(readFileSync(".claude/settings.json", "utf8")));
  assert.ok(scripts.includes("scripts/lanes/approve-guard.mjs"), "hook extraction found the approve guard");
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
  // approve-guard.mjs and start-guard.mjs are each wired twice in the real settings.json
  // (UserPromptSubmit and PreToolUse); a naive list (not a Set) would count them twice.
  const settings = {
    hooks: {
      UserPromptSubmit: [{ hooks: [{ type: "command", command: 'node "$CLAUDE_PROJECT_DIR/scripts/lanes/approve-guard.mjs" user-prompt-submit' }] }],
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: 'node "$CLAUDE_PROJECT_DIR/scripts/lanes/approve-guard.mjs" pre-tool-use' }] }],
    },
  };
  assert.deepEqual(hookScripts(settings), ["scripts/lanes/approve-guard.mjs"]);
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

test("MANIFEST includes cleanup.mjs", () => {
  assert.ok(MANIFEST.includes("scripts/lanes/cleanup.mjs"));
});

test("MANIFEST ships lessons.mjs and the module it imports, but no lesson fragment", () => {
  assert.ok(MANIFEST.includes("scripts/lanes/lessons.mjs"));
  assert.ok(MANIFEST.includes("scripts/lanes/modules.mjs"));
  assert.deepEqual(MANIFEST.filter((f) => f.startsWith("docs/lessons.d")), []);
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

test("edge: install copies the approve guard into the target", () => {
  const target = mkdtempSync(path.join(tmpdir(), "lanes-"));
  install(".", target, {});
  assert.ok(existsSync(path.join(target, "scripts/lanes/approve-guard.mjs")));
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
