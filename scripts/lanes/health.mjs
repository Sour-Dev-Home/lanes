// The watchdog (ADR 0027): evaluates lanes' health from GitHub and keeps one `lanes-health` issue current. It comments
// each new problem once and its recovery once, and writes to no other issue.
// Usage: node scripts/lanes/health.mjs   (reads and writes GitHub through gh; meant for the scheduled workflow)
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isLaneBot, loadConfig } from "./lib.mjs";
import { STATUS_QUERY, gateSince, mergeGroupFailures, mergeQueueEntries, queueRemovals } from "./status.mjs";

export const HEALTH_LABEL = "lanes-health";
export const HEARTBEAT_MARKER = "<!-- lanes:heartbeat -->";
export const HEALTH_DEFAULTS = { approvedStuckMinutes: 30, noProgressMinutes: 30 };
export const FLAKE_DAYS = 7;

const DAY = 86_400_000;
const FAILED_GATE = new Set(["FAILURE", "ERROR"]);
const KEY = /^[a-z][a-z-]{0,30}(?::[A-Za-z0-9 #@._/()-]{1,80})?$/;
const FINDING_LIMIT = 20;

// `config.health` over the defaults; a value that is not a positive number falls back to its default.
export function healthThresholds(config) {
  const pick = (name) => (Number.isFinite(config?.health?.[name]) && config.health[name] > 0 ? config.health[name] : HEALTH_DEFAULTS[name]);
  return { approvedStuckMinutes: pick("approvedStuckMinutes"), noProgressMinutes: pick("noProgressMinutes") };
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
    const findings = (Array.isArray(data?.findings) ? data.findings : []).filter((f) => typeof f === "string" && KEY.test(f)).slice(0, FINDING_LIMIT);
    if (!best || at > best.at) best = { at, findings };
  }
  return best;
}

/**
 * ADR 0027 part 3: the active problems, `[{ key, kind, text }]` sorted by key. `inputs`: `{ config, identity, reply,
 * mergeGroupRuns, prs: [{ number, gateState, gateSince }], readyCount, inFlightCount, checkRuns: [{ name, sha,
 * conclusion, at }], comments }`. `reply` is the STATUS_QUERY reply, `now` ms.
 */
export function evaluate(inputs, now) {
  const { approvedStuckMinutes, noProgressMinutes } = healthThresholds(inputs.config);
  const found = new Map();
  const add = (key, kind, text) => found.set(key, { key, kind, text });
  const prs = inputs.prs ?? [];
  const open = new Set(prs.map((p) => p.number));
  const queued = mergeQueueEntries(inputs.reply).map((e) => e.number);
  for (const [n] of queueRemovals(inputs.reply, queued)) add(`queue-removed:PR ${n}`, "queue-removed", `PR ${n} was removed from the merge queue and not re-queued`);
  for (const p of prs) {
    if (p.gateState === "SUCCESS" && Number.isFinite(p.gateSince) && now - p.gateSince >= approvedStuckMinutes * 60_000) {
      add(`approved-stuck:PR ${p.number}`, "approved-stuck", `PR ${p.number} is approved and its gate is green but it has not merged in ${approvedStuckMinutes} minutes`);
    }
    if (FAILED_GATE.has(p.gateState)) add(`gate-failure:PR ${p.number}`, "gate-failure", `PR ${p.number}: lanes/gate is failing`);
  }
  for (const [n, f] of mergeGroupFailures(inputs.mergeGroupRuns)) {
    if (open.has(n) && !queued.includes(n)) add(`gate-failure:PR ${n}`, "gate-failure", `PR ${n}: a merge-group check failed${f.name ? ` (${safeName(f.name)})` : ""}`);
  }
  const heartbeat = readHeartbeat(inputs.comments, inputs.identity);
  if (inputs.readyCount > 0 && inputs.inFlightCount === 0 && (!heartbeat || now - heartbeat.at >= noProgressMinutes * 60_000)) {
    add("no-progress", "no-progress", `issues are ready, nothing is in flight and the queue has not reported in ${noProgressMinutes} minutes`);
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
      add(`flake:${safeName(e.name)}@${sha7}`, "flake", `check ${safeName(e.name)} failed and then passed on the same commit ${sha7}`);
    }
  }
  for (const f of heartbeat?.findings ?? []) add(f, "queue", `the queue reports: ${f}`);
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

export function renderBody(open, active, heartbeat) {
  const text = new Map(active.map((p) => [p.key, p.text]));
  const lines = [`<!-- lanes:health ${JSON.stringify({ open })} -->`, "", `**Status:** ${open.length ? `${open.length} problem${open.length === 1 ? "" : "s"}` : "healthy"}`, ""];
  for (const o of open) lines.push(`- ${text.get(o.key) ?? o.key} (since ${new Date(o.at).toISOString().slice(0, 16).replace("T", " ")} UTC)`);
  if (open.length) lines.push("");
  lines.push(`Last queue heartbeat: ${heartbeat ? `${new Date(heartbeat.at).toISOString().slice(0, 16).replace("T", " ")} UTC` : "none"}`);
  return lines.join("\n");
}

/**
 * ADR 0027 parts 4 to 6. `client` is the only way to GitHub and has these operations: `listIssues(label)` (every
 * state, `[{ number, state, body, lastWriter }]`), `createLabel(label)`, `createIssue({ title, body, labels })` (the new
 * number), and, each given the one issue number this run found or created, `listComments(number)`, `editBody`,
 * `reopen` and `comment`. `inputs` is evaluate's, minus `comments`, which run reads from the health issue.
 */
export async function run({ client, inputs, now = Date.now() }) {
  const issues = (await client.listIssues(HEALTH_LABEL)).filter((i) => Number.isInteger(i?.number)).sort((a, b) => a.number - b.number);
  let issue = issues.find((i) => i.state === "OPEN") ?? issues[0];
  if (!issue) {
    await client.createLabel(HEALTH_LABEL);
    const number = await client.createIssue({ title: "lanes health", body: renderBody([], [], null), labels: [HEALTH_LABEL] });
    issue = { number, state: "OPEN", body: "", lastWriter: null };
  }
  const n = issue.number;
  const comments = await client.listComments(n);
  const active = evaluate({ ...inputs, comments }, now);
  const { open, added, recovered } = reconcile(readStored(issue), active, now);
  if (issue.state !== "OPEN" && active.length > 0) await client.reopen(n);
  const body = renderBody(open, active, readHeartbeat(comments, inputs.identity));
  if (body !== issue.body) await client.editBody(n, body);
  for (const p of added) await client.comment(n, `New problem: ${p.text}`);
  if (recovered && (issue.state === "OPEN" || active.length > 0)) await client.comment(n, "Recovered: lanes is healthy again.");
  return { number: n, active, added: added.map((p) => p.key), recovered };
}

// The gh-backed client for `run`. `gh(args)` returns parsed JSON (or text for non-JSON).
export function ghClient(gh) {
  const quote = (s) => JSON.stringify(String(s));
  return {
    async listIssues(label) {
      const q = `query($owner:String!,$name:String!){ repository(owner:$owner,name:$name){ issues(labels:[${quote(label)}],states:[OPEN,CLOSED],first:50,orderBy:{field:CREATED_AT,direction:ASC}){ nodes { number state body author { login __typename } editor { login __typename } } } } }`;
      const nodes = gh(["api", "graphql", "-F", "owner={owner}", "-F", "name={repo}", "-f", `query=${q}`])?.data?.repository?.issues?.nodes ?? [];
      return nodes.map((i) => ({ number: i.number, state: i.state, body: i.body ?? "", lastWriter: i.editor ?? i.author }));
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
  const out = execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 120_000 });
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
  const prs = (reply?.data?.repository?.pullRequests?.nodes ?? []).map((node) => {
    const status = node.commits?.nodes?.[0]?.commit?.status;
    return { number: node.number, gateState: status?.contexts?.find((c) => c.context === "lanes/gate")?.state ?? null, gateSince: since.get(node.number) };
  });
  const issues = gh(["issue", "list", "--state", "open", "--limit", "1000", "--json", "number,labels"]);
  const has = (i, name) => i.labels.some((l) => l.name === name);
  const runs = gh(["run", "list", "--limit", "100", "--json", "name,headSha,conclusion,updatedAt"]);
  return {
    config,
    identity: config.identity,
    reply,
    prs,
    mergeGroupRuns: gh(["run", "list", "--event", "merge_group", "--status", "failure", "--limit", "50", "--json", "databaseId,headBranch,workflowName,url,createdAt"]),
    readyCount: issues.filter((i) => has(i, "ready") && !has(i, "lane:running")).length,
    inFlightCount: prs.length + issues.filter((i) => has(i, "lane:running")).length,
    checkRuns: runs.map((r) => ({ name: r.name, sha: r.headSha, conclusion: r.conclusion, at: r.updatedAt })),
  };
}

async function main() {
  const result = await run({ client: ghClient(ghJson), inputs: gatherInputs() });
  console.log(`health: issue #${result.number}, ${result.active.length} problem(s), ${result.added.length} new${result.recovered ? ", recovered" : ""}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
