import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildOwnerReviewRuleset, buildRuleset, configureRulesets, existingEnforcement, findRulesetId, gateOnDefaultBranch, LABELS, readNonLanePrs, readRequiredChecks, startingEnforcement } from "./setup-repo.mjs";

// #747: setup-repo runs before CODEOWNERS exists, so it reads requiredChecks without loadConfig's owner-path check.
function withConfig(text, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "lanes-sr-"));
  try {
    const file = path.join(dir, "lanes.config.json");
    if (text !== undefined) writeFileSync(file, text);
    return fn(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const DEFAULT_CHECKS = ["verify", "security", "lanes/gate"];

test("#747: readRequiredChecks reads a team config with no CODEOWNERS and no owner paths", () => {
  const cfg = JSON.stringify({ requiredChecks: ["verify", "x"], identity: { profile: "team" }, paths: { owner: [] } });
  assert.deepEqual(withConfig(cfg, readRequiredChecks), ["verify", "x"]);
});

test("edge: readRequiredChecks falls back to the defaults for a missing file, bad JSON or a missing/invalid list", () => {
  assert.deepEqual(withConfig(undefined, readRequiredChecks), DEFAULT_CHECKS);
  assert.deepEqual(withConfig("{nope", readRequiredChecks), DEFAULT_CHECKS);
  assert.deepEqual(withConfig("{}", readRequiredChecks), DEFAULT_CHECKS);
  assert.deepEqual(withConfig('{"requiredChecks":[]}', readRequiredChecks), DEFAULT_CHECKS);
  assert.deepEqual(withConfig('{"requiredChecks":[1]}', readRequiredChecks), DEFAULT_CHECKS);
});

test("the ruleset requires the checks, a merge queue and CodeQL, with no bypass", () => {
  const r = buildRuleset(["verify", "security", "lanes/gate"]);
  assert.deepEqual(r.bypass_actors, []);
  const byType = Object.fromEntries(r.rules.map((x) => [x.type, x.parameters]));
  assert.deepEqual(byType.required_status_checks.required_status_checks.map((c) => c.context), ["verify", "security", "lanes/gate"]);
  assert.equal(byType.merge_queue.merge_method, "SQUASH");
  assert.equal(byType.code_scanning.code_scanning_tools[0].security_alerts_threshold, "high_or_higher");
  assert.ok("non_fast_forward" in byType && "deletion" in byType);
});

// I3: pin every required check to GitHub Actions, so a status posted with a personal token cannot satisfy it
test("every required check is pinned to the GitHub Actions app", () => {
  const r = buildRuleset(["verify", "security", "lanes/gate"]);
  const byType = Object.fromEntries(r.rules.map((x) => [x.type, x.parameters]));
  for (const check of byType.required_status_checks.required_status_checks) {
    assert.equal(check.integration_id, 15368, check.context);
  }
});

test("labels include the tiers, ready, contract:breaking, digest and lane-filed", () => {
  const names = LABELS.map((l) => l.name);
  for (const n of ["tier:skip", "tier:quick", "tier:full", "ready", "contract:breaking", "digest", "lane-filed"]) assert.ok(names.includes(n), n);
});

// #136: a lane that finds nothing to build labels the issue needs-owner; adopters get the label from setup-repo
test("labels include needs-owner, next to lane-filed, with the description the lane relies on", () => {
  const names = LABELS.map((l) => l.name);
  const label = LABELS.find((l) => l.name === "needs-owner");
  assert.ok(label, "needs-owner is created");
  assert.equal(label.description, "A lane stopped and needs the owner; see its last comment");
  assert.equal(names.indexOf("needs-owner"), names.indexOf("lane-filed") + 1);
});

test("edge: every label has a name, a 6-digit hex color and a description of at most 100 characters (GitHub's limit), and names are unique", () => {
  for (const l of LABELS) {
    assert.match(l.color, /^[0-9a-f]{6}$/i, l.name);
    assert.ok(l.description.length > 0 && l.description.length <= 100, l.name);
  }
  assert.equal(new Set(LABELS.map((l) => l.name)).size, LABELS.length);
});

// M6: setup-repo must update an existing "main (lanes)" ruleset by id, never create a duplicate
test("findRulesetId finds an existing ruleset by name, or null", () => {
  assert.equal(findRulesetId([{ id: 1, name: "other" }, { id: 42, name: "main (lanes)" }], "main (lanes)"), 42);
  assert.equal(findRulesetId([{ id: 1, name: "other" }], "main (lanes)"), null);
  assert.equal(findRulesetId([], "main (lanes)"), null);
  assert.equal(findRulesetId(undefined, "main (lanes)"), null);
});

// #762: the lanes ruleset starts disabled until lanes-gate.yml is on the default branch
const failWith = (stderr) => Object.assign(new Error("Command failed"), { stderr });
const fakeGh = (outcome) => (args) => {
  assert.deepEqual(args, ["api", "repos/acme/widgets/contents/.github/workflows/lanes-gate.yml"]);
  if (outcome) throw outcome;
  return "{}";
};

test("buildRuleset is active by default and takes an enforcement", () => {
  assert.equal(buildRuleset(DEFAULT_CHECKS).enforcement, "active");
  assert.equal(buildRuleset(DEFAULT_CHECKS, "disabled").enforcement, "disabled");
});

test("a new ruleset starts disabled without lanes-gate.yml on the default branch, active with it", () => {
  assert.equal(startingEnforcement(fakeGh(failWith("gh: Not Found (HTTP 404)")), "acme/widgets"), "disabled");
  assert.equal(startingEnforcement(fakeGh(), "acme/widgets"), "active");
});

test("edge: an empty repository (409) counts as no workflow, any other failure throws", () => {
  assert.equal(gateOnDefaultBranch(fakeGh(failWith("gh: Git Repository is empty. (HTTP 409)")), "acme/widgets"), false);
  assert.throws(() => gateOnDefaultBranch(fakeGh(failWith("gh: Bad credentials (HTTP 401)")), "acme/widgets"), /Command failed/);
  assert.throws(() => gateOnDefaultBranch(fakeGh(failWith("gh: Server Error (HTTP 500)")), "acme/widgets"), /Command failed/);
});

test("an existing ruleset's enforcement is read, never overridden", () => {
  const list = [{ id: 1, name: "other", enforcement: "active" }, { id: 7, name: "main (lanes)", enforcement: "disabled" }];
  assert.equal(existingEnforcement(list, "main (lanes)"), "disabled");
  assert.equal(existingEnforcement([{ id: 7, name: "main (lanes)", enforcement: "evaluate" }], "main (lanes)"), "evaluate");
  assert.equal(existingEnforcement([], "main (lanes)"), undefined);
  assert.equal(existingEnforcement(undefined, "main (lanes)"), undefined);
});

// ADR 0034 part 2 (#781): the split rulesets
const CHECKS = ["verify", "security", "lanes/gate"];
function rulesetGh({ rulesets = [], gateFile = true } = {}) {
  const calls = [];
  const fn = (args, input) => {
    calls.push({ args, body: input ? JSON.parse(input) : undefined });
    if (args.length === 2 && args[1] === "repos/me/proj/rulesets") return JSON.stringify(rulesets);
    if (String(args[1]).includes("contents/.github/workflows/lanes-gate.yml")) {
      if (gateFile) return "{}";
      throw Object.assign(new Error("HTTP 404 Not Found"), { stderr: "HTTP 404" });
    }
    return "{}";
  };
  return { fn, writes: () => calls.filter((c) => c.body) };
}

test("the owner-review ruleset holds only the code-owner pull_request rule and an admin bypass in pull_request mode", () => {
  const r = buildOwnerReviewRuleset();
  assert.equal(r.name, "main (lanes owner review)");
  assert.equal(r.rules.length, 1);
  assert.equal(r.rules[0].type, "pull_request");
  assert.equal(r.rules[0].parameters.require_code_owner_review, true);
  assert.equal(r.rules[0].parameters.required_approving_review_count, 0);
  assert.deepEqual(r.bypass_actors, [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "pull_request" }]);
  assert.equal(buildOwnerReviewRuleset("disabled").enforcement, "disabled");
});

test("key on and no lanes ruleset: both rulesets are created, main (lanes) with no bypass and no code-owner rule", () => {
  const g = rulesetGh();
  const lines = [];
  configureRulesets(g.fn, "me/proj", CHECKS, true, (l) => lines.push(l));
  const w = g.writes();
  assert.deepEqual(w.map((c) => c.body.name), ["main (lanes)", "main (lanes owner review)"]);
  assert.ok(w.every((c) => c.args.includes("POST")));
  assert.deepEqual(w[0].body.bypass_actors, []);
  assert.equal(w[0].body.rules.find((r) => r.type === "pull_request").parameters.require_code_owner_review, false);
  assert.ok(w[0].body.rules.some((r) => r.type === "merge_queue") && w[0].body.rules.some((r) => r.type === "code_scanning"));
  assert.equal(w[0].body.enforcement, "active");
  assert.equal(w[1].body.enforcement, "active");
  assert.match(lines.join("\n"), /created \(active\)/);
});

test("key on follows #762: both start disabled until lanes-gate.yml is on the default branch", () => {
  const g = rulesetGh({ gateFile: false });
  configureRulesets(g.fn, "me/proj", CHECKS, true, () => {});
  assert.deepEqual(g.writes().map((c) => c.body.enforcement), ["disabled", "disabled"]);
});

test("key off: today's single ruleset is created, unchanged", () => {
  const g = rulesetGh();
  configureRulesets(g.fn, "me/proj", CHECKS, false, () => {});
  assert.deepEqual(g.writes().map((c) => c.body), [buildRuleset(CHECKS, "active")]);
});

test("key off: an existing single ruleset is updated by id, keeping its enforcement", () => {
  const g = rulesetGh({ rulesets: [{ id: 9, name: "main (lanes)", enforcement: "disabled" }] });
  configureRulesets(g.fn, "me/proj", CHECKS, false, () => {});
  const w = g.writes();
  assert.equal(w.length, 1);
  assert.ok(w[0].args.includes("PUT") && w[0].args.includes("repos/me/proj/rulesets/9"));
  assert.equal(w[0].body.enforcement, "disabled");
});

test("key on and only the single ruleset exists: nothing is written, the two manual steps print with links, no throw", () => {
  const g = rulesetGh({ rulesets: [{ id: 9, name: "main (lanes)", enforcement: "active" }] });
  const lines = [];
  configureRulesets(g.fn, "me/proj", CHECKS, true, (l) => lines.push(l));
  assert.equal(g.writes().length, 0);
  const out = lines.join("\n");
  assert.match(out, /1\. open https:\/\/github\.com\/me\/proj\/settings\/rules\/9 and remove the code-owner rule/);
  assert.match(out, /2\. create "main \(lanes owner review\)" at https:\/\/github\.com\/me\/proj\/settings\/rules\/new\?target=branch/);
});

test("edge: key on with both rulesets present changes nothing and prints no steps", () => {
  const g = rulesetGh({ rulesets: [{ id: 9, name: "main (lanes)" }, { id: 10, name: "main (lanes owner review)" }] });
  const lines = [];
  configureRulesets(g.fn, "me/proj", CHECKS, true, (l) => lines.push(l));
  assert.equal(g.writes().length, 0);
  assert.doesNotMatch(lines.join("\n"), /manual steps/);
});

test("edge: key on with only the owner-review ruleset creates nothing and says to create main (lanes)", () => {
  const g = rulesetGh({ rulesets: [{ id: 10, name: "main (lanes owner review)" }] });
  const lines = [];
  configureRulesets(g.fn, "me/proj", CHECKS, true, (l) => lines.push(l));
  assert.equal(g.writes().length, 0);
  assert.match(lines.join("\n"), /"main \(lanes\)" does not/);
  assert.doesNotMatch(lines.join("\n"), /remove the code-owner rule/);
});

test("readNonLanePrs is true only for a literal true; a missing file, bad JSON or other value is false", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "nlp-"));
  try {
    const f = path.join(dir, "c.json");
    writeFileSync(f, JSON.stringify({ gate: { nonLanePrs: true } }));
    assert.equal(readNonLanePrs(f), true);
    writeFileSync(f, JSON.stringify({ gate: { nonLanePrs: "true" } }));
    assert.equal(readNonLanePrs(f), false);
    writeFileSync(f, "{");
    assert.equal(readNonLanePrs(f), false);
    assert.equal(readNonLanePrs(path.join(dir, "none.json")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("edge: key on with a non-array rulesets reply is treated as none and creates both", () => {
  const g = rulesetGh({ rulesets: { message: "unexpected" } });
  configureRulesets(g.fn, "me/proj", CHECKS, true, () => {});
  assert.deepEqual(g.writes().map((c) => c.body.name), ["main (lanes)", "main (lanes owner review)"]);
});
