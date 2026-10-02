// scripts/lanes/lib.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEAM_REQUIRED_MESSAGE, identityRefusal,adrGoverns, pendingFileHash, parsePending, pendingReuseBlockedBy, botIssueReleased, readBotIssueRelease, nativeCodeOwnerApproval, parseCodeOwnerUsers, REUSABLE_REVIEWERS, REVIEWERS, reusableReviewers, reviewerNames, authorCanWrite, classifyFiles, compileConfig, isLaneBot, parseIdentity, trustedStatuses, diffFingerprint, gateDecision, interfaceContractOf, interfacePaths, laneIssueOf, loadAdrs, loadConfig, moduleMapProblem, parseAdr, parseValidation, parseVerdictComment, requiredReviewers, reviewContext, reviewersReport, testHunterReusable } from "./lib.mjs";

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

test("laneIssueOf reads the lane-<N> name first, then an issue-<N> folder in the cwd, else null", () => {
  const cwd = "C:\\repo\\.claude\\worktrees\\issue-12-slug";
  assert.equal(laneIssueOf({ kind: "background", name: "lane-338", cwd: "C:\\repo" }), 338);
  assert.equal(laneIssueOf({ kind: "background", name: "lane-5", cwd }), 5, "the name wins over the folder");
  assert.equal(laneIssueOf({ kind: "background", name: "reactapps-dc", cwd }), null, "a session with another name never maps (#494)");
  assert.equal(laneIssueOf({ kind: "background", name: "owner-session catch-up", cwd }), null);
  assert.equal(laneIssueOf({ kind: "background", name: "", cwd }), 12, "an empty name is no name");
  assert.equal(laneIssueOf({ kind: "background", cwd }), 12);
  assert.equal(laneIssueOf({ kind: "background", cwd: "C:\\repo\\.claude\\worktrees\\issue-7" }), 7);
  assert.equal(laneIssueOf({ name: "lane-9", cwd: "C:\\repo" }), 9, "a session with no kind (sessionsFrom output) still counts");
  assert.equal(laneIssueOf({ kind: "background", name: "other", cwd: "C:\\repo" }), null);
});

test("laneIssueOf ignores names that only look like lane names, and non-background sessions", () => {
  for (const name of ["lane-", "lane-0", "lane-07", "lane-12x", "xlane-12", "Lane-12", "lane-12-b", " lane-12", "lane--3"]) {
    assert.equal(laneIssueOf({ kind: "background", name, cwd: "C:\\repo" }), null, name);
  }
  assert.equal(laneIssueOf({ kind: "interactive", name: "lane-12", cwd: "C:\\repo" }), null);
  assert.equal(laneIssueOf({ kind: "interactive", cwd: "C:\\repo\\.claude\\worktrees\\issue-12-x" }), null);
  assert.equal(laneIssueOf({ kind: "background", name: "lane-99999999999999999999", cwd: "C:\\repo" }), null, "unsafe integer");
  for (const bad of [null, undefined, {}, { name: 5, cwd: 7 }, "lane-3"]) assert.equal(laneIssueOf(bad), null);
});

test("laneIssueOf takes the folder directly under the last .claude/worktrees, not lane-shaped parents or children", () => {
  assert.equal(laneIssueOf({ kind: "background", cwd: "C:\\issue-3\\repo\\.claude\\worktrees\\issue-8-x\\issue-9-notes" }), 8);
  assert.equal(laneIssueOf({ kind: "background", cwd: "/work/issue-4-x/repo/sub" }), 4, "no worktrees folder: the first lane-shaped one");
  assert.equal(laneIssueOf({ kind: "background", cwd: "C:\\repo\\.claude\\worktrees\\scratch" }), null);
});

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

// ADR 0022 part 1 and 6: a bot-authored issue is trusted once a write-access actor removed lane-filed. Block-scoped so its
// fixtures do not clash with the module-level BOT further down.
{
const TEAM = { profile: "team", app: { botLogin: "lanes-app[bot]" } };
const BOT = { login: "lanes-app[bot]", type: "Bot" };
const WRITERS = new Set(["owner"]);
const canWrite = (login) => WRITERS.has(login);
const botIssue = (labels = []) => ({ user: BOT, labels });
const ev = (id, event, login, at = "2026-10-01T10:00:00Z") => ({ id, event, created_at: at, label: { name: "lane-filed" }, actor: { login } });
const RELEASED = [ev(1, "labeled", BOT.login), ev(2, "unlabeled", "owner", "2026-10-01T10:00:00Z")];
const released = (events = RELEASED, edit = null, issue = botIssue(), identity = TEAM) => botIssueReleased(identity, issue, events, edit, canWrite);

test("botIssueReleased: an owner release is trusted", () => {
  assert.equal(released(), true);
  assert.equal(released(RELEASED, null, botIssue([{ name: "ready" }])), true, "labels as objects");
});

test("botIssueReleased: the bot removing its own label, or re-adding it after the owner, is untrusted", () => {
  assert.equal(released([ev(1, "labeled", BOT.login), ev(2, "unlabeled", BOT.login)]), false);
  assert.equal(released([...RELEASED, ev(3, "labeled", BOT.login)]), false, "re-added and still labelled by events");
  assert.equal(released([...RELEASED, ev(3, "labeled", BOT.login), ev(4, "unlabeled", BOT.login)]), false);
});

test("botIssueReleased: a re-add followed by an owner removal is trusted, by event id not array order", () => {
  const events = [...RELEASED, ev(3, "labeled", BOT.login), ev(4, "unlabeled", "owner")];
  assert.equal(released(events), true);
  assert.equal(released([events[3], events[2], events[1], events[0]]), true, "reversed input");
});

test("botIssueReleased: a body edit after the release needs a write-access editor", () => {
  assert.equal(released(RELEASED, { lastEditedAt: "2026-10-01T10:05:00Z", editor: { login: BOT.login } }), false, "bot edit after release");
  assert.equal(released(RELEASED, { lastEditedAt: "2026-10-01T10:05:00Z", editor: { login: "owner" } }), true, "owner edit after a bot edit");
  const slug = BOT.login.replace("[bot]", "");
  const anyone = () => true;
  assert.equal(botIssueReleased(TEAM, botIssue(), RELEASED, { lastEditedAt: "2026-10-01T10:05:00Z", editor: { login: slug } }, anyone), false, "GraphQL bot editor without [bot]");
  assert.equal(botIssueReleased(TEAM, botIssue(), [ev(1, "labeled", BOT.login), ev(2, "unlabeled", slug)], null, anyone), false, "bare bot slug as releaser");
  assert.equal(released(RELEASED, { lastEditedAt: "2026-10-01T09:59:00Z", editor: { login: BOT.login } }), true, "edit before release");
});

test("botIssueReleased: an issue that never had lane-filed, or still has it, is untrusted", () => {
  assert.equal(released([]), false);
  assert.equal(released([ev(5, "labeled", "owner")].map((e) => ({ ...e, label: { name: "other" } }))), false, "other labels only");
  assert.equal(released(RELEASED, null, botIssue(["lane-filed"])), false);
  assert.equal(released(RELEASED, null, botIssue([{ name: "lane-filed" }])), false);
});

test("botIssueReleased: solo, a second bot, a human author and a non-Bot type are untrusted", () => {
  assert.equal(released(RELEASED, null, botIssue(), { profile: "solo" }), false);
  assert.equal(released(RELEASED, null, { user: { login: "other-app[bot]", type: "Bot" }, labels: [] }), false);
  assert.equal(released(RELEASED, null, { user: { login: "owner", type: "User" }, labels: [] }), false);
  assert.equal(released(RELEASED, null, { user: { login: BOT.login, type: "User" }, labels: [] }), false);
});

test("edge: botIssueReleased fails closed on a missing field or an unexpected shape", () => {
  const edited = (editor) => ({ lastEditedAt: "2026-10-01T10:05:00Z", editor });
  assert.equal(released(RELEASED, edited(undefined)), false, "missing editor");
  assert.equal(released(RELEASED, edited(null)), false, "null editor");
  assert.equal(released(RELEASED, edited({})), false, "editor with no login");
  assert.equal(released(RELEASED, { editor: { login: "owner" } }), false, "no lastEditedAt");
  assert.equal(released(RELEASED, { lastEditedAt: "soon", editor: { login: "owner" } }), false, "bad date");
  assert.equal(released(RELEASED, "edited"), false);
  assert.equal(botIssueReleased(TEAM, botIssue(), RELEASED, undefined, canWrite), false, "edit undefined is not a never-edited null");
  assert.equal(released(RELEASED, { lastEditedAt: "2026-10-01T10:00:00Z", editor: { login: BOT.login } }), false, "same second as release");
  assert.equal(released(RELEASED, { lastEditedAt: "2026-10-01T10:00:00Z", editor: { login: "owner" } }), true);
  assert.equal(released("events"), false);
  assert.equal(released([null]), false);
  assert.equal(released([ev(1, "labeled", BOT.login), { ...ev(2, "unlabeled", "owner"), id: "2" }]), false, "string id");
  assert.equal(released([ev(1, "labeled", BOT.login), { ...ev(2, "unlabeled", "owner"), created_at: undefined }]), false);
  assert.equal(released([ev(1, "labeled", BOT.login), { ...ev(2, "unlabeled", undefined) }]), false, "no actor");
  assert.equal(released(RELEASED, null, { user: BOT }), false, "no labels");
  assert.equal(released(RELEASED, null, botIssue([5])), false, "label of unknown shape");
  assert.equal(released(RELEASED, null, null), false);
  assert.equal(botIssueReleased(TEAM, botIssue(), RELEASED, null, undefined), false, "no canWrite");
  assert.equal(botIssueReleased(TEAM, botIssue(), RELEASED, null, () => "true"), false, "canWrite must be exactly true");
  assert.equal(botIssueReleased(undefined, botIssue(), RELEASED, null, canWrite), false);
  assert.equal(botIssueReleased(TEAM, botIssue(), RELEASED, null, () => { throw new Error("boom"); }), false);
});

const issueReply = { user: BOT, labels: [] };
const readApi = ({ issue = issueReply, events = RELEASED, graphql = { data: { repository: { issue: { lastEditedAt: null, editor: null } } } }, fail } = {}) => {
  const calls = [];
  const api = (args) => {
    calls.push(args);
    if (fail?.(args)) throw new Error("HTTP 500");
    if (args[0] === "graphql") return typeof graphql === "string" ? graphql : JSON.stringify(graphql);
    if (args[0].endsWith("/events")) return typeof events === "string" ? events : events.map((e) => JSON.stringify(e)).join("\n");
    if (args[0].includes("/collaborators/")) return JSON.stringify({ permission: WRITERS.has(args[0].split("/")[4]) ? "write" : "read" });
    return typeof issue === "string" ? issue : JSON.stringify(issue);
  };
  return { api, calls };
};

test("readBotIssueRelease: reads the issue, its events and its last edit, and trusts an owner release", () => {
  const { api, calls } = readApi();
  assert.equal(readBotIssueRelease(api, TEAM, "o/r", 7), true);
  assert.equal(calls[0][0], "repos/o/r/issues/7");
  const events = calls.find((a) => a[0] === "repos/o/r/issues/7/events");
  assert.ok(events.includes("--paginate"));
  const graphql = calls.find((a) => a[0] === "graphql");
  assert.ok(graphql.some((a) => a.includes("lastEditedAt") && a.includes("editor { login }")));
  assert.deepEqual(calls.filter((a) => a[0].includes("/collaborators/")).map((a) => a[0]), ["repos/o/r/collaborators/owner/permission"]);
});

test("readBotIssueRelease: solo, or team with no bot login, returns false with no API call", () => {
  for (const identity of [{ profile: "solo" }, undefined, { profile: "team" }, { profile: "team", app: { botLogin: "" } }]) {
    const { api, calls } = readApi();
    assert.equal(readBotIssueRelease(api, identity, "o/r", 7), false);
    assert.equal(calls.length, 0);
  }
});

test("readBotIssueRelease: a post-release bot edit read from GraphQL is untrusted, an owner edit trusted", () => {
  const edit = (login, at = "2026-10-01T11:00:00Z") => ({ data: { repository: { issue: { lastEditedAt: at, editor: login && { login } } } } });
  assert.equal(readBotIssueRelease(readApi({ graphql: edit(BOT.login) }).api, TEAM, "o/r", 7), false);
  assert.equal(readBotIssueRelease(readApi({ graphql: edit("owner") }).api, TEAM, "o/r", 7), true);
});

test("edge: readBotIssueRelease fails closed on an API error, bad JSON, a missing editor or a truncated page", () => {
  const read = (opts) => readBotIssueRelease(readApi(opts).api, TEAM, "o/r", 7);
  assert.equal(read({ fail: (a) => a[0] === "repos/o/r/issues/7" }), false, "issue read error");
  assert.equal(read({ fail: (a) => a[0].endsWith("/events") }), false, "events read error");
  assert.equal(read({ fail: (a) => a[0] === "graphql" }), false, "graphql error");
  assert.equal(read({ fail: (a) => a[0].includes("/collaborators/") }), false, "permission error");
  assert.equal(read({ issue: "not json" }), false);
  assert.equal(read({ issue: "null" }), false);
  assert.equal(read({ events: `${JSON.stringify(RELEASED[0])}\n{"id":2,"event":"unla` }), false, "truncated page");
  assert.equal(read({ graphql: "not json" }), false);
  assert.equal(read({ graphql: { data: { repository: { issue: null } } } }), false);
  assert.equal(read({ graphql: { errors: [{ message: "x" }] } }), false);
  assert.equal(read({ graphql: { data: { repository: { issue: { lastEditedAt: "2026-10-01T11:00:00Z" } } } } }), false, "missing editor");
  assert.equal(read({ graphql: { data: { repository: { issue: { editor: null } } } } }), false, "missing lastEditedAt");
  assert.equal(read({ issue: { user: { login: "other-app[bot]", type: "Bot" }, labels: [] } }), false, "a second bot");
  assert.equal(read({ issue: { user: BOT, labels: [{ name: "lane-filed" }] } }), false, "still labelled");
  assert.equal(read({ events: [] }), false, "never had lane-filed");
  assert.equal(readBotIssueRelease(readApi().api, TEAM, "not-a-repo", 7), false);
  assert.equal(readBotIssueRelease(readApi().api, TEAM, "o/r", "7"), false);
});
}

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

