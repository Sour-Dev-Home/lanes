// scripts/lanes/handover.mjs
// #595 (ADR 0023 part 2): a team lane cannot push `.github/workflows/` (the App has no `workflows` permission), so it
// hands each workflow file to the owner in one PR comment: the full content, a link to GitHub's web editor on the PR
// branch, and a read-before-commit warning. This is the one fixed command that posts that comment, so the lane never
// writes a free-text `gh pr comment` carrying workflow files.
// ADR 0029 part 7: with the `lanes-workflow-apply` environment holding a required reviewer (read with the lane's token),
// the comment asks the owner to press "Approve and deploy"; otherwise, or when the read fails, it is the copy-paste text.
// Usage: node scripts/lanes/handover.mjs <pr>
// Run it after the lane pushed `HEAD~1` and opened the PR. Exit 0: posted. 1: refused.
// 2: usage or an unreadable input. It prints each file's `pendingFileHash` as one `pending: [...]` JSON line for the
// verdicts' `pending` field, and never a token.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseIdentity, pendingFileHash } from "./lib.mjs";

const DIR = ".github/workflows/";
const SAFE_PATH = /^[A-Za-z0-9._\/-]+$/;
const SAFE_BRANCH = /^[A-Za-z0-9._\/-]+$/;
// GitHub rejects a comment body over 65536 characters.
const MAX_COMMENT = 60000;

// Characters that make displayed text differ from copied text: C0 and C1 controls except tab, LF and CR, bidi controls
// (U+061C, U+200E/F, U+202A-E, U+2066-9), zero-width and invisible format characters (U+00AD, U+034F, U+180E,
// U+200B-D, U+2060-206F, U+FEFF), Hangul fillers, variation selectors, interlinear annotation, Unicode tag characters
// (U+E0000-E007F, used to hide text) and the line and paragraph separators (U+2028/9).
const HIDDEN_RANGES = [[0x00, 0x08], [0x0b, 0x0c], [0x0e, 0x1f], [0x7f, 0x9f], [0xad, 0xad], [0x34f, 0x34f], [0x61c, 0x61c], [0x115f, 0x1160], [0x180e, 0x180e], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x206f], [0x3164, 0x3164], [0xfe00, 0xfe0f], [0xfeff, 0xfeff], [0xffa0, 0xffa0], [0xfff9, 0xfffb], [0xe0000, 0xe007f], [0xe0100, 0xe01ef]];
const hex = (n) => "\\u{" + n.toString(16) + "}";
const HIDDEN = new RegExp(`[${HIDDEN_RANGES.map(([a, b]) => hex(a) + "-" + hex(b)).join("")}]`, "u");

class Refusal extends Error {}
const refuse = (why) => new Refusal(why);

const WARNING =
  "**Read each file before you click Commit changes.** Committing a workflow file to this branch runs any push-triggered workflow in it, " +
  "with the permissions the file asks for, before anyone has reviewed it further. If the content below is not what you expect, do not commit it.";

const fenceFor = (text) => "`".repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)));
const encodePath = (p) => p.split("/").map(encodeURIComponent).join("/");

/**
 * The comment body for the pending files: `files` is `[{ path, status: "A" | "M", text }]`. Pure.
 * Each file gets its full content in a fenced block (the fence is longer than any backtick run inside) and the web
 * editor link on `branch`: `edit/<branch>/<path>` for an existing file, `new/<branch>?filename=<path>` for a new one.
 */
export function handoverComment({ repo, branch, files, mode = "copy-paste" }) {
  const base = `https://github.com/${repo}`;
  const oneClick = mode === "one-click";
  // Both headings start with the marker `workflow-apply.mjs` matches (ADR 0029 part 4).
  const parts = oneClick
    ? [
        "### Workflow change to approve and deploy",
        "",
        "This lane cannot push `.github/workflows/` files (ADR 0023). Its reviewers reviewed this content. Open the `lanes-workflow-apply` run for this comment " +
          `(${base}/actions/workflows/lanes-workflow-apply.yml) and press **Approve and deploy**: it commits exactly the files below to this PR's branch (ADR 0029). ` +
          "It refuses, with the reason, if this comment was edited, a newer hand-over exists or the branch moved.",
        "",
        "Read each file below before you approve. Committing a workflow file to this branch runs any push-triggered workflow in it, with the permissions the file asks for.",
      ]
    : [
        "### Workflow change to commit in GitHub's web editor",
        "",
        "This lane cannot push `.github/workflows/` files (ADR 0023). Its reviewers reviewed this content. Commit each file to this PR's branch in the browser.",
        "",
        WARNING,
      ];
  for (const f of files) {
    const fence = fenceFor(f.text);
    parts.push("", `#### \`${f.path}\` (${f.status === "A" ? "new file" : "changed file"})`, "");
    if (!oneClick) {
      const link = f.status === "A" ? `${base}/new/${encodePath(branch)}?filename=${encodePath(f.path)}` : `${base}/edit/${encodePath(branch)}/${encodePath(f.path)}`;
      parts.push(`${f.status === "A" ? "Create" : "Edit"} it here: ${link}`, "");
    }
    parts.push(`${fence}yaml`, f.text.replace(/\n+$/, ""), fence);
  }
  return `${parts.join("\n")}\n`;
}

const ENVIRONMENT = "lanes-workflow-apply";

