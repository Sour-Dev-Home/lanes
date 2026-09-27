import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SCHEMA_VERSION, buildReport, collectVerdicts, normalizePr, parseArgs, parseGraphql, readVerdict, renderMarkdown, summarize } from "./review-metrics.mjs";

const NOW = new Date("2026-09-27T12:00:00Z");
const SHA = "a".repeat(40);

const verdict = (reviewer, { findings = [], metrics } = {}) => ({
  reviewer,
  verdict: findings.some((f) => f.severity !== "minor") ? "failure" : "success",
  summary: "private-summary-marker",
  criteria: [{ index: 1, result: "pass", evidence: "private-evidence-marker" }],
  findings,
  ...(metrics === undefined ? {} : { metrics }),
});
const finding = (severity) => ({ severity, file: "private/file-marker.mjs", line: 1, summary: "private-finding-marker", fixed: true });
const comment = (v, sha = SHA) => `<!-- lanes:verdict ${v.reviewer} ${sha} -->\n\`\`\`json\n${JSON.stringify(v, null, 2)}\n\`\`\``;

// A GraphQL PR node as the API returns it, with the personal fields a careless script could copy through.
const node = (bodies, overrides = {}) => ({
  number: 7,
  mergedAt: "2026-09-26T04:00:00Z",
  updatedAt: "2026-09-26T04:00:00Z",
  title: "feat: private-title-marker",
  author: { login: "octo-person" },
  closingIssuesReferences: { nodes: [{ labels: { nodes: [{ name: "ready" }, { name: "tier:full" }] } }] },
  comments: { nodes: bodies.map((body) => ({ body, author: { login: "octo-person" } })) },
  ...overrides,
});

const entry = (tier, v) => ({ tier, reviewer: v.reviewer, verdict: v });
const group = (summary, tier, reviewer) => summary.tiers.find((t) => t.tier === tier).reviewers.find((r) => r.reviewer === reviewer);

// ---- AC1: reads verdict comments on PRs merged in the window; unreadable is counted, not fatal ----

test("readVerdict parses a verdict comment and takes its tier from metrics", () => {
  const v = verdict("test-hunter", { metrics: { tier: "quick", minutes: 3, tokens: 1000 } });
  assert.deepEqual(readVerdict(comment(v), "full"), { tier: "quick", reviewer: "test-hunter", verdict: v });
});

test("readVerdict falls back to the PR's tier, then unknown, when a verdict has no metrics", () => {
  const v = verdict("security-reviewer");
  assert.equal(readVerdict(comment(v), "full").tier, "full");
  assert.equal(readVerdict(comment(v), null).tier, "unknown");
});

test("readVerdict marks a verdict comment that does not parse as unreadable and ignores other comments", () => {
  assert.deepEqual(readVerdict("<!-- lanes:verdict test-hunter -->\n```json\n{ not json\n```", "full"), { unreadable: true });
  assert.deepEqual(readVerdict("<!-- lanes:verdict test-hunter -->\nno fence", "full"), { unreadable: true });
  assert.equal(readVerdict("LGTM", "full"), null);
  assert.equal(readVerdict("> <!-- lanes:verdict test-hunter -->", "full"), null);
  assert.equal(readVerdict(undefined, "full"), null);
});

test("collectVerdicts keeps only PRs merged inside the window", () => {
  const inside = normalizePr(node([comment(verdict("test-hunter"))]));
  const before = normalizePr(node([comment(verdict("ui-reviewer"))], { mergedAt: "2026-09-10T00:00:00Z" }));
  const after = normalizePr(node([comment(verdict("ui-reviewer"))], { mergedAt: "2026-09-28T00:00:00Z" }));
  const entries = collectVerdicts([inside, before, after, undefined], { now: NOW, days: 7 });
  assert.deepEqual(entries.map((e) => e.reviewer), ["test-hunter"]);
  assert.equal(entries[0].tier, "full");
});

test("normalizePr keeps only the merge date, the issue tier and comment bodies", () => {
  const pr = normalizePr(node(["body"]));
  assert.deepEqual(pr, { mergedAt: "2026-09-26T04:00:00Z", tier: "full", bodies: ["body"] });
  assert.equal(normalizePr(node([], { closingIssuesReferences: { nodes: [] } })).tier, null);
  assert.equal(normalizePr({}), undefined);
});