test("compileConfig defaults paths.owner to [] and rejects a non-array one", () => {
  const paths = { skip: [], contract: [], sensitive: [], ui: [] };
  assert.deepEqual(compileConfig({ requiredChecks: ["verify"], paths }).paths.owner, []);
  assert.equal(classifyFiles(["scripts/lanes/gate.mjs"], compileConfig({ requiredChecks: ["verify"], paths })).owner, false);
  for (const owner of ["^docs/adr/", { a: 1 }, null, 3]) {
    assert.throws(() => compileConfig({ requiredChecks: ["verify"], paths: { ...paths, owner } }), /paths\.owner/, String(owner));
  }
});

test("compileConfig rejects an owner entry that is not a valid regex string", () => {
  const paths = { skip: [], contract: [], sensitive: [], ui: [] };
  assert.throws(() => compileConfig({ requiredChecks: ["verify"], paths: { ...paths, owner: ["^docs/("] } }));
});

test("classifyFiles reports owner when any file matches paths.owner", () => {
  const withOwner = compileConfig({ requiredChecks: ["verify"], paths: { skip: ["^docs/"], contract: [], sensitive: [], ui: [], owner: ["^docs/adr/"] } });
  assert.equal(classifyFiles(["docs/adr/0003-x.md"], withOwner).owner, true);
  assert.equal(classifyFiles(["docs/a.md", "docs/adr/0003-x.md"], withOwner).owner, true);
  assert.equal(classifyFiles(["docs/a.md"], withOwner).owner, false);
  assert.equal(classifyFiles([], withOwner).owner, false);
  // An owner-only file that is also a skip path stays skipOnly: owner-only makes a PR wait, it never fails skip.
  assert.equal(classifyFiles(["docs/adr/0003-x.md"], withOwner).skipOnly, true);
});

// ADR 0002: every regex in the real paths.owner, with a path it must match and a near-miss that is not owner-only.
const OWNER_SAMPLES = {
  "^scripts/lanes/(gate|lib|post-review|issue-contract)(\\.test)?\\.mjs$": ["scripts/lanes/post-review.test.mjs", "scripts/lanes/gatekeeper.mjs"],
  "^scripts/lanes/gate-decision\\.test\\.mjs$": ["scripts/lanes/gate-decision.test.mjs", "scripts/lanes/gate-decision.mjs"],
  "^scripts/lanes/workflow\\.test\\.mjs$": ["scripts/lanes/workflow.test.mjs", "scripts/lanes/workflow.mjs"],
  "^scripts/lanes/contracts\\.test\\.mjs$": ["scripts/lanes/contracts.test.mjs", "scripts/lanes/contracts.test.mjs.bak"],
  "^scripts/lanes/start-guard(\\.test)?\\.mjs$": ["scripts/lanes/start-guard.test.mjs", "scripts/lanes/start-guards.mjs"],
  "^scripts/lanes/shell-lex(\\.test|\\.fixtures)?\\.mjs$": ["scripts/lanes/shell-lex.fixtures.mjs", "scripts/lanes/shell-lexer.mjs"],
  "^scripts/lanes/(install|setup-repo|new-project)(\\.test)?\\.mjs$": ["scripts/lanes/setup-repo.mjs", "scripts/lanes/new-project-x.mjs"],
  "^scripts/gate-workflow\\.test\\.mjs$": ["scripts/gate-workflow.test.mjs", "scripts/gate-workflow.test.mjs.bak"],
  "^\\.claude/settings\\.json$": [".claude/settings.json", ".claude/settings.local.json"],
  "^\\.github/": [".github/workflows/verify.yml", "docs/github/x.md"],
  "^\\.githooks/": [".githooks/pre-push", "scripts/githooks/x.mjs"],
  "^lanes\\.config\\.json$": ["lanes.config.json", "templates/lanes.config.json"],
  "^\\.claude/agents/": [".claude/agents/test-hunter.md", ".claude/agents.md"],
  "^\\.claude/commands/(lane|night|approve)\\.md$": [".claude/commands/night.md", ".claude/commands/lanes.md"],
  "^docs/adr/": ["docs/adr/0003-x.md", "docs/adrs.md"],
  "^package(-lock)?\\.json$": ["package-lock.json", "frontend/package.json"],
  "(^|/)(pnpm-lock\\.yaml|yarn\\.lock)$": ["frontend/yarn.lock", "pnpm-lock.yaml.bak"],
  "^vendor/": ["vendor/agent-skills/VENDORED.md", "src/vendor/x.ts"],
  "(^|/)CLAUDE\\.md$": ["backend/CLAUDE.md", "docs/NOTCLAUDE.md"],
  "^\\.gitattributes$": [".gitattributes", "src/.gitattributes"],
  "^lanes\\.lock\\.json$": ["lanes.lock.json", "sub/lanes.lock.json"],
  "^scripts/preflight\\.mjs$": ["scripts/preflight.mjs", "scripts/preflight.test.mjs"],
  "(^|/)\\.env": [".env.local", "src/environment.ts"],
  "(^|/)auth/": ["src/auth/login.ts", "src/oauth/x.ts"],
  "(^|/)secrets?/": ["secrets/key.txt", "src/secretsauce/x.ts"],
  "^deploy/": ["deploy/prod.sh", "docs/deploy/x.md"],
};

test("every regex in lanes.config.json paths.owner matches its sample and not its near-miss", () => {
  const raw = JSON.parse(readFileSync("lanes.config.json", "utf8"));
  const real = loadConfig();
  assert.ok(raw.paths.owner.includes("^docs/adr/"), "docs/adr/ is owner-only");
  assert.deepEqual([...raw.paths.owner].sort(), Object.keys(OWNER_SAMPLES).sort(), "each owner regex has a sample row");
  for (const source of raw.paths.owner) {
    const [sample, nearMiss] = OWNER_SAMPLES[source];
    const re = new RegExp(source);
    assert.equal(re.test(sample), true, `${source} should match ${sample}`);
    assert.equal(re.test(nearMiss), false, `${source} should not match ${nearMiss}`);
    assert.equal(classifyFiles([sample], real).owner, true, sample);
    assert.equal(classifyFiles([nearMiss], real).owner, false, nearMiss);
  }
});

test("the real config: start-guard.mjs and contracts.test.mjs are owner-only, reviewers.mjs is not (ADR 0003)", () => {
  const real = loadConfig();
  for (const file of ["scripts/lanes/contracts.test.mjs", "scripts/lanes/start-guard.mjs", "scripts/lanes/start-guard.test.mjs"]) {
    assert.equal(classifyFiles([file], real).owner, true, file);
  }
  for (const file of [
    "scripts/lanes/reviewers.mjs",
    "scripts/lanes/reviewers.test.mjs",
    "scripts/lanes/contracts.mjs",
    "scripts/lanes/start-guard.mjs.orig",
    "scripts/lanes/start.mjs",
    // edge: the new regexes are anchored to scripts/lanes/ exactly, not any nested directory under it.
    "scripts/lanes/sub/contracts.test.mjs",
    "scripts/lanes/sub/start-guard.mjs",
  ]) {
    assert.equal(classifyFiles([file], real).owner, false, file);
  }
});

test("the real config: scripts/gate-workflow.test.mjs is owner-only, near-misses are not (ADR 0002)", () => {
  const real = loadConfig();
  assert.equal(classifyFiles(["scripts/gate-workflow.test.mjs"], real).owner, true);
  for (const file of [
    "scripts/gate-workflow.mjs",
    "scripts/gate-workflow.test.mjs.bak",
    // edge: anchored to scripts/ exactly, not a nested directory or another root.
    "scripts/lanes/gate-workflow.test.mjs",
    "docs/scripts/gate-workflow.test.mjs",
  ]) {
    assert.equal(classifyFiles([file], real).owner, false, file);
  }
});

test("ADR 0002 lists scripts/gate-workflow.test.mjs among the owner-only paths", () => {
  const adr = readFileSync("docs/adr/0002-owner-only-paths.md", "utf8");
  assert.ok(adr.includes("`scripts/gate-workflow.test.mjs`"), "ADR 0002's list names the file");
});

test("ADR 0003 is accepted, parses, and governs lanes.config.json", () => {
  const adr = parseAdr(readFileSync("docs/adr/0003-owner-only-amendment.md", "utf8"));
  assert.equal(adr.error, undefined, adr.error);
  assert.equal(adr.number, 3);
  assert.equal(adr.status, "accepted");
  assert.deepEqual(adr.governs, ["lanes.config.json"]);
  assert.ok(adrGoverns(loadAdrs(), "lanes.config.json").includes(3));
});

test("the real config: tooling scripts and non-lane commands are sensitive but not owner-only", () => {
  const real = loadConfig();
  for (const file of ["scripts/lanes/status.mjs", "scripts/lanes/blockers.mjs", ".claude/commands/status.md", ".claude/hooks/notify.mjs"]) {
    const cls = classifyFiles([file], real);
    assert.equal(cls.sensitive, true, file);
    assert.equal(cls.owner, false, file);
  }
});

test("docs and tests only are skipOnly", () => {
  assert.deepEqual(classifyFiles(["docs/a.md", "src/x.test.ts"], config), { skipOnly: true, contract: false, sensitive: false, ui: false, owner: false, adr: [], architecture: false });
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
  assert.deepEqual(cls, { skipOnly: false, contract: true, sensitive: false, ui: true, owner: false, adr: [], architecture: false });
});

