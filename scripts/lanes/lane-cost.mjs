#!/usr/bin/env node
// Lane session cost: what each lane's own Claude Code session used, recorded when cleanup removes the lane and
// reported per tier. Reviewer cost is measured apart (review-metrics.mjs); this is the lane's own session.
//
//   node scripts/lanes/lane-cost.mjs --days 7    # per tier: lanes, median and total tokens, lanes with no transcript
//
// `.lanes/costs.jsonl` (git-ignored, never posted) holds one JSON line per removed lane, and only these fields:
//   { issue, tier, sessionId, model, tokens: { input, output, cacheRead, cacheCreation, total } | null, reason?,
//     launchedAt, removedAt }
// No path and no prompt text is ever written: `reason` is one of the fixed strings below.
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DAY_MS = 24 * 3_600_000;
const TIER_ORDER = ["full", "quick", "skip", "unknown"];
export const REASONS = { noSession: "no session id", missing: "transcript not found", unreadable: "transcript unreadable" };
const MAX_MODEL_CHARS = 100;
// A transcript larger than this is not read into memory; the lane gets `tokens: null` instead.
export const MAX_TRANSCRIPT_BYTES = 256 * 1024 * 1024;

const count = (n) => (Number.isFinite(n) && n > 0 ? n : 0);

/**
 * Sums `message.usage` over a Claude Code session transcript (JSONL). Each assistant message id counts once (a message
 * is written once per content block, so its last line wins); a line that is not JSON, or has no usage, is skipped.
 * @param {string} jsonlText
 * @returns {{ input: number, output: number, cacheRead: number, cacheCreation: number, total: number, messages: number, models: string[] }}
 */
export function sessionUsage(jsonlText) {
  const byId = new Map();
  let anonymous = 0;
  for (const line of String(jsonlText ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const message = entry?.message;
    const usage = message?.usage;
    if (!usage || typeof usage !== "object" || message.role === "user") continue;
    const id = typeof message.id === "string" && message.id ? message.id : `#${anonymous++}`;
    byId.set(id, { usage, model: typeof message.model === "string" ? message.model : null });
  }
  const totals = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  const models = new Set();
  for (const { usage, model } of byId.values()) {
    totals.input += count(usage.input_tokens);
    totals.output += count(usage.output_tokens);
    totals.cacheRead += count(usage.cache_read_input_tokens);
    totals.cacheCreation += count(usage.cache_creation_input_tokens);
    if (model && model !== "<synthetic>") models.add(model);
  }
  const total = totals.input + totals.output + totals.cacheRead + totals.cacheCreation;
  return { ...totals, total, messages: byId.size, models: [...models] };
}

// Claude Code names a project's transcript folder after its path with every non-alphanumeric character as `-`.
export const projectFolder = (root) => String(root).replace(/[^A-Za-z0-9]/g, "-");

function readTranscript(file) {
  if (statSync(file).size > MAX_TRANSCRIPT_BYTES) throw Object.assign(new Error("transcript too large"), { code: "E2BIG" });
  return readFileSync(file, "utf8");
}

const isoOrNull = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * The cost line for one removed lane. Never throws: a session with no id, or a transcript that is missing or unreadable,
 * gives `tokens: null` and a fixed `reason`.
 * @param {{ issue: number|null, tier?: string|null, sessionId?: string, startedAt?: number, root: string, now?: () => number, home?: string, read?: (file: string) => string }} lane
 */
export function costLine({ issue, tier = null, sessionId, startedAt, root, cwd, now = Date.now, home = homedir(), read = readTranscript }) {
  const base = { issue: issue ?? null, tier: TIER_ORDER.includes(tier) ? tier : null, sessionId: sessionId ?? null, model: null, launchedAt: isoOrNull(startedAt), removedAt: isoOrNull(now()) };
  if (typeof sessionId !== "string" || !SAFE_ID.test(sessionId)) return { ...base, sessionId: null, tokens: null, reason: REASONS.noSession };
  let text;
  // A session launched from the root writes its transcript under the folder of the directory it later works in (the
  // worktree), so try the root's folder first and then the session's own cwd folder.
  const folders = [...new Set([root, cwd].filter((p) => typeof p === "string" && p).map(projectFolder))];
  for (const [i, folder] of folders.entries()) {
    try {
      text = read(join(home, ".claude", "projects", folder, `${sessionId}.jsonl`));
      break;
    } catch (err) {
      if (err?.code === "ENOENT" && i < folders.length - 1) continue;
      return { ...base, tokens: null, reason: err?.code === "ENOENT" ? REASONS.missing : REASONS.unreadable };
    }
  }
  const { models, messages, ...tokens } = sessionUsage(text);
  if (messages === 0) return { ...base, tokens: null, reason: REASONS.unreadable };
  return { ...base, model: models.join(",").slice(0, MAX_MODEL_CHARS) || null, tokens };
}

/** Appends `line` to `<root>/.lanes/costs.jsonl`; throws only when the file cannot be written. */
export function appendCost(root, line) {
  const dir = join(root, ".lanes");
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, "costs.jsonl"), `${JSON.stringify(line)}\n`);
}

