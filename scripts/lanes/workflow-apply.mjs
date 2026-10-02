// scripts/lanes/workflow-apply.mjs
// ADR 0029 parts 4 to 6: the logic behind the one-click workflow hand-over. The `lanes-workflow-apply` workflow runs it from
// the default branch, never from a PR head.
//   filter: decides whether a comment starts an approval at all (no environment, no token).
//   apply:  after the owner's "Approve and deploy", checks everything first and then commits exactly the reviewed workflow
//           files through the Git Data API with the lanes-workflows installation token. Any failed check writes nothing.
// Usage: node scripts/lanes/workflow-apply.mjs filter|apply
//   filter env: COMMENT_BODY, COMMENT_LOGIN, COMMENT_TYPE, IS_PR ("true" on a PR), LANES_REPO, LANES_PR; writes go=true|false
//     and head=<sha> to $GITHUB_OUTPUT. Exit 0 whatever the answer, 2 on unusable input.
//   apply env: LANES_REPO, LANES_PR, LANES_COMMENT_ID, LANES_HEAD_SHA (the head the filter saw), LANES_WORKFLOWS_TOKEN.
//     Exit 0 committed, 1 refused (the reason is printed, nothing was written), 2 unusable input.
// The token is read once, never printed, and scrubbed from every line the script prints.
// Two checks are stricter or narrower than ADR 0029 part 5 words them: any edit of the comment refuses (the lane bot
// never edits a hand-over), and "the head has not moved since the comment" compares the head with the one the filter
// job read when the comment arrived; the verdicts' SHA match and the non-forced ref update close the gap after that.
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { REVIEWERS, isLaneBot, parseIdentity, parsePending, parseVerdictComment, pendingFileHash } from "./lib.mjs";

// The hand-over comment (handover.mjs) starts with this heading; the filter and the newest-hand-over check match on it.
export const HANDOVER_MARKER = "### Workflow change";
const PATH_PATTERN = /^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const SAFE_REF = /^[A-Za-z0-9._\/-]+$/;
const MAX_COMMENT_PAGES = 10;

const startsWithMarker = (body) => typeof body === "string" && body.startsWith(HANDOVER_MARKER);

/**
 * Whether a comment starts an approval: it is on a PR, its author is the lane bot (ADR 0020) and its body starts with the
 * hand-over marker. `comment` is `{ body, author: { login, type? } }`. Pure; `reason` says why not.
 * @returns {{ go: boolean, reason: string }}
 */
export function filterDecision({ comment, isPr, identity } = {}) {
  if (isPr !== true) return { go: false, reason: "the comment is not on a pull request" };
  if (!comment || typeof comment !== "object") return { go: false, reason: "no comment" };
  if (!isLaneBot(identity, comment.author)) return { go: false, reason: "the comment is not by the lane bot" };
  if (!startsWithMarker(comment.body)) return { go: false, reason: "the comment is not a workflow hand-over" };
  return { go: true, reason: "a lane hand-over comment" };
}

/**
 * The files of a hand-over comment: each `#### \`path\`` heading followed by a fenced block. The fence is the one
 * handover.mjs wrote, longer than any backtick run inside, so the block ends at the first line that is exactly the fence.
 * @returns {{ files: { path: string, text: string }[] } | { error: string }}
 */
