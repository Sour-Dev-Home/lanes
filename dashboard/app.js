// The lanes dashboard: fetches snapshot.json and renders it. No build step, no dependency.
// Every GitHub-sourced string (titles, refs, reasons) goes in through textContent or createElement, never as markup.
// The page only reads: nothing here can post an approval.
"use strict";

var POLL_MS = 60000;
var STALE_MS = 20 * 60000;
var SVG_NS = "http://www.w3.org/2000/svg";
var WAITING_NOTE_MS = 5 * 60000;
var STAGES = ["ready", "not ready", "already met", "running", "writing", "test review", "security review", "architecture review", "waiting on owner", "queued", "merge queue", "merged", "blocked"];

var slug = function (stage) {
  return stage.replace(/ /g, "-");
};

// Builds an element; `text` goes in as textContent, `cls` as the class attribute.
function el(doc, tag, cls, text, ns) {
  var node = ns ? doc.createElementNS(ns, tag) : doc.createElement(tag);
  if (cls) node.setAttribute("class", cls);
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function formatGenerated(generatedAt) {
  return Number.isNaN(Date.parse(generatedAt)) ? "Snapshot time unknown" : "Snapshot generated " + generatedAt;
}

function staleNote(generatedAt, now) {
  var age = now - Date.parse(generatedAt);
  if (Number.isNaN(age)) return "Stale: the snapshot time cannot be read.";
  if (age <= STALE_MS) return "";
  return "Stale: this snapshot is " + Math.round(age / 60000) + " min old, so the page may be behind GitHub.";
}

// The snapshot's age in plain words; empty when the time cannot be read.
function ageText(generatedAt, now) {
  var age = now - Date.parse(generatedAt);
  if (Number.isNaN(age)) return "";
  var minutes = Math.floor(age / 60000);
  if (minutes < 1) return "updated just now";
  if (minutes < 60) return "updated " + minutes + " min ago";
  return "updated over an hour ago";
}

function waitingNote(generatedAt, now) {
  var age = now - Date.parse(generatedAt);
  if (Number.isNaN(age) || age <= WAITING_NOTE_MS) return "";
  return "This snapshot is more than 5 minutes old, so these entries may already be approved.";
}

// Refreshes everything that depends on the clock; runs every minute without refetching.
function renderAge(doc, generatedAt, now) {
  var text = ageText(generatedAt, now);
  doc.getElementById("age").textContent = text;
  doc.getElementById("waiting-age").textContent = text;
  var note = waitingNote(generatedAt, now);
  var waiting = doc.getElementById("waiting-note");
  waiting.textContent = note;
  waiting.hidden = !note;
  var stale = doc.getElementById("stale");
  var staleText = staleNote(generatedAt, now);
  stale.textContent = staleText;
  stale.hidden = !staleText;
}

// The snapshot's stage vocabulary onto the display stages.
function stageOf(issue) {
  switch (issue.stage) {
    case "ready":
      return "ready";
    case "not-ready":
      return "not ready";
    case "already met":
      return "already met";
    case "running":
      return "running";
    case "starting":
    case "failing":
      return "writing";
    case "gate": {
      var ref = String(((issue.blockedBy || [])[0] || {}).ref || "");
      if (ref.indexOf("security") === 0) return "security review";
      if (ref.indexOf("architecture") === 0) return "architecture review";
      return "test review";
    }
    case "review":
      return "test review";
    case "owner":
    case "contract":
      return "waiting on owner";
    case "queued":
      return "merge queue";
    case "blocked":
      return "blocked";
    default:
      return "queued";
  }
}

function renderLegend(doc, ul) {
  STAGES.forEach(function (stage) {
    var li = el(doc, "li");
    li.appendChild(el(doc, "span", "chip stage-" + slug(stage), stage));
    ul.appendChild(li);
  });
}

// ADR 0024. The page links only under the team profile, and only into the snapshot's own repository. The repo is
// re-validated here, since a snapshot file can be edited or stale.
var REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
// A "." or ".." part or path segment (also as %2e) would pass a prefix check yet resolve to another path.
var DOT_SEGMENT = /(^|\/)(\.|%2e){1,2}(\/|\?|#|$)/i;

function isTeam(snapshot) {
  return !!snapshot && snapshot.profile === "team";
}

// "https://github.com/<repo>/" for a valid repo, "" otherwise.
function linkBase(snapshot) {
  var repo = snapshot ? snapshot.repo : undefined;
  return typeof repo === "string" && REPO_PATTERN.test(repo) && !DOT_SEGMENT.test(repo) ? "https://github.com/" + repo + "/" : "";
}

// An <a> when `url` starts with `base` and holds no whitespace or control character; otherwise a <span> with the same
// text, so a bad value shows but never links. The text goes in through textContent, the URL through setAttribute only.
function linkOrText(doc, base, url, text, cls) {
  var ok = base !== "" && typeof url === "string" && url.indexOf(base) === 0 && url.length <= 500 && !/[\s\u0000-\u001f\u007f-\u009f]/.test(url) && !DOT_SEGMENT.test(url.slice(8));
  if (!ok) return el(doc, "span", cls, text);
  var a = el(doc, "a", cls, text);
  a.setAttribute("href", url);
  a.setAttribute("rel", "noopener noreferrer");
  return a;
}

function wholeNumber(n) {
  return typeof n === "number" && isFinite(n) && Math.floor(n) === n && n >= 1;
}

function renderTask(doc, issue, snapshot) {
  var stage = stageOf(issue);
  var li = el(doc, "li", "task stage-" + slug(stage));
  var team = isTeam(snapshot);
  var base = team ? linkBase(snapshot) : "";
  if (team) {
    li.appendChild(linkOrText(doc, base, wholeNumber(issue.number) ? base + "issues/" + issue.number : "", "#" + issue.number, "num"));
  } else {
    li.appendChild(el(doc, "span", "num", "#" + issue.number));
  }
  li.appendChild(el(doc, "span", "title", issue.title));
  li.appendChild(el(doc, "span", "chip stage-" + slug(stage), stage));
  if (team && issue.pr && wholeNumber(issue.pr.number)) {
    li.appendChild(linkOrText(doc, base, base + "pull/" + issue.pr.number, "PR #" + issue.pr.number, "pr-link"));
  }
  if (team && issue.pr) {
    (issue.pr.checks || []).forEach(function (c) {
      if (!c || c.result !== "fail") return;
      var p = el(doc, "p", "why", "Failing check: ");
      p.appendChild(linkOrText(doc, base, c.url, String(c.name), "check-link"));
      li.appendChild(p);
    });
  }
  var blockers = issue.blockedBy || [];
  if (blockers.length) {
    blockers.forEach(function (b) {
      li.appendChild(el(doc, "p", "why", b.ref + (b.reason ? ": " + b.reason : "")));
    });
  } else if (stage === "blocked") {
    li.appendChild(el(doc, "p", "why", "Blocked, no reason recorded in the snapshot."));
  }
  return li;
}

function waitingOnOwner(issues) {
  return issues.filter(function (i) {
    return stageOf(i) === "waiting on owner" && i.pr && Number.isInteger(i.pr.number);
  });
}

function approveLine(issues) {
  var numbers = waitingOnOwner(issues)
    .map(function (i) {
      return i.pr.number;
    })
    .sort(function (a, b) {
      return a - b;
    });
  return numbers.length ? "/approve " + numbers.join(" ") : "";
}

function copyText(text) {
  if (typeof navigator !== "undefined" && navigator.clipboard) return navigator.clipboard.writeText(text);
  return Promise.reject(new Error("clipboard unavailable"));
}

function renderWaiting(doc, box, issues, snapshot) {
  var waiting = waitingOnOwner(issues);
  if (!waiting.length) {
    box.appendChild(el(doc, "p", "muted", "Nothing is waiting on you."));
    return;
  }
  var team = isTeam(snapshot);
  var base = team ? linkBase(snapshot) : "";
  waiting.forEach(function (i) {
    var card = el(doc, "div", "card");
    card.appendChild(el(doc, "span", "num", "PR #" + i.pr.number));
    card.appendChild(el(doc, "span", "title", i.title));
    (i.blockedBy || []).forEach(function (b) {
      card.appendChild(el(doc, "p", "why", b.reason));
    });
    if (team) {
      var p = el(doc, "p", "review");
      p.appendChild(linkOrText(doc, base, base + "pull/" + i.pr.number + "/files", "Review in GitHub", "review-link"));
      card.appendChild(p);
      card.appendChild(el(doc, "p", "why", i.pr.ownerApproved === true ? "your review covers this head" : "your review does not cover this head"));
    }
    box.appendChild(card);
  });
  if (team) {
    box.appendChild(el(doc, "p", "muted", "Approve in GitHub; the gate re-runs on your review."));
    return;
  }
  var line = approveLine(issues);
  var row = el(doc, "div", "approve");
  row.appendChild(el(doc, "code", "", line));
  var button = el(doc, "button", "", "Copy");
  button.setAttribute("type", "button");
  button.addEventListener("click", function () {
    copyText(line).then(
      function () {
        button.textContent = "Copied";
      },
      function () {
        button.textContent = "Copy failed";
      }
    ).then(function () {
      setTimeout(function () {
        button.textContent = "Copy";
      }, 2000);
    });
  });
  row.appendChild(button);
  box.appendChild(row);
  box.appendChild(el(doc, "p", "muted", "Paste the line into the owner session. This page cannot approve anything."));
}

// The longest chain of "blocks" links among the listed issues (by issue count); ties go to the lowest numbers.
function criticalPath(numbers, edges) {
  var listed = {};
  numbers.forEach(function (n) {
    listed[n] = true;
  });
  var next = {};
  edges.forEach(function (e) {
    if (!listed[e.from] || !listed[e.to] || e.from === e.to) return;
    (next[e.from] = next[e.from] || []).push(e.to);
  });
  var memo = {};
  var onStack = {};
  function longest(n) {
    if (memo[n]) return memo[n];
    onStack[n] = true;
    var best = [];
    (next[n] || [])
      .slice()
      .sort(function (a, b) {
        return a - b;
      })
      .forEach(function (m) {
        if (onStack[m]) return;
        var p = longest(m);
        if (p.length > best.length) best = p;
      });
    onStack[n] = false;
    memo[n] = [n].concat(best);
    return memo[n];
  }
  var result = [];
  numbers
    .slice()
    .sort(function (a, b) {
      return a - b;
    })
    .forEach(function (n) {
      var p = longest(n);
      if (p.length > result.length) result = p;
    });
  return result;
}

var NODE_W = 170;
var NODE_H = 46;
var GAP_X = 60;
var GAP_Y = 16;

function graphNote(edges, overlaps) {
  return (edges || []).length || (overlaps || []).length ? "" : "No blockers or overlaps between open tasks.";
}

function renderGraph(doc, issues, edges, overlaps) {
  var numbers = issues.map(function (i) {
    return i.number;
  });
  var byNumber = {};
  issues.forEach(function (i) {
    byNumber[i.number] = i;
  });
  var links = edges.filter(function (e) {
    return byNumber[e.from] && byNumber[e.to] && e.from !== e.to;
  });
  var path = criticalPath(numbers, links);
  var onPath = {};
  var edgeOnPath = {};
  if (path.length > 1) {
    path.forEach(function (n, k) {
      onPath[n] = true;
      if (k) edgeOnPath[path[k - 1] + ">" + n] = true;
    });
  }
  // Column = length of the longest chain leading in; capped passes keep a cycle from looping.
  var col = {};
  numbers.forEach(function (n) {
    col[n] = 0;
  });
  for (var pass = 0; pass < numbers.length; pass++) {
    links.forEach(function (e) {
      if (col[e.to] < col[e.from] + 1 && col[e.from] + 1 < numbers.length) col[e.to] = col[e.from] + 1;
    });
  }
  var rows = {};
  var pos = {};
  var maxCol = 0;
  var maxRow = 0;
  numbers
    .slice()
    .sort(function (a, b) {
      return a - b;
    })
    .forEach(function (n) {
      var r = rows[col[n]] || 0;
      rows[col[n]] = r + 1;
      pos[n] = { x: col[n] * (NODE_W + GAP_X) + 8, y: r * (NODE_H + GAP_Y) + 8 };
      maxCol = Math.max(maxCol, col[n]);
      maxRow = Math.max(maxRow, r);
    });
  var width = (maxCol + 1) * (NODE_W + GAP_X) + 8;
  var height = (maxRow + 1) * (NODE_H + GAP_Y) + 8;
  var svg = el(doc, "svg", "", null, SVG_NS);
  svg.setAttribute("viewBox", "0 0 " + width + " " + height);
  svg.setAttribute("width", width);
  svg.setAttribute("height", height);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Dependency graph of open tasks");
  links.forEach(function (e) {
    var a = pos[e.from];
    var b = pos[e.to];
    var crit = edgeOnPath[e.from + ">" + e.to];
    var x1 = a.x + NODE_W;
    var y1 = a.y + NODE_H / 2;
    var x2 = b.x;
    var y2 = b.y + NODE_H / 2;
    var line = el(doc, "path", "edge" + (crit ? " critical" : ""), null, SVG_NS);
    var mid = (x1 + x2) / 2;
    line.setAttribute("d", "M" + x1 + " " + y1 + " C" + mid + " " + y1 + " " + mid + " " + y2 + " " + x2 + " " + y2);
    svg.appendChild(line);
    var head = el(doc, "polygon", "arrow" + (crit ? " critical" : ""), null, SVG_NS);
    head.setAttribute("points", x2 + "," + y2 + " " + (x2 - 10) + "," + (y2 - 5) + " " + (x2 - 10) + "," + (y2 + 5));
    svg.appendChild(head);
  });
  (overlaps || []).forEach(function (o) {
    if (!Object.prototype.hasOwnProperty.call(pos, o.a) || !Object.prototype.hasOwnProperty.call(pos, o.b) || o.a === o.b) return;
    var a = pos[o.a];
    var b = pos[o.b];
    var line = el(doc, "line", "overlap", null, SVG_NS);
    line.setAttribute("x1", a.x + NODE_W / 2);
    line.setAttribute("y1", a.y + NODE_H / 2);
    line.setAttribute("x2", b.x + NODE_W / 2);
    line.setAttribute("y2", b.y + NODE_H / 2);
    svg.appendChild(line);
  });
  issues.forEach(function (i) {
    var p = pos[i.number];
    var g = el(doc, "g", "node stage-" + slug(stageOf(i)) + (onPath[i.number] ? " critical" : ""), null, SVG_NS);
    var rect = el(doc, "rect", "", null, SVG_NS);
    rect.setAttribute("x", p.x);
    rect.setAttribute("y", p.y);
    rect.setAttribute("width", NODE_W);
    rect.setAttribute("height", NODE_H);
    rect.setAttribute("rx", 6);
    g.appendChild(rect);
    var label = el(doc, "text", "", "#" + i.number + " " + String(i.title).slice(0, 20), SVG_NS);
    label.setAttribute("x", p.x + 8);
    label.setAttribute("y", p.y + 19);
    g.appendChild(label);
    var stage = el(doc, "text", "", stageOf(i), SVG_NS);
    stage.setAttribute("x", p.x + 8);
    stage.setAttribute("y", p.y + 36);
    g.appendChild(stage);
    var tip = el(doc, "title", "", "#" + i.number + " " + i.title, SVG_NS);
    g.appendChild(tip);
    svg.appendChild(g);
  });
  return svg;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

// The metrics panel (lane-metrics.json, contracts/lane-metrics.schema.json). Medians, counts and rates only.
var METRIC_BLOCKS = ["rework", "scopeDrift", "ownerTime", "concurrency", "friction", "delivery", "review"];

function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function validAggregate(a) {
  return isObject(a) && METRIC_BLOCKS.every(function (k) {
    return isObject(a[k]);
  });
}

// A shape check only: enough that rendering cannot throw. Anything else hides the panel.
function validMetrics(report) {
  if (!validAggregate(report) || report.schemaVersion !== 1 || typeof report.public !== "boolean") return false;
  if (!Array.isArray(report.review.tiers)) return false;
  if (report.split === undefined) return true;
  return Array.isArray(report.split) && report.split.every(function (s) {
    return isObject(s) && typeof s.date === "string" && validAggregate(s.before) && validAggregate(s.after) && Array.isArray(s.before.review.tiers) && Array.isArray(s.after.review.tiers);
  });
}

function num(v, digits) {
  return typeof v === "number" && Number.isFinite(v) ? String(Math.round(v * Math.pow(10, digits)) / Math.pow(10, digits)) : "–";
}

function pct(v) {
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v * 100) + "%" : "–";
}

function med(stat, unit) {
  var s = isObject(stat) ? stat : {};
  var m = num(s.median, 1);
  return (m === "–" ? m : m + unit) + " (n=" + num(s.count, 0) + ")";
}

// [label, value] rows for one aggregate block.
function metricRows(a) {
  return [
    ["Lead time (median)", num(a.delivery.leadTimeHoursMedian, 1) === "–" ? "–" : num(a.delivery.leadTimeHoursMedian, 1) + " h"],
    ["Rework: PRs with a gate failure", num(a.rework.prsWithGateFailure, 0) + " of " + num(a.rework.prs, 0)],
    ["Rework: pushes after open", med(a.rework.pushesAfterOpen, "")],
    ["Scope drift: PRs outside scope", pct(a.scopeDrift.driftRate) + " (" + num(a.scopeDrift.prsWithDrift, 0) + " of " + num(a.scopeDrift.prs, 0) + ")"],
    ["Scope drift: files outside scope", med(a.scopeDrift.filesOutsideScope, "")],
    ["Owner wait", med(a.ownerTime.waitHours, " h")],
    ["Friction: PRs with a CI rerun", num(a.friction.prsWithRerun, 0) + " (" + num(a.friction.ciReruns, 0) + " reruns)"],
    ["Friction: stuck queue", med(a.friction.stuckQueueMinutes, " min")]
  ];
}

function table(doc, label, headers, rows) {
  var t = el(doc, "table", "metrics-table");
  t.setAttribute("aria-label", label);
  var thead = el(doc, "thead");
  var head = el(doc, "tr");
  headers.forEach(function (h) {
    var th = el(doc, "th", "", h);
    th.setAttribute("scope", "col");
    head.appendChild(th);
  });
  thead.appendChild(head);
  t.appendChild(thead);
  rows.forEach(function (r) {
    var tr = el(doc, "tr");
    r.forEach(function (cell, i) {
      var c = el(doc, i ? "td" : "th", "", cell);
      if (!i) c.setAttribute("scope", "row");
      tr.appendChild(c);
    });
    t.appendChild(tr);
  });
  return t;
}

// Returns true when it rendered, false (and renders nothing) for a report that is not the contract's shape.
function renderMetrics(doc, box, report) {
  if (!validMetrics(report)) return false;
  box.appendChild(el(doc, "p", "muted", "Last " + num((report.window || {}).days, 0) + " days: medians and counts, not causes."));
  box.appendChild(table(doc, "Lane metrics", ["Metric", "Value"], metricRows(report)));
  var tiers = report.review.tiers.filter(isObject);
  if (tiers.length) {
    box.appendChild(el(doc, "h3", "", "Per tier"));
    box.appendChild(
      table(
        doc,
        "Metrics per tier",
        ["Tier", "Review runs", "Real findings", "Runs with none"],
        tiers.map(function (t) {
          return [t.tier, num(t.runs, 0), num(t.realFindings, 0), pct(t.noRealFindingShare)];
        })
      )
    );
  }
  (report.split || []).forEach(function (s) {
    box.appendChild(el(doc, "h3", "", "Before and after " + s.date));
    var after = metricRows(s.after);
    box.appendChild(
      table(
        doc,
        "Before and after " + s.date,
        ["Metric", "Before", "After"],
        metricRows(s.before).map(function (r, i) {
          return [r[0], r[1], after[i][1]];
        })
      )
    );
  });
  return true;
}

// Fetches lane-metrics.json beside snapshot.json. Any failure hides the panel and touches nothing else.
function loadMetrics(doc, fetcher) {
  var section = doc.getElementById("metrics");
  var box = doc.getElementById("metrics-body");
  if (!section || !box) return Promise.resolve();
  var hide = function () {
    section.hidden = true;
  };
  return (fetcher || fetch)("lane-metrics.json", { cache: "no-store" })
    .then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    })
    .then(function (report) {
      clear(box);
      if (renderMetrics(doc, box, report)) section.hidden = false;
      else hide();
    })
    .catch(function () {
      clear(box);
      hide();
    });
}

