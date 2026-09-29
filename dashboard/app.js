// The lanes dashboard: fetches snapshot.json and renders it. No build step, no dependency.
// Every GitHub-sourced string (titles, refs, reasons) goes in through textContent or createElement, never as markup.
// The page only reads: nothing here can post an approval.
"use strict";

var POLL_MS = 60000;
var STALE_MS = 20 * 60000;
var SVG_NS = "http://www.w3.org/2000/svg";
var STAGES = ["writing", "test review", "security review", "architecture review", "waiting on owner", "queued", "merge queue", "merged", "blocked"];

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

// The snapshot's stage vocabulary onto the nine display stages.
function stageOf(issue) {
  switch (issue.stage) {
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

function renderTask(doc, issue) {
  var stage = stageOf(issue);
  var li = el(doc, "li", "task stage-" + slug(stage));
  li.appendChild(el(doc, "span", "num", "#" + issue.number));
  li.appendChild(el(doc, "span", "title", issue.title));
  li.appendChild(el(doc, "span", "chip stage-" + slug(stage), stage));
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

function renderWaiting(doc, box, issues) {
  var waiting = waitingOnOwner(issues);
  if (!waiting.length) {
    box.appendChild(el(doc, "p", "muted", "Nothing is waiting on you."));
    return;
  }
  waiting.forEach(function (i) {
    var card = el(doc, "div", "card");
    card.appendChild(el(doc, "span", "num", "PR #" + i.pr.number));
    card.appendChild(el(doc, "span", "title", i.title));
    (i.blockedBy || []).forEach(function (b) {
      card.appendChild(el(doc, "p", "why", b.reason));
    });
    box.appendChild(card);
  });
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
    );
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

function renderGraph(doc, issues, edges) {
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
    head.setAttribute("points", x2 + "," + y2 + " " + (x2 - 8) + "," + (y2 - 4) + " " + (x2 - 8) + "," + (y2 + 4));
    svg.appendChild(head);
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

function render(doc, snapshot, now) {
  var issues = snapshot.issues || [];
  doc.getElementById("generated").textContent = formatGenerated(snapshot.generatedAt);
  var stale = doc.getElementById("stale");
  var note = staleNote(snapshot.generatedAt, now);
  stale.textContent = note;
  stale.hidden = !note;
  var waiting = doc.getElementById("waiting");
  clear(waiting);
  renderWaiting(doc, waiting, issues);
  var tasks = doc.getElementById("tasks");
  clear(tasks);
  issues.forEach(function (i) {
    tasks.appendChild(renderTask(doc, i));
  });
  var graph = doc.getElementById("graph");
  clear(graph);
  graph.appendChild(renderGraph(doc, issues, snapshot.edges || []));
}

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
}

if (typeof document !== "undefined") {
  renderLegend(document, document.getElementById("legend"));
  load(document);
  setInterval(function () {
    load(document);
  }, POLL_MS);
}

if (typeof module !== "undefined") {
  module.exports = { POLL_MS: POLL_MS, STALE_MS: STALE_MS, STAGES: STAGES, formatGenerated: formatGenerated, staleNote: staleNote, stageOf: stageOf, renderLegend: renderLegend, renderTask: renderTask, approveLine: approveLine, renderWaiting: renderWaiting, criticalPath: criticalPath, renderGraph: renderGraph };
}
