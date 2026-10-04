// The adopter path end to end, as child processes in a scratch repo: install lanes, edit, upgrade (ADR 0017).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const lockSchema = JSON.parse(readFileSync(path.join(ROOT, "contracts", "lanes-lock.schema.json"), "utf8"));
const sha = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");

// upgrade.mjs refuses to run inside Claude, so the children never inherit CLAUDECODE.
const { CLAUDECODE: _unused, ...env } = process.env;
function run(script, ...args) {
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "lanes", script), ...args], { cwd: ROOT, env, encoding: "utf8", timeout: 60_000, windowsHide: true });
  assert.equal(r.status, 0, `${script} ${args.join(" ")} exited ${r.status}: ${r.stdout}${r.stderr}`);
  return r.stdout;
}

function readLock(dir) {
  return JSON.parse(readFileSync(path.join(dir, "lanes.lock.json"), "utf8"));
}

function assertValidLock(lock) {
  const d = lockSchema.$defs;
  assert.deepEqual(Object.keys(lock).sort(), ["files", "version"]);
  assert.match(lock.version, new RegExp(d.semver.pattern));
  assert.ok(Object.keys(lock.files).length > 0);
  for (const [p, h] of Object.entries(lock.files)) {
    assert.match(p, new RegExp(d.repoPath.pattern), p);
    assert.match(h, new RegExp(d.sha256.pattern), p);
  }
}

test("install then upgrade keeps an adopter's edits", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lanes-adopter-"));
  try {
    execFileSync("git", ["init", "--quiet", dir], { windowsHide: true });
    run("install.mjs", dir, "--private");

    const lock = readLock(dir);
    assertValidLock(lock);
    for (const [p, h] of Object.entries(lock.files)) assert.equal(sha(path.join(dir, p)), h, p);

    const edited = ".claude/commands/status.md";
    const editedPath = path.join(dir, edited);
    writeFileSync(editedPath, `${readFileSync(editedPath, "utf8")}\nlocal edit\n`);
    const editedBytes = readFileSync(editedPath);
    const configPath = path.join(dir, "lanes.config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.start = { maxLanes: 3 }; // #747: the starter config has no `start` of its own
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const configBytes = readFileSync(configPath);

    const plan = run("upgrade.mjs", dir);
    assert.match(plan, new RegExp(`^refuse ${edited.replaceAll(".", "\\.")}$`, "m"));
    assert.match(plan, /Nothing written/);
    assert.deepEqual(readFileSync(editedPath), editedBytes);

    run("upgrade.mjs", dir, "--apply");
    assert.deepEqual(readFileSync(editedPath), editedBytes, "the edited file is left unchanged");
    assert.deepEqual(readFileSync(configPath), configBytes, "the config edit is kept");
    assert.equal(JSON.parse(readFileSync(configPath, "utf8")).start.maxLanes, 3);

    const after = readLock(dir);
    assertValidLock(after);
    for (const [p, h] of Object.entries(after.files)) {
      if (p !== edited) assert.equal(sha(path.join(dir, p)), h, p);
    }
    assert.equal(after.files[edited], lock.files[edited], "a refused file keeps its installed hash in the lock");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
