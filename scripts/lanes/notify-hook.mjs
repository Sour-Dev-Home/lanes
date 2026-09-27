// Notification hook: a desktop notification when a background lane stops at a prompt, or finishes with its PR
// waiting on the owner or failing. A lane stuck on a permission prompt cannot run a tool, so the harness runs this.
// Usage (from .claude/settings.json): node scripts/lanes/notify-hook.mjs < hook-input.json
// The notification carries only the issue or PR number, the kind of stop, the short session id and the harness's own
// message. Any failure exits 0, prints nothing and appends one line to .lanes/notify-hook.log.
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { GATE_CONTEXT } from "./lib.mjs";

const MAX_BODY = 199;
const GH_BUDGET_MS = 5000;
const NOTIFIER_TIMEOUT_MS = 10_000;
const TITLE = "lanes";
const LANE_DIR_RE = /[\\/]\.claude[\\/]worktrees[\\/](issue-([1-9]\d*)-[^\\/]+)/;
const SESSION_RE = /^[A-Za-z0-9-]{8,}$/;
const FAILED = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"]);
const OWNER_WAIT_RE = /^waiting on owner \(\/approve\)(?: \((.*)\))?$/;

/** The issue number of the lane worktree `cwd` sits in (`.claude/worktrees/issue-<N>-…`), or null. */
export function laneIssue(cwd) {
  const m = typeof cwd === "string" ? LANE_DIR_RE.exec(cwd) : null;
  return m ? Number(m[2]) : null;
}

const clean = (s) => (typeof s === "string" ? s.replace(/[\s\p{Cc}]+/gu, " ").trim() : "");

// `prefix + text + suffix`, with `text` cut (ending in …) so the whole stays within MAX_BODY characters.
function fit(prefix, text, suffix = "") {
  const room = MAX_BODY - prefix.length - suffix.length;
  return prefix + (text.length > room ? `${text.slice(0, room - 1)}…` : text) + suffix;
}

function stopNotification(issue, input) {
  const generic = input.notification_type === "permission_prompt" ? "waiting on a permission prompt" : "needs input";
  const sid = typeof input.session_id === "string" && SESSION_RE.test(input.session_id) ? input.session_id.slice(0, 8) : null;
  return { title: TITLE, body: fit(`lanes #${issue}: `, clean(input.message) || generic, sid ? ` — claude attach ${sid}` : "") };
}

function completedNotification(issue, lookup) {
  if (!lookup || lookup.error) return { title: TITLE, body: `lanes #${issue}: lane finished, check /status` };
  const { pr, gate } = lookup;
  if (!pr || pr.state !== "OPEN") return null;
  const prefix = `lanes #${pr.number}: `;
  const failing = (pr.statusCheckRollup ?? [])
    .filter((c) => c.context !== GATE_CONTEXT && c.name !== GATE_CONTEXT && (FAILED.has(c.conclusion) || FAILED.has(c.state)))
    .map((c) => clean(c.name ?? c.context));
  const gateState = String(gate?.state ?? "").toLowerCase();
  if (gateState === "failure" || gateState === "error") failing.push(GATE_CONTEXT);
  if (failing.length) return { title: TITLE, body: fit(`${prefix}failing: `, failing.join(", ")) };
  const wait = gateState === "pending" ? OWNER_WAIT_RE.exec(clean(gate.description)) : null;
  if (wait) return { title: TITLE, body: fit(`${prefix}waiting on /approve: `, wait[1] || `see #${pr.number}`) };
  return null; // queued, approved, unattended-eligible, or still waiting on reviews
}

/**
 * The `{ title, body }` to show for a Notification hook `input`, or null when `cwd` is not a lane worktree or there is
 * nothing to say. For `agent_completed`, `lookup` is what lookupPr found (`{ pr, gate }`), or `{ error: true }`.
 */
export function notification(input, lookup) {
  if (!input || typeof input !== "object") return null;
  const issue = laneIssue(input.cwd);
  if (issue === null) return null;
  return input.notification_type === "agent_completed" ? completedNotification(issue, lookup) : stopNotification(issue, input);
}

/**
 * The lane's PR (newest for its branch, any state) and the `lanes/gate` status on its head. `exec` is execFileSync's
 * shape; every call shares one GH_BUDGET_MS budget from `start`, and a call past it throws.
 */
