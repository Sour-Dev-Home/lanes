// scripts/lanes/blockers.mjs
// Checks that a task issue's "Blocked by" issues are all closed, failing closed on anything it cannot read.
// Usage: node scripts/lanes/blockers.mjs <issue>. Exit 0: no open blockers. 1: open blockers. 2: cannot check.
// /lane step 2 runs it; unlike /status, which only hints, a blocker it cannot read stops the lane.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseIssueForm } from "./lib.mjs";

/**
 * @param {number[]} blockedBy the issue's blocker numbers
 * @param {Record<number, "open"|"closed"|null> | Map<number, "open"|"closed"|null>} states each blocker's state;
 *   null (or a missing entry) means not found or unreadable
 * @returns {{ ok: boolean, open: number[], unreadable: number[] }} ok only when every blocker is "closed"
 */
export function blockerReport(blockedBy, states) {
  const get = (b) => (states instanceof Map ? states.get(b) : states?.[b]);
  const open = [];
  const unreadable = [];
  for (const b of new Set(blockedBy)) {
    const state = get(b);
    if (state === "open") open.push(b);
    else if (state !== "closed") unreadable.push(b);
  }
  return { ok: open.length === 0 && unreadable.length === 0, open, unreadable };
}

/** An issue body's distinct "Blocked by" numbers, or `{ error }` when that field is missing or malformed. */
export function parseBlockedBy(body) {
  // Only the "Blocked by" field matters here; the issue contract check owns the rest of the form.
  const form = parseIssueForm(body);
  const errors = form.errors.filter((e) => /blocked by/.test(e));
  return errors.length ? { error: errors.join("; ") } : { blockedBy: [...new Set(form.fields.blockedBy)] };
}

/**
 * The one "Blocked by" reader, shared by this CLI and lanes/gate (#36): `blockerReport` for an issue body, calling
 * `readState(b)` once per distinct blocker. A throw, or any state but "open" or "closed", makes that blocker
 * unreadable. A missing or malformed field reads nothing and returns `{ ok: false, open: [], unreadable: [], error }`.
 */
export function readBlockerReport(body, readState) {
  const { blockedBy, error } = parseBlockedBy(body);
  if (error) return { ok: false, open: [], unreadable: [], error };
  const states = new Map();
  for (const b of blockedBy) {
    try {
      const state = readState(b);
      states.set(b, state === "open" || state === "closed" ? state : null);
    } catch {
      states.set(b, null);
    }
  }
  return blockerReport(blockedBy, states);
}

// Printable text only: control, format (bidi overrides) and line-separator characters are dropped, and the length is capped.
const printable = (s) => String(s).replace(/[\p{C}\p{Zl}\p{Zp}]/gu, "").slice(0, 200);
const reason = (err) => printable(String(err?.stderr || err?.message || err).trim().split("\n")[0]);

/** `run` takes full `gh` arguments and returns stdout; tests pass a fake. Returns the exit code and the line to print. */
export function main(argv, run = gh) {
  const arg = String(argv[0] ?? "").replace(/^#/, "");
  if (!/^[1-9]\d*$/.test(arg)) return { code: 2, message: `#?: cannot check blockers: usage: blockers.mjs <issue number>` };
  const n = arg;
  const cannot = (why) => ({ code: 2, message: `#${n}: cannot check blockers: ${why}` });

  let body;
  try {
    body = JSON.parse(run(["issue", "view", n, "--json", "body"])).body;
  } catch (err) {
    return cannot(`issue #${n} not found or unreadable (${reason(err)})`);
  }

  // The issues API also answers for a PR, so a PR used as a blocker counts by its own state.
  // The shared reader drops why a blocker was unreadable, so note it here for the message.
  const why = new Map();
  const report = readBlockerReport(body, (b) => {
    let state;
    try {
      state = JSON.parse(run(["api", `repos/{owner}/{repo}/issues/${b}`])).state;
    } catch (err) {
      why.set(b, reason(err));
      throw err;
    }
    if (state !== "open" && state !== "closed") why.set(b, `state: ${printable(state)}`);
    return state;
  });
  if (report.error) return cannot(report.error);
  if (report.unreadable.length) {
    const named = report.unreadable.map((b) => `#${b} not found or unreadable${why.get(b) ? ` (${why.get(b)})` : ""}`);
    return cannot(named.join(", "));
  }
  if (report.open.length) return { code: 1, message: `#${n}: blocked by ${report.open.map((b) => `#${b} (open)`).join(", ")}` };
  return { code: 0, message: `#${n}: no open blockers` };
}

const gh = (args) => execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { code, message } = main(process.argv.slice(2));
  console.log(message);
  process.exitCode = code;
}