export function parseHandoverFiles(body) {
  if (!startsWithMarker(body)) return { error: "the comment is not a workflow hand-over" };
  const lines = body.split(/\r?\n/);
  const files = [];
  let path = null;
  for (let i = 0; i < lines.length; i++) {
    const heading = lines[i].match(/^#### `([^`]+)`/);
    if (heading) {
      if (path !== null) return { error: `no fenced content for ${path}` };
      path = heading[1];
      continue;
    }
    const open = lines[i].match(/^(`{3,})yaml$/);
    if (open && path !== null) {
      const fence = open[1];
      const end = lines.indexOf(fence, i + 1);
      if (end === -1) return { error: `the fenced content for ${path} is not closed` };
      if (files.some((f) => f.path === path)) return { error: `${path} appears twice` };
      files.push({ path, text: lines.slice(i + 1, end).join("\n") });
      path = null;
      i = end;
    }
  }
  if (path !== null) return { error: `no fenced content for ${path}` };
  if (files.length === 0) return { error: "the comment holds no files" };
  return { files };
}

// The bytes the gate hashed and the commit writes (pendingFileHash's normalisation, ADR 0023 part 3).
const normalised = (text) => `${text.replaceAll("\r\n", "\n").replace(/\n+$/, "")}\n`;

// The repo, as GraphQL or REST names it, compared the way GitHub does.
const sameRepo = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

const olderThan = (a, b) => (a.createdAt === b.createdAt ? Number(a.id) < Number(b.id) : a.createdAt < b.createdAt);

/**
 * ADR 0029 part 5, every check before any write. Inputs (all plain data read by `main`):
 * `comment` { id, author, body, lastEditedAt }; `comments` every comment on the PR as { id, author, body, createdAt };
 * `pr` { state, headRepo, baseRepo, headSha, headRef }; `headShaAtFilter` the head the filter job saw; `identity`.
 * `comments` also carries the verdict comments (their `author` must be the lane bot). Pure.
 * @returns {{ ok: true, files: { path: string, content: string }[], headSha: string, headRef: string } | { ok: false, reason: string }}
 */
export function applyChecks({ comment, comments, pr, headShaAtFilter, identity, reviewerNames = REVIEWERS } = {}) {
  const no = (reason) => ({ ok: false, reason });
  // 1. The comment.
  if (!comment || typeof comment !== "object" || !Array.isArray(comments) || !pr || typeof pr !== "object") return no("the inputs are incomplete");
  if (!isLaneBot(identity, comment.author)) return no("the comment is not by the lane bot");
  if (!startsWithMarker(comment.body)) return no("the comment is not a workflow hand-over");
  if (comment.lastEditedAt !== null && comment.lastEditedAt !== undefined) return no("the comment was edited");
  const handovers = comments.filter((c) => isLaneBot(identity, c.author) && startsWithMarker(c.body));
  const self = handovers.find((c) => String(c.id) === String(comment.id));
  if (!self) return no("the comment is not among the PR's comments");
  if (handovers.some((c) => c !== self && olderThan(self, c))) return no("a newer hand-over comment exists on the PR");
  // 2. The PR.
  if (String(pr.state).toLowerCase() !== "open") return no("the pull request is not open");
  if (!sameRepo(pr.headRepo, pr.baseRepo)) return no("the pull request head is not in this repository");
  if (typeof pr.headSha !== "string" || !SHA_RE.test(pr.headSha)) return no("the pull request head could not be read");
  if (typeof pr.headRef !== "string" || !SAFE_REF.test(pr.headRef) || pr.headRef.split("/").includes("..") || pr.headRef.startsWith("-")) {
    return no("the pull request branch is not a plain name");
  }
  if (pr.headSha !== headShaAtFilter) return no("the pull request head moved since the hand-over comment");
  // 3. The files.
  const parsed = parseHandoverFiles(comment.body);
  if (parsed.error) return no(parsed.error);
  const bad = parsed.files.find((f) => !PATH_PATTERN.test(f.path));
  if (bad) return no(`${bad.path} is outside .github/workflows/*.yml or *.yaml`);
  const recorded = new Map(); // path -> sha256 across the trusted verdicts for this head
  let sawPending = false;
  for (const c of comments) {
    if (!isLaneBot(identity, c.author)) continue;
    const v = parseVerdictComment(c.body, reviewerNames);
    if (!v || v.sha !== pr.headSha) continue;
    const pending = parsePending(v.verdict);
    if (!pending) continue;
    sawPending = true;
    for (const { path, sha256 } of pending) {
      if (recorded.has(path) && recorded.get(path) !== sha256) return no(`two verdicts record different hashes for ${path}`);
      recorded.set(path, sha256);
    }
  }
  if (!sawPending) return no("no verdict for this head records the pending files");
  const commentPaths = new Set(parsed.files.map((f) => f.path));
  const missing = [...recorded.keys()].filter((p) => !commentPaths.has(p));
  const extra = [...commentPaths].filter((p) => !recorded.has(p));
  if (missing.length || extra.length) {
    return no(`the comment's files differ from the verdicts' pending files (${[...extra.map((p) => `+${p}`), ...missing.map((p) => `-${p}`)].join(", ")})`);
  }
  for (const f of parsed.files) {
    if (pendingFileHash(f.text) !== recorded.get(f.path)) return no(`the hash of ${f.path} differs from the one the reviewers recorded`);
  }
  return { ok: true, files: parsed.files.map((f) => ({ path: f.path, content: normalised(f.text) })), headSha: pr.headSha, headRef: pr.headRef };
}

class Refusal extends Error {}

/**
 * The commit through the Git Data API: blobs, tree on the head's tree, one commit whose parent is the head, then a
 * non-forced ref update. `api(method, path, body)` returns `{ status, json }`. A moved head makes the update fail (422).
 */
async function commitFiles({ api, repo, checked, pr }) {
  const call = async (method, path, body, what) => {
    const res = await api(method, `/repos/${repo}${path}`, body);
    if (!res || res.status < 200 || res.status >= 300) throw new Refusal(`${what} failed (HTTP ${res?.status ?? "none"})`);
    return res;
  };
  const head = await call("GET", `/git/commits/${checked.headSha}`, undefined, "reading the head commit");
  const baseTree = head.json?.tree?.sha;
  if (typeof baseTree !== "string") throw new Refusal("the head commit has no tree");
  const tree = [];
  for (const f of checked.files) {
    const blob = await call("POST", "/git/blobs", { content: f.content, encoding: "utf-8" }, `creating the blob for ${f.path}`);
    tree.push({ path: f.path, mode: "100644", type: "blob", sha: blob.json?.sha });
  }
  const made = await call("POST", "/git/trees", { base_tree: baseTree, tree }, "creating the tree");
  const commit = await call(
    "POST",
    "/git/commits",
    { message: `apply reviewed workflow changes (#${pr})\n\nCommitted by lanes-workflow-apply after the owner's approval (ADR 0029).`, tree: made.json?.sha, parents: [checked.headSha] },
    "creating the commit",
  );
  const ref = checked.headRef.split("/").map(encodeURIComponent).join("/");
  const res = await api("PATCH", `/repos/${repo}/git/refs/heads/${ref}`, { sha: commit.json?.sha, force: false });
  if (res?.status === 409 || res?.status === 422) throw new Refusal("the branch moved while applying, nothing was changed");
  if (!res || res.status < 200 || res.status >= 300) throw new Refusal(`updating the branch failed (HTTP ${res?.status ?? "none"})`);
  return commit.json.sha;
}

const PR_QUERY = `query($owner:String!,$name:String!,$number:Int!,$before:String){repository(owner:$owner,name:$name){pullRequest(number:$number){
state headRefName headRefOid headRepository{nameWithOwner} baseRepository{nameWithOwner}
comments(last:100,before:$before){pageInfo{hasPreviousPage startCursor} nodes{databaseId body createdAt lastEditedAt author{login __typename}}}}}}`;

// GraphQL names a Bot without the `[bot]` suffix that REST and isLaneBot use.
const authorOf = (a) => (a ? { login: a.__typename === "Bot" && !a.login.endsWith("[bot]") ? `${a.login}[bot]` : a.login, type: a.__typename } : null);

async function readPr(graphql, repo, number) {
  const [owner, name] = repo.split("/");
  let pr = null;
  const comments = [];
  let before = null;
  for (let page = 0; page < MAX_COMMENT_PAGES; page++) {
    const data = await graphql(PR_QUERY, { owner, name, number, before });
    const p = data?.repository?.pullRequest;
    if (!p) throw new Refusal("the pull request could not be read");
    pr ??= { state: p.state, headRepo: p.headRepository?.nameWithOwner ?? null, baseRepo: p.baseRepository?.nameWithOwner ?? null, headSha: p.headRefOid, headRef: p.headRefName };
    for (const n of p.comments.nodes) {
      comments.push({ id: n.databaseId, body: n.body, createdAt: n.createdAt, lastEditedAt: n.lastEditedAt, author: authorOf(n.author) });
    }
    if (!p.comments.pageInfo.hasPreviousPage) return { pr, comments };
    before = p.comments.pageInfo.startCursor;
  }
  throw new Refusal("the pull request has too many comments to check");
}

const scrub = (text, token) => (token ? String(text).split(token).join("***") : String(text));

/**
 * `argv` is `["filter"]` or `["apply"]`. `deps`: `env`, `readConfig()`, `api(method, path, body)`, `graphql(query, vars)`
 * and `token` (apply only; scrubbed from every printed line). Never throws; returns `{ code, lines, outputs }`.
 */
export async function main(argv, deps) {
  const { env = {}, token = "" } = deps;
  const done = (code, lines, outputs = {}) => ({ code, lines: lines.map((l) => scrub(l, token)), outputs });
  const usage = (why) => done(2, [why]);
  try {
    if (argv.length !== 1 || !["filter", "apply"].includes(argv[0])) return usage("usage: node scripts/lanes/workflow-apply.mjs filter|apply");
    let identity;
    try {
      identity = parseIdentity(JSON.parse(deps.readConfig()).identity);
    } catch {
      return usage("lanes.config.json unreadable or its identity invalid");
    }
    const repo = env.LANES_REPO;
    const pr = env.LANES_PR;
    if (!REPO_RE.test(repo ?? "") || !/^[1-9]\d{0,8}$/.test(pr ?? "")) return usage("LANES_REPO or LANES_PR is missing or malformed");

    if (argv[0] === "filter") {
      const decision = filterDecision({ comment: { body: env.COMMENT_BODY, author: { login: env.COMMENT_LOGIN, type: env.COMMENT_TYPE || undefined } }, isPr: env.IS_PR === "true", identity });
      if (!decision.go) return done(0, [`go=false: ${decision.reason}`], { go: "false" });
      const res = await deps.api("GET", `/repos/${repo}/pulls/${pr}`);
      const head = res?.json?.head?.sha;
      if (!res || res.status !== 200 || typeof head !== "string" || !SHA_RE.test(head)) return done(0, ["go=false: the pull request head could not be read"], { go: "false" });
      return done(0, [`go=true: ${decision.reason}`], { go: "true", head });
    }

    const headAtFilter = env.LANES_HEAD_SHA;
    if (!SHA_RE.test(headAtFilter ?? "") || !/^[1-9]\d{0,17}$/.test(env.LANES_COMMENT_ID ?? "") || !token) return usage("LANES_HEAD_SHA, LANES_COMMENT_ID or the token is missing or malformed");
    const { pr: prData, comments } = await readPr(deps.graphql, repo, Number(pr));
    const comment = comments.find((c) => String(c.id) === env.LANES_COMMENT_ID);
    if (!comment) throw new Refusal("the approved comment is no longer on the pull request");
    const checked = applyChecks({ comment, comments, pr: prData, headShaAtFilter: headAtFilter, identity });
    if (!checked.ok) throw new Refusal(checked.reason);
    const sha = await commitFiles({ api: deps.api, repo, checked, pr });
    return done(0, [`committed ${checked.files.map((f) => f.path).join(", ")} as ${sha} on ${checked.headRef}`]);
  } catch (err) {
    if (err instanceof Refusal) return done(1, [`refused: ${err.message}`]);
    return done(2, [`workflow-apply failed: ${err?.message ?? "unknown error"}`]);
  }
}

function realDeps(env) {
  const token = env.LANES_WORKFLOWS_TOKEN ?? "";
  const call = async (path, init) => fetch(`https://api.github.com${path}`, { ...init, headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...(token || env.GITHUB_TOKEN ? { Authorization: `Bearer ${token || env.GITHUB_TOKEN}` } : {}), ...init?.headers } });
  return {
    env,
    token,
    readConfig: () => readFileSync("lanes.config.json", "utf8"),
    api: async (method, path, body) => {
      const res = await call(path, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: body === undefined ? {} : { "Content-Type": "application/json" } });
      return { status: res.status, json: await res.json().catch(() => null) };
    },
    graphql: async (query, variables) => {
      const res = await call("/graphql", { method: "POST", body: JSON.stringify({ query, variables }), headers: { "Content-Type": "application/json" } });
      const json = await res.json().catch(() => null);
      if (!res.ok || json?.errors) throw new Error(`GraphQL request failed (HTTP ${res.status})`);
      return json.data;
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const deps = realDeps(process.env);
  const result = await main(process.argv.slice(2), deps);
  for (const line of result.lines) console.log(line);
  if (process.env.GITHUB_OUTPUT) for (const [k, v] of Object.entries(result.outputs)) appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`);
  process.exitCode = result.code;
}