/**
 * ADR 0029 part 7: "one-click" only when the lane's read of the environment shows a required reviewer. A missing
 * environment, no reviewer, an unparsable answer or a failed read is "copy-paste", today's flow.
 */
export function handoverMode(deps, repo) {
  try {
    const env = JSON.parse(deps.gh(["api", `repos/${repo}/environments/${ENVIRONMENT}`]));
    const rules = Array.isArray(env?.protection_rules) ? env.protection_rules : [];
    return rules.some((r) => r?.type === "required_reviewers" && Array.isArray(r.reviewers) && r.reviewers.length > 0) ? "one-click" : "copy-paste";
  } catch {
    return "copy-paste";
  }
}

/**
 * Posts the hand-over comment for PR `pr`. `deps`: `readConfig()`, `git(args)` (a Buffer or string), `gh(args)` (text)
 * and `comment(pr, body)`. Returns `{ code, lines }`; never throws for an expected refusal.
 */
export function handover(argv, deps) {
  if (argv.length !== 1 || !/^[1-9]\d{0,8}$/.test(argv[0])) return { code: 2, lines: ["usage: node scripts/lanes/handover.mjs <pr number>"] };
  const pr = argv[0];
  try {
    try {
      parseIdentity(JSON.parse(deps.readConfig()).identity);
    } catch (err) {
      return { code: 2, lines: [err?.teamRequired ? err.message : "lanes.config.json unreadable or its identity invalid"] };
    }

    const text = (out) => String(out).trim();
    const repo = text(deps.gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]));
    if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) throw refuse("the repository name could not be read");
    const view = JSON.parse(deps.gh(["pr", "view", pr, "--json", "headRefName,headRefOid"]));
    const branch = view.headRefName;
    if (typeof branch !== "string" || !SAFE_BRANCH.test(branch) || branch.split("/").includes("..") || branch.startsWith("-")) throw refuse("the PR branch name is not a plain name");
    if (!/^[0-9a-f]{40}$/.test(String(view.headRefOid))) throw refuse("the PR head could not be read");

    // The pushed head must be the commit before the final local one: nothing else may sit between them.
    if (text(deps.git(["rev-parse", "HEAD~1"])) !== view.headRefOid) throw refuse(`HEAD~1 is not the PR's head on GitHub (#${pr}): push HEAD~1 first`);

    const entries = String(deps.git(["diff", "--name-status", "--no-renames", "-z", "HEAD~1", "HEAD"])).split("\0").filter(Boolean);
    if (entries.length === 0 || entries.length % 2) throw refuse("HEAD changes no file, or its diff could not be read");
    const changes = [];
    for (let i = 0; i < entries.length; i += 2) changes.push({ status: entries[i], path: entries[i + 1] });
    const outside = changes.filter((c) => !c.path.startsWith(DIR));
    if (outside.length) throw refuse(`HEAD changes ${outside.length} file(s) outside ${DIR}, which the final commit must not: ${outside.map((c) => c.path).slice(0, 3).join(", ")}`);
    const deleted = changes.find((c) => c.status === "D");
    if (deleted) throw refuse(`HEAD deletes ${deleted.path}: a deletion is not handed over this way, ask the owner to delete the file in the browser`);
    const odd = changes.find((c) => (c.status !== "A" && c.status !== "M") || c.path.length === DIR.length || !SAFE_PATH.test(c.path) || c.path.split("/").includes(".."));
    if (odd) throw refuse(`HEAD changes ${odd.path} in a way a hand-over cannot carry (status ${odd.status})`);

    const files = [];
    const pending = [];
    for (const c of changes) {
      // The content is read only from the final local commit, as bytes, so a file that is not UTF-8 is refused.
      const raw = deps.git(["show", `HEAD:${c.path}`], { raw: true });
      const sha256 = pendingFileHash(raw);
      if (!sha256) throw refuse(`${c.path} is empty or not valid UTF-8, so it cannot be handed over`);
      const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
      // The owner reads this text and then copies it: nothing may display differently from what is copied.
      const hidden = HIDDEN.exec(text);
      if (hidden) throw refuse(`${c.path} holds a hidden, bidirectional or control character (U+${hidden[0].codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}), so its displayed text could differ from what is copied`);
      files.push({ path: c.path, status: c.status, text });
      pending.push({ path: c.path, sha256 });
    }
    const mode = handoverMode(deps, repo);
    const body = handoverComment({ repo, branch, files, mode });
    if (body.length > MAX_COMMENT) throw refuse("the workflow files are too large for one PR comment");
    deps.comment(pr, body);
    return { code: 0, lines: [`posted the ${mode} hand-over comment on #${pr} for ${files.length} workflow file(s)`, `pending: ${JSON.stringify(pending)}`] };
  } catch (err) {
    if (err instanceof Refusal) return { code: 1, lines: [`refused: ${err.message}`] };
    return { code: 2, lines: [`hand-over failed: ${err.message.split("\n")[0]}`] };
  }
}

const realDeps = () => ({
  readConfig: () => readFileSync("lanes.config.json", "utf8"),
  git: (args, { raw = false } = {}) => {
    const out = execFileSync("git", args, { maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    return raw ? out : out.toString("utf8");
  },
  gh: (args) => execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
  comment: (pr, body) => execFileSync("gh", ["pr", "comment", pr, "--body-file", "-"], { input: body, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }),
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { code, lines } = handover(process.argv.slice(2), realDeps());
  for (const l of lines) console.log(l);
  process.exitCode = code;
}
