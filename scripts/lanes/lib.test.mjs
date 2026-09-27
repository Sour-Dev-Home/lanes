// scripts/lanes/lib.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { authorCanWrite, classifyFiles, compileConfig, loadConfig, requiredReviewers, reviewContext } from "./lib.mjs";

// The permission endpoint's `permission` field is the legacy base role: maintain maps to write, triage to read.
const permissionApi = (reply) => {
  const calls = [];
  const api = (args) => {
    calls.push(args);
    if (reply instanceof Error) throw reply;
    return typeof reply === "string" ? reply : JSON.stringify(reply);
  };
  return { api, calls };
};

test("authorCanWrite trusts write, maintain and admin, read from the collaborator permission endpoint", () => {
  for (const [permission, role_name] of [["admin", "admin"], ["write", "maintain"], ["write", "write"]]) {
    const { api, calls } = permissionApi({ permission, role_name });
    assert.equal(authorCanWrite(api, "o/r", "leo"), true, role_name);
    assert.deepEqual(calls, [["repos/o/r/collaborators/leo/permission"]]);
  }
});

test("authorCanWrite never trusts read, triage or no permission", () => {
  for (const [permission, role_name] of [["read", "triage"], ["read", "read"], ["none", undefined], [undefined, "write"]]) {
    assert.equal(authorCanWrite(permissionApi({ permission, role_name }).api, "o/r", "leo"), false, String(role_name));
  }
});

test("authorCanWrite fails closed when the permission cannot be read", () => {
  assert.equal(authorCanWrite(permissionApi(new Error("HTTP 404")).api, "o/r", "leo"), false);
  assert.equal(authorCanWrite(permissionApi(new Error("HTTP 403")).api, "o/r", "leo"), false);
  assert.equal(authorCanWrite(permissionApi("not json").api, "o/r", "leo"), false);
  assert.equal(authorCanWrite(permissionApi("null").api, "o/r", "leo"), false);
});

test("authorCanWrite refuses a missing or malformed login without calling the API", () => {
  for (const login of [undefined, null, "", "../../x", "a/b", "dependabot[bot]", "-leo", "a".repeat(40)]) {
    const { api, calls } = permissionApi({ permission: "admin" });
    assert.equal(authorCanWrite(api, "o/r", login), false, String(login));
    assert.equal(calls.length, 0, String(login));
  }
});

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
