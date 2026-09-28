// scripts/lanes/issue-contract.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { blockerDiff, issuePlan, main, MARKER, MAX_BLOCKERS } from "./issue-contract.mjs";

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

// #136: a lane that found its criteria already met swapped ready for needs-owner; the contract check must not undo it
test("a complete task carrying needs-owner never gets ready, even from the owner, and loses it if present", () => {
  const p = issuePlan(body, ["needs-owner", "ready", "tier:quick"], true);
  assert.deepEqual(p.add, ["tier:full"]);
  assert.deepEqual(p.remove, ["tier:quick", "ready"]);
  assert.match(p.comment, /needs-owner/);
  assert.ok(p.comment.startsWith(MARKER));
});

test("edge: needs-owner without ready adds no ready and removes nothing but stale tiers", () => {
  const p = issuePlan(body, ["needs-owner", "tier:full"], true);
  assert.deepEqual([p.add, p.remove], [["tier:full"], []]);
});

test("edge: needs-owner and lane-filed together still give neither ready, and the comment names lane-filed", () => {
  const p = issuePlan(body, ["needs-owner", "lane-filed", "ready"], true);
  assert.ok(!p.add.includes("ready"));
  assert.ok(p.remove.includes("ready"));
  assert.match(p.comment, /lane-filed/);
});

test("edge: an incomplete task carrying needs-owner still loses ready and lists what is missing", () => {
  const p = issuePlan(body.replace("\ns\n", "\n_No response_\n"), ["needs-owner", "ready"], true);
  assert.deepEqual(p.remove, ["ready"]);
  assert.match(p.comment, /missing: scope/);
});

