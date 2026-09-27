// scripts/lanes/lib.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { adrGoverns, authorCanWrite, classifyFiles, compileConfig, loadConfig, parseAdr, parseVerdictComment, requiredReviewers, reviewContext } from "./lib.mjs";

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