// ---- AC2 + AC3: summarize groups by tier and reviewer; runs without metrics count for runs and findings only ----

test("summarize groups two tiers by reviewer with medians, totals and finding counts", () => {
  const s = summarize([
    entry("full", verdict("test-hunter", { findings: [finding("critical"), finding("minor")], metrics: { tier: "full", minutes: 10, tokens: 4000 } })),
    entry("full", verdict("test-hunter", { findings: [finding("important")], metrics: { tier: "full", minutes: 20, tokens: 6000 } })),
    entry("full", verdict("test-hunter", { findings: [], metrics: { tier: "full", minutes: 40, tokens: 20000 } })),
    entry("quick", verdict("test-hunter", { findings: [finding("minor")], metrics: { tier: "quick", minutes: 2, tokens: 500 } })),
  ]);
  assert.deepEqual(s.tiers.map((t) => t.tier), ["full", "quick"]);
  assert.deepEqual(group(s, "full", "test-hunter"), {
    reviewer: "test-hunter",
    runs: 3,
    runsWithMetrics: 3,
    runsWithoutMetrics: 0,
    minutes: { median: 20, total: 70 },
    tokens: { median: 6000, total: 30000 },
    realFindings: 2,
    minorFindings: 1,
    runsWithNoRealFinding: 1,
  });
  assert.equal(group(s, "quick", "test-hunter").realFindings, 0);
  assert.equal(group(s, "quick", "test-hunter").minorFindings, 1);
});

test("summarize reports a reviewer with no findings", () => {
  const s = summarize([entry("full", verdict("ui-reviewer", { metrics: { tier: "full", minutes: 1, tokens: 100 } }))]);
  const r = group(s, "full", "ui-reviewer");
  assert.equal(r.realFindings, 0);
  assert.equal(r.minorFindings, 0);
  assert.equal(r.runsWithNoRealFinding, 1);
  const tier = s.tiers[0];
  assert.equal(tier.noRealFindingShare, 1);
  assert.equal(tier.tokensPerRealFinding, null);
});

test("runs without metrics count toward runs and findings but not minutes or tokens", () => {
  const entries = [
    entry("full", verdict("security-reviewer", { findings: [finding("critical")] })),
    entry("full", verdict("security-reviewer", { metrics: { tier: "full", minutes: 5, tokens: 2000 } })),
  ];
  const s = summarize(entries);
  const r = group(s, "full", "security-reviewer");
  assert.equal(r.runs, 2);
  assert.equal(r.runsWithMetrics, 1);
  assert.equal(r.runsWithoutMetrics, 1);
  assert.deepEqual(r.minutes, { median: 5, total: 5 });
  assert.deepEqual(r.tokens, { median: 2000, total: 2000 });
  assert.equal(r.realFindings, 1);
  const tier = s.tiers[0];
  assert.equal(tier.runsWithoutMetrics, 1);
  // Tokens per real finding uses metered runs only: the one metered run found nothing.
  assert.equal(tier.tokensPerRealFinding, null);
  const report = buildReport({ entries, now: NOW, days: 7 });
  assert.equal(report.runsWithoutMetrics, 1);
  assert.match(renderMarkdown(report), /1 of 2 runs without metrics/);
});

test("a reviewer whose runs all lack metrics has null medians and zero totals", () => {
  const r = group(summarize([entry("quick", verdict("test-hunter"))]), "quick", "test-hunter");
  assert.deepEqual(r.minutes, { median: null, total: 0 });
  assert.deepEqual(r.tokens, { median: null, total: 0 });
});

