import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRuleset, findRulesetId, LABELS } from "./setup-repo.mjs";

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

// M6: setup-repo must update an existing "main (lanes)" ruleset by id, never create a duplicate
test("findRulesetId finds an existing ruleset by name, or null", () => {
  assert.equal(findRulesetId([{ id: 1, name: "other" }, { id: 42, name: "main (lanes)" }], "main (lanes)"), 42);
  assert.equal(findRulesetId([{ id: 1, name: "other" }], "main (lanes)"), null);
  assert.equal(findRulesetId([], "main (lanes)"), null);
  assert.equal(findRulesetId(undefined, "main (lanes)"), null);
});