/** Records one lane's cost line under `root`; returns the line. Throws only when the file cannot be written. */
export function recordLaneCost(lane, { root, ...deps } = {}) {
  const line = costLine({ ...lane, root, ...deps });
  appendCost(root, line);
  return line;
}

/**
 * Per tier: lanes removed in the window, median and total tokens (over lanes with a transcript) and lanes without one.
 * Lines that do not parse are skipped.
 * @param {string} jsonlText
 * @param {{ days: number, now?: number }} opts
 */
export function summarize(jsonlText, { days, now = Date.now() }) {
  const from = now - days * DAY_MS;
  const byTier = new Map();
  for (const text of String(jsonlText ?? "").split(/\r?\n/)) {
    let line;
    try {
      line = JSON.parse(text);
    } catch {
      continue;
    }
    const removed = Date.parse(line?.removedAt);
    if (!Number.isFinite(removed) || removed < from || removed > now) continue;
    const tier = TIER_ORDER.includes(line.tier) ? line.tier : "unknown";
    const row = byTier.get(tier) ?? { tier, lanes: 0, tokens: [], noTranscript: 0 };
    row.lanes += 1;
    if (Number.isFinite(line.tokens?.total)) row.tokens.push(line.tokens.total);
    else row.noTranscript += 1;
    byTier.set(tier, row);
  }
  return TIER_ORDER.filter((t) => byTier.has(t)).map((t) => {
    const { tokens, ...row } = byTier.get(t);
    const sorted = [...tokens].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    return { ...row, medianTokens: sorted.length ? Math.round(median) : null, totalTokens: sorted.reduce((a, b) => a + b, 0) };
  });
}

export function render(rows, days) {
  if (rows.length === 0) return `lane cost, last ${days} days: no lanes recorded`;
  const lines = rows.map((r) => `${r.tier}: ${r.lanes} lanes, median ${r.medianTokens ?? "n/a"} tokens, total ${r.totalTokens} tokens, ${r.noTranscript} without a transcript`);
  return [`lane cost, last ${days} days:`, ...lines].join("\n");
}

function main(argv = process.argv.slice(2)) {
  const i = argv.indexOf("--days");
  const days = i >= 0 ? Number(argv[i + 1]) : 7;
  if (!Number.isFinite(days) || days <= 0) {
    console.error("usage: node scripts/lanes/lane-cost.mjs --days N");
    process.exitCode = 2;
    return;
  }
  let text = "";
  try {
    // Lanes run in worktrees, so the file sits under the main checkout: the common git dir's parent.
    const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8", windowsHide: true }).trim();
    text = readFileSync(join(dirname(common), ".lanes", "costs.jsonl"), "utf8");
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  console.log(render(summarize(text, { days }), days));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
