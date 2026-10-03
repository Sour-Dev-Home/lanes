// The pause and resume buttons (ADR 0028): run by .github/workflows/lanes-control.yml. It writes one comment, starting
// `<!-- lanes:control -->`, on the lanes-health issue, holding `{ paused, since, by, reason }`, and touches nothing else.
// Usage: LANES_ACTION=pause|resume LANES_REASON=<text> LANES_ACTOR=<login> node scripts/lanes/control.mjs
//   (reads and writes GitHub through gh; GH_TOKEN and GITHUB_REPOSITORY come from the workflow)
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CONTROL_MARKER, HEALTH_ISSUE_LABEL, controlText } from "./lib.mjs";

export const REASON_LIMIT = 200;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}|[A-Za-z0-9-]*\[bot\])$/;
const isActionsBot = (u) => u?.login === "github-actions[bot]" && u?.type === "Bot";

export function controlBody({ paused, since, by, reason }) {
  return `${CONTROL_MARKER}\n\`\`\`json\n${JSON.stringify({ paused, since, by, reason })}\n\`\`\`\n`;
}

/** The state to write from the workflow's inputs; throws on an unknown action or a reason over the limit. */
export function nextState({ action, reason, actor }, now) {
  if (action !== "pause" && action !== "resume") throw new Error(`action must be pause or resume, not ${controlText(action, 20) || "empty"}`);
  const raw = String(reason ?? "");
  if (raw.length > REASON_LIMIT) throw new Error(`reason is ${raw.length} characters, over the ${REASON_LIMIT} limit`);
  return { paused: action === "pause", since: new Date(now).toISOString(), by: LOGIN.test(String(actor ?? "")) ? actor : "unknown", reason: controlText(raw, REASON_LIMIT) };
}

/**
 * `api(args)` takes `gh api` arguments and returns the reply text. Finds the lanes-health issue as health.mjs does (the
 * lowest-numbered open one, else the lowest-numbered in any state), creating it after its label when there is none; then
 * edits the lowest-numbered control comment github-actions[bot] wrote, or creates one. Returns `{ number, created }`.
 */
export function run({ api, repo, env, now = Date.now() }) {
  const state = nextState({ action: env.LANES_ACTION, reason: env.LANES_REASON, actor: env.LANES_ACTOR }, now);
  const json = (args) => JSON.parse(api(args));
  const issues = json(["--method", "GET", `repos/${repo}/issues`, "-f", `labels=${HEALTH_ISSUE_LABEL}`, "-f", "state=all", "-f", "per_page=100", "-f", "sort=created", "-f", "direction=asc"]).filter((i) => !i.pull_request && Number.isInteger(i.number)).sort((a, b) => a.number - b.number);
  let issue = issues.find((i) => i.state === "open") ?? issues[0];
  if (!issue) {
    try {
      api([`repos/${repo}/labels`, "-f", `name=${HEALTH_ISSUE_LABEL}`, "-f", "color=d93f0b", "-f", "description=The lanes health inbox"]);
    } catch (e) {
      if (!/already_exists|422/.test(String(e?.stderr ?? e?.message ?? e))) throw e;
    }
    issue = json([`repos/${repo}/issues`, "-f", "title=lanes health", "-f", `labels[]=${HEALTH_ISSUE_LABEL}`, "-f", `body=<!-- lanes:health {"open":[]} -->\n\n**Status:** healthy`]);
  }
  const comments = json(["--paginate", "--slurp", `repos/${repo}/issues/${issue.number}/comments?per_page=100`]).flat();
  const mine = comments.filter((c) => typeof c?.body === "string" && c.body.startsWith(CONTROL_MARKER) && isActionsBot(c.user)).sort((a, b) => a.id - b.id)[0];
  const body = controlBody(state);
  if (mine) api(["-X", "PATCH", `repos/${repo}/issues/comments/${Number(mine.id)}`, "-f", `body=${body}`]);
  else api([`repos/${repo}/issues/${issue.number}/comments`, "-f", `body=${body}`]);
  return { number: issue.number, created: !mine, state };
}

const gh = (args) => execFileSync("gh", ["api", ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 120_000, windowsHide: true });

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const repo = process.env.GITHUB_REPOSITORY;
    if (!repo) throw new Error("GITHUB_REPOSITORY is not set");
    const r = run({ api: gh, repo, env: process.env });
    console.log(`control: ${r.state.paused ? "paused" : "resumed"} by ${r.state.by} on issue #${r.number}`);
  } catch (err) {
    console.error(`control: ${String(err?.message ?? err).split("\n")[0]}`);
    process.exitCode = 1;
  }
}
