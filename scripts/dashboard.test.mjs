import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const src = readFileSync("dashboard/app.js", "utf8");
const app = (() => {
  const sandbox = { module: { exports: {} } };
  vm.runInNewContext(src, sandbox);
  return sandbox.module.exports;
})();

// A minimal document: it records text and refuses innerHTML, outerHTML and insertAdjacentHTML.
function fakeDoc() {
  const make = (tag) => {
    const node = { tag, children: [], attrs: {}, className: "", textContent: "", hidden: false };
    for (const p of ["innerHTML", "outerHTML"]) Object.defineProperty(node, p, { set() { throw new Error(`${p} used`); }, get: () => "" });
    node.insertAdjacentHTML = () => { throw new Error("insertAdjacentHTML used"); };
    node.appendChild = (c) => (node.children.push(c), c);
    node.append = (...cs) => cs.forEach((c) => node.children.push(typeof c === "string" ? { tag: "#text", textContent: c, children: [] } : c));
    node.setAttribute = (k, v) => { node.attrs[k] = String(v); if (k === "class") node.className = String(v); };
    node.addEventListener = () => {};
    return node;
  };
  return { createElement: make, createElementNS: (_ns, tag) => make(tag), createTextNode: (t) => ({ tag: "#text", textContent: t, children: [] }) };
}
const textOf = (n) => (n.textContent ?? "") + " " + (n.children ?? []).map(textOf).join(" ");
const walk = (n, f) => { f(n); (n.children ?? []).forEach((c) => walk(c, f)); };
const pr = (number) => ({ number, headSha: "a".repeat(40), checks: [] });
const issue = (number, stage, extra = {}) => ({ number, title: `t${number}`, tier: "full", stage, blockedBy: [], ...extra });

test("app.js has no innerHTML, outerHTML, insertAdjacentHTML, document.write, eval, import or require", () => {
  assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|\bimport\b|\brequire\(/);
});

