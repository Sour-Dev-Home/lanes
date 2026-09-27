// scripts/lanes/issue-contract.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { issuePlan, main, MARKER } from "./issue-contract.mjs";

const body = "### Goal\n\ng\n\n### Acceptance criteria\n\n- [ ] a\n\n### Interface contract\n\nnone\n\n### Scope\n\ns\n\n### Blocked by\n\nnone\n\n### Tier\n\nfull\n";

test("a complete task from an author with write access gets its tier and ready; other tier labels go", () => {
  const p = issuePlan(body, ["tier:quick", "bug"], true);
  assert.deepEqual(p.add, ["tier:full", "ready"]);
  assert.deepEqual(p.remove, ["tier:quick"]);
  assert.ok(p.comment.startsWith(MARKER));
});

test("an incomplete task loses ready and lists what is missing", () => {
  const p = issuePlan(body.replace("\ns\n", "\n_No response_\n"), ["ready", "tier:full"], true);
  assert.deepEqual(p.remove, ["ready"]);
  assert.match(p.comment, /missing: scope/);
});

test("an issue that is not a task form is left alone", () => {
  assert.equal(issuePlan("just a note", [], true).isTask, false);
});

// C1: a stranger's complete task must never get `ready`
// R2: hand-adding `ready` cannot fix this — the gate rejects an author without write access even with `ready` on the
// issue — so the real path is a maintainer filing the task themselves, and the comment must say that, not "mark it ready".
test("a complete task from an author without write access gets its tier but not ready, and says a maintainer must file it themselves", () => {
  for (const canWrite of [false, undefined, null, "true", 1]) {
    const p = issuePlan(body, ["ready", "tier:quick"], canWrite);
    assert.deepEqual(p.add, ["tier:full"], String(canWrite));
    assert.ok(p.remove.includes("ready"), String(canWrite));
    assert.match(p.comment, /a maintainer must open this task themselves/, String(canWrite));
    assert.doesNotMatch(p.comment, /mark it ready/, String(canWrite));
  }
});

// I4: a lane's own follow-up issues (label lane-filed) never get `ready` automatically, even from the owner
test("a complete task carrying lane-filed never gets ready, even from the owner", () => {
  const p = issuePlan(body, ["lane-filed", "ready"], true);
  assert.deepEqual(p.add, ["tier:full"]);
  assert.ok(p.remove.includes("ready"));
  assert.match(p.comment, /lane-filed/);
});

// main() looks the author's permission up by login and only then decides; `gh` is faked, so nothing leaves the test.
function fakeGh(permission) {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    if (args[0] === "api" && args[1] === "repos/o/r/collaborators/leo/permission") {
      if (permission instanceof Error) throw permission;
      return JSON.stringify({ permission });
    }
    return "";
  };
  return { run, calls };
}
const env = { REPO: "o/r", ISSUE_NUMBER: "9", ISSUE_BODY: body, ISSUE_LABELS_JSON: "[]", ISSUE_AUTHOR: "leo" };
const labelEdit = (calls) => calls.find((a) => a[0] === "issue" && a[1] === "edit");

test("main adds ready when the issue author has write, maintain or admin permission", () => {
  for (const permission of ["admin", "write"]) {
    const { run, calls } = fakeGh(permission);
    main(env, run);
    assert.deepEqual(labelEdit(calls), ["issue", "edit", "9", "-R", "o/r", "--add-label", "tier:full,ready"], permission);
  }
});

test("main never adds ready for an author with read, triage or no permission", () => {
  for (const permission of ["read", "none"]) {
    const { run, calls } = fakeGh(permission);
    main(env, run);
    assert.deepEqual(labelEdit(calls), ["issue", "edit", "9", "-R", "o/r", "--add-label", "tier:full"], permission);
  }
});

test("main fails closed when the author's permission cannot be read", () => {
  const { run, calls } = fakeGh(new Error("HTTP 403"));
  main(env, run);
  assert.deepEqual(labelEdit(calls), ["issue", "edit", "9", "-R", "o/r", "--add-label", "tier:full"]);
  const { run: run2, calls: calls2 } = fakeGh("admin");
  main({ ...env, ISSUE_AUTHOR: "" }, run2);
  assert.deepEqual(labelEdit(calls2), ["issue", "edit", "9", "-R", "o/r", "--add-label", "tier:full"]);
});