test("edge: a label that only contains needs-owner in its name does not hold the issue back", () => {
  const p = issuePlan(body, ["not-needs-owner"], true);
  assert.deepEqual(p.add, ["tier:full", "ready"]);
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

// #11: "Blocked by" is the source of truth; GitHub's native blocked-by relationships are a mirror of it.
test("blockerDiff: add only, remove only, both, no change, and none", () => {
  const cur = (...ns) => ns.map((n) => ({ id: 1000 + n, number: n }));
  assert.deepEqual(blockerDiff([3, 4], []), { add: [3, 4], remove: [] });
  assert.deepEqual(blockerDiff([3], cur(3, 5)), { add: [], remove: cur(5) });
  assert.deepEqual(blockerDiff([3, 4], cur(4, 5)), { add: [3], remove: cur(5) });
  assert.deepEqual(blockerDiff([4, 3], cur(3, 4)), { add: [], remove: [] });
  assert.deepEqual(blockerDiff([], cur(3, 4)), { add: [], remove: cur(3, 4) });
});

test("blockerDiff edge: a duplicated wanted number is added once", () => {
  assert.deepEqual(blockerDiff([3, 3], []), { add: [3], remove: [] });
});

test("blockerDiff edge: a current blocker from another repository (number null) is always removed", () => {
  const foreign = { id: 77, number: null };
  assert.deepEqual(blockerDiff([3], [foreign, { id: 3003, number: 3 }]), { add: [], remove: [foreign] });
});

test("blockerDiff edge: empty and missing inputs", () => {
  assert.deepEqual(blockerDiff([], []), { add: [], remove: [] });
  assert.deepEqual(blockerDiff(undefined, undefined), { add: [], remove: [] });
});

/**
 * A fake `gh` for the mirror: `deps` is the current native blocked-by list ([{ id, number, repo }]), `issues` maps a
 * number to { id, pr } (absent = 404), and `fail` holds an Error for the list read or per-id Errors for POST/DELETE.
 */
function fakeMirror({ deps = [], issues = {}, fail = {}, permission = "admin" } = {}) {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    const path = args.find((a) => a.startsWith("repos/")) ?? "";
    const method = args.includes("-X") ? args[args.indexOf("-X") + 1] : "GET";
    if (path === "repos/o/r/collaborators/leo/permission") return JSON.stringify({ permission });
    if (path === "repos/o/r/issues/9/dependencies/blocked_by" && method === "GET") {
      if (fail.deps) throw fail.deps;
      return deps.map((d) => JSON.stringify({ id: d.id, number: d.number, repo: `https://api.github.com/repos/${d.repo ?? "o/r"}` })).join("\n");
    }
    if (path === "repos/o/r/issues/9/dependencies/blocked_by" && method === "POST") {
      const id = Number(args.find((a) => a.startsWith("issue_id=")).slice(9));
      if (fail.post?.[id]) throw fail.post[id];
      return "";
    }
    const del = path.match(/^repos\/o\/r\/issues\/9\/dependencies\/blocked_by\/(\d+)$/);
    if (del && method === "DELETE") {
      if (fail.delete?.[del[1]]) throw fail.delete[del[1]];
      return "";
    }
    const one = path.match(/^repos\/o\/r\/issues\/(\d+)$/);
    if (one && method === "GET") {
      const i = issues[one[1]];
      if (!i) throw Object.assign(new Error("Command failed"), { stderr: "gh: Not Found (HTTP 404)\n" });
      return JSON.stringify({ id: i.id, pr: Boolean(i.pr) });
    }
    return "";
  };
  return { run, calls };
}
const ghError = (stderr) => Object.assign(new Error("Command failed: gh api"), { stderr });
const withBlocked = (b, text) => b.replace("### Blocked by\n\nnone\n", `### Blocked by\n\n${text}\n`);
const methodOf = (a) => (a.includes("-X") ? a[a.indexOf("-X") + 1] : "GET");
const posts = (calls) => calls.filter((a) => methodOf(a) === "POST" && a.some((x) => x.endsWith("/dependencies/blocked_by"))).map((a) => a[a.indexOf("-F") + 1]);
const deletes = (calls) => calls.filter((a) => methodOf(a) === "DELETE").map((a) => a.find((x) => x.startsWith("repos/")));
const commentBody = (calls) => calls.filter((a) => a.some((x) => x.startsWith("body="))).map((a) => a.find((x) => x.startsWith("body=")).slice(5)).at(-1);

test("main reads the native list, POSTs each missing blocker by issue id, and DELETEs each extra one by id", () => {
  const { run, calls } = fakeMirror({ deps: [{ id: 3003, number: 3 }, { id: 5005, number: 5 }], issues: { 3: { id: 3003 }, 4: { id: 4004 } } });
  main({ ...env, ISSUE_BODY: withBlocked(body, "#3, #4") }, run);
  assert.ok(calls.some((a) => a.includes("repos/o/r/issues/9/dependencies/blocked_by") && methodOf(a) === "GET"), "GET the current list");
  // -F (not -f) so issue_id is sent as a JSON number, the issue's id rather than its number
  assert.deepEqual(posts(calls), ["issue_id=4004"]);
  assert.deepEqual(deletes(calls), ["repos/o/r/issues/9/dependencies/blocked_by/5005"]);
});

test("main edge: a Blocked by field naming only foreign issues still removes stale native relationships", () => {
  // Nothing in the field resolves to a native blocker (both refs are foreign), so `wanted` is empty and every
  // existing native relationship is stale and must be removed, same as if the field said `none`.
  const { run, calls } = fakeMirror({ deps: [{ id: 3003, number: 3 }] });
  main({ ...env, ISSUE_BODY: withBlocked(body, "other/repo#12, another/repo#7") }, run);
  assert.deepEqual(posts(calls), []);
  assert.deepEqual(deletes(calls), ["repos/o/r/issues/9/dependencies/blocked_by/3003"]);
  const c = commentBody(calls);
  assert.match(c, /other\/repo#12\b.*another repository/);
  assert.match(c, /another\/repo#7\b.*another repository/);
});

test("main: Blocked by none removes every native relationship, including one in another repository", () => {
  const { run, calls } = fakeMirror({ deps: [{ id: 3003, number: 3 }, { id: 88, number: 3, repo: "x/y" }] });
  main(env, run);
  assert.deepEqual(posts(calls), []);
  assert.deepEqual(deletes(calls), ["repos/o/r/issues/9/dependencies/blocked_by/3003", "repos/o/r/issues/9/dependencies/blocked_by/88"]);
});

test("main edge: a native blocker whose repository URL differs only in case counts as this repository", () => {
  const { run, calls } = fakeMirror({ deps: [{ id: 3003, number: 3, repo: "O/R" }], issues: { 3: { id: 3003 } } });
  main({ ...env, ISSUE_BODY: withBlocked(body, "#3") }, run);
  assert.deepEqual(posts(calls), []);
  assert.deepEqual(deletes(calls), []);
});

test("main: a relationship added by hand but absent from the form is removed", () => {
  const { run, calls } = fakeMirror({ deps: [{ id: 3003, number: 3 }, { id: 6006, number: 6 }], issues: { 3: { id: 3003 } } });
  main({ ...env, ISSUE_BODY: withBlocked(body, "#3") }, run);
  assert.deepEqual(posts(calls), []);
  assert.deepEqual(deletes(calls), ["repos/o/r/issues/9/dependencies/blocked_by/6006"]);
});

test("main mirrors for a task whose other fields are incomplete", () => {
  const incomplete = withBlocked(body, "#3").replace("\ns\n", "\n_No response_\n");
  for (const permission of ["admin", "write"]) {
    const { run, calls } = fakeMirror({ issues: { 3: { id: 3003 } }, permission });
    main({ ...env, ISSUE_BODY: incomplete }, run);
    assert.deepEqual(posts(calls), ["issue_id=3003"], permission);
  }
});

// Security review: the mirror uses the job's issues:write token, so like `ready` it acts only for a trusted author.
test("main edge: an author without write access gets no mirror call, and the comment says why", () => {
  for (const permission of ["read", "none"]) {
    const { run, calls } = fakeMirror({ deps: [{ id: 5005, number: 5 }], issues: { 3: { id: 3003 } }, permission });
    main({ ...env, ISSUE_BODY: withBlocked(body, "#3") }, run);
    assert.ok(!calls.some((a) => a.some((x) => String(x).includes("dependencies"))), permission);
    assert.match(commentBody(calls), /not mirrored.*write access/, permission);
  }
});

test("main edge: more than MAX_BLOCKERS distinct blockers mirror nothing and say so; exactly MAX_BLOCKERS are mirrored", () => {
  const list = (k) => Array.from({ length: k }, (_, i) => `#${100 + i}`).join(", ");
  const issues = Object.fromEntries(Array.from({ length: MAX_BLOCKERS + 1 }, (_, i) => [100 + i, { id: 10000 + i }]));
  const over = fakeMirror({ deps: [{ id: 5005, number: 5 }], issues });
  main({ ...env, ISSUE_BODY: withBlocked(body, list(MAX_BLOCKERS + 1)) }, over.run);
  assert.ok(!over.calls.some((a) => a.some((x) => String(x).includes("dependencies"))));
  assert.match(commentBody(over.calls), new RegExp(`more than ${MAX_BLOCKERS} blockers`));
  const at = fakeMirror({ issues });
  main({ ...env, ISSUE_BODY: withBlocked(body, list(MAX_BLOCKERS)) }, at.run);
  assert.equal(posts(at.calls).length, MAX_BLOCKERS);
});

test("main edge: a token-like string in a gh error is masked before it reaches the public comment", () => {
  const { run, calls } = fakeMirror({ fail: { deps: ghError("gh: bad credentials ghp_abcDEF123456 and github_pat_11ABC_xyz (HTTP 401)\n") } });
  main({ ...env, ISSUE_BODY: withBlocked(body, "#3") }, run);
  const c = commentBody(calls);
  assert.doesNotMatch(c, /abcDEF123456|11ABC_xyz/);
  assert.match(c, /ghp_\*\*\*.*github_pat_\*\*\*/);
});

test("main runs no mirror call for a non-task issue", () => {
  const { run, calls } = fakeMirror({ deps: [{ id: 3003, number: 3 }] });
  main({ ...env, ISSUE_BODY: "just a note, blocked by #3" }, run);
  assert.deepEqual(calls, []);
});

test("main edge: a Blocked by that does not parse (empty, or no #N) leaves the native list alone", () => {
  for (const text of ["_No response_", "the login issue"]) {
    const { run, calls } = fakeMirror({ deps: [{ id: 3003, number: 3 }] });
    main({ ...env, ISSUE_BODY: withBlocked(body, text) }, run);
    assert.ok(!calls.some((a) => a.some((x) => String(x).includes("dependencies"))), text);
    assert.ok(commentBody(calls).startsWith(MARKER), text);
  }
});

test("main: a blocker that is a PR, nonexistent, or in another repository is named in the comment and does not fail the job", () => {
  const { run, calls } = fakeMirror({ issues: { 3: { id: 3003 }, 7: { id: 7007, pr: true } } });
  main({ ...env, ISSUE_BODY: withBlocked(body, "#3, #7, #404, other/repo#12") }, run);
  assert.deepEqual(posts(calls), ["issue_id=3003"]);
  const c = commentBody(calls);
  assert.ok(c.startsWith(MARKER));
  assert.match(c, /#7\b.*pull request/);
  assert.match(c, /#404\b.*not found/i);
  assert.match(c, /other\/repo#12\b.*another repository/);
  assert.doesNotMatch(c, /#12\b.*not found/i, "the cross-repository reference is not looked up here as #12");
  assert.ok(labelEdit(calls), "labels still set");
});

// Bug: `owner/repo#N` naming this repository itself (e.g. pasted from GitHub's autocomplete) is not foreign, and must
// still be linked like a bare #N.
test("main edge: an owner/repo#N reference to this repository itself is linked, not treated as foreign", () => {
  const { run, calls } = fakeMirror({ issues: { 3: { id: 3003 } } });
  main({ ...env, ISSUE_BODY: withBlocked(body, "o/r#3") }, run);
  assert.deepEqual(posts(calls), ["issue_id=3003"]);
  assert.doesNotMatch(commentBody(calls), /another repository/);
});

test("main edge: a blocker the POST rejects is named in the comment; the others are still linked", () => {
  const { run, calls } = fakeMirror({ issues: { 3: { id: 3003 }, 4: { id: 4004 } }, fail: { post: { 3003: ghError("gh: Validation Failed (HTTP 422)\n") } } });
  main({ ...env, ISSUE_BODY: withBlocked(body, "#3, #4") }, run);
  assert.deepEqual(posts(calls), ["issue_id=3003", "issue_id=4004"]);
  assert.match(commentBody(calls), /#3\b.*HTTP 422/);
});

test("main edge: an issue listed as blocking itself is named in the comment, not linked", () => {
  const { run, calls } = fakeMirror({ issues: { 9: { id: 9009 } } });
  main({ ...env, ISSUE_BODY: withBlocked(body, "#9") }, run);
  assert.deepEqual(posts(calls), []);
  assert.match(commentBody(calls), /#9\b.*itself/);
});

test("main: a failing dependencies API is reported in the comment and the labels are still set", () => {
  const { run, calls } = fakeMirror({ issues: { 3: { id: 3003 } }, fail: { deps: ghError("gh: Not Found (HTTP 404)\n") } });
  main({ ...env, ISSUE_BODY: withBlocked(body, "#3") }, run);
  assert.deepEqual(labelEdit(calls), ["issue", "edit", "9", "-R", "o/r", "--add-label", "tier:full,ready"]);
  assert.match(commentBody(calls), /dependencies API.*HTTP 404/i);
  assert.deepEqual(posts(calls), []);
});

test("main edge: a failed DELETE is named in the comment", () => {
  const { run, calls } = fakeMirror({ deps: [{ id: 5005, number: 5 }], fail: { delete: { 5005: ghError("gh: Forbidden (HTTP 403)\n") } } });
  main(env, run);
  assert.match(commentBody(calls), /#5\b.*HTTP 403/);
});

test("main edge: an error put in the comment is its first line only, bounded in length", () => {
  const { run, calls } = fakeMirror({ fail: { deps: ghError("gh: " + "a".repeat(500) + " (HTTP 500)\nsecond line\n") } });
  main({ ...env, ISSUE_BODY: withBlocked(body, "#3") }, run);
  const line = commentBody(calls).split("\n").find((l) => /dependencies API/i.test(l));
  assert.ok(line.length <= 300, String(line.length));
  assert.doesNotMatch(commentBody(calls), /second line/);
});

test("main edge: an error without stderr still yields a one-line reason", () => {
  const { run, calls } = fakeMirror({ fail: { deps: new Error("spawn gh ENOENT") } });
  main({ ...env, ISSUE_BODY: withBlocked(body, "#3") }, run);
  assert.match(commentBody(calls), /dependencies API.*ENOENT/);
});
