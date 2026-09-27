// scripts/lanes/lib.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyFiles, compileConfig, loadConfig, requiredReviewers, reviewContext } from "./lib.mjs";

const config = compileConfig({
  requiredChecks: ["verify", "security", "lanes/gate"],
  paths: {
    skip: ["^docs/", "\\.md$", "\\.test\\.m?[jt]sx?$"],
    contract: ["^contracts/"],
    sensitive: ["^\\.github/", "^scripts/lanes/"],
    ui: ["^frontend/src/"],
  },
});

test("compileConfig rejects a missing path list", () => {
  assert.throws(() => compileConfig({ requiredChecks: ["verify"], paths: { skip: [] } }), /paths\.contract/);
});

test("compileConfig rejects empty requiredChecks", () => {
  assert.throws(() => compileConfig({ requiredChecks: [], paths: { skip: [], contract: [], sensitive: [], ui: [] } }), /requiredChecks/);
});

test("docs and tests only are skipOnly", () => {
  assert.deepEqual(classifyFiles(["docs/a.md", "src/x.test.ts"], config), { skipOnly: true, contract: false, sensitive: false, ui: false });
});

test("a sensitive markdown file is not skipOnly", () => {
  assert.equal(classifyFiles([".github/pull_request_template.md"], config).skipOnly, false);
  assert.equal(classifyFiles([".github/pull_request_template.md"], config).sensitive, true);
});

test("no files is not skipOnly", () => {
  assert.equal(classifyFiles([], config).skipOnly, false);
});

test("code plus docs is not skipOnly; contract and ui are detected", () => {
  const cls = classifyFiles(["docs/a.md", "contracts/snapshot.ts", "frontend/src/App.tsx"], config);
  assert.deepEqual(cls, { skipOnly: false, contract: true, sensitive: false, ui: true });
});

test("required reviewers by tier and class", () => {
  const none = { skipOnly: false, contract: false, sensitive: false, ui: false };
  assert.deepEqual(requiredReviewers("skip", none), []);
  assert.deepEqual(requiredReviewers("quick", none), ["test-hunter"]);
  assert.deepEqual(requiredReviewers("quick", { ...none, ui: true }), ["test-hunter", "ui-reviewer"]);
  assert.deepEqual(requiredReviewers("full", { ...none, sensitive: true, contract: true }), ["test-hunter", "security-reviewer", "architecture-advisor"]);
});

test("reviewContext", () => {
  assert.equal(reviewContext("owner"), "review/owner");
});

// I7: package.json, lockfiles, vendor/, CLAUDE.md and .gitattributes are sensitive in the repo's real config
test("lanes.config.json marks package/lockfiles, vendor/, CLAUDE.md and .gitattributes sensitive", () => {
  const real = loadConfig();
  const examples = [
    "package.json",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "vendor/agent-skills/VENDORED.md",
    "CLAUDE.md",
    "backend/CLAUDE.md",
    ".gitattributes",
  ];
  for (const file of examples) {
    const cls = classifyFiles([file], real);
    assert.equal(cls.sensitive, true, file);
    assert.equal(cls.skipOnly, false, file);
  }
});
