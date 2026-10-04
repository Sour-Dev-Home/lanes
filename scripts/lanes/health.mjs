// The watchdog (ADR 0027): evaluates lanes' health from GitHub and keeps one `lanes-health` issue current. It comments
// each new problem once and its recovery once, and writes to no other issue.
// Usage: node scripts/lanes/health.mjs   (reads and writes GitHub through gh; meant for the scheduled workflow)
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isLaneBot, loadConfig, readControlState } from "./lib.mjs";
import { STATUS_QUERY, formatAge, gateDescriptions, gateSince, mergeGroupFailures, mergeQueueEntries, prStage, queueRemovals, trustedRollups } from "./status.mjs";

export const HEALTH_LABEL = "lanes-health";
export const HEARTBEAT_MARKER = "<!-- lanes:heartbeat -->";
export const HEALTH_DEFAULTS = { approvedStuckMinutes: 30, noProgressMinutes: 30, gateFailureMinutes: 10, stuckPrMinutes: 30 };
export const FLAKE_DAYS = 7;

const DAY = 86_400_000;
const FAILED_GATE = new Set(["FAILURE", "ERROR"]);
const KEY = /^[a-z][a-z-]{0,30}(?::[A-Za-z0-9 #@._/()-]{1,80})?$/;
// A finding from the queue is echoed into comments, so it cannot carry `@` or `#` (a mention or a cross-link).
const FINDING = /^[a-z][a-z-]{0,30}(?::[A-Za-z0-9 ._/()-]{1,80})?$/;
const FINDING_LIMIT = 20;

// `config.health` over the defaults; a value that is not a positive number falls back to its default.
export function healthThresholds(config) {
  const pick = (name) => (Number.isFinite(config?.health?.[name]) && config.health[name] > 0 ? config.health[name] : HEALTH_DEFAULTS[name]);
  return { approvedStuckMinutes: pick("approvedStuckMinutes"), noProgressMinutes: pick("noProgressMinutes"), gateFailureMinutes: pick("gateFailureMinutes"), stuckPrMinutes: pick("stuckPrMinutes") };
}

// A check name from GitHub is untrusted text that ends up in a key and a comment: keep a plain, bounded alphabet.
const safeName = (s) => String(s ?? "").replace(/[^A-Za-z0-9 ._/()-]/g, "_").slice(0, 60);

// The newest heartbeat comment written by the lane bot: `{ at, findings }`, or null. Any other comment carrying the
// marker is ignored, whoever wrote it. `at` is the time inside the block, else the comment's own update time.
export function readHeartbeat(comments, identity) {
  let best = null;
  for (const c of Array.isArray(comments) ? comments : []) {
    if (typeof c?.body !== "string" || !c.body.startsWith(HEARTBEAT_MARKER) || !isLaneBot(identity, c.author)) continue;
    let data = {};
    try {
      data = JSON.parse(/\{[\s\S]*\}/.exec(c.body.slice(HEARTBEAT_MARKER.length))?.[0] ?? "{}");
    } catch {
      // A block that does not parse still proves the queue ran at the comment's update time.
    }
    const at = Date.parse(data?.at) || Date.parse(c.updatedAt);
    if (!Number.isFinite(at)) continue;
    const findings = (Array.isArray(data?.findings) ? data.findings : []).filter((f) => typeof f === "string" && FINDING.test(f)).slice(0, FINDING_LIMIT);
    // ADR 0028: a heartbeat without `paused` reads as not paused.
    // #745: the issues with a running or waiting lane session; a heartbeat without `live` lists none.
    const live = (Array.isArray(data?.live) ? data.live : []).filter((n) => Number.isSafeInteger(n) && n > 0).slice(0, FINDING_LIMIT);
    if (!best || at > best.at) best = { at, findings, paused: data?.paused === true, live };
  }
  return best;
}

// Quoted text in a comment is one line without control characters, and carries no `@` (a mention) or `#` (a cross-link).
// Control and format characters (bidi overrides, zero-width): Unicode line separators are whitespace, so the next replace folds them.
const CONTROL = /[\x00-\x1f\x7f-\x9f]/g;
const FORMAT = /\p{Cf}/gu;
export function oneLine(s, max = 120) {
  const t = String(s ?? "").replace(FORMAT, "").replace(CONTROL, " ").replace(/\s+/g, " ").trim().replace(/[@#`<>[\]]/g, "_").replace(/:\/\//g, ":/ /").replace(/www\./gi, "www_");
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

const httpsUrl = (u) => (typeof u === "string" && /^https:\/\/[^\s]+$/.test(u) ? u : undefined);
const TAP_MARK = /(?:^|\s)not ok \d{1,9} - /;
const DURATION = / \(\d{1,9}(?:\.\d{1,9})?ms\)$/;
const NAME_LIMIT = 120;
const TEST_LIMIT = 10;
const LINE_LIMIT = 400;
const LOG_LINES = 200_000;

// The names of up to 10 failing tests in a failed job's log (node:test's spec or TAP lines), each one line of at most 120 characters.
export function failingTests(log) {
  const names = new Set();
  // A log is untrusted and can be 64 MB: bound each line before the regex (quadratic on a long whitespace run) and the lines read.
  for (const raw of String(log ?? "").split(/\r?\n/, LOG_LINES)) {
    const line = raw.slice(0, LINE_LIMIT).replace(/\u001b\[[0-9;]*m/g, "");
    // No regex backtracks over the untrusted tail: find the marker, collapse whitespace (linear), then strip the duration.
    const at = line.indexOf("✖ ");
    const tap = at < 0 ? TAP_MARK.exec(line) : null;
    const rest = at >= 0 ? line.slice(at + 2) : tap ? line.slice(tap.index + tap[0].length) : null;
    if (rest === null || (at > 0 && !/\s/.test(line[at - 1]))) continue;
    const full = oneLine(rest, LINE_LIMIT).replace(DURATION, "");
    const name = full.length > NAME_LIMIT ? `${full.slice(0, NAME_LIMIT - 1)}…` : full;
    if (name && !/^failing tests:?$/i.test(name) && !/^# /.test(name)) names.add(name);
    if (names.size >= TEST_LIMIT) break;
  }
  return [...names];
}

function stuckReason(p, inQueue) {
  if (p.approvalStale) return { cause: "the approval is on an older commit", fix: "a push dismissed your approval: approve again" };
  if (p.gateState !== "SUCCESS") return { cause: `the gate is pending: ${oneLine(p.gateDescription) || "no reason given"}`, fix: "wait for the gate, or act on the reason it gives" };
  if (!inQueue) return { cause: "the PR is not in the merge queue", fix: "click Enable auto-merge on the PR" };
  return { cause: "the PR is in the merge queue but has not merged", fix: "open the queue's checks on the PR and see which one is waiting" };
}

function gateFailure(p, run) {
  const pr = httpsUrl(p.url);
  return {
    anchor: "gate-failure",
    pr,
    run: run ?? (pr ? { url: `${pr}/checks` } : null),
    cause: run?.name ? `the merge-group check ${run.name} failed` : `lanes/gate says: ${oneLine(p.gateDescription) || "failing"}`,
    fix: run ? "open the run, fix what it names, and push" : "the lane fixes this; if its session has stopped, the issue shows needs-owner with what to do",
  };
}

// The comment for a new problem. `tests` is the failing test names (an array), or null when the log could not be read;
// undefined means the problem has no log to read.
export function renderComment(p, tests, repoUrl) {
  const lines = [`New problem: ${p.text}`];
  if (p.pr) lines.push(`PR: ${p.pr}`);
  if (p.url) lines.push(`Issue: ${p.url}`);
  if (p.run?.url) lines.push(`Run: ${p.run.url}`);
  if (tests === null) lines.push("The failing test names could not be read from the log.");
  else if (tests?.length) lines.push(`Failing tests (up to ${TEST_LIMIT}):`, ...tests.map((t) => `- ${t}`));
  else if (tests) lines.push("No failing test names were found in the log.");
  if (!p.cause) return lines.join("\n");
  const base = httpsUrl(repoUrl);
  lines.push(`Cause: ${p.cause}`, `Fix: ${p.fix}`, `Runbook: ${base ? `${base}/blob/main/` : ""}docs/OPERATIONS.md${p.anchor ? `#${p.anchor}` : ""}`);
  return lines.join("\n");
}

/**
 * ADR 0027 part 3: the active problems, `[{ key, kind, text }]` sorted by key. `inputs`: `{ config, identity, reply,
 * mergeGroupRuns, prs: [{ number, gateState, gateSince }], readyCount, inFlightCount, checkRuns: [{ name, sha,
 * conclusion, at }], comments }`. `reply` is the STATUS_QUERY reply, `now` ms.
 */
export function evaluate(inputs, now) {
  const { approvedStuckMinutes, noProgressMinutes, gateFailureMinutes, stuckPrMinutes } = healthThresholds(inputs.config);
  const found = new Map();
  // `extra` is the owner's guidance: `cause`, `fix`, the runbook `anchor`, and for a PR its `pr` link and failed `run`.
  const add = (key, kind, text, extra = {}) => found.set(key, { key, kind, text, ...extra });
  const prs = inputs.prs ?? [];
  const open = new Set(prs.map((p) => p.number));
  const byNumber = new Map(prs.map((p) => [p.number, p]));
  const queued = mergeQueueEntries(inputs.reply).map((e) => e.number);
  const failures = mergeGroupFailures(inputs.mergeGroupRuns);
  const prLink = (n) => httpsUrl(byNumber.get(n)?.url);
  const runOf = (f) => (f ? { name: oneLine(f.name, 60), url: httpsUrl(f.url), id: /\/actions\/runs\/(\d+)/.exec(f.url ?? "")?.[1] } : null);
  for (const [n] of queueRemovals(inputs.reply, queued)) {
    const run = runOf(failures.get(n));
    add(`queue-removed:PR ${n}`, "queue-removed", `PR ${n} was removed from the merge queue and not re-queued`, {
      anchor: "merge-queue-removed",
      pr: prLink(n),
      run,
      cause: run?.name ? `the merge-group check ${run.name} failed` : "the merge queue removed it and no failed merge-group check was found",
      fix: "fix the cause, then click Enable auto-merge on the PR",
    });
  }
  for (const p of prs) {
    // An approved PR stays stuck when its gate is green but it has not merged, or when the gate stays pending after the approval.
    if ((p.gateState === "SUCCESS" || (p.approved === true && p.gateState === "PENDING")) && Number.isFinite(p.gateSince) && now - p.gateSince >= approvedStuckMinutes * 60_000) {
      add(`approved-stuck:PR ${p.number}`, "approved-stuck", `PR ${p.number} is approved and its gate is green but it has not merged in ${approvedStuckMinutes} minutes`, {
        anchor: "approved-not-merged",
        pr: prLink(p.number),
        ...stuckReason(p, queued.includes(p.number)),
      });
    }
    // #732: a lane fixes a briefly failing gate (a missing section) itself, so it alerts only once the failure lasts.
    const lasting = !Number.isFinite(p.gateSince) || now - p.gateSince >= gateFailureMinutes * 60_000;
    if (FAILED_GATE.has(p.gateState) && lasting) add(`gate-failure:PR ${p.number}`, "gate-failure", `PR ${p.number}: lanes/gate is failing`, gateFailure(p, null));
  }
  for (const [n, f] of failures) {
    if (open.has(n) && !queued.includes(n)) {
      add(`gate-failure:PR ${n}`, "gate-failure", `PR ${n}: a merge-group check failed${f.name ? ` (${safeName(f.name)})` : ""}`, gateFailure(byNumber.get(n) ?? { number: n }, runOf(f)));
    }
  }
  // #679: an open issue a lane stopped on. The text never copies the title, which is the issue author's free text.
  for (const i of inputs.needsOwner ?? []) {
    if (!Number.isInteger(i?.number) || i.number < 1) continue;
    add(`needs-owner:#${i.number}`, "needs-owner", `#${i.number} needs you: a lane stopped or found nothing to build; see its last comment`, {
      anchor: "needs-owner",
      url: httpsUrl(i.url),
      cause: "a lane stopped on this issue, or found nothing to build, and left a comment saying why",
      fix: "read the issue's last comment, then close or rewrite the issue and remove needs-owner",
    });
  }
  const heartbeat = readHeartbeat(inputs.comments, inputs.identity);
  // #745: an open lane PR that is failing, conflicting or not yet gated, with no lane working on it and no commit for
  // `stuckPrMinutes`. A missing or stale heartbeat raises nothing here: `no-progress` covers a stopped queue.
  if (heartbeat && now - heartbeat.at < noProgressMinutes * 60_000) {
    const position = new Map(mergeQueueEntries(inputs.reply).map((e) => [e.number, e.position]));
    for (const p of trustedRollups(prs, inputs.reply, inputs.config)) {
      const n = Number(/^issue-(\d+)-/.exec(p.headRefName ?? "")?.[1]);
      if (!Number.isSafeInteger(n) || heartbeat.live.includes(n)) continue;
      const { stage } = prStage(p, position.get(p.number), p.gateDescription);
      if (!["failing", "conflict", "starting"].includes(stage)) continue;
      const newest = Math.max(...(Array.isArray(p.commits) ? p.commits : []).map((c) => Date.parse(c?.committedDate)).filter(Number.isFinite));
      if (!Number.isFinite(newest) || now - newest < stuckPrMinutes * 60_000) continue;
      add(`stuck-pr:PR ${p.number}`, "stuck-pr", `PR ${p.number} (#${n}) is ${stage} and no lane is working on it`, {
        anchor: "stuck-pr",
        pr: prLink(p.number),
        cause: `its newest commit is ${formatAge(newest, now)} old and the queue's heartbeat lists no lane session for it`,
        fix: "the queue should resume it; if it has not, check the issue's last comment",
      });
    }
  }
  // ADR 0028 part 6: while paused on purpose, nothing launching is expected, so `no-progress` stays quiet (other alerts fire).
  const switchedOff = inputs.control?.paused === true || heartbeat?.paused === true;
  if (!switchedOff && inputs.readyCount > 0 && inputs.inFlightCount === 0 && (!heartbeat || now - heartbeat.at >= noProgressMinutes * 60_000)) {
    const paused = inputs.queuePaused === true;
    add("no-progress", "no-progress", `issues are ready, nothing is in flight and the queue has not reported in ${noProgressMinutes} minutes`, {
      anchor: paused ? "paused" : "no-progress",
      cause: heartbeat ? `the queue's last heartbeat was ${formatAge(heartbeat.at, now)} ago` : "the queue has never reported a heartbeat",
      fix: paused ? "the queue is paused; resume it" : "start the queue",
    });
  }
  // A flake: the same check failed and then passed on the same head SHA. It has no recovery signal, so it stays for FLAKE_DAYS from the pass.
  const byCheck = new Map();
  for (const r of inputs.checkRuns ?? []) {
    const at = Date.parse(r?.at);
    if (typeof r?.name !== "string" || typeof r?.sha !== "string" || !Number.isFinite(at)) continue;
    const k = `${r.name}\u0000${r.sha}`;
    const e = byCheck.get(k) ?? { name: r.name, sha: r.sha, failedAt: Infinity, passedAt: -Infinity };
    if (r.conclusion === "failure") e.failedAt = Math.min(e.failedAt, at);
    if (r.conclusion === "success") e.passedAt = Math.max(e.passedAt, at);
    byCheck.set(k, e);
  }
  for (const e of byCheck.values()) {
    if (e.failedAt < e.passedAt && now - e.passedAt < FLAKE_DAYS * DAY) {
      const sha7 = e.sha.replace(/[^0-9a-f]/gi, "").slice(0, 7);
      add(`flake:${safeName(e.name)}@${sha7}`, "flake", `check ${safeName(e.name)} failed and then passed on the same commit ${sha7}`, {
        anchor: "flaky-test",
        cause: "the same check failed and then passed on one commit, so it is flaky",
        fix: "no action unless it recurs; then follow the runbook",
      });
    }
  }
  // #637: the merge queue's test-retry.mjs reruns a failing test file once and annotates a test that then passed (`lanes-flaky`).
  const noted = new Map();
  for (const a of Array.isArray(inputs.flakyAnnotations) ? inputs.flakyAnnotations : []) {
    const at = Date.parse(a?.at);
    if (typeof a?.file !== "string" || a.file === "" || typeof a?.sha !== "string" || !Number.isFinite(at)) continue;
    const k = `${a.file}\u0000${a.sha}`;
    noted.set(k, { file: a.file, sha: a.sha, at: Math.max(at, noted.get(k)?.at ?? -Infinity) });
  }
  for (const e of noted.values()) {
    if (now - e.at >= FLAKE_DAYS * DAY) continue;
    const sha7 = e.sha.replace(/[^0-9a-f]/gi, "").slice(0, 7);
    add(`flake:${safeName(e.file)}@${sha7}`, "flake", `test file ${safeName(e.file)} failed and then passed on rerun on commit ${sha7}`, {
      anchor: "flaky-test",
      cause: "a test failed once and passed on the merge queue's rerun, so it is flaky",
      fix: "no action unless it recurs; then follow the runbook",
    });
  }
  for (const f of heartbeat?.findings ?? []) {
    const id = /^stalled:(.+)$/.exec(f)?.[1];
    add(f, id ? "stalled" : "queue", `the queue reports: ${f}`, id
      ? { anchor: "stalled-lane", cause: `lane session ${id} stopped making progress`, fix: `run /status: it gives the recovery for session ${id} (claude attach ${id})` }
      : { anchor: "", cause: "the queue reported it in its heartbeat", fix: "run /status and follow what it says" });
  }
  return [...found.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

const isActionsBot = (a) => a?.login === "github-actions[bot]" || (a?.login === "github-actions" && a?.type === "Bot");
const STATE = /^<!-- lanes:health (\{.*\}) -->/m;

// The open keys stored in an issue body: `[{ key, at }]`. Anything but a well-formed block in a body last written by
// github-actions[bot] counts as absent.
export function readStored(issue) {
  if (!isActionsBot(issue?.lastWriter) || typeof issue?.body !== "string") return [];
  try {
    const open = JSON.parse(STATE.exec(issue.body)?.[1] ?? "null")?.open;
    if (!Array.isArray(open)) return [];
    return open.filter((o) => typeof o?.key === "string" && KEY.test(o.key) && Number.isFinite(o.at)).map((o) => ({ key: o.key, at: o.at }));
  } catch {
    return [];
  }
}

// ADR 0027 part 4: compare the stored keys with the active problems. `open` is the new stored list (a kept key keeps
// its first-seen time), `added` the problems to comment once, `recovered` true when a non-empty set became empty.
export function reconcile(stored, active, now) {
  const since = new Map(stored.map((o) => [o.key, o.at]));
  const open = active.map((p) => ({ key: p.key, at: since.get(p.key) ?? now }));
  const added = active.filter((p) => !since.has(p.key));
  return { open, added, recovered: stored.length > 0 && active.length === 0 };
}

export function renderBody(open, active, heartbeat, control = null) {
  const text = new Map(active.map((p) => [p.key, p.text]));
  const lines = [`<!-- lanes:health ${JSON.stringify({ open })} -->`, "", `**Status:** ${open.length ? `${open.length} problem${open.length === 1 ? "" : "s"}` : "healthy"}`, ""];
  // ADR 0028 part 6: the pause, from the control comment (text already one line, but bounded again here).
  if (control?.paused === true) lines.push(`Paused since ${new Date(control.since).toISOString().slice(0, 16).replace("T", " ")} UTC by ${oneLine(control.by, 60)}: ${oneLine(control.reason, 200) || "no reason given"}`, "");
  for (const o of open) lines.push(`- ${text.get(o.key) ?? o.key} (since ${new Date(o.at).toISOString().slice(0, 16).replace("T", " ")} UTC)`);
  if (open.length) lines.push("");
  lines.push(`Last queue heartbeat: ${heartbeat ? `${new Date(heartbeat.at).toISOString().slice(0, 16).replace("T", " ")} UTC` : "none"}`);
  return lines.join("\n");
}

/**
 * The `lanes-health` issue every writer shares (the watchdog and the queue's heartbeat): the lowest-numbered open one,
 * else the lowest-numbered one in any state, else a new one made after its label. `client` is `run`'s, using
 * `listIssues`, `createLabel` and `createIssue`. Returns `{ number, state, body, lastWriter }`.
 */
export async function findOrCreateHealthIssue(client) {
  const issues = (await client.listIssues(HEALTH_LABEL)).filter((i) => Number.isInteger(i?.number)).sort((a, b) => a.number - b.number);
  const found = issues.find((i) => i.state === "OPEN") ?? issues[0];
  if (found) return found;
  await client.createLabel(HEALTH_LABEL);
  const number = await client.createIssue({ title: "lanes health", body: renderBody([], [], null), labels: [HEALTH_LABEL] });
  return { number, state: "OPEN", body: "", lastWriter: null };
}

/**
 * ADR 0027 parts 4 to 6. `client` is the only way to GitHub and has these operations: `listIssues(label)` (every
 * state, `[{ number, state, body, lastWriter }]`), `createLabel(label)`, `createIssue({ title, body, labels })` (the new
 * number), and, each given the one issue number this run found or created, `listComments(number)`, `editBody`,
 * `reopen` and `comment`. `inputs` is evaluate's, minus `comments`, which run reads from the health issue.
 */
export async function run({ client, inputs, now = Date.now() }) {
  const issue = await findOrCreateHealthIssue(client);
  const n = issue.number;
  const comments = await client.listComments(n);
  const active = evaluate({ ...inputs, comments }, now);
  const { open, added, recovered } = reconcile(readStored(issue), active, now);
  if (issue.state !== "OPEN" && active.length > 0) await client.reopen(n);
  const body = renderBody(open, active, readHeartbeat(comments, inputs.identity), inputs.control);
  if (body !== issue.body) await client.editBody(n, body);
  for (const p of added) {
    let tests;
    if (p.run?.id) {
      try {
        tests = failingTests(await inputs.readLog?.(p.run.id));
      } catch {
        tests = null;
      }
    }
    await client.comment(n, renderComment(p, tests, inputs.repoUrl));
  }
  if (recovered && (issue.state === "OPEN" || active.length > 0)) await client.comment(n, "Recovered: lanes is healthy again.");
  return { number: n, active, added: added.map((p) => p.key), recovered };
}

// The gh-backed client for `run`. `gh(args)` returns parsed JSON (or text for non-JSON).
// A GraphQL actor is `{ login, __typename }`; the trust checks read `type`. A missing actor stays null.
const actor = (a) => (a && typeof a.login === "string" ? { login: a.login, type: a.__typename } : null);

export function ghClient(gh) {
  const quote = (s) => JSON.stringify(String(s));
  return {
    async listIssues(label) {
      const q = `query($owner:String!,$name:String!){ repository(owner:$owner,name:$name){ issues(labels:[${quote(label)}],states:[OPEN,CLOSED],first:50,orderBy:{field:CREATED_AT,direction:ASC}){ nodes { number state body author { login __typename } editor { login __typename } } } } }`;
      const nodes = gh(["api", "graphql", "-F", "owner={owner}", "-F", "name={repo}", "-f", `query=${q}`])?.data?.repository?.issues?.nodes ?? [];
      return nodes.map((i) => ({ number: i.number, state: i.state, body: i.body ?? "", lastWriter: actor(i.editor ?? i.author) }));
    },
    async createLabel(label) {
      try {
        gh(["api", "repos/{owner}/{repo}/labels", "-f", `name=${label}`, "-f", "color=d93f0b", "-f", "description=The lanes health inbox"]);
      } catch (e) {
        if (!/already_exists|422/.test(String(e?.stderr ?? e?.message ?? e))) throw e;
      }
    },
    async createIssue({ title, body, labels }) {
      return gh(["api", "repos/{owner}/{repo}/issues", "-f", `title=${title}`, "-f", `body=${body}`, ...labels.flatMap((l) => ["-f", `labels[]=${l}`])]).number;
    },
    async listComments(number) {
      const rows = gh(["api", "--paginate", "--slurp", `repos/{owner}/{repo}/issues/${Number(number)}/comments?per_page=100`]).flat();
      return rows.map((c) => ({ body: c.body ?? "", author: { login: c.user?.login }, updatedAt: c.updated_at }));
    },
    async editBody(number, body) {
      gh(["api", "-X", "PATCH", `repos/{owner}/{repo}/issues/${Number(number)}`, "-f", `body=${body}`]);
    },
    async reopen(number) {
      gh(["api", "-X", "PATCH", `repos/{owner}/{repo}/issues/${Number(number)}`, "-f", "state=open"]);
    },
    async comment(number, body) {
      gh(["api", `repos/{owner}/{repo}/issues/${Number(number)}/comments`, "-f", `body=${body}`]);
    },
  };
}

function ghJson(args) {
  const out = execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 120_000, windowsHide: true });
  try {
    return JSON.parse(out);
  } catch {
    return out;
  }
}

// What `run` needs from GitHub that is not the health issue.
export function gatherInputs(gh = ghJson, config = loadConfig()) {
  const reply = gh(["api", "graphql", "-F", "owner={owner}", "-F", "name={repo}", "-f", `query=${STATUS_QUERY}`]);
  const since = gateSince(reply);
  const descriptions = gateDescriptions(reply);
  // An approval is stale when one exists but none is on the PR's current head.
  const details = new Map();
  for (const d of gh(["pr", "list", "--state", "open", "--limit", "100", "--json", "number,url,headRefOid,latestReviews,headRefName,mergeable,statusCheckRollup,autoMergeRequest,commits"]) ?? []) {
    const approved = (d.latestReviews ?? []).filter((r) => r?.state === "APPROVED").map((r) => r?.commit?.oid);
    details.set(d.number, { url: d.url, headRefName: d.headRefName, mergeable: d.mergeable, statusCheckRollup: d.statusCheckRollup, autoMergeRequest: d.autoMergeRequest, commits: d.commits, approved: approved.length > 0, approvalStale: approved.length > 0 && !approved.includes(d.headRefOid) });
  }
  const prs = (reply?.data?.repository?.pullRequests?.nodes ?? []).map((node) => {
    const status = node.commits?.nodes?.[0]?.commit?.status;
    return { number: node.number, gateState: status?.contexts?.find((c) => c.context === "lanes/gate")?.state ?? null, gateSince: since.get(node.number), gateDescription: descriptions.get(node.number), ...details.get(node.number) };
  });
  const issues = gh(["issue", "list", "--state", "open", "--limit", "1000", "--json", "number,labels,url"]);
  const has = (i, name) => i.labels.some((l) => l.name === name);
  const runs = gh(["run", "list", "--limit", "100", "--json", "databaseId,name,headSha,conclusion,updatedAt"]);
  const repoInfo = gh(["repo", "view", "--json", "url,nameWithOwner"]);
  return {
    config,
    identity: config.identity,
    repoUrl: repoInfo?.url,
    control: readControlState((args) => {
      const reply = gh(["api", ...args]);
      return typeof reply === "string" ? reply : JSON.stringify(reply);
    }, repoInfo?.nameWithOwner),
    readLog: (id) => gh(["run", "view", String(Number(id)), "--log-failed"]),
    reply,
    prs,
    mergeGroupRuns: gh(["run", "list", "--event", "merge_group", "--status", "failure", "--limit", "50", "--json", "databaseId,headBranch,workflowName,url,createdAt"]),
    readyCount: issues.filter((i) => has(i, "ready") && !has(i, "lane:running")).length,
    needsOwner: issues.filter((i) => has(i, "needs-owner")).map((i) => ({ number: i.number, url: i.url })),
    inFlightCount: prs.length + issues.filter((i) => has(i, "lane:running")).length,
    checkRuns: runs.map((r) => ({ name: r.name, sha: r.headSha, conclusion: r.conclusion, at: r.updatedAt })),
    flakyAnnotations: flakyAnnotations(gh, runs),
  };
}

const FLAKY_RUN_LIMIT = 30;

// #637: a `lanes-flaky` warning is an annotation on a job of a successful verify run (its message is `<file> :: <test>`).
// Read through the check-run annotations API; a read that fails is reported on stderr and skipped, never fatal.
function flakyAnnotations(gh, runs) {
  const found = [];
  const verified = runs.filter((r) => r.name === "verify" && r.conclusion === "success" && Number.isInteger(r.databaseId)).slice(0, FLAKY_RUN_LIMIT);
  for (const r of verified) {
    try {
      for (const job of gh(["api", `repos/{owner}/{repo}/actions/runs/${r.databaseId}/jobs`])?.jobs ?? []) {
        if (!Number.isInteger(job?.id)) continue;
        const notes = gh(["api", `repos/{owner}/{repo}/check-runs/${job.id}/annotations`]);
        for (const n of Array.isArray(notes) ? notes : []) {
          const file = n?.title === "lanes-flaky" && typeof n.message === "string" ? n.message.split(" :: ")[0].trim() : "";
          if (file) found.push({ file, sha: r.headSha, at: r.updatedAt });
        }
      }
    } catch (e) {
      console.error(`health: could not read the annotations of run ${r.databaseId}: ${String(e?.message ?? e).split("\n")[0]}`);
    }
  }
  return found;
}

async function main() {
  const result = await run({ client: ghClient(ghJson), inputs: gatherInputs() });
  console.log(`health: issue #${result.number}, ${result.active.length} problem(s), ${result.added.length} new${result.recovered ? ", recovered" : ""}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