export function lookupPr(cwd, exec, start, now = Date.now) {
  const remaining = () => {
    const ms = start + GH_BUDGET_MS - now();
    if (ms <= 0) throw new Error("gh took longer than 5 seconds");
    return ms;
  };
  const run = (file, args) => exec(file, args, { cwd, encoding: "utf8", timeout: remaining(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let branch = "";
  try {
    branch = String(run("git", ["branch", "--show-current"])).trim();
  } catch {
    // Not fatal: lanes name their branch after the worktree directory.
  }
  branch ||= LANE_DIR_RE.exec(cwd)[1];
  const [pr = null] = JSON.parse(run("gh", ["pr", "list", "--head", branch, "--state", "all", "--limit", "1", "--json", "number,state,headRefOid,statusCheckRollup"]));
  if (!pr || pr.state !== "OPEN") return { pr, gate: null };
  if (!/^[0-9a-f]{7,40}$/i.test(pr.headRefOid ?? "")) throw new Error("PR head is not a commit sha");
  const { statuses = [] } = JSON.parse(run("gh", ["api", `repos/{owner}/{repo}/commits/${pr.headRefOid}/status`]));
  return { pr, gate: statuses.find((s) => s.context === GATE_CONTEXT) ?? null };
}

// A fixed script: the text arrives in $env:LANES_NOTIFY_TITLE and $env:LANES_NOTIFY_BODY and is added as XML text
// nodes, so it is never parsed as PowerShell or as XML. The app id is Windows PowerShell's own, which every
// Windows 10/11 install registers for toasts.
const WINDOWS_TOAST = [
  "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null",
  "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null",
  "$x = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
  "$t = $x.GetElementsByTagName('text')",
  "$t.Item(0).AppendChild($x.CreateTextNode($env:LANES_NOTIFY_TITLE)) > $null",
  "$t.Item(1).AppendChild($x.CreateTextNode($env:LANES_NOTIFY_BODY)) > $null",
  "$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'",
  "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($x))",
].join("\n");

/**
 * The notifier for `platform`: `{ file, args, env }` for execFileSync with no shell. The text travels in `env`; on
 * Linux notify-send cannot read it from there, so it is also the last two arguments, after `--`.
 */
export function deliveryCommand(platform, { title = "", body = "" } = {}) {
  const env = { LANES_NOTIFY_TITLE: title, LANES_NOTIFY_BODY: body };
  if (platform === "win32") {
    const encoded = Buffer.from(WINDOWS_TOAST, "utf16le").toString("base64");
    return { file: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], env };
  }
  if (platform === "darwin") {
    return { file: "osascript", args: ["-e", 'display notification (system attribute "LANES_NOTIFY_BODY") with title (system attribute "LANES_NOTIFY_TITLE")'], env };
  }
  if (platform === "linux") return { file: "notify-send", args: ["--app-name=lanes", "--", title, body], env };
  throw new Error(`no desktop notifier for platform ${platform}`);
}

/** One hook call. `raw` is the hook's stdin; errors go to `log` as one line and never escape. */
export function runHook(raw, { platform = process.platform, exec = execFileSync, log, now = Date.now } = {}) {
  try {
    const input = JSON.parse(raw);
    let lookup;
    if (input?.notification_type === "agent_completed" && laneIssue(input.cwd) !== null) {
      try {
        lookup = lookupPr(input.cwd, exec, now(), now);
      } catch {
        lookup = { error: true };
      }
    }
    const n = notification(input, lookup);
    if (!n) return;
    const d = deliveryCommand(platform, n);
    exec(d.file, d.args, { env: { ...process.env, ...d.env }, stdio: "ignore", timeout: NOTIFIER_TIMEOUT_MS, windowsHide: true });
  } catch (error) {
    log(clean(String(error?.message ?? error)).slice(0, 300));
  }
}

function appendLog(line) {
  try {
    const dir = process.env.LANES_NOTIFY_LOG_DIR || fileURLToPath(new URL("../../.lanes/", import.meta.url));
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "notify-hook.log"), `${new Date().toISOString()} ${line}\n`);
  } catch {
    // Nowhere left to report to; the hook still exits 0.
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let raw = "";
  try {
    raw = readFileSync(0, "utf8");
  } catch {
    // An unreadable stdin reads as empty, which runHook logs as bad JSON.
  }
  runHook(raw, { log: appendLog });
}