function render(doc, snapshot, now) {
  var issues = snapshot.issues || [];
  doc.getElementById("generated").textContent = formatGenerated(snapshot.generatedAt);
  lastGenerated = snapshot.generatedAt;
  renderAge(doc, snapshot.generatedAt, now);
  var waiting = doc.getElementById("waiting");
  clear(waiting);
  renderWaiting(doc, waiting, issues, snapshot);
  var tasks = doc.getElementById("tasks");
  clear(tasks);
  issues.forEach(function (i) {
    tasks.appendChild(renderTask(doc, i, snapshot));
  });
  var graph = doc.getElementById("graph");
  clear(graph);
  graph.appendChild(renderGraph(doc, issues, snapshot.edges || [], snapshot.overlaps || []));
  var note = doc.getElementById("graph-note");
  var noteText = graphNote(snapshot.edges, snapshot.overlaps);
  note.textContent = noteText;
  note.hidden = !noteText;
}

var lastGenerated = null;

function load(doc) {
  fetch("snapshot.json", { cache: "no-store" })
    .then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    })
    .then(function (snapshot) {
      render(doc, snapshot, Date.now());
    })
    .catch(function (err) {
      doc.getElementById("generated").textContent = "Could not load snapshot.json: " + err.message;
    });
  loadMetrics(doc);
}

if (typeof document !== "undefined") {
  renderLegend(document, document.getElementById("legend"));
  load(document);
  setInterval(function () {
    load(document);
  }, POLL_MS);
  // The age words move on every minute from the last generatedAt, with no refetch.
  setInterval(function () {
    if (lastGenerated !== null) renderAge(document, lastGenerated, Date.now());
  }, 60000);
}

if (typeof module !== "undefined") {
  module.exports = { POLL_MS: POLL_MS, STALE_MS: STALE_MS, STAGES: STAGES, formatGenerated: formatGenerated, staleNote: staleNote, ageText: ageText, waitingNote: waitingNote, renderAge: renderAge, graphNote: graphNote, stageOf: stageOf, renderLegend: renderLegend, renderTask: renderTask, linkBase: linkBase, linkOrText: linkOrText, approveLine: approveLine, renderWaiting: renderWaiting, criticalPath: criticalPath, renderGraph: renderGraph, validMetrics: validMetrics, renderMetrics: renderMetrics, loadMetrics: loadMetrics };
}