test("summarize totals a tier: tokens per real finding and share of runs with no real finding", () => {
  const s = summarize([
    entry("full", verdict("test-hunter", { findings: [finding("critical"), finding("important")], metrics: { tier: "full", minutes: 10, tokens: 8000 } })),
    entry("full", verdict("ui-reviewer", { metrics: { tier: "full", minutes: 2, tokens: 2000 } })),
    entry("full", verdict("security-reviewer", { findings: [finding("minor")], metrics: { tier: "full", minutes: 3, tokens: 2000 } })),
    entry("full", verdict("architecture-advisor", { findings: [finding("important")] })),
  ]);
  const t = s.tiers[0];
  assert.equal(t.runs, 4);
  assert.equal(t.realFindings, 3);
  assert.equal(t.totalTokens, 12000);
  assert.equal(t.tokensPerRealFinding, 6000); // 12000 metered tokens / 2 real findings from metered runs
  assert.equal(t.runsWithNoRealFinding, 2);
  assert.equal(t.noRealFindingShare, 0.5);
  assert.deepEqual(t.reviewers.map((r) => r.reviewer), ["architecture-advisor", "security-reviewer", "test-hunter", "ui-reviewer"]);
});

// ---- AC6: empty window ----

test("an empty window gives no tiers and a report that says so", () => {
  assert.deepEqual(summarize([]).tiers, []);
  const r = buildReport({ entries: collectVerdicts([], { now: NOW, days: 7 }), now: NOW, days: 7 });
  assert.equal(r.runs, 0);
  assert.match(renderMarkdown(r), /No reviewer runs/);
});

test("unreadable comments are counted in the report", () => {
  const prs = [normalizePr(node(["<!-- lanes:verdict test-hunter -->\n```json\n{\n```", comment(verdict("ui-reviewer"))]))];
  const r = buildReport({ entries: collectVerdicts(prs, { now: NOW, days: 7 }), now: NOW, days: 7 });
  assert.equal(r.unreadable, 1);
  assert.equal(r.runs, 1);
  assert.match(renderMarkdown(r), /1 unreadable/);
});

test("summarize skips unreadable markers", () => {
  const s = summarize([{ unreadable: true }, entry("full", verdict("ui-reviewer"))]);
  assert.equal(s.tiers[0].runs, 1);
});

// ---- AC4: aggregates only ----

test("the report and markdown carry no login, title, finding text or file", () => {
  const prs = [normalizePr(node([comment(verdict("test-hunter", { findings: [finding("critical")], metrics: { tier: "full", minutes: 1, tokens: 10 } }))]))];
  const r = buildReport({ entries: collectVerdicts(prs, { now: NOW, days: 7 }), now: NOW, days: 7 });
  const text = JSON.stringify(r) + renderMarkdown(r);
  for (const marker of ["octo-person", "private-title-marker", "private-finding-marker", "private-summary-marker", "private-evidence-marker", "file-marker", SHA]) {
    assert.ok(!text.includes(marker), `leaked ${marker}`);
  }
  assert.equal(r.schemaVersion, SCHEMA_VERSION);
});

// ---- AC5: /health runs it ----

test("/health runs review-metrics for 7 days and reports tokens per real finding and runs with none", () => {
  const health = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".claude", "commands", "health.md"), "utf8");
  assert.match(health, /node scripts\/lanes\/review-metrics\.mjs --days 7/);
  assert.match(health, /tokens per real finding/);
  assert.match(health, /no real finding/);
});

// ---- edge cases ----

test("edge: malformed findings or metrics, or an unknown reviewer, make a verdict unreadable", () => {
  const bad = (v) => readVerdict(comment(v), "full");
  assert.deepEqual(bad({ ...verdict("test-hunter"), findings: "none" }), { unreadable: true });
  assert.deepEqual(bad({ ...verdict("test-hunter"), findings: [null] }), { unreadable: true });
  assert.deepEqual(bad(verdict("test-hunter", { metrics: { tier: "full", minutes: -1, tokens: 1 } })), { unreadable: true });
  assert.deepEqual(bad(verdict("test-hunter", { metrics: { tier: "huge", minutes: 1, tokens: 1 } })), { unreadable: true });
  assert.deepEqual(bad(verdict("test-hunter", { metrics: { tier: "full", minutes: 1, tokens: 1.5 } })), { unreadable: true });
  assert.deepEqual(bad(verdict("test-hunter", { metrics: null })), { unreadable: true });
  assert.deepEqual(bad(verdict("someone-else")), { unreadable: true });
});

test("edge: a finding with an unknown severity is neither real nor minor", () => {
  const r = group(summarize([entry("full", verdict("test-hunter", { findings: [finding("nit")] }))]), "full", "test-hunter");
  assert.equal(r.realFindings, 0);
  assert.equal(r.minorFindings, 0);
  assert.equal(r.runsWithNoRealFinding, 1);
});

