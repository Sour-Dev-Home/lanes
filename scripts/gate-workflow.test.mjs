// #82: pins what lanes-gate.yml needs for the owner-approval comment, without widening what the gate may do.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const yml = readFileSync(".github/workflows/lanes-gate.yml", "utf8");
const block = (name) => {
  const match = new RegExp(`\\n${name}:\\n((?:  .*\\n)+)`).exec(yml);
  assert.ok(match, `lanes-gate.yml has no top-level ${name} block`);
  return match[1];
};

test("lanes-gate may write issue comments, and its other permissions are unchanged", () => {
  assert.equal(block("permissions"), "  contents: read\n  pull-requests: read\n  issues: write\n  statuses: write\n");
});

test("lanes-gate passes the status event's state to gate.mjs", () => {
  assert.match(yml, /\n {10}STATUS_STATE: \$\{\{ github\.event\.state \}\}\n/);
});

test("lanes-gate still checks out only the default branch", () => {
  const checkouts = yml.match(/uses: actions\/checkout@/g) ?? [];
  assert.equal(checkouts.length, 1);
  const refs = yml.match(/\n\s+ref: .*/g) ?? [];
  assert.deepEqual(refs.map((r) => r.trim()), ["ref: ${{ github.event.repository.default_branch }}"]);
});