test("required reviewers by tier and class", () => {
  const none = { skipOnly: false, contract: false, sensitive: false, ui: false, owner: false };
  assert.deepEqual(requiredReviewers("skip", none), []);
  // Owner-only adds no reviewer at any tier.
  for (const tier of ["skip", "quick", "full"]) assert.deepEqual(requiredReviewers(tier, { ...none, owner: true }), requiredReviewers(tier, none), tier);
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

// ---- Verdict comments ----

const VSHA = "0123456789abcdef0123456789abcdef01234567";
const vjson = { reviewer: "security-reviewer", verdict: "failure", summary: "x", criteria: [], findings: [] };
const vcomment = (marker, json = JSON.stringify(vjson, null, 2)) => `<!-- lanes:verdict ${marker} -->\n\`\`\`json\n${json}\n\`\`\``;

test("parseVerdictComment reads the reviewer, the SHA and the parsed verdict", () => {
  assert.deepEqual(parseVerdictComment(vcomment(`security-reviewer ${VSHA}`)), { reviewer: "security-reviewer", sha: VSHA, verdict: vjson });
});

test("parseVerdictComment accepts CRLF bodies and lower-cases the SHA", () => {
  const body = vcomment(`security-reviewer ${VSHA.toUpperCase()}`).replace(/\n/g, "\r\n");
  assert.deepEqual(parseVerdictComment(body), { reviewer: "security-reviewer", sha: VSHA, verdict: vjson });
});

test("parseVerdictComment returns null for anything that is not a well-formed verdict comment", () => {
  const cases = {
    "no marker": "```json\n{}\n```",
    "empty body": "",
    "not a string": undefined,
    "unknown reviewer": vcomment(`owner ${VSHA}`, JSON.stringify({ ...vjson, reviewer: "owner" })),
    "short SHA": vcomment("security-reviewer abc1234"),
    "non-hex SHA": vcomment(`security-reviewer ${"g".repeat(40)}`),
    "41-char SHA": vcomment(`security-reviewer ${VSHA}0`),
    "extra marker token": vcomment(`security-reviewer ${VSHA} extra`),
    "no JSON fence": `<!-- lanes:verdict security-reviewer ${VSHA} -->\n${JSON.stringify(vjson)}`,
    "JSON that does not parse": vcomment(`security-reviewer ${VSHA}`, "{ not json"),
    "JSON that is not an object": vcomment(`security-reviewer ${VSHA}`, "[]"),
    "marker reviewer differs from the JSON": vcomment(`test-hunter ${VSHA}`),
    "marker not at the start": `quoted:\n${vcomment(`security-reviewer ${VSHA}`)}`,
    "trailing text after the closing fence": `${vcomment(`security-reviewer ${VSHA}`)}\nedited: please ignore`,
  };
  for (const [name, body] of Object.entries(cases)) assert.equal(parseVerdictComment(body), null, name);
});

test("an old-format marker without a SHA parses with sha null", () => {
  assert.deepEqual(parseVerdictComment(vcomment("security-reviewer")), { reviewer: "security-reviewer", sha: null, verdict: vjson });
});

// The ADR format contract: contracts/adr-template.md.
const adr = ({ title = "# 0007: Cache the snapshot", status = "Status: accepted", governs = "- scripts/lanes/\n- contracts/adr-template.md" } = {}) =>
  `${title}\n\n${status}\n\n## Context\n\nWhy.\n\n## Decision\n\nWhat.\n\n## Decisions for the owner\n\nnothing\n\n## Consequences\n\nThen.\n\n## Governs\n\n${governs}\n`;

test("parseAdr reads number, title, status and governs", () => {
  assert.deepEqual(parseAdr(adr()), { number: 7, title: "Cache the snapshot", status: "accepted", governs: ["scripts/lanes/", "contracts/adr-template.md"] });
});

test("parseAdr accepts each status", () => {
  assert.equal(parseAdr(adr({ status: "Status: proposed" })).status, "proposed");
  assert.equal(parseAdr(adr({ status: "Status: accepted" })).status, "accepted");
  const sup = parseAdr(adr({ status: "Status: superseded by 0012" }));
  assert.equal(sup.status, "superseded");
  assert.equal(sup.supersededBy, 12);
});

test("parseAdr names each error", () => {
  const cases = {
    "missing title": [adr({ title: "" }), /title/],
    "title without a number": [adr({ title: "# Cache the snapshot" }), /number/],
    "title with an empty name": [adr({ title: "# 0007:" }), /title/],
    "unknown status": [adr({ status: "Status: rejected" }), /status/],
    "missing status": [adr({ status: "" }), /status/],
    "superseded without a number": [adr({ status: "Status: superseded by someone" }), /status/],
    "absolute path": [adr({ governs: "- /etc/passwd" }), /absolute/],
    "Windows absolute path": [adr({ governs: "- C:/repo/x.md" }), /absolute/],
    "parent segment": [adr({ governs: "- docs/../secrets.md" }), /\.\./],
    "glob star": [adr({ governs: "- scripts/*.mjs" }), /glob/],
    "glob brace": [adr({ governs: "- scripts/{a,b}.mjs" }), /glob/],
    "glob question mark": [adr({ governs: "- scripts/a?.mjs" }), /glob/],
    "empty governs": [adr({ governs: "" }), /governs/i],
    "missing governs section": [adr().replace(/## Governs[\s\S]*$/, ""), /governs/i],
    "governs with only prose": [adr({ governs: "the lanes scripts" }), /governs/i],
    "governs with a * bullet": [adr({ governs: "* scripts/lanes/" }), /list item/],
    "a second Governs section": [adr() + "\n## Governs\n\n- secrets/private.md\n", /duplicate section: governs/],
  };
  for (const [name, [text, re]] of Object.entries(cases)) {
    const r = parseAdr(text);
    assert.ok(r.error, name);
    assert.match(r.error, re, name);
  }
});

test("adrGoverns matches an exact file and a directory entry, not a sibling", () => {
  const adrs = [parseAdr(adr({ title: "# 0001: A", governs: "- contracts/adr-template.md" })), parseAdr(adr({ title: "# 0002: B", governs: "- scripts/lanes/" }))];
  assert.deepEqual(adrGoverns(adrs, "contracts/adr-template.md"), [1]);
  assert.deepEqual(adrGoverns(adrs, "scripts/lanes/lib.mjs"), [2]);
  assert.deepEqual(adrGoverns(adrs, "scripts/lanes/sub/x.mjs"), [2]);
  assert.deepEqual(adrGoverns(adrs, "scripts/lanes2/lib.mjs"), []);
  assert.deepEqual(adrGoverns(adrs, "contracts/adr-template.md.bak"), []);
});

test("parseAdr edges: CRLF, backticked paths, and headings or status lines inside a fence", () => {
  assert.equal(parseAdr(adr().replace(/\n/g, "\r\n")).number, 7);
  assert.deepEqual(parseAdr(adr({ governs: "- `scripts/lanes/`" })).governs, ["scripts/lanes/"]);
  const fenced = "```\n# 9999: Fake\nStatus: proposed\n```\n" + adr();
  assert.deepEqual([parseAdr(fenced).number, parseAdr(fenced).status], [7, "accepted"]);
  assert.match(parseAdr(adr({ status: "```\nStatus: accepted\n```" })).error, /status/);
});

test("parseAdr edges: unnormalized Governs entries are errors", () => {
  for (const g of ["./scripts/lanes/", "scripts//lanes/", "scripts\\lanes\\lib.mjs", "\\\\server\\share", "..", "!scripts/"]) {
    assert.ok(parseAdr(adr({ governs: `- ${g}` })).error, g);
  }
  assert.equal(parseAdr(null).error.includes("title"), true);
  assert.equal(parseAdr(adr({ status: "<!-<!-- x -->-\nStatus: proposed\n-->\nStatus: accepted" })).status, "accepted", "nested comment is stripped fully");
});

test("adrGoverns edges: error entries, normalized file spelling and duplicate entries", () => {
  const a = parseAdr(adr({ title: "# 0004: D", governs: "- scripts/lanes/\n- scripts/lanes/lib.mjs" }));
  assert.deepEqual(adrGoverns([a, { error: "bad" }, null], "scripts/lanes/lib.mjs"), [4]);
  assert.deepEqual(adrGoverns([a], "./scripts/lanes/lib.mjs"), [4]);
  assert.deepEqual(adrGoverns([a], "scripts\\lanes\\lib.mjs"), [4]);
  assert.deepEqual(adrGoverns([a], "scripts/lanes"), []);
  assert.deepEqual(adrGoverns([a], "scripts/lanes/../other/x.mjs"), [], "a .. that leaves the directory does not match");
  assert.deepEqual(adrGoverns([a], "other/../scripts/lanes/x.mjs"), [4], "a .. that lands inside it does");
  assert.deepEqual(adrGoverns([a], "../scripts/lanes/x.mjs"), []);
  assert.deepEqual(adrGoverns([], "scripts/lanes/lib.mjs"), []);
});

test("adrGoverns ignores superseded and proposed ADRs", () => {
  const adrs = [
    parseAdr(adr({ title: "# 0001: Old", status: "Status: superseded by 0003", governs: "- scripts/lanes/" })),
    parseAdr(adr({ title: "# 0002: Maybe", status: "Status: proposed", governs: "- scripts/lanes/" })),
    parseAdr(adr({ title: "# 0003: New", governs: "- scripts/lanes/" })),
  ];
  assert.deepEqual(adrGoverns(adrs, "scripts/lanes/lib.mjs"), [3]);
});

// Extra case beyond the issue's listed edges: the title number must be exactly four digits, not fewer or more.
test("parseAdr rejects a title number that is not exactly four digits", () => {
  assert.match(parseAdr(adr({ title: "# 007: Three digits" })).error, /number/);
  assert.match(parseAdr(adr({ title: "# 00007: Five digits" })).error, /number/);
});

// Regression test for a bug found in review: a Governs entry with a stray, unbalanced backtick (e.g. an
// author forgot to close it) used to parse silently instead of failing. governsPathError now rejects any
// backtick left after stripping a balanced leading+trailing pair.
test("parseAdr rejects a Governs entry with an unbalanced backtick", () => {
  const r = parseAdr(adr({ governs: "- `scripts/lanes/" }));
  assert.ok(r.error, `expected an error, got a parsed path: ${JSON.stringify(r)}`);
});

// Extra case beyond the issue's listed edges: two different accepted ADRs governing the same file must both
// be returned, sorted by number regardless of the input order (not just deduplicated, which the existing
// duplicate-entry test already covers for one ADR listing the same path twice).
test("adrGoverns sorts numbers from multiple accepted ADRs that govern the same file", () => {
  const nine = parseAdr(adr({ title: "# 0009: Nine", governs: "- scripts/lanes/" }));
  const two = parseAdr(adr({ title: "# 0002: Two", governs: "- scripts/lanes/" }));
  assert.deepEqual(adrGoverns([nine, two], "scripts/lanes/lib.mjs"), [2, 9]);
});

// #45: accepted ADRs that govern a changed file require the architecture-advisor
const governing = (n, governs, status = "Status: accepted") =>
  parseAdr(adr({ title: `# ${String(n).padStart(4, "0")}: ADR ${n}`, status, governs }));

test("classifyFiles reports the accepted ADRs governing any changed file", () => {
  const adrs = [governing(3, "- scripts/lanes/"), governing(7, "- src/a.ts"), governing(9, "- src/b.ts")];
  assert.deepEqual(classifyFiles(["src/a.ts", "scripts/lanes/x.mjs", "docs/a.md"], config, adrs).adr, [3, 7]);
  assert.deepEqual(classifyFiles(["docs/a.md"], config, adrs).adr, []);
});

test("classifyFiles without adrs returns adr: [], as before", () => {
  assert.deepEqual(classifyFiles(["scripts/lanes/x.mjs"], config).adr, []);
});

// edge: a rename passes both names (as gateDecision's skip check already relies on); moving a file out of a
// governed path must still surface the ADR, since the old name is still in the diff.
test("edge: a file renamed out of a governed path still reports the ADR (old name passed too)", () => {
  const adrs = [governing(3, "- scripts/lanes/")];
  assert.deepEqual(classifyFiles(["scripts/lanes/old.mjs", "docs/new.md"], config, adrs).adr, [3]);
});

test("classifyFiles ignores superseded and proposed ADRs", () => {
  const adrs = [governing(3, "- src/a.ts", "Status: superseded by 0004"), governing(4, "- src/a.ts", "Status: proposed")];
  assert.deepEqual(classifyFiles(["src/a.ts"], config, adrs).adr, []);
});

test("edge: two changed files governed by the same ADR report it once", () => {
  assert.deepEqual(classifyFiles(["src/a.ts", "src/b.ts"], config, [governing(3, "- src/")]).adr, [3]);
});

// #241: the advisor runs for contract, module-map and ADR changes, no longer for every diff an ADR governs.
test("requiredReviewers adds no architecture-advisor for a diff that only touches governed files", () => {
  const none = { skipOnly: false, contract: false, sensitive: false, ui: false, owner: false, adr: [], architecture: false };
  const governed = { ...none, adr: [3] };
  assert.deepEqual(requiredReviewers("quick", governed), ["test-hunter"]);
  assert.deepEqual(requiredReviewers("full", governed), ["test-hunter"]);
  assert.deepEqual(requiredReviewers("full", none), ["test-hunter"]);
});

test("requiredReviewers adds the architecture-advisor for an architecture change at quick and full, never skip", () => {
  const arch = { skipOnly: false, contract: false, sensitive: false, ui: false, owner: false, adr: [], architecture: true };
  assert.deepEqual(requiredReviewers("quick", arch), ["test-hunter", "architecture-advisor"]);
  assert.deepEqual(requiredReviewers("full", arch), ["test-hunter", "architecture-advisor"]);
  assert.deepEqual(requiredReviewers("skip", arch), []);
  assert.deepEqual(requiredReviewers("skip", { ...arch, architecture: false, contract: true }), []);
});

test("edge: contract and architecture together add the architecture-advisor once", () => {
  const cls = { skipOnly: false, contract: true, sensitive: false, ui: false, owner: false, adr: [3], architecture: true };
  assert.deepEqual(requiredReviewers("full", cls), ["test-hunter", "architecture-advisor"]);
});

const advisorFor = (files, interfaceContract = "", adrs = [governing(10, "- scripts/lanes/reap.mjs")]) =>
  requiredReviewers("full", classifyFiles(files, config, adrs, interfaceContract)).includes("architecture-advisor");

test("a governed-file-only diff (scripts/lanes/reap.mjs) needs no advisor, but still reports its ADR", () => {
  assert.equal(advisorFor(["scripts/lanes/reap.mjs"]), false);
  assert.deepEqual(classifyFiles(["scripts/lanes/reap.mjs"], config, [governing(10, "- scripts/lanes/reap.mjs")]).adr, [10]);
});

test("an ADR, lanes.config.json, a contract file or an Interface contract path each need the advisor", () => {
  assert.equal(advisorFor(["docs/adr/0010-lane-reaper.md"]), true);
  assert.equal(advisorFor(["lanes.config.json"]), true);
  assert.equal(advisorFor(["contracts/x.schema.json"]), true);
  assert.equal(advisorFor(["scripts/lanes/reap.mjs"], "`scripts/lanes/reap.mjs` exports `reap(opts)`"), true);
});

test("classifyFiles reports architecture for docs/adr/, lanes.config.json and named Interface contract paths only", () => {
  assert.equal(classifyFiles(["docs/adr/README.md"], config).architecture, true);
  assert.equal(classifyFiles(["lanes.config.json"], config).architecture, true);
  assert.equal(classifyFiles(["src/a.ts"], config, [], "`src/a.ts` returns `{ x }`").architecture, true);
  assert.equal(classifyFiles(["src/a.ts"], config).architecture, false);
  assert.equal(classifyFiles(["contracts/x.schema.json"], config).architecture, false);
});

test("edge: an Interface contract of none, empty or missing names no path", () => {
  for (const text of ["none", "None", "none: this changes `src/a.ts` internals only", "", undefined, null]) {
    assert.equal(classifyFiles(["src/a.ts"], config, [], text).architecture, false, String(text));
  }
});

test("edge: an Interface contract path the diff does not change needs no advisor", () => {
  assert.equal(advisorFor(["src/b.ts"], "`src/a.ts` exports `f`"), false);
  // A path must match whole: a longer name that merely starts with it is another file.
  assert.equal(advisorFor(["src/a.tsx"], "`src/a.ts` exports `f`"), false);
});

test("edge: an Interface contract directory (trailing /) covers the files under it", () => {
  assert.equal(advisorFor(["src/api/users.ts"], "Every handler in `src/api/` returns `Result`"), true);
  assert.equal(advisorFor(["src/apiv2/users.ts"], "Every handler in `src/api/` returns `Result`"), false);
});

test("edge: bare, unbackticked paths with trailing punctuation still count", () => {
  assert.equal(advisorFor(["scripts/lanes/lib.mjs"], "The shape of scripts/lanes/lib.mjs, and nothing else."), true);
  assert.equal(advisorFor(["lanes.config.json"], "Adds a key to lanes.config.json."), true);
});

test("edge: prose that only looks path-like (e.g., i.e., versions) names no path", () => {
  const text = "Returns a list, e.g. the ids; i.e. unchanged since v1.0 and 2.5 as before.";
  assert.equal(advisorFor(["e.g", "i.e", "v1.0", "2.5"], text), false);
});

test("edge: Interface contract and diff paths are compared normalized (backslashes, ./)", () => {
  assert.equal(advisorFor(["src\\a.ts"], "`./src/a.ts` exports `f`"), true);
  assert.equal(advisorFor(["docs\\adr\\0010-lane-reaper.md"]), true);
  assert.equal(advisorFor(["./lanes.config.json"]), true);
});

test("edge: an absolute or parent-relative Interface contract path matches nothing", () => {
  assert.equal(advisorFor(["etc/x.conf"], "`/etc/x.conf` holds the key"), false);
  assert.equal(advisorFor(["src/a.ts"], "`../src/a.ts` exports `f`"), false);
});

test("edge: a file renamed out of an Interface contract path still counts (old name passed too)", () => {
  assert.equal(advisorFor(["src/a.ts", "src/b.ts"], "`src/a.ts` exports `f`"), true);
});

test("edge: an Interface contract naming several paths needs the advisor when the diff changes any one of them", () => {
  const text = "adds `src/a.ts` and updates `src/b.ts`";
  assert.deepEqual(interfacePaths(text), ["src/a.ts", "src/b.ts"]);
  assert.equal(advisorFor(["src/b.ts"], text), true);
  assert.equal(advisorFor(["src/c.ts"], text), false);
});

test("interfaceContractOf reads a task issue's Interface contract, and '' for a missing or non-string body", () => {
  assert.equal(interfaceContractOf("### Goal\n\ng\n\n### Interface contract\n\n`src/a.ts` exports `f`\n\n### Scope\n\nx\n"), "`src/a.ts` exports `f`");
  assert.equal(interfaceContractOf("### Goal\n\ng\n"), "");
  for (const body of [null, undefined, 42, {}]) assert.equal(interfaceContractOf(body), "", String(body));
});

test("edge: the tier skip still needs no reviewer, whatever the diff touches", () => {
  const cls = classifyFiles(["docs/adr/0010-lane-reaper.md", "lanes.config.json", "contracts/x.schema.json"], config, [], "`contracts/x.schema.json`");
  assert.deepEqual(requiredReviewers("skip", cls), []);
});

test("reviewersReport and requiredReviewers agree, and the report takes the Interface contract too", () => {
  const adrs = [governing(10, "- scripts/lanes/reap.mjs")];
  assert.equal(reviewersReport("full", ["scripts/lanes/reap.mjs"], config, adrs), "test-hunter\nsecurity-reviewer\nADRs: 0010");
  assert.equal(reviewersReport("full", ["scripts/lanes/reap.mjs"], config, adrs, "`scripts/lanes/reap.mjs`"), "test-hunter\nsecurity-reviewer\narchitecture-advisor\nADRs: 0010");
});

test("edge: a class without an adr key (older callers) adds no advisor", () => {
  assert.deepEqual(requiredReviewers("full", { skipOnly: false, contract: false, sensitive: false, ui: false }), ["test-hunter"]);
});

const adrDir = (files) => {
  const root = mkdtempSync(join(tmpdir(), "lanes-adr-"));
  const dir = join(root, "docs", "adr");
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return { root, dir };
};

test("loadAdrs parses every *.md in the directory, in file-name order", () => {
  const { root, dir } = adrDir({ "0007-b.md": adr({ title: "# 0007: B" }), "0003-a.md": adr({ title: "# 0003: A" }), "notes.txt": "x" });
  try {
    assert.deepEqual(loadAdrs(dir).map((a) => a.number), [3, 7]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("edge: loadAdrs returns [] when the directory does not exist", () => {
  assert.deepEqual(loadAdrs(join(tmpdir(), "lanes-no-such-dir", "docs", "adr")), []);
});

test("edge: loadAdrs keeps a malformed ADR as an error that governs nothing", () => {
  const { root, dir } = adrDir({ "0001-bad.md": "no title", "0002-ok.md": adr({ title: "# 0002: Ok", governs: "- src/a.ts" }) });
  try {
    const adrs = loadAdrs(dir);
    assert.ok(adrs[0].error);
    assert.deepEqual(classifyFiles(["src/a.ts"], config, adrs).adr, [2]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadAdrs defaults to this repo's docs/adr", () => {
  assert.ok(loadAdrs().some((a) => a.number === 1 && a.status === "accepted"));
});

test("reviewersReport lists the reviewers, then the governing ADRs zero-padded", () => {
  const adrs = [governing(3, "- src/a.ts"), governing(7, "- src/a.ts")];
  assert.equal(reviewersReport("full", ["src/a.ts"], config, adrs), "test-hunter\nADRs: 0003, 0007");
  assert.equal(reviewersReport("full", ["src/a.ts", "docs/adr/0003-a.md"], config, adrs), "test-hunter\narchitecture-advisor\nADRs: 0003, 0007");
});

test("reviewersReport prints no ADR line when none govern the diff", () => {
  assert.equal(reviewersReport("quick", ["src/b.ts"], config, [governing(3, "- src/a.ts")]), "test-hunter");
});

test("edge: reviewersReport at tier skip warns on code, prints none, and still names governing ADRs", () => {
  const out = reviewersReport("skip", ["src/a.ts"], config, [governing(3, "- src/a.ts")]);
  assert.equal(out, "NOT SKIP: the diff changes files outside the skip paths; use quick or full\nnone\nADRs: 0003");
});

// #25: diffFingerprint identifies a PR's own diff across merges from main
const fileA = (idx, hunk, line) => `diff --git a/a.js b/a.js\nindex ${idx}..1111111 100644\n--- a/a.js\n+++ b/a.js\n@@ ${hunk} @@ function f() {\n ctx\n-old\n+${line}\n`;
const fileB = (idx) => `diff --git a/b.js b/b.js\nindex ${idx}..2222222 100644\n--- a/b.js\n+++ b/b.js\n@@ -1,1 +1,1 @@\n-x\n+y\n`;

test("diffFingerprint returns a SHA-256 hex digest", () => {
  assert.match(diffFingerprint(fileA("0000000", "-1,2 +1,2", "new")), /^[0-9a-f]{64}$/);
});

test("diffFingerprint ignores index lines, hunk line numbers and file order", () => {
  const one = fileA("0000000", "-1,2 +1,2", "new") + fileB("3333333");
  const two = fileB("4444444") + fileA("5555555", "-40,2 +41,2", "new").replace("function f() {", "class C {");
  assert.equal(diffFingerprint(one), diffFingerprint(two));
});

test("diffFingerprint changes when an added or removed line changes, whitespace included", () => {
  const base = diffFingerprint(fileA("0000000", "-1,2 +1,2", "new"));
  assert.notEqual(diffFingerprint(fileA("0000000", "-1,2 +1,2", "newer")), base);
  assert.notEqual(diffFingerprint(fileA("0000000", "-1,2 +1,2", "new ")), base);
  assert.notEqual(diffFingerprint(fileA("0000000", "-1,2 +1,2", "\tnew")), base);
  assert.notEqual(diffFingerprint(fileA("0000000", "-1,2 +1,2", "new").replace("-old", "-older")), base);
});

test("edge: diffFingerprint of an empty or non-string diff is stable and differs from a real diff", () => {
  assert.equal(diffFingerprint(""), diffFingerprint(undefined));
  assert.notEqual(diffFingerprint(""), diffFingerprint(fileB("0000000")));
});

test("edge: diffFingerprint keeps the same change in a different file apart", () => {
  assert.notEqual(diffFingerprint(fileB("0000000")), diffFingerprint(fileB("0000000").replaceAll("b.js", "c.js")));
});

test("edge: diffFingerprint tells a duplicated file block from a single one", () => {
  assert.notEqual(diffFingerprint(fileB("0000000")), diffFingerprint(fileB("0000000") + fileB("0000000")));
});

test("edge: diffFingerprint treats a CRLF added line as different from an LF one", () => {
  assert.notEqual(diffFingerprint(fileB("0000000")), diffFingerprint(fileB("0000000").replace("+y\n", "+y\r\n")));
});

const human = { type: "User", login: "leo" };
const hunterOk = { context: "review/test-hunter", state: "success", description: "ok", created_at: "2026-09-26T10:00:00Z", creator: human };

test("testHunterReusable only when the tier requires the test-hunter and the head has no trusted status for it", () => {
  const base = { issueLabels: ["tier:quick", "ready"], files: ["src/a.ts"], statuses: [], config };
  assert.equal(testHunterReusable(base), true);
  assert.equal(testHunterReusable({ ...base, statuses: [{ ...hunterOk, creator: { type: "Bot", login: "x[bot]" } }] }), true);
  assert.equal(testHunterReusable({ ...base, statuses: [{ ...hunterOk, state: "failure" }] }), false);
  assert.equal(testHunterReusable({ ...base, issueLabels: ["tier:skip"] }), false);
  assert.equal(testHunterReusable({ ...base, issueLabels: ["tier:quick", "tier:full"] }), false);
  assert.equal(testHunterReusable({ ...base, issueLabels: undefined }), false);
});

// edge: not named by the acceptance criteria or the lane's edge: cases, which only test a head failure winning over
// reuse; a pending or errored head status is "any status" too and must equally block reuse consideration.
test("edge: testHunterReusable treats a pending or errored head status as a status too, not only a failure", () => {
  const base = { issueLabels: ["tier:quick", "ready"], files: ["src/a.ts"], statuses: [], config };
  assert.equal(testHunterReusable({ ...base, statuses: [{ ...hunterOk, state: "pending" }] }), false);
  assert.equal(testHunterReusable({ ...base, statuses: [{ ...hunterOk, state: "error" }] }), false);
});

const quickPr = {
  prBody: "Closes #7\n## What changed\nx\n## Contract changes\nnone\n## Tests added\nx\n## Reviewer results\nx\n## Needs the owner\nnothing\n## Not done\nnothing",
  issueLabels: ["tier:quick", "ready"],
  issueState: "open",
  issueAuthorCanWrite: true,
  issueIsPr: false,
  headRef: "issue-7-x",
  headSha: "a".repeat(40),
  files: ["src/a.ts"],
  statuses: [],
  verdicts: [],
  config,
};

test("edge: gateDecision refuses a reused status that is not a trusted test-hunter success on a real SHA", () => {
  const sha = "e".repeat(40);
  assert.match(gateDecision({ ...quickPr, reused: { sha, status: hunterOk } }).description, /reused test-hunter from eeeeeee$/);
  for (const reused of [
    { sha, status: { ...hunterOk, creator: { type: "Bot", login: "github-actions[bot]" } } },
    { sha, status: { ...hunterOk, state: "failure" } },
    { sha, status: { ...hunterOk, context: "review/ui-reviewer" } },
    { sha: "not-a-sha", status: hunterOk },
    { sha },
  ]) {
    assert.equal(gateDecision({ ...quickPr, reused }).description, "waiting for review/test-hunter", JSON.stringify(reused));
  }
});

test("edge: gateDecision ignores a reused status when the head has its own trusted test-hunter status", () => {
  const d = gateDecision({ ...quickPr, statuses: [{ ...hunterOk, state: "failure" }], reused: { sha: "e".repeat(40), status: hunterOk } });
  assert.equal(d.description, "review/test-hunter is failure");
});

// #493: an earlier owner approval carried to the head when the PR's own diff is byte-identical
const ownerOk = { ...hunterOk, context: "review/owner" };
const OWNED = "c".repeat(40);
const needsOwnerPr = { ...quickPr, prBody: quickPr.prBody.replace("## Needs the owner\nnothing", "## Needs the owner\ndecide x"), statuses: [hunterOk] };

const TEAM_WAIT = (reason) => `waiting for a code-owner review in GitHub (${reason})`;

test("gateDecision no longer reads a review/owner status or an owner carry: only the native approval passes", () => {
  const withOwner = { ...needsOwnerPr, statuses: [hunterOk, ownerOk] };
  assert.equal(gateDecision(withOwner).description, TEAM_WAIT("needs the owner"));
  // An ownerCarry input is ignored whatever it says.
  for (const ownerCarry of [{ sha: OWNED, status: ownerOk, same: true }, { sha: OWNED, status: ownerOk, same: false }, null, "x"]) {
    const d = gateDecision({ ...needsOwnerPr, ownerCarry, prNumber: 9 });
    assert.equal(d.state, "pending");
    assert.equal(d.description, TEAM_WAIT("needs the owner"));
  }
  const approved = gateDecision({ ...needsOwnerPr, nativeApproval: { approved: true, by: "leo" } });
  assert.deepEqual(approved, { state: "success", description: "approved by code owner @leo", stage: "ready" });
});

test("gateDecision never lets the native approval skip a reviewer the head still owes", () => {
  const d = gateDecision({ ...needsOwnerPr, statuses: [], nativeApproval: { approved: true, by: "leo" } });
  assert.equal(d.description, "waiting for review/test-hunter");
});

test("edge: an ownerDiff input is ignored: an 'additive' verdict never clears the owner wait", () => {
  const d = gateDecision({ ...needsOwnerPr, prBody: quickPr.prBody, files: ["scripts/lanes/gate.mjs"], config: ownerCfg, ownerDiff: "additive" });
  assert.notEqual(d.state, "success");
});

test("edge: diffFingerprint keeps a hunk boundary: one hunk split in two is a different diff", () => {
  const one = "diff --git a/b.js b/b.js\n--- a/b.js\n+++ b/b.js\n@@ -1,2 +1,2 @@\n-x\n+y\n-p\n+q\n";
  const two = "diff --git a/b.js b/b.js\n--- a/b.js\n+++ b/b.js\n@@ -1,1 +1,1 @@\n-x\n+y\n@@ -9,1 +9,1 @@\n-p\n+q\n";
  assert.notEqual(diffFingerprint(one), diffFingerprint(two));
});

const V = (tail) => `validate: node --test — ${tail}`;

test("parseValidation returns the parts for each operator", () => {
  for (const op of ["<", "<=", ">", ">="]) {
    assert.deepEqual(parseValidation(V(`(\\d+) passed ${op} 3.5 (attempts: 4)`)), { command: "node --test", regex: "(\\d+) passed", op, threshold: 3.5, attempts: 4 });
  }
});

test("parseValidation accepts attempts 1 and 10, rejects 0 and 11", () => {
  assert.equal(parseValidation(V("(\\d+) >= 1 (attempts: 1)")).attempts, 1);
  assert.equal(parseValidation(V("(\\d+) >= 1 (attempts: 10)")).attempts, 10);
  for (const n of [0, 11]) assert.throws(() => parseValidation(V(`(\\d+) >= 1 (attempts: ${n})`)), { name: "ValidationParseError" });
});

test("parseValidation: null for a plain criterion, negative thresholds parse", () => {
  assert.equal(parseValidation("Tests cover the parser"), null);
  assert.equal(parseValidation(""), null);
  assert.equal(parseValidation("see validate: later"), null);
  assert.equal(parseValidation(V("(\\d+) > -2 (attempts: 2)")).threshold, -2);
});

test("parseValidation stays fast on a 65,000-character hostile criterion of spaces or repeated separators", () => {
  for (const hostile of [`validate:${" ".repeat(65000)}`, `validate: ${" — ".repeat(21600)}`, `validate: a — ${" ".repeat(65000)}x`]) {
    const start = performance.now();
    assert.throws(() => parseValidation(hostile), { name: "ValidationParseError" });
    assert.ok(performance.now() - start < 100, "parse time over 100 ms");
  }
});

test("parseValidation rejects a line over 500 characters and accepts one of exactly 500", () => {
  const tail = " >= 1 (attempts: 2)";
  const at = (len) => `validate: node --test — (${"a".repeat(len - "validate: node --test — ()".length - tail.length)})${tail}`;
  assert.equal(at(500).length, 500);
  assert.equal(parseValidation(at(500)).attempts, 2);
  assert.throws(() => parseValidation(at(501)), { name: "ValidationParseError", message: /500/ });
});

test("edge: parseValidation keeps a separator inside the regex and whitespace variants", () => {
  assert.deepEqual(parseValidation("validate:  node --test  —  (a — b) >=  3   (attempts:2)"), { command: "node --test", regex: "(a — b)", op: ">=", threshold: 3, attempts: 2 });
  assert.throws(() => parseValidation("validate: node —  >= 3 (attempts: 2)"), { name: "ValidationParseError" });
});

test("edge: parseValidation rejects a newline inside the command or the regex, as the old pattern did", () => {
  assert.throws(() => parseValidation("validate: a — x\ny < 1 (attempts: 1)"), { name: "ValidationParseError" });
  assert.throws(() => parseValidation("validate: a\nb — (x) < 1 (attempts: 1)"), { name: "ValidationParseError" });
});

test("edge: parseValidation throws a named error for malformed validate lines", () => {
  for (const bad of [
    "validate:",
    "validate: node --test",
    "validate: node --test — (\\d+) >= 3",
    "validate: node --test — (\\d+) == 3 (attempts: 2)",
    "validate: node --test — (\\d+) >= three (attempts: 2)",
    "validate: — (\\d+) >= 3 (attempts: 2)",
    "validate: node --test — (\\d+ >= 3 (attempts: 2)",
    "validate: node --test — \\d+ >= 3 (attempts: 2)",
    "validate: node --test — (\\d+) >= 3 (attempts: 2.5)",
  ]) {
    assert.throws(() => parseValidation(bad), (e) => e.name === "ValidationParseError" && /validate/.test(e.message), bad);
  }
});

// The owner stage under a config with its own owner-only paths (ADR 0021, 0025).
const ownerCfg = compileConfig({
  requiredChecks: ["verify"],
  paths: {
    skip: ["^docs/"],
    contract: ["^contracts/"],
    sensitive: ["^scripts/lanes/", "^lanes\\.config\\.json$"],
    ui: [],
    owner: ["^lanes\\.config\\.json$", "^scripts/lanes/workflow\\.test\\.mjs$", "^scripts/lanes/gate\\.mjs$"],
  },
});
const PIN_FILES = ["lanes.config.json", "scripts/lanes/workflow.test.mjs"];
const pinHead = "b".repeat(40);
const passed = (names) => names.map((r) => ({ context: reviewContext(r), state: "success", description: "ok", created_at: "2026-09-29T10:00:00Z", creator: human }));
const praised = (names, sha = pinHead) => names.map((reviewer) => ({ reviewer, sha, verdict: { verdict: "success", findings: [] } }));
const pinPr = (over = {}) => {
  const files = over.files ?? PIN_FILES;
  const names = requiredReviewers("full", classifyFiles(files, ownerCfg));
  return { ...quickPr, issueLabels: ["tier:full", "ready"], headSha: pinHead, files, config: ownerCfg, statuses: passed(names), verdicts: praised(names), ...over };
};
const pinReviewers = requiredReviewers("full", classifyFiles(PIN_FILES, ownerCfg));

test("gateDecision waits for the native review on every owner reason, with every reviewer passed", () => {
  assert.equal(gateDecision(pinPr()).description, TEAM_WAIT("owner-only path"));
  const [first, ...rest] = pinReviewers;
  assert.ok(rest.length > 0);
  const failing = praised(pinReviewers).map((v) => (v.reviewer === first ? { ...v, verdict: { verdict: "failure", findings: [] } } : v));
  assert.equal(gateDecision(pinPr({ files: ["src/a.ts", "docs/a.md"], verdicts: failing })).description, TEAM_WAIT(`verdict from ${first} is not success`));
  assert.equal(gateDecision(pinPr({ files: ["src/a.ts", "docs/a.md"], verdicts: praised(rest) })).description, TEAM_WAIT(`no verdict for head from ${first}`));
  // A review status missing or failed on the head never reaches the owner stage.
  assert.equal(gateDecision(pinPr({ statuses: passed(rest) })).description, `waiting for review/${first}`);
  const failed = passed(pinReviewers).map((s, i) => (i === 0 ? { ...s, state: "failure" } : s));
  assert.equal(gateDecision(pinPr({ statuses: failed })).state, "failure");
});

test("gateDecision waits on the owner when Needs the owner is not nothing", () => {
  const prBody = quickPr.prBody.replace("## Needs the owner\nnothing", "## Needs the owner\nDecide whether this pin belongs here.");
  assert.equal(gateDecision(pinPr({ files: ["src/a.ts"], prBody })).description, TEAM_WAIT("needs the owner"));
});

test("edge: an unfixed important finding waits on the owner for that finding", () => {
  const verdicts = praised(pinReviewers).map((v, i) => (i === 0 ? { ...v, verdict: { verdict: "success", findings: [{ severity: "important", fixed: false }] } } : v));
  assert.match(gateDecision(pinPr({ files: ["src/a.ts"], verdicts })).description, /^waiting for a code-owner review in GitHub \(unfixed important finding from /);
});

test("edge: no owner wait reason mentions /approve", () => {
  for (const d of [gateDecision(pinPr()), gateDecision(pinPr({ files: ["src/a.ts"], prBody: quickPr.prBody.replace("## Needs the owner\nnothing", "## Needs the owner\nx") }))]) {
    assert.equal(d.stage, "owner");
    assert.doesNotMatch(d.description, /\/approve/);
  }
});

// ---- #462: reviewers from config (ADR 0018) ----

const modConfig = compileConfig({
  requiredChecks: ["verify"],
  paths: { skip: ["^docs/"], contract: ["^contracts/"], sensitive: ["^scripts/lanes/"], ui: [] },
  modules: {
    entries: [
      { id: "perf", paths: ["src/hot/"], imports: [], reviewers: ["test-hunter-extra"] },
      { id: "none", paths: ["src/plain/"], imports: [] },
      { id: "dup", paths: ["src/dup/"], imports: [], reviewers: ["test-hunter"] },
    ],
  },
});
const noCls = { skipOnly: false, contract: false, sensitive: false, ui: false, adr: [], architecture: false };

// modules.mjs checks each configured reviewer's .claude/agents/<name>.md against the cwd, so run in a temp repo.
function inAgentRepo(fn) {
  const dir = mkdtempSync(join(tmpdir(), "lanes-462-"));
  const prev = process.cwd();
  try {
    mkdirSync(join(dir, ".claude", "agents"), { recursive: true });
    for (const n of ["test-hunter-extra", "test-hunter"]) writeFileSync(join(dir, ".claude", "agents", `${n}.md`), `---\nname: ${n}\n---\n`);
    process.chdir(dir);
    fn();
  } finally {
    process.chdir(prev);
    rmSync(dir, { recursive: true, force: true });
  }
}

test("requiredReviewers adds each changed module's configured reviewers after the built-in ones, at quick and full", () => inAgentRepo(() => {
  for (const tier of ["quick", "full"]) {
    assert.deepEqual(requiredReviewers(tier, noCls, ["src/hot/a.js"], modConfig.modules), ["test-hunter", "test-hunter-extra"]);
  }
  assert.deepEqual(requiredReviewers("skip", noCls, ["src/hot/a.js"], modConfig.modules), []);
  assert.deepEqual(requiredReviewers("full", noCls, ["src/other.js"], modConfig.modules), ["test-hunter"]);
}));

test("a config can never remove a built-in reviewer", () => inAgentRepo(() => {
  const cls = { ...noCls, sensitive: true, contract: true };
  for (const f of ["src/plain/x.js", "src/dup/x.js"]) {
    const got = requiredReviewers("full", cls, [f], modConfig.modules);
    assert.deepEqual(got, ["test-hunter", "security-reviewer", "architecture-advisor"], f);
  }
}));

test("edge: requiredReviewers without files or modules is the built-in list", () => {
  assert.deepEqual(requiredReviewers("full", noCls), ["test-hunter"]);
  assert.deepEqual(requiredReviewers("full", noCls, ["src/hot/a.js"], undefined), ["test-hunter"]);
});

test("reviewerNames is the built-in four plus configured names, never owner", () => {
  assert.deepEqual(reviewerNames(modConfig), [...REVIEWERS, "test-hunter-extra"]);
  assert.deepEqual(reviewerNames(config), REVIEWERS);
  assert.deepEqual(reviewerNames(undefined), REVIEWERS);
  const withOwner = { modules: { entries: [{ id: "x", paths: ["x/"], imports: [], reviewers: ["owner"] }] } };
  assert.ok(!reviewerNames(withOwner).includes("owner"));
});

test("edge: reviewerNames and moduleMapProblem on a malformed module map", () => inAgentRepo(() => {
  for (const modules of ["x", { entries: 5 }, { entries: [null, { reviewers: "a" }, { reviewers: [7, "ok-name"] }] }]) {
    assert.doesNotThrow(() => reviewerNames({ modules }), JSON.stringify(modules));
  }
  assert.deepEqual(reviewerNames({ modules: { entries: [{ reviewers: [7, "ok-name"] }] } }), [...REVIEWERS, "ok-name"]);
  assert.equal(moduleMapProblem(modConfig), null);
  assert.equal(moduleMapProblem({}), null);
  assert.match(moduleMapProblem({ modules: "x" }), /modules must be an object/);
  assert.match(moduleMapProblem({ modules: { entries: [{ id: "a", paths: ["a/"], imports: [], reviewers: ["ghost"] }] } }), /"ghost" has no \.claude\/agents\/ghost\.md/);
}));

test("gateDecision fails with the module-map reason, before any tier check", () => inAgentRepo(() => {
  const d = gateDecision({ ...quickPr, config: { ...config, modules: { entries: "nope" } } });
  assert.equal(d.state, "failure");
  assert.match(d.description, /^module map unusable: .*entries must be an array/);
}));

test("parseVerdictComment accepts exactly the names it is given", () => {
  const body = (r) => `<!-- lanes:verdict ${r} -->\n\`\`\`json\n{"reviewer":"${r}","verdict":"success"}\n\`\`\``;
  const names = reviewerNames(modConfig);
  assert.equal(parseVerdictComment(body("test-hunter-extra"), names)?.reviewer, "test-hunter-extra");
  assert.equal(parseVerdictComment(body("test-hunter-extra")), null);
  assert.equal(parseVerdictComment(body("owner"), names), null);
  assert.equal(parseVerdictComment(body("test-hunter"), names)?.reviewer, "test-hunter");
});

test("REUSABLE_REVIEWERS stays the built-in three", () => inAgentRepo(() => {
  assert.deepEqual([...REUSABLE_REVIEWERS], ["test-hunter", "security-reviewer", "architecture-advisor"]);
  assert.ok(!reusableReviewers({ issueLabels: ["tier:full"], files: ["src/hot/a.js"], statuses: [], config: modConfig }).includes("test-hunter-extra"));
}));

test("reviewersReport prints a configured reviewer for a diff in its module", () => inAgentRepo(() => {
  assert.equal(reviewersReport("full", ["src/hot/a.js"], modConfig), "test-hunter\ntest-hunter-extra");
  assert.equal(reviewersReport("full", ["src/plain/a.js"], modConfig), "test-hunter");
}));

// #526 (ADR 0020): the configured lane App bot is trusted for reviewer statuses under team, and nothing else.
const BOT = "sour-dev-lanes[bot]";
const TEAM_ID = { profile: "team", app: { id: 11, installationId: 22, botLogin: BOT } };
const botCreator = { type: "Bot", login: BOT };
const botStatus = (name, creator = botCreator) => ({ context: reviewContext(name), state: "success", description: "ok", created_at: "2026-09-29T10:00:00Z", ...(creator === null ? {} : { creator }) });

test("parseIdentity accepts only the team shape (ADR 0025)", () => {
  assert.deepEqual(parseIdentity(TEAM_ID), TEAM_ID);
});

test("parseIdentity refuses a missing identity, a missing profile and any profile but team with the one message", () => {
  assert.equal(TEAM_REQUIRED_MESSAGE, "lanes needs the team identity profile (a GitHub App). Run: node scripts/lanes/app-setup.mjs");
  const refused = (identity, path) => assert.throws(() => parseIdentity(identity, path), (e) => e.message.startsWith(TEAM_REQUIRED_MESSAGE) ? true : false);
  refused(undefined);
  refused({});
  refused({ profile: "solo" });
  refused({ profile: "solo", app: { id: 1, installationId: 2, botLogin: BOT } });
  refused({ profile: "other" });
  refused({ profile: "" });
  refused({ profile: null });
  refused({ profile: "TEAM" });
  // the error names the config path and the profile found, if any
  assert.throws(() => parseIdentity({ profile: "solo" }, "x/lanes.config.json"), /x\/lanes\.config\.json.*profile "solo"/);
  assert.throws(() => parseIdentity({ profile: "other" }), /lanes\.config\.json.*profile "other"/);
  assert.throws(() => parseIdentity(undefined, "x/lanes.config.json"), (e) => e.message.includes("x/lanes.config.json") && !/profile "/.test(e.message));
  assert.throws(() => parseIdentity({}), (e) => e.message.includes("lanes.config.json") && !/profile "/.test(e.message));
});

test("this repository's lanes.config.json passes parseIdentity", () => {
  const identity = JSON.parse(readFileSync("lanes.config.json", "utf8")).identity;
  assert.equal(parseIdentity(identity).profile, "team");
});

test("parseIdentity rejects bad shapes and bad bot logins", () => {
  const app = (extra) => ({ profile: "team", app: { id: 1, installationId: 2, ...extra } });
  const bad = [null, "team", [], { profile: "team" }, { profile: "team", x: 1 },{ profile: "team", app: null }, { profile: "team", app: { id: 1 } }, { profile: "team", app: { id: "1", installationId: 2, botLogin: BOT } }, { profile: "team", app: { id: 1, installationId: 2, botLogin: BOT, key: "x" } }];
  for (const identity of bad) assert.throws(() => parseIdentity(identity), /lanes\.config\.json: identity /, JSON.stringify(identity));
  // edge: team without botLogin, and malformed logins (no suffix, wildcard, list, empty, dash edges, upper-case suffix, too long)
  assert.throws(() => parseIdentity(app({})), /botLogin/);
  for (const botLogin of ["lanes", "*[bot]", "github-actions", "", "-a[bot]", "a-[bot]", "a[BOT]", "a b[bot]", ["a[bot]"], 5, null, `${"a".repeat(40)}[bot]`]) {
    assert.throws(() => parseIdentity(app({ botLogin })), /botLogin/, JSON.stringify(botLogin));
  }
  assert.equal(parseIdentity(app({ botLogin: "a[bot]" })).app.botLogin, "a[bot]");
  // edge: ids at the boundary: 0 and negative are refused, 1 accepted, and a 39-character slug is the longest allowed
  for (const id of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parseIdentity(app({ id, botLogin: BOT })), /\.app\.id/, String(id));
    assert.throws(() => parseIdentity(app({ installationId: id, botLogin: BOT })), /\.app\.installationId/, String(id));
  }
  assert.equal(parseIdentity({ profile: "team", app: { id: 1, installationId: 1, botLogin: `${"a".repeat(39)}[bot]` } }).app.id, 1);
});

test("compileConfig exposes a validated identity, leaves it out when absent and throws on an invalid one", () => {
  const raw = { requiredChecks: ["verify"], paths: { skip: [], contract: [], sensitive: [], ui: [] } };
  assert.equal("identity" in compileConfig(raw), false);
  assert.deepEqual(compileConfig({ ...raw, identity: TEAM_ID }).identity, TEAM_ID);
  assert.throws(() => compileConfig({ ...raw, identity: { profile: "team" } }), /identity/);
  // an identity that is not team compiles as its bare profile name (or none), for start, queue and the gate to refuse
  for (const identity of [{ profile: "solo" }, { profile: "solo", app: { id: 1, installationId: 2 } }]) {
    assert.deepEqual(compileConfig({ ...raw, identity }).identity, { profile: "solo" }, JSON.stringify(identity));
  }
  assert.equal("identity" in compileConfig({ ...raw, identity: {} }), false);
  assert.throws(() => parseIdentity(compileConfig({ ...raw, identity: { profile: "solo" } }).identity), (e) => e.teamRequired === true && /profile "solo"/.test(e.message));
});

test("edge: compileConfig keeps no profile for a non-object or non-string-profile identity, and still throws a team shape error", () => {
  const raw = { requiredChecks: ["verify"], paths: { skip: [], contract: [], sensitive: [], ui: [] } };
  assert.equal("identity" in compileConfig({ ...raw, identity: { profile: 7 } }), false);
  for (const identity of ["solo", null, 5, []]) {
    assert.throws(() => compileConfig({ ...raw, identity }), /identity must be an object/, JSON.stringify(identity));
  }
  assert.throws(() => compileConfig({ ...raw, identity: { profile: "team", app: { id: "x" } } }), /identity/);
});

test("identityRefusal is the refusal line for a config that is not team, and null for team or an unparseable file", () => {
  const cfg = (identity) => () => JSON.stringify({ identity });
  assert.equal(identityRefusal(cfg(TEAM_ID)), null);
  assert.match(identityRefusal(cfg({ profile: "solo" })), new RegExp(`^${TEAM_REQUIRED_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*profile "solo"`));
  assert.match(identityRefusal(cfg({ profile: "other" })), /profile "other"/);
  assert.match(identityRefusal(() => "{}"), /^lanes needs the team identity profile/);
  assert.match(identityRefusal(() => { throw Object.assign(new Error("gone"), { code: "ENOENT" }); }), /^lanes needs the team identity profile/);
  assert.equal(identityRefusal(() => "not json"), null);
  assert.equal(identityRefusal(() => { throw new Error("EACCES"); }), null);
  // a malformed team identity is not this refusal (loadConfig reports it)
  assert.equal(identityRefusal(cfg({ profile: "team" })), null);
});

test("isLaneBot is true only for team, a set botLogin, the exact login and (for a status) type Bot", () => {
  assert.equal(isLaneBot(TEAM_ID, botCreator), true);
  assert.equal(isLaneBot(TEAM_ID, { login: BOT }), true, "a comment author has no type");
  assert.equal(isLaneBot(TEAM_ID, { type: "User", login: BOT }), false);
  assert.equal(isLaneBot(TEAM_ID, { type: "Bot", login: "github-actions[bot]" }), false);
  assert.equal(isLaneBot(TEAM_ID, { type: "Bot", login: BOT.toUpperCase() }), false);
  assert.equal(isLaneBot(TEAM_ID, undefined), false);
  assert.equal(isLaneBot(TEAM_ID, null), false);
  assert.equal(isLaneBot({ profile: "solo", app: { id: 1, installationId: 2, botLogin: BOT } }, botCreator), false);
  assert.equal(isLaneBot({ profile: "team", app: { id: 1, installationId: 2 } }, botCreator), false);
  assert.equal(isLaneBot({ profile: "team" }, botCreator), false);
  assert.equal(isLaneBot(undefined, botCreator), false);
});

test("trustedStatuses keeps a configured reviewer status from the lane bot and drops everything else from it", () => {
  const names = ["test-hunter", "security-reviewer"];
  const kept = botStatus("test-hunter");
  assert.deepEqual(trustedStatuses([kept], TEAM_ID, names), [kept]);
  assert.deepEqual(trustedStatuses([botStatus("owner")], TEAM_ID, names), []);
  // edge: review/owner stays untrusted from the bot even if a caller's reviewer names wrongly include "owner"
  assert.deepEqual(trustedStatuses([botStatus("owner")], TEAM_ID, [...names, "owner"]), []);
  assert.deepEqual(trustedStatuses([botStatus("unknown-reviewer")], TEAM_ID, names), []);
  assert.deepEqual(trustedStatuses([botStatus("test-hunter", { type: "Bot", login: "github-actions[bot]" })], TEAM_ID, names), []);
  assert.deepEqual(trustedStatuses([botStatus("test-hunter", { type: "Bot", login: "other-app[bot]" })], TEAM_ID, names), []);
  assert.deepEqual(trustedStatuses([botStatus("test-hunter", { type: "User", login: BOT })], TEAM_ID, names), []);
  assert.deepEqual(trustedStatuses([botStatus("test-hunter", null)], TEAM_ID, names), []);
  assert.deepEqual(trustedStatuses([kept], { profile: "solo", app: { id: 1, installationId: 2, botLogin: BOT } }, names), []);
  assert.deepEqual(trustedStatuses([kept], { profile: "team", app: { id: 1, installationId: 2 } }, names), []);
  // the new arguments omitted or partial: no bot is trusted
  assert.deepEqual(trustedStatuses([kept]), []);
  assert.deepEqual(trustedStatuses([kept], TEAM_ID), []);
  assert.deepEqual(trustedStatuses([kept], undefined, names), []);
  // edge: a human status passes either way, a non-review context is never filtered, and non-array input is empty
  assert.equal(trustedStatuses(passed(["test-hunter"]), TEAM_ID, names).length, 1);
  const gate = { ...kept, context: "lanes/gate" };
  assert.deepEqual(trustedStatuses([gate], TEAM_ID, names), [gate]);
  assert.deepEqual(trustedStatuses(undefined, TEAM_ID, names), []);
});

test("gateDecision trusts the lane bot's reviewer statuses under team, but never the owner one", () => {
  const teamCfg = { ...ownerCfg, identity: TEAM_ID };
  const names = requiredReviewers("full", classifyFiles(PIN_FILES, ownerCfg));
  const botPassed = names.map((n) => botStatus(n));
  const args = { statuses: botPassed };
  assert.equal(gateDecision(pinPr({ ...args, config: teamCfg, nativeApproval: approvedBy })).state, "success");
  assert.equal(gateDecision(pinPr({ ...args, config: teamCfg })).state, "pending", "team: an unread native approval is pending (#575)");
  assert.notEqual(gateDecision(pinPr({ ...args, config: ownerCfg })).state, "success", "no identity: no bot trusted");
  assert.notEqual(gateDecision(pinPr({ ...args, config: { ...ownerCfg, identity: { profile: "team", app: { id: 1, installationId: 2 } } } })).state, "success");
  // the bot's owner status is not approval
  const fromBot = gateDecision(pinPr({ files: ["src/a.ts", "lanes.config.json"], config: teamCfg, statuses: [...botPassed, botStatus("owner")] }));
  assert.notEqual(fromBot.state, "success");
});

test("gateDecision reuse takes a lane-bot status under team and refuses it otherwise", () => {
  const sha = "a".repeat(40);
  const names = requiredReviewers("full", classifyFiles(PIN_FILES, ownerCfg));
  const others = passed(names.filter((n) => n !== "test-hunter"));
  const reused = { sha, status: botStatus("test-hunter") };
  const base = pinPr({ statuses: others, verdicts: praised(names).map((v) => (v.reviewer === "test-hunter" ? { ...v, sha } : v)), reused });
  assert.match(gateDecision({ ...base, config: { ...ownerCfg, identity: TEAM_ID } }).description, /reused test-hunter/);
  assert.doesNotMatch(gateDecision({ ...base, config: ownerCfg }).description, /reused test-hunter/);
});

// #558, ADR 0021: the team profile's owner stage is a native code-owner review.
const HEAD = "d".repeat(40);
const review = (login, state = "APPROVED", commit_id = HEAD, type = "User") => ({ user: { login, type }, state, commit_id });
const OWNERS = ["leo", "Mia"];

test("nativeCodeOwnerApproval approves a code owner's APPROVED review on the head", () => {
  assert.deepEqual(nativeCodeOwnerApproval([review("leo")], "lane-author", HEAD, OWNERS, TEAM_ID), { approved: true, by: "leo" });
});

test("nativeCodeOwnerApproval never approves an older SHA, the author, the lane bot or a non-owner", () => {
  const no = { approved: false, by: null };
  assert.deepEqual(nativeCodeOwnerApproval([review("leo", "APPROVED", "e".repeat(40))], "x", HEAD, OWNERS, TEAM_ID), no);
  assert.deepEqual(nativeCodeOwnerApproval([review("leo")], "leo", HEAD, OWNERS, TEAM_ID), no);
  assert.deepEqual(nativeCodeOwnerApproval([review(BOT, "APPROVED", HEAD, "Bot")], "x", HEAD, [BOT], TEAM_ID), no);
  assert.deepEqual(nativeCodeOwnerApproval([review("eve")], "x", HEAD, OWNERS, TEAM_ID), no);
});

test("nativeCodeOwnerApproval lets a later CHANGES_REQUESTED or DISMISSED supersede, and a later approval win", () => {
  for (const state of ["CHANGES_REQUESTED", "DISMISSED"]) {
    assert.equal(nativeCodeOwnerApproval([review("leo"), review("leo", state)], "x", HEAD, OWNERS, TEAM_ID).approved, false, state);
  }
  assert.equal(nativeCodeOwnerApproval([review("leo", "CHANGES_REQUESTED"), review("leo")], "x", HEAD, OWNERS, TEAM_ID).approved, true);
  // Another owner's later rejection does not undo this owner's approval.
  assert.deepEqual(nativeCodeOwnerApproval([review("leo"), review("Mia", "CHANGES_REQUESTED")], "x", HEAD, OWNERS, TEAM_ID), { approved: true, by: "leo" });
});

test("nativeCodeOwnerApproval: approve-then-comment stays approved, approve-then-changes-requested does not", () => {
  for (const state of ["COMMENTED", "PENDING"]) {
    assert.deepEqual(nativeCodeOwnerApproval([review("leo"), review("leo", state)], "x", HEAD, OWNERS, TEAM_ID), { approved: true, by: "leo" }, state);
  }
  assert.equal(nativeCodeOwnerApproval([review("leo"), review("leo", "COMMENTED"), review("leo", "CHANGES_REQUESTED")], "x", HEAD, OWNERS, TEAM_ID).approved, false);
  // edge: a comment alone is no approval
  assert.equal(nativeCodeOwnerApproval([review("leo", "COMMENTED")], "x", HEAD, OWNERS, TEAM_ID).approved, false);
});

test("edge: nativeCodeOwnerApproval matches owners exactly and fails closed on empty or malformed input", () => {
  const no = { approved: false, by: null };
  assert.deepEqual(nativeCodeOwnerApproval([review("LEO")], "x", HEAD, OWNERS, TEAM_ID), no);
  assert.deepEqual(nativeCodeOwnerApproval([review("leo")], "x", HEAD, [], TEAM_ID), no);
  for (const reviews of [null, undefined, "x", [], [null], [{}], [{ user: null, state: "APPROVED", commit_id: HEAD }]]) {
    assert.deepEqual(nativeCodeOwnerApproval(reviews, "x", HEAD, OWNERS, TEAM_ID), no, JSON.stringify(reviews));
  }
  assert.deepEqual(nativeCodeOwnerApproval([review("leo")], "x", undefined, OWNERS, TEAM_ID), no);
  assert.deepEqual(nativeCodeOwnerApproval([review("leo")], "x", HEAD, null, TEAM_ID), no);
});

test("edge: nativeCodeOwnerApproval treats a login that equals the bot as the bot only under team", () => {
  assert.equal(nativeCodeOwnerApproval([review(BOT, "APPROVED", HEAD, "Bot")], "x", HEAD, [BOT], TEAM_ID).approved, false);
  assert.equal(nativeCodeOwnerApproval([review(BOT, "APPROVED", HEAD, "Bot")], "x", HEAD, [BOT], undefined).approved, true);
  assert.equal(nativeCodeOwnerApproval([review(BOT, "APPROVED", HEAD, "Bot")], "x", HEAD, [BOT], { profile: "solo" }).approved, true);
});

test("parseCodeOwnerUsers returns user owners and ignores teams, emails and comments", () => {
  const text = ["# owners", "* @leo @Mia # trailing comment @ghost", "/docs/ @acme/docs-team a@b.co", "", "  # @indented", "*.md @leo @new-user\r", "/x @org/t @solo-1"].join("\n");
  assert.deepEqual(parseCodeOwnerUsers(text), ["leo", "Mia", "new-user", "solo-1"]);
});

test("edge: parseCodeOwnerUsers yields nothing for empty, comment-only, team-only or non-string input", () => {
  for (const t of ["", "# only a comment\n", "* @org/team\n", "@leo\n", null, undefined, 5]) {
    assert.deepEqual(parseCodeOwnerUsers(t), [], String(t));
  }
});

const teamCfg = { ...ownerCfg, identity: TEAM_ID };
const teamPr = (over = {}) => pinPr({ config: teamCfg, files: ["src/a.ts"], ...over });
const approvedBy = { approved: true, by: "leo" };
const needsPr = (over = {}) => teamPr({ prBody: quickPr.prBody.replace("## Needs the owner\nnothing", "## Needs the owner\ndecide x"), ...over });
const teamWait = (reason) => `waiting for a code-owner review in GitHub (${reason})`;

test("team gateDecision waits for a native review for each of the four owner reasons and passes with one", () => {
  const cases = {
    "owner-only path": teamPr({ files: ["lanes.config.json"] }),
    "needs the owner": needsPr(),
    "breaking contract change": teamPr({ prBody: quickPr.prBody.replace("## Contract changes\nnone", "## Contract changes\nbreaking"), files: ["contracts/x.ts"], issueLabels: ["tier:full", "ready", "contract:breaking"] }),
  };
  for (const [reason, input] of Object.entries(cases)) {
    for (const nativeApproval of [{ approved: false, by: null }, { approved: "yes", by: "leo" }, {}]) {
      const d = gateDecision({ ...input, nativeApproval });
      assert.deepEqual([d.state, d.stage, d.description], ["pending", "owner", teamWait(reason)], `${reason} ${JSON.stringify(nativeApproval)}`);
    }
    const ok = gateDecision({ ...input, nativeApproval: approvedBy });
    assert.deepEqual([ok.state, ok.stage], ["success", "ready"], reason);
  }
  const quick = { ...quickPr, config: teamCfg, files: ["contracts/x.ts"], prBody: quickPr.prBody.replace("## Contract changes\nnone", "## Contract changes\nadditive"), statuses: passed(requiredReviewers("quick", classifyFiles(["contracts/x.ts"], ownerCfg))) };
  assert.equal(gateDecision({ ...quick, nativeApproval: { approved: false, by: null } }).description, teamWait("contract change"));
  assert.equal(gateDecision({ ...quick, nativeApproval: approvedBy }).state, "success");
});

test("team gateDecision: a full-tier blocker waits for a native review", () => {
  const d = gateDecision(teamPr({ verdicts: [], nativeApproval: { approved: false, by: null } }));
  assert.equal(d.description, teamWait(`no verdict for head from ${requiredReviewers("full", classifyFiles(["src/a.ts"], ownerCfg))[0]}`));
  assert.equal(gateDecision(teamPr({ verdicts: [], nativeApproval: approvedBy })).state, "success");
});

test("team gateDecision never says /approve, and ignores review/owner statuses", () => {
  const input = needsPr({ statuses: [...passed(["test-hunter"]), { ...ownerOk, creator: human }] });
  const d = gateDecision({ ...input, prNumber: 9, nativeApproval: { approved: false, by: null } });
  assert.equal(d.state, "pending");
  assert.doesNotMatch(d.description, /approve/);
  const onlyOwner = gateDecision(teamPr({ files: PIN_FILES, nativeApproval: { approved: false, by: null } }));
  assert.equal(onlyOwner.description, teamWait("owner-only path"));
  assert.equal(gateDecision(teamPr({ files: PIN_FILES, nativeApproval: approvedBy })).state, "success");
});

test("team gateDecision with no owner reason does not need a native review and still needs its reviewers", () => {
  assert.equal(gateDecision(teamPr()).description, "unattended-eligible (tier:full), reviews in");
  assert.equal(gateDecision(teamPr({ statuses: [] })).stage, "review");
});

test("gateDecision with nativeApproval null or absent is pending (#575)", () => {
  for (const nativeApproval of [undefined, null]) {
    const d = gateDecision(needsPr({ nativeApproval }));
    assert.deepEqual([d.state, d.stage, d.description], ["pending", "owner", teamWait("needs the owner")], String(nativeApproval));
  }
  // a review/owner success does not pass it either
  const ownerStatus = { ...ownerOk, creator: human };
  for (const nativeApproval of [undefined, null]) {
    const withOwner = gateDecision(needsPr({ statuses: [...passed(["test-hunter"]), ownerStatus], nativeApproval }));
    assert.deepEqual([withOwner.state, withOwner.stage, withOwner.description], ["pending", "owner", teamWait("needs the owner")], `review/owner ${nativeApproval}`);
    const onlyOwner = gateDecision(teamPr({ files: PIN_FILES, nativeApproval }));
    assert.deepEqual([onlyOwner.state, onlyOwner.stage], ["pending", "owner"], `owner-only ${nativeApproval}`);
    assert.match(onlyOwner.description, /^waiting for a code-owner review in GitHub \(owner-only path\)/);
  }
  // edge: a non-object nativeApproval (a bare true) is not an approval either
  assert.equal(gateDecision(needsPr({ nativeApproval: true })).state, "pending");
});

test("team gateDecision with a nativeApproval object ignores a review/owner success; only approved true passes", () => {
  const ownerStatus = { ...ownerOk, creator: human };
  const withOwner = needsPr({ statuses: [...passed(["test-hunter"]), ownerStatus] });
  const d = gateDecision({ ...withOwner, nativeApproval: { approved: false, by: null } });
  assert.deepEqual([d.state, d.description], ["pending", teamWait("needs the owner")]);
  assert.equal(gateDecision({ ...withOwner, nativeApproval: approvedBy }).state, "success");
});

// #593: pure reuse check for pending workflow files (ADR 0023 part 3)
const WF = ".github/workflows/x.yml";
const wfDiff = (path, line = "y") => `diff --git a/${path} b/${path}\nindex 0000000..1111111 100644\n--- a/${path}\n+++ b/${path}\n@@ -1,1 +1,1 @@\n-x\n+${line}\n`;
const sha = (text) => createHash("sha256").update(text).digest("hex");

test("pendingFileHash hashes the normalised text; CRLF and final-newline variants hash alike", () => {
  const want = sha("a: 1\nb: 2\n");
  assert.equal(pendingFileHash("a: 1\nb: 2\n"), want);
  assert.equal(pendingFileHash("a: 1\r\nb: 2\r\n"), want);
  assert.equal(pendingFileHash("a: 1\nb: 2"), want);
  assert.equal(pendingFileHash("a: 1\nb: 2\n\n\n"), want);
  assert.notEqual(pendingFileHash("a: 1\nb: 3\n"), want);
});

test("edge: pendingFileHash is null for empty, newline-only, invalid UTF-8 and non-text input", () => {
  assert.equal(pendingFileHash(""), null);
  assert.equal(pendingFileHash("\r\n\n"), null);
  assert.equal(pendingFileHash(Buffer.from([0xff, 0xfe, 0x41])), null);
  assert.equal(pendingFileHash("a\ud800b"), null);
  assert.equal(pendingFileHash(undefined), null);
  assert.equal(pendingFileHash(42), null);
  assert.equal(pendingFileHash(Buffer.from("a: 1\r\n")), sha("a: 1\n"));
});

const H = "a".repeat(64);
test("parsePending returns the entries only for a valid non-empty list", () => {
  assert.deepEqual(parsePending({ pending: [{ path: WF, sha256: H }] }), [{ path: WF, sha256: H }]);
  assert.deepEqual(parsePending({ pending: [{ path: WF, sha256: H, extra: 1 }] }), [{ path: WF, sha256: H }]);
});

test("edge: parsePending rejects a path outside .github/workflows/, a .. path, a bad hash and duplicates", () => {
  const bad = (p) => assert.equal(parsePending({ pending: p }), null);
  bad([{ path: "src/x.yml", sha256: H }]);
  bad([{ path: ".github/other/x.yml", sha256: H }]);
  bad([{ path: ".github/workflows/../x.yml", sha256: H }]);
  bad([{ path: ".github/workflows/", sha256: H }]);
  bad([{ path: WF, sha256: "A".repeat(64) }]);
  bad([{ path: WF, sha256: "a".repeat(63) }]);
  bad([{ path: WF, sha256: H }, { path: WF, sha256: "b".repeat(64) }]);
  bad([{ path: WF }]);
  bad([null]);
  bad([[]]);
  bad([]);
  bad("x");
  bad(undefined);
});

test("edge: parsePending fails closed on a non-object verdict", () => {
  for (const v of [null, undefined, "x", 3, [], {}]) assert.equal(parsePending(v), null);
});

test("diffFingerprint with omit drops the listed paths' blocks; without omit it is unchanged", () => {
  const both = fileB("0000000") + wfDiff(WF);
  assert.equal(diffFingerprint(both, { omit: [WF] }), diffFingerprint(fileB("1234567")));
  assert.equal(diffFingerprint(both), diffFingerprint(both, {}));
  assert.equal(diffFingerprint(both), diffFingerprint(both, { omit: [] }));
  assert.notEqual(diffFingerprint(both), diffFingerprint(fileB("0000000")));
  assert.notEqual(diffFingerprint(both, { omit: [WF] }), diffFingerprint(both));
});

test("edge: diffFingerprint with omit fails closed (null) on a block whose file name cannot be parsed", () => {
  assert.equal(diffFingerprint(fileB("0000000").replace("diff --git a/b.js b/b.js", "diff --git weird"), { omit: [WF] }), null);
  assert.equal(diffFingerprint('diff --git "a/q r.js" "b/q r.js"\n+x\n', { omit: [WF] }), null);
  assert.equal(diffFingerprint("+stray\n", { omit: [WF] }), null);
  assert.equal(diffFingerprint(fileB("0000000").replace("b/b.js", "b/c.js"), { omit: [WF] }), null);
});

const earlier = fileB("0000000");
const reuse = (over = {}) => pendingReuseBlockedBy({
  pending: [{ path: WF, sha256: H }],
  changedSince: [WF],
  headHashes: { [WF]: H },
  earlierDiff: earlier,
  headDiff: earlier + wfDiff(WF),
  ...over,
});

test("pendingReuseBlockedBy is null when only the pending file was added, with the reviewed hash and the same other diff", () => {
  assert.equal(reuse(), null);
  assert.equal(reuse({ headHashes: new Map([[WF, H]]) }), null);
  assert.equal(reuse({ headDiff: wfDiff(WF) + earlier.replace("0000000", "9999999") }), null);
});

test("pendingReuseBlockedBy blocks a changed file that is not pending", () => {
  assert.match(reuse({ changedSince: [WF, "src/a.js"] }), /src\/a\.js/);
  assert.match(reuse({ changedSince: [WF, ".github/workflows/y.yml"] }), /y\.yml/);
});

test("pendingReuseBlockedBy names a missing or different pending blob", () => {
  assert.equal(reuse({ headHashes: { [WF]: "b".repeat(64) } }), `workflow file ${WF} differs from the reviewed copy`);
  assert.equal(reuse({ headHashes: {} }), `workflow file ${WF} is not committed yet`);
  assert.equal(reuse({ headHashes: { [WF]: null } }), `workflow file ${WF} is not committed yet`);
  assert.equal(reuse({ headHashes: new Map() }), `workflow file ${WF} is not committed yet`);
  assert.equal(reuse({ changedSince: [], headHashes: {} }), `workflow file ${WF} is not committed yet`);
});

test("pendingReuseBlockedBy blocks a fingerprint mismatch of the non-pending diff", () => {
  assert.match(reuse({ headDiff: fileB("0000000").replace("+y", "+z") + wfDiff(WF) }), /./);
  assert.match(reuse({ headDiff: "" }), /./);
});

test("edge: pendingReuseBlockedBy fails closed on malformed inputs", () => {
  const blocked = (over) => assert.equal(typeof reuse(over), "string");
  blocked({ pending: null });
  blocked({ pending: [] });
  blocked({ pending: [{ path: "src/x.yml", sha256: H }] });
  blocked({ changedSince: null });
  blocked({ changedSince: "x" });
  blocked({ changedSince: [WF, 3] });
  blocked({ headHashes: null });
  blocked({ headHashes: undefined });
  blocked({ earlierDiff: undefined });
  blocked({ headDiff: "diff --git weird\n" });
  assert.equal(typeof pendingReuseBlockedBy(), "string");
  assert.equal(typeof pendingReuseBlockedBy({}), "string");
});

test("edge: pendingReuseBlockedBy ignores a hash that is only inherited from Object.prototype", () => {
  assert.equal(reuse({ headHashes: Object.create({ [WF]: H }) }), `workflow file ${WF} is not committed yet`);
});
