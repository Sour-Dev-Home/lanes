// scripts/lanes/lib.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adrGoverns, authorCanWrite, classifyFiles, compileConfig, diffFingerprint, gateDecision, interfaceContractOf, interfacePaths, laneIssueOf, loadAdrs, loadConfig, parseAdr, parseValidation, parseVerdictComment, requiredReviewers, reviewContext, reviewersReport, testHunterReusable } from "./lib.mjs";

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
  assert.equal(laneIssueOf({ kind: "background", name: "reactapps-dc", cwd }), 12);
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
  "^scripts/lanes/(gate|lib|approve-guard|post-review|issue-contract)(\\.test)?\\.mjs$": ["scripts/lanes/approve-guard.test.mjs", "scripts/lanes/gatekeeper.mjs"],
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
  "^scripts/lanes/owner-diff(\\.test)?\\.mjs$": ["scripts/lanes/owner-diff.test.mjs", "scripts/lanes/owner-diffs.mjs"],
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

// #380, ADR 0015: the owner-path exemption for a diff owner-diff.mjs proved additive.
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

test("gateDecision clears the owner-only-path wait for an additive diff of the pin files with every reviewer passed", () => {
  assert.equal(gateDecision(pinPr()).description, "waiting on owner (/approve) (owner-only path)");
  const d = gateDecision(pinPr({ ownerDiff: "additive" }));
  assert.equal(d.state, "success");
  assert.equal(d.description, "unattended-eligible (tier:full), reviews in");
  for (const files of [["lanes.config.json"], ["scripts/lanes/workflow.test.mjs"]]) {
    assert.equal(gateDecision(pinPr({ files, ownerDiff: "additive" })).state, "success", files[0]);
  }
});

test("gateDecision keeps the owner wait when an additive diff also changes a third file", () => {
  for (const extra of ["scripts/lanes/gate.mjs", "docs/a.md", "src/a.ts"]) {
    const d = gateDecision(pinPr({ files: [...PIN_FILES, extra], ownerDiff: "additive" }));
    assert.equal(d.state, "pending", extra);
    assert.match(d.description, /^waiting on owner \(\/approve\) \(owner-only path\)/, extra);
  }
});

test("gateDecision keeps the owner wait for an additive diff whose reviewer failed or is missing", () => {
  const [first, ...rest] = pinReviewers;
  assert.ok(rest.length > 0);
  const failing = praised(pinReviewers).map((v) => (v.reviewer === first ? { ...v, verdict: { verdict: "failure", findings: [] } } : v));
  assert.equal(gateDecision(pinPr({ ownerDiff: "additive", verdicts: failing })).description, `waiting on owner (/approve) (verdict from ${first} is not success)`);
  assert.equal(gateDecision(pinPr({ ownerDiff: "additive", verdicts: praised(rest) })).description, `waiting on owner (/approve) (no verdict for head from ${first})`);
  // A verdict for an older commit is no verdict for the head.
  assert.equal(gateDecision(pinPr({ ownerDiff: "additive", verdicts: praised(pinReviewers, "c".repeat(40)) })).stage, "owner");
  // A review status missing or failed on the head never reaches the owner stage, exempt or not.
  assert.equal(gateDecision(pinPr({ ownerDiff: "additive", statuses: passed(rest) })).description, `waiting for review/${first}`);
  const failed = passed(pinReviewers).map((s, i) => (i === 0 ? { ...s, state: "failure" } : s));
  assert.equal(gateDecision(pinPr({ ownerDiff: "additive", statuses: failed })).state, "failure");
});

test("gateDecision keeps the owner wait for an additive diff whose Needs the owner is not nothing", () => {
  const prBody = quickPr.prBody.replace("## Needs the owner\nnothing", "## Needs the owner\nDecide whether this pin belongs here.");
  assert.equal(gateDecision(pinPr({ ownerDiff: "additive", prBody })).description, "waiting on owner (/approve) (needs the owner)");
});

test("gateDecision is unchanged when ownerDiff is absent or anything but the string additive", () => {
  const today = gateDecision(pinPr());
  for (const ownerDiff of [undefined, null, "", "needs owner", "Additive", " additive", "additive ", true, 1, ["additive"], { additive: true }]) {
    assert.deepEqual(gateDecision(pinPr({ ownerDiff })), today, String(ownerDiff));
  }
});

test("edge: the owner-path exemption compares file names exactly, never after normalising them", () => {
  for (const odd of ["./lanes.config.json", "Lanes.config.json", "scripts\\lanes\\workflow.test.mjs", "scripts/lanes/../lanes/workflow.test.mjs"]) {
    const d = gateDecision(pinPr({ files: [PIN_FILES[0], odd], statuses: passed(pinReviewers), verdicts: praised(pinReviewers), ownerDiff: "additive" }));
    assert.equal(d.stage, "owner", odd);
  }
});

test("edge: a rename into a pin file still lists its old name, which keeps the owner wait", () => {
  const d = gateDecision(pinPr({ files: ["scripts/lanes/gate.mjs", "lanes.config.json"], ownerDiff: "additive" }));
  assert.equal(d.description, "waiting on owner (/approve) (owner-only path)");
});

test("edge: the owner-path exemption never applies where the tier requires no reviewer", () => {
  const skipCfg = compileConfig({
    requiredChecks: ["verify"],
    paths: { skip: ["^lanes\\.config\\.json$", "\\.test\\.mjs$"], contract: [], sensitive: [], ui: [], owner: ["^lanes\\.config\\.json$", "^scripts/lanes/workflow\\.test\\.mjs$"] },
  });
  const d = gateDecision({ ...quickPr, issueLabels: ["tier:skip", "ready"], files: PIN_FILES, config: skipCfg, ownerDiff: "additive" });
  assert.equal(d.description, "waiting on owner (/approve) (owner-only path)");
});

test("edge: an additive diff with an unfixed important finding still waits on the owner for that finding", () => {
  const verdicts = praised(pinReviewers).map((v, i) => (i === 0 ? { ...v, verdict: { verdict: "success", findings: [{ severity: "important", fixed: false }] } } : v));
  assert.match(gateDecision(pinPr({ ownerDiff: "additive", verdicts })).description, /^waiting on owner \(\/approve\) \(unfixed important finding from /);
});