test("fetches snapshot.json every 60 s and treats 20 minutes as stale", () => {
  assert.match(src, /fetch\(["']snapshot\.json/);
  assert.equal(app.POLL_MS, 60_000);
  assert.equal(app.STALE_MS, 20 * 60_000);
});

test("staleNote is empty within 20 minutes and names the age past it", () => {
  const now = Date.parse("2026-09-28T12:00:00Z");
  assert.equal(app.staleNote("2026-09-28T11:41:00Z", now), "");
  assert.match(app.staleNote("2026-09-28T11:30:00Z", now), /stale.*30 min/i);
});

test("edge: staleNote is empty at exactly 20 minutes and stale one minute later", () => {
  const now = Date.parse("2026-09-28T12:00:00Z");
  assert.equal(app.staleNote("2026-09-28T11:40:00Z", now), "");
  assert.match(app.staleNote("2026-09-28T11:39:00Z", now), /stale/i);
});

test("renderGraph highlights only the edges on the critical path", () => {
  const svg = app.renderGraph(fakeDoc(), [1, 2, 3, 4].map((n) => issue(n, "blocked")), [{ from: 1, to: 2 }, { from: 2, to: 3 }, { from: 1, to: 4 }]);
  const cls = [];
  walk(svg, (n) => { if (/\bedge\b/.test(n.className)) cls.push(n.className); });
  assert.equal(cls.length, 3);
  assert.equal(cls.filter((c) => /\bcritical\b/.test(c)).length, 2);
});

test("edge: renderWaiting puts a hostile title and reason in text only", () => {
  const evil = `<img src=x onerror=alert(1)>`;
  const d = fakeDoc();
  const box = d.createElement("div");
  app.renderWaiting(d, box, [issue(1, "owner", { title: evil, pr: pr(3), blockedBy: [{ kind: "owner", ref: "r", reason: evil }] })]);
  assert.ok(textOf(box).includes(evil));
  walk(box, (n) => assert.ok(!/^(img|script)$/.test(n.tag), n.tag));
});

test("edge: staleNote treats an unreadable time as stale", () => {
  assert.match(app.staleNote("garbage", Date.now()), /stale/i);
});

test("stageOf maps snapshot stages onto the nine display stages", () => {
  const gate = (ref) => issue(1, "gate", { blockedBy: [{ kind: "review", ref, reason: "r" }] });
  assert.equal(app.stageOf(issue(1, "starting")), "writing");
  assert.equal(app.stageOf(issue(1, "failing")), "writing");
  assert.equal(app.stageOf(gate("test-hunter")), "test review");
  assert.equal(app.stageOf(gate("security-reviewer")), "security review");
  assert.equal(app.stageOf(gate("architecture-advisor")), "architecture review");
  assert.equal(app.stageOf(issue(1, "owner")), "waiting on owner");
  assert.equal(app.stageOf(issue(1, "contract")), "waiting on owner");
  assert.equal(app.stageOf(issue(1, "queued")), "merge queue");
  assert.equal(app.stageOf(issue(1, "blocked")), "blocked");
  assert.deepEqual(JSON.parse(JSON.stringify(app.STAGES)), ["ready", "not ready", "already met", "running", "writing", "test review", "security review", "architecture review", "waiting on owner", "queued", "merge queue", "merged", "blocked"]);
});

test("stageOf has explicit cases for ready, not-ready, already met and running; only an unknown stage is queued", () => {
  assert.equal(app.stageOf(issue(1, "ready")), "ready");
  assert.equal(app.stageOf(issue(1, "not-ready")), "not ready");
  assert.equal(app.stageOf(issue(1, "already met")), "already met");
  assert.equal(app.stageOf(issue(1, "running")), "running");
  assert.equal(app.stageOf(issue(1, "brand-new")), "queued");
  const snapshotStages = JSON.parse(readFileSync("contracts/snapshot.schema.json", "utf8")).properties.issues.items.properties.stage.enum;
  for (const s of snapshotStages) assert.notEqual(app.stageOf(issue(1, s)), "queued", s);
});

test("edge: an unknown stage or a gate wait with no reviewer name still maps to a stage", () => {
  assert.ok(app.STAGES.includes(app.stageOf(issue(1, "brand-new"))));
  assert.ok(app.STAGES.includes(app.stageOf(issue(1, "gate", { blockedBy: [] }))));
});

test("renderLegend lists every stage", () => {
  const d = fakeDoc();
  const ul = d.createElement("ul");
  app.renderLegend(d, ul);
  for (const s of app.STAGES) assert.ok(textOf(ul).includes(s), s);
});

test("renderTask names why a blocked task is blocked", () => {
  const li = app.renderTask(fakeDoc(), issue(5, "blocked", { blockedBy: [{ kind: "issue", ref: "#3", reason: "waits on open issue #3" }] }));
  assert.ok(textOf(li).includes("waits on open issue #3"));
  assert.ok(textOf(li).includes("#5"));
});

test("edge: a blocked task with an empty reason shows its ref; with no blockers it says no reason recorded", () => {
  const li = app.renderTask(fakeDoc(), issue(5, "blocked", { blockedBy: [{ kind: "issue", ref: "#3", reason: "" }] }));
  assert.ok(textOf(li).includes("#3"));
  assert.match(textOf(app.renderTask(fakeDoc(), issue(6, "blocked"))), /no reason recorded/i);
});

test("XSS fixture: a hostile title, ref and reason land only in text, never as elements", () => {
  const evil = `<img src=x onerror=alert(1)>"'</script>`;
  const d = fakeDoc();
  const li = app.renderTask(d, issue(9, "blocked", { title: evil, blockedBy: [{ kind: "check", ref: evil, reason: evil }] }));
  assert.ok(textOf(li).includes(evil));
  walk(li, (n) => assert.ok(!/^(img|script)$/.test(n.tag), n.tag));
  const svg = app.renderGraph(d, [issue(9, "blocked", { title: evil })], []);
  walk(svg, (n) => assert.ok(!/^(img|script)$/.test(n.tag), n.tag));
});

test("the page has no approve line, no Copy button and cannot post anything", () => {
  assert.equal(app.approveLine, undefined);
  assert.doesNotMatch(src, /approveLine|clipboard|"Copy"/);
  assert.doesNotMatch(src, /method\s*:\s*["']POST|XMLHttpRequest|api\.github\.com|sendBeacon|WebSocket/i);
  assert.equal([...src.matchAll(/fetch\(/g)].length, 1);
});

test("edge: renderWaiting says nothing waits when the list is empty", () => {
  const d = fakeDoc();
  const box = d.createElement("div");
  app.renderWaiting(d, box, []);
  assert.match(textOf(box), /nothing/i);
});

// ADR 0024: the team view.
const links = (n) => { const out = []; walk(n, (x) => { if (x.tag === "a") out.push(x); }); return out; };
const team = { profile: "team", repo: "acme/lanes" };
const BASE = "https://github.com/acme/lanes/";
const waitingIssue = (extra = {}) => issue(1, "owner", { pr: { ...pr(11), ownerApproved: true }, blockedBy: [{ kind: "owner", ref: "review/owner", reason: "waiting for a code-owner review in GitHub" }], ...extra });
const renderWait = (issues, snapshot) => {
  const d = fakeDoc();
  const box = d.createElement("div");
  app.renderWaiting(d, box, issues, snapshot);
  return box;
};

test("team: the waiting box has a Review in GitHub link, the reason, coverage text and the approve note, and no copy line or button", () => {
  const box = renderWait([waitingIssue()], team);
  const [a] = links(box);
  assert.equal(a.attrs.href, `${BASE}pull/11/files`);
  assert.equal(a.attrs.rel, "noopener noreferrer");
  assert.equal(a.textContent, "Review in GitHub");
  const text = textOf(box);
  assert.match(text, /waiting for a code-owner review in GitHub/);
  assert.match(text, /your review covers this head/);
  assert.match(text, /Approve in GitHub; the gate re-runs on your review\./);
  assert.doesNotMatch(text, /\/approve 11|Paste the line/);
  walk(box, (n) => assert.notEqual(n.tag, "button"));
});

test("team: a PR whose review does not cover the head, or has no ownerApproved, says so", () => {
  for (const approved of [false, undefined]) {
    const text = textOf(renderWait([waitingIssue({ pr: { ...pr(11), ownerApproved: approved } })], team));
    assert.match(text, /your review does not cover this head/);
  }
});

test("edge: a missing snapshot or repo shows the waiting box with no links, no copy line and no button", () => {
  for (const snapshot of [{ profile: "team" }, undefined]) {
    const box = renderWait([waitingIssue()], snapshot);
    assert.match(textOf(box), /Approve in GitHub/);
    assert.doesNotMatch(textOf(box), /\/approve 11|Paste the line/);
    assert.deepEqual(links(box), []);
    walk(box, (n) => assert.notEqual(n.tag, "button"));
  }
});

test("team: task cards link to the issue and the PR, and a failing check links to its url", () => {
  const run = `${BASE}actions/runs/9`;
  const li = app.renderTask(fakeDoc(), issue(7, "failing", { pr: { ...pr(12), checks: [{ name: "verify", result: "fail", url: run }, { name: "lint", result: "pass", url: `${BASE}actions/runs/8` }] } }), team);
  assert.deepEqual(links(li).map((a) => [a.textContent, a.attrs.href]), [["#7", `${BASE}issues/7`], ["PR #12", `${BASE}pull/12`], ["verify", run]]);
  for (const a of links(li)) assert.equal(a.attrs.rel, "noopener noreferrer");
});

test("team: a task without a PR links only the issue, and a task with no snapshot has no links", () => {
  assert.deepEqual(links(app.renderTask(fakeDoc(), issue(7, "ready"), team)).map((a) => a.attrs.href), [`${BASE}issues/7`]);
  const failing = issue(7, "failing", { pr: { ...pr(12), checks: [{ name: "verify", result: "fail", url: `${BASE}actions/runs/9` }] } });
  assert.deepEqual(links(app.renderTask(fakeDoc(), failing)), []);
});

test("edge: a malicious check url, another repo, http or whitespace renders as plain text, never an href", () => {
  const evil = ["javascript:alert(1)", "https://github.com/other/repo/runs/1", `http://github.com/acme/lanes/runs/1`, `${BASE}runs/1 x`, `${BASE}runs/1\n`, `https://github.com/acme/lanes-fork/runs/1`, `${BASE}../../evil/x`, `${BASE}runs/%2e%2E/x`, `${BASE}runs/./1`, `${BASE}runs/..`, `${BASE}pull/1/..\\..\\..\\other/x`, `${BASE}runs\\1`, `${BASE}runs/%5c..%5cother`, `${BASE}runs/%2F..%2fother`, "data:text/html,<script>1</script>", 5, undefined];
  for (const url of evil) {
    const li = app.renderTask(fakeDoc(), issue(7, "failing", { pr: { ...pr(12), checks: [{ name: "verify", result: "fail", url }] } }), team);
    assert.ok(!links(li).some((a) => a.textContent === "verify"), `edge: ${String(url).slice(0, 30)}`);
    assert.ok(textOf(li).includes("verify"));
  }
});

test("edge: a malicious or malformed repo makes every team link plain text", () => {
  for (const repo of ["javascript:alert(1)//x/y", "evil.com/x/../..", "a/b/c", "a b/c", "", 5, undefined, "acme/lanes\"onmouseover=\"x", "../x", "a/..", "./."]) {
    const snapshot = { profile: "team", repo };
    const box = renderWait([waitingIssue()], snapshot);
    assert.deepEqual(links(box), [], `edge: repo ${JSON.stringify(repo)}`);
    assert.ok(textOf(box).includes("Review in GitHub"));
    const li = app.renderTask(fakeDoc(), issue(7, "failing", { pr: { ...pr(12), checks: [{ name: "verify", result: "fail", url: `${BASE}runs/1` }] } }), snapshot);
    assert.deepEqual(links(li), []);
  }
});

test("edge: a non-integer issue or PR number is never put into a link", () => {
  const li = app.renderTask(fakeDoc(), issue("7/../x", "ready", { pr: { number: "9; rm", checks: [] } }), team);
  assert.deepEqual(links(li), []);
});

test("edge: a hostile title and check name in the team view stay text; links hold no markup", () => {
  const evil = `<img src=x onerror=alert(1)>`;
  const li = app.renderTask(fakeDoc(), issue(7, "failing", { title: evil, pr: { ...pr(12), checks: [{ name: evil, result: "fail", url: `${BASE}runs/1` }] } }), team);
  assert.ok(textOf(li).includes(evil));
  walk(li, (n) => assert.ok(!/^(img|script)$/.test(n.tag), n.tag));
});

test("linkBase accepts owner/name only and returns the github.com prefix", () => {
  assert.equal(app.linkBase({ repo: "acme/lanes" }), BASE);
  assert.equal(app.linkBase({ repo: "acme" }), "");
  assert.equal(app.linkBase({}), "");
  assert.equal(app.linkBase(undefined), "");
});

test("app.js sets href only through setAttribute and never assigns .href", () => {
  assert.doesNotMatch(src, /\.href\s*=|\.src\s*=|location\s*=/);
  assert.equal([...src.matchAll(/setAttribute\("href"/g)].length, 1);
});

test("criticalPath is the longest blocking chain, and ignores edges to unlisted issues", () => {
  const edges = [{ from: 1, to: 2 }, { from: 2, to: 3 }, { from: 1, to: 4 }, { from: 9, to: 3 }];
  assert.deepEqual(JSON.parse(JSON.stringify(app.criticalPath([1, 2, 3, 4], edges))), [1, 2, 3]);
});

test("edge: criticalPath survives a cycle, an empty graph and a single node", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(app.criticalPath([], []))), []);
  assert.deepEqual(JSON.parse(JSON.stringify(app.criticalPath([1], []))), [1]);
  const p = app.criticalPath([1, 2], [{ from: 1, to: 2 }, { from: 2, to: 1 }]);
  assert.ok(p.length >= 1 && p.length <= 2);
});

test("renderGraph draws a node per issue, an edge per link, and marks the critical path", () => {
  const svg = app.renderGraph(fakeDoc(), [issue(1, "ready"), issue(2, "blocked"), issue(3, "blocked")], [{ from: 1, to: 2 }, { from: 2, to: 3 }]);
  assert.equal(svg.tag, "svg");
  let nodes = 0, edges = 0, crit = 0;
  walk(svg, (n) => {
    if (/\bnode\b/.test(n.className)) nodes++;
    if (/\bedge\b/.test(n.className)) edges++;
    if (/\bcritical\b/.test(n.className)) crit++;
  });
  assert.equal(nodes, 3);
  assert.equal(edges, 2);
  assert.ok(crit >= 3);
});

test("edge: renderGraph with no issues still returns an svg", () => {
  assert.equal(app.renderGraph(fakeDoc(), [], []).tag, "svg");
});

test("renderGraph draws each overlap as a dashed undirected line with no arrowhead, beside the solid arrows", () => {
  const svg = app.renderGraph(fakeDoc(), [issue(1, "ready"), issue(2, "ready"), issue(3, "blocked")], [{ from: 1, to: 3 }], [{ a: 1, b: 2 }]);
  let overlaps = 0, edges = 0, arrows = 0;
  walk(svg, (n) => {
    if (/\boverlap\b/.test(n.className)) overlaps++;
    if (/\bedge\b/.test(n.className)) edges++;
    if (/\barrow\b/.test(n.className)) arrows++;
  });
  assert.equal(overlaps, 1);
  assert.equal(edges, 1);
  assert.equal(arrows, 1);
  assert.match(readFileSync("dashboard/style.css", "utf8"), /\.overlap[^}]*stroke-dasharray/);
});

test("edge: an overlap naming an unlisted issue or itself is not drawn", () => {
  const svg = app.renderGraph(fakeDoc(), [issue(1, "ready")], [], [{ a: 1, b: 9 }, { a: 1, b: 1 }]);
  let overlaps = 0;
  walk(svg, (n) => { if (/\boverlap\b/.test(n.className)) overlaps++; });
  assert.equal(overlaps, 0);
});

test("graphNote is one line when there are no blockers and no overlaps, and empty otherwise", () => {
  assert.match(app.graphNote([], []), /no blockers or overlaps/i);
  assert.match(app.graphNote(undefined, undefined), /no blockers or overlaps/i);
  assert.equal(app.graphNote([{ from: 1, to: 2 }], []), "");
  assert.equal(app.graphNote([], [{ a: 1, b: 2 }]), "");
});

const NOW = Date.parse("2026-09-29T12:00:00Z");
const ago = (ms) => new Date(NOW - ms).toISOString();

test("ageText says just now, minutes, and over an hour", () => {
  assert.equal(app.ageText(ago(20000), NOW), "updated just now");
  assert.equal(app.ageText(ago(3 * 60000), NOW), "updated 3 min ago");
  assert.equal(app.ageText(ago(59 * 60000), NOW), "updated 59 min ago");
  assert.equal(app.ageText(ago(61 * 60000), NOW), "updated over an hour ago");
});

test("edge: ageText for an unreadable time is empty, and a future time reads as just now", () => {
  assert.equal(app.ageText("nope", NOW), "");
  assert.equal(app.ageText(ago(-5 * 60000), NOW), "updated just now");
});

test("waitingNote warns that entries may already be approved only past 5 minutes", () => {
  assert.equal(app.waitingNote(ago(5 * 60000), NOW), "");
  assert.match(app.waitingNote(ago(6 * 60000), NOW), /may already be approved/);
  assert.equal(app.waitingNote("nope", NOW), "");
});

test("renderAge fills the heading age, the waiting age and the note from generatedAt without a fetch", () => {
  const els = {};
  const d = { getElementById: (id) => (els[id] ??= { textContent: "", hidden: false }) };
  app.renderAge(d, ago(7 * 60000), NOW);
  assert.equal(els.age.textContent, "updated 7 min ago");
  assert.equal(els["waiting-age"].textContent, "updated 7 min ago");
  assert.match(els["waiting-note"].textContent, /may already be approved/);
  assert.equal(els["waiting-note"].hidden, false);
  assert.equal(els.stale.hidden, true);
  app.renderAge(d, ago(30 * 60000), NOW);
  assert.equal(els.stale.hidden, false);
  app.renderAge(d, ago(60000), NOW);
  assert.equal(els["waiting-note"].hidden, true);
});

test("layout: the task row keeps the tag apart from the number and title, and lets a long title wrap", () => {
  const css = readFileSync("dashboard/style.css", "utf8");
  assert.match(css, /\.task\s*\{[^}]*display:\s*flex/);
  assert.match(css, /\.task\s*\{[^}]*gap:\s*8px/);
  assert.match(css, /\.task \.title\s*\{[^}]*min-width:\s*0/);
  assert.match(css, /\.task \.title\s*\{[^}]*overflow-wrap:\s*anywhere/);
  assert.match(css, /\.task \.chip\s*\{[^}]*flex:\s*none/);
});

test("index.html has the age, waiting note and graph note elements", () => {
  const html = readFileSync("dashboard/index.html", "utf8");
  for (const id of ["age", "waiting-age", "waiting-note", "graph-note"]) assert.match(html, new RegExp(`id="${id}"`), id);
});

test("formatGenerated shows the timestamp, and flags an unreadable one", () => {
  assert.ok(app.formatGenerated("2026-09-28T12:00:00Z").includes("2026-09-28"));
  assert.match(app.formatGenerated("nope"), /unknown/i);
});

test("index.html loads app.js and style.css only, with a viewport meta and no external resource", () => {
  const html = readFileSync("dashboard/index.html", "utf8");
  assert.match(html, /name="viewport"/);
  assert.match(html, /src="app\.js"/);
  assert.match(html, /href="style\.css"/);
  assert.doesNotMatch(html, /(src|href)="https?:/);
});

test("style.css has design tokens, dark mode, transitions, a phone breakpoint and a colour per stage", () => {
  const css = readFileSync("dashboard/style.css", "utf8");
  assert.match(css, /:root\s*\{[^}]*--bg:/);
  assert.match(css, /prefers-color-scheme:\s*dark/);
  assert.match(css, /transition:/);
  assert.match(css, /@media \(max-width:\s*\d+px\)/);
  for (const s of app.STAGES) assert.ok(css.includes(`--stage-${s.replace(/ /g, "-")}:`), s);
});

test("lanes.config.json marks dashboard/ as ui and sensitive", () => {
  const cfg = JSON.parse(readFileSync("lanes.config.json", "utf8"));
  for (const k of ["ui", "sensitive"]) assert.ok(cfg.paths[k].some((p) => new RegExp(p).test("dashboard/app.js")), k);
});

// --- metrics panel (#298) ---
const stat = (median, count = 3) => ({ count, median });
const block = () => ({
  rework: { prs: 10, prsWithGateFailure: 2, gateFailuresByStage: [], pushesAfterOpen: stat(1) },
  scopeDrift: { prs: 10, prsWithDrift: 3, driftRate: 0.3, filesOutsideScope: stat(2) },
  ownerTime: { prsWaited: 4, waitHours: stat(5.5, 4), interventions: stat(1) },
  concurrency: { maxOpenPrs: 3, medianOpenPrs: 2 },
  friction: { prsWithRerun: 1, ciReruns: 2, stuckQueueMinutes: stat(7) },
  delivery: { mergedPrs: 10, perDay: 1, leadTimeHoursMedian: 12.5, medianLinesChanged: 80, bounceRate: 0.1, failureRate: 0, revertRate: 0 },
  review: { runs: 5, runsWithoutMetrics: 0, realFindings: 2, minorFindings: 1, tiers: [{ tier: "full", runs: 3, realFindings: 2, noRealFindingShare: 0.33 }, { tier: "quick", runs: 2, realFindings: 0, noRealFindingShare: 1 }] },
});
const report = (extra = {}) => ({ schemaVersion: 1, generatedAt: "2026-09-28T12:00:00Z", public: true, window: { days: 30, from: "2026-08-29T00:00:00Z", to: "2026-09-28T00:00:00Z" }, ...block(), ...extra });
const panelBox = () => {
  const d = fakeDoc();
  return { d, box: d.createElement("div") };
};

test("metrics: renderMetrics shows the medians, tiers and the caveat, and returns true", () => {
  const { d, box } = panelBox();
  assert.equal(app.renderMetrics(d, box, report()), true);
  const t = textOf(box);
  assert.match(t, /medians and counts, not causes/);
  assert.match(t, /12\.5/);
  assert.match(t, /5\.5/);
  assert.match(t, /30%/);
  assert.match(t, /full/);
  assert.match(t, /quick/);
  assert.match(t, /lead time/i);
  assert.match(t, /rework/i);
  assert.match(t, /scope drift/i);
  assert.match(t, /owner wait/i);
  assert.match(t, /friction/i);
});

test("metrics: no before/after table without split, one with it", () => {
  const a = panelBox();
  app.renderMetrics(a.d, a.box, report());
  assert.doesNotMatch(textOf(a.box), /before/i);
  const after = block();
  after.delivery.leadTimeHoursMedian = 6;
  const b = panelBox();
  app.renderMetrics(b.d, b.box, report({ split: [{ date: "2026-09-15", before: block(), after }] }));
  const t = textOf(b.box);
  assert.match(t, /2026-09-15/);
  assert.match(t, /before/i);
  assert.match(t, /after/i);
  assert.match(t, /6\b/);
});

test("edge: null medians and rates show a dash, never NaN or null", () => {
  const r = report();
  r.delivery.leadTimeHoursMedian = null;
  r.scopeDrift.driftRate = null;
  r.ownerTime.waitHours = stat(null, 0);
  const { d, box } = panelBox();
  assert.equal(app.renderMetrics(d, box, r), true);
  assert.doesNotMatch(textOf(box), /NaN|null|undefined/);
});

test("edge: markup in a tier name is text, never an element", () => {
  const r = report();
  r.review.tiers = [{ tier: "<img src=x onerror=alert(1)>", runs: 1, realFindings: 0, noRealFindingShare: 1 }];
  const { d, box } = panelBox();
  assert.equal(app.renderMetrics(d, box, r), true);
  assert.ok(textOf(box).includes("<img src=x onerror=alert(1)>"));
  walk(box, (n) => assert.notEqual(n.tag, "img"));
});

test("edge: validMetrics accepts a report and rejects junk, missing blocks and wrong types", () => {
  assert.equal(app.validMetrics(report()), true);
  for (const bad of [null, undefined, 5, "x", [], {}, { ...report(), schemaVersion: 2 }, { ...report(), review: null }, { ...report(), split: "no" }, { ...report(), split: [{ date: "d" }] }, { ...report(), public: undefined }, { ...report(), public: "true" }, { ...report(), split: [{ before: block(), after: block() }] }]) {
    assert.equal(app.validMetrics(bad), false, JSON.stringify(bad));
  }
  const r = report();
  delete r.rework;
  assert.equal(app.validMetrics(r), false);
});

test("edge: renderMetrics on an invalid report renders nothing and returns false", () => {
  const { d, box } = panelBox();
  assert.equal(app.renderMetrics(d, box, { schemaVersion: 1 }), false);
  assert.equal(box.children.length, 0);
});

test("metrics: a missing file, a bad body and a JSON error hide the panel; a good one shows it", async () => {
  const mk = (res) => {
    const section = { hidden: false };
    const box = fakeDoc().createElement("div");
    const d = fakeDoc();
    d.getElementById = (id) => (id === "metrics" ? section : box);
    return { d, section, box, res };
  };
  const run = async (m) => {
    await app.loadMetrics(m.d, async () => m.res);
  };
  const missing = mk({ ok: false, status: 404, json: async () => ({}) });
  await run(missing);
  assert.equal(missing.section.hidden, true);
  const bad = mk({ ok: true, json: async () => ({ nope: 1 }) });
  await run(bad);
  assert.equal(bad.section.hidden, true);
  const thrown = mk({ ok: true, json: async () => { throw new SyntaxError("bad json"); } });
  await run(thrown);
  assert.equal(thrown.section.hidden, true);
  const good = mk({ ok: true, json: async () => report() });
  await run(good);
  assert.equal(good.section.hidden, false);
  assert.ok(good.box.children.length > 0);
});

test("edge: a non-ok response hides the panel even when its body is a valid report", async () => {
  const section = { hidden: false };
  const d = fakeDoc();
  const box = d.createElement("div");
  d.getElementById = (id) => (id === "metrics" ? section : box);
  await app.loadMetrics(d, async () => ({ ok: false, status: 500, json: async () => report() }));
  assert.equal(section.hidden, true);
  assert.equal(box.children.length, 0);
});

test("metrics: app.js fetches lane-metrics.json, and index.html has the hidden panel", () => {
  assert.match(src, /["']lane-metrics\.json["']/);
  const html = readFileSync("dashboard/index.html", "utf8");
  assert.match(html, /id="metrics"[^>]*hidden/);
});

test("metrics: style.css styles the panel with tokens only", () => {
  const css = readFileSync("dashboard/style.css", "utf8");
  const at = css.indexOf("/* metrics panel */");
  assert.ok(at > 0);
  assert.match(css.slice(at), /\.metrics/);
  assert.doesNotMatch(css.slice(at), /#[0-9a-fA-F]{3,6}\b/);
});

test("boundary: age words flip exactly at 1 and 60 minutes; the waiting note and stale note at 5 and 20", () => {
  assert.equal(app.ageText(ago(59999), NOW), "updated just now");
  assert.equal(app.ageText(ago(60000), NOW), "updated 1 min ago");
  assert.equal(app.ageText(ago(60 * 60000 - 1), NOW), "updated 59 min ago");
  assert.equal(app.ageText(ago(60 * 60000), NOW), "updated over an hour ago");
  assert.notEqual(app.waitingNote(ago(5 * 60000 + 1), NOW), "");
  assert.equal(app.staleNote(ago(20 * 60000), NOW), "");
  assert.notEqual(app.staleNote(ago(20 * 60000 + 1), NOW), "");
});

test("edge: only a boolean true counts as the owner's review covering the head", () => {
  for (const v of ["yes", 1, "true", {}]) {
    const box = renderWait([waitingIssue({ pr: { ...pr(12), ownerApproved: v } })], team);
    assert.ok(textOf(box).includes("does not cover this head"), "edge: " + JSON.stringify(v));
  }
});

test("edge: a check url is linked at exactly 500 characters and plain text at 501", () => {
  const base = BASE + "runs/";
  for (const [len, linked] of [[500, true], [501, false]]) {
    const url = base + "x".repeat(len - base.length);
    const li = app.renderTask(fakeDoc(), issue(7, "failing", { pr: { ...pr(12), checks: [{ name: "verify", result: "fail", url }] } }), team);
    assert.equal(links(li).some((a) => a.textContent === "verify"), linked, "edge: length " + len);
  }
});
