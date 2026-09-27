// scripts/lanes/issue-contract.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { issuePlan, MARKER } from "./issue-contract.mjs";

const body = "### Goal\n\ng\n\n### Acceptance criteria\n\n- [ ] a\n\n### Interface contract\n\nnone\n\n### Scope\n\ns\n\n### Blocked by\n\nnone\n\n### Tier\n\nfull\n";

test("a complete task from a trusted author gets its tier and ready; other tier labels go", () => {
  const p = issuePlan(body, ["tier:quick", "bug"], "OWNER");
  assert.deepEqual(p.add, ["tier:full", "ready"]);
  assert.deepEqual(p.remove, ["tier:quick"]);
  assert.ok(p.comment.startsWith(MARKER));
});

test("an incomplete task loses ready and lists what is missing", () => {
  const p = issuePlan(body.replace("\ns\n", "\n_No response_\n"), ["ready", "tier:full"], "OWNER");
  assert.deepEqual(p.remove, ["ready"]);
  assert.match(p.comment, /missing: scope/);
});

test("an issue that is not a task form is left alone", () => {
  assert.equal(issuePlan("just a note", [], "OWNER").isTask, false);
});

// C1: a stranger's complete task must never get `ready`
// R2: hand-adding `ready` cannot fix this — the gate rejects an untrusted author even with `ready` on the issue — so
// the real path is a maintainer filing the task themselves, and the comment must say that, not "mark it ready".
test("a complete task from an untrusted author gets its tier but not ready, and says a maintainer must file it themselves", () => {
  for (const assoc of ["NONE", "FIRST_TIME_CONTRIBUTOR", "CONTRIBUTOR", undefined]) {
    const p = issuePlan(body, ["ready", "tier:quick"], assoc);
    assert.deepEqual(p.add, ["tier:full"], String(assoc));
    assert.ok(p.remove.includes("ready"), String(assoc));
    assert.match(p.comment, /a maintainer must open this task themselves/, String(assoc));
    assert.doesNotMatch(p.comment, /mark it ready/, String(assoc));
  }
});

test("MEMBER and COLLABORATOR are trusted like OWNER", () => {
  for (const assoc of ["MEMBER", "COLLABORATOR"]) {
    assert.deepEqual(issuePlan(body, [], assoc).add, ["tier:full", "ready"], assoc);
  }
});

// I4: a lane's own follow-up issues (label lane-filed) never get `ready` automatically, even from the owner
test("a complete task carrying lane-filed never gets ready, even from the owner", () => {
  const p = issuePlan(body, ["lane-filed", "ready"], "OWNER");
  assert.deepEqual(p.add, ["tier:full"]);
  assert.ok(p.remove.includes("ready"));
  assert.match(p.comment, /lane-filed/);
});
