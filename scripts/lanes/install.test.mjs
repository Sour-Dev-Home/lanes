import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { install, MANIFEST } from "./install.mjs";

test("every manifest file exists in this repo", () => {
  for (const f of MANIFEST) assert.ok(existsSync(f), f);
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
