import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
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

test("edge: every local module a hook script imports is in MANIFEST", () => {
  for (const s of hookScripts(JSON.parse(readFileSync(".claude/settings.json", "utf8"))))
    for (const m of readFileSync(s, "utf8").matchAll(/^import .* from "(\.{1,2}\/[^"]+)";$/gm)) {
      const dep = path.posix.join(path.posix.dirname(s), m[1]);
      assert.ok(MANIFEST.includes(dep), `${s} imports ${dep}, which is not installed`);
    }
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