test("edge: tiers sort full, quick, skip, unknown", () => {
  const s = summarize(["unknown", "skip", "full", "quick"].map((tier) => entry(tier, verdict("test-hunter"))));
  assert.deepEqual(s.tiers.map((t) => t.tier), ["full", "quick", "skip", "unknown"]);
});

test("edge: an even number of metered runs takes the midpoint median; zero-token runs still count", () => {
  const r = group(
    summarize([
      entry("full", verdict("ui-reviewer", { metrics: { tier: "full", minutes: 0, tokens: 0 } })),
      entry("full", verdict("ui-reviewer", { metrics: { tier: "full", minutes: 3, tokens: 1000 } })),
    ]),
    "full",
    "ui-reviewer",
  );
  assert.deepEqual(r.minutes, { median: 1.5, total: 3 });
  assert.deepEqual(r.tokens, { median: 500, total: 1000 });
});

test("edge: normalizePr ignores non-tier labels, null nodes and non-string bodies", () => {
  const pr = normalizePr(node([], {
    closingIssuesReferences: { nodes: [null, { labels: { nodes: [{ name: "tier:huge" }, null, { name: "tier:quick" }] } }] },
    comments: { nodes: [null, { body: 5 }, { body: "ok" }] },
  }));
  assert.equal(pr.tier, "quick");
  assert.deepEqual(pr.bodies, ["ok"]);
});

test("edge: a PR merged exactly at the window start is inside it", () => {
  const pr = normalizePr(node([comment(verdict("test-hunter"))], { mergedAt: "2026-09-20T12:00:00Z" }));
  assert.equal(collectVerdicts([pr], { now: NOW, days: 7 }).length, 1);
});

test("edge: a PR merged exactly at 'now' is inside the window", () => {
  const pr = normalizePr(node([comment(verdict("test-hunter"))], { mergedAt: NOW.toISOString() }));
  assert.equal(collectVerdicts([pr], { now: NOW, days: 7 }).length, 1);
});

// Not covered by the acceptance criteria or the listed edge cases above: a second review round on the same PR
// posts a second verdict comment from the same reviewer, which the file's own header comment defines as a second
// run. Nothing dedupes by reviewer, so it must count twice, not once.
test("edge: two verdict comments from the same reviewer on one PR count as two separate runs", () => {
  const v1 = verdict("test-hunter", { findings: [finding("critical")], metrics: { tier: "full", minutes: 10, tokens: 1000 } });
  const v2 = verdict("test-hunter", { findings: [], metrics: { tier: "full", minutes: 5, tokens: 500 } });
  const pr = normalizePr(node([comment(v1), comment(v2)]));
  const entries = collectVerdicts([pr], { now: NOW, days: 7 });
  assert.equal(entries.length, 2);
  const r = group(summarize(entries), "full", "test-hunter");
  assert.equal(r.runs, 2);
  assert.equal(r.realFindings, 1);
  assert.equal(r.runsWithNoRealFinding, 1);
  assert.deepEqual(r.minutes, { median: 7.5, total: 15 });
  assert.deepEqual(r.tokens, { median: 750, total: 1500 });
});

test("edge: parseGraphql never echoes the raw response", () => {
  assert.throws(() => parseGraphql("secret <html>"), (e) => !e.message.includes("secret"));
  assert.throws(() => parseGraphql('{"data":{}}'), /unexpected/);
  assert.equal(parseGraphql('{"data":{"repository":{"pullRequests":{"nodes":[],"pageInfo":{"hasNextPage":false}}}}}').nodes.length, 0);
});

// ---- args ----

test("parseArgs defaults to 7 days of markdown and validates --days", () => {
  assert.deepEqual(parseArgs([]), { days: 7, json: false });
  assert.deepEqual(parseArgs(["--days", "30", "--json"]), { days: 30, json: true });
  assert.throws(() => parseArgs(["--days", "0"]), /--days/);
  assert.throws(() => parseArgs(["--days"]), /--days/);
  assert.throws(() => parseArgs(["--days", "x"]), /--days/);
  assert.throws(() => parseArgs(["--nope"]), /Unknown argument/);
});
