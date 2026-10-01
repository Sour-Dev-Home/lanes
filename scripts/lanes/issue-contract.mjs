// scripts/lanes/issue-contract.mjs
// Checks a task issue against the task contract and sets its labels: tier:<tier> and `ready` when complete.
// Run by .github/workflows/issue-contract.yml. Inputs: REPO, ISSUE_NUMBER, ISSUE_BODY, ISSUE_LABELS_JSON, ISSUE_AUTHOR,
// GH_TOKEN.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { authorCanWrite, classifyFiles, compileConfig, interfacePaths, parseIssueForm, parseSections, parseValidation, readBotIssueRelease, ValidationParseError } from "./lib.mjs";

const MAX_VALIDATE_LINE = 500;

export const MARKER = "<!-- lanes:issue-contract -->";

/**
 * The paths a Scope's "In scope" part names that are not skip-only by the gate's rule (#453), so a tier skip that the
 * gate would fail is caught when the issue is filed. Anything from "Out of scope" or "Out:" on is not claimed.
 */
function nonSkipScopePaths(scope, config) {
  const inPart = scope.split(/(?<![\w-])Out(?: of scope)?:/i)[0].replace(/^[\s\S]*?(?<![\w-])In(?: scope)?:/i, "");
  return interfacePaths(inPart).filter((p) => !classifyFiles([p], config).skipOnly);
}

/**
 * @param {string} body the issue body
 * @param {string[]} labels the issue's current labels
 * @param {boolean} [canWrite] whether the issue author has write, maintain or admin permission; only true trusts
 * @param {object} [config] lanes.config.json's parsed content; without it a tier skip is not checked against the Scope
 */
export function issuePlan(body, labels, canWrite, config) {
  if (!/^### Goal\s*$/m.test(String(body ?? "").replace(/\r\n/g, "\n"))) return { isTask: false, add: [], remove: [], comment: "" };
  const r = parseIssueForm(body);
  // ADR 0012: a `validate:` criterion that will not parse would only fail once a lane is running it.
  r.fields.criteria.forEach((c, i) => {
    try {
      // The line pattern backtracks badly on long whitespace runs, so a hostile body is bounded before it is matched.
      if (c.startsWith("validate:") && c.length > MAX_VALIDATE_LINE) throw new ValidationParseError(`validate: line is longer than ${MAX_VALIDATE_LINE} characters`);
      parseValidation(c);
    } catch (e) {
      if (!(e instanceof ValidationParseError)) throw e;
      // The message can echo the issue author's regex into a public comment: show it as inert code.
      r.errors.push(`acceptance criterion ${i + 1}: \`${e.message.replace(/[`\r\n]/g, " ")}\``);
      r.ok = false;
    }
  });
  const tierLabels = labels.filter((l) => l.startsWith("tier:"));
  const hadReady = labels.includes("ready");
  if (!r.ok) {
    return {
      isTask: true,
      add: [],
      remove: hadReady ? ["ready"] : [],
      comment: `${MARKER}\n**Task contract incomplete**, so this issue is not ready:\n${r.errors.map((e) => `- ${e}`).join("\n")}`,
    };
  }
  if (r.fields.tier === "skip" && config) {
    const bad = nonSkipScopePaths(r.fields.scope, compileConfig(config));
    if (bad.length) {
      return {
        isTask: true,
        add: [],
        remove: hadReady ? ["ready"] : [],
        comment: `${MARKER}\n**Tier skip does not fit this Scope**, so this issue is not ready: the gate fails a skip PR that changes a path outside the skip paths, or one that is sensitive. Set the tier to quick or full for:\n${bad.map((p) => `- \`${p}\``).join("\n")}`,
      };
    }
  }
  const want = `tier:${r.fields.tier}`;
  const laneFiled = labels.includes("lane-filed");
  // C1: an untrusted author's issue never gets `ready`, however complete its contract.
  // I4: a lane's own follow-up (lane-filed) never gets `ready` automatically, even from the owner.
  // #136: a lane that found the criteria already met swapped `ready` for `needs-owner`; re-adding `ready` would undo it.
  const needsOwner = labels.includes("needs-owner");
  if (laneFiled || needsOwner || canWrite !== true) {
    // R2: hand-adding `ready` will not help here — the gate itself rejects an issue not opened by someone with write
    // access, whatever labels it carries — so the real path is a maintainer opening the task themselves.
    const why = laneFiled
      ? "a maintainer must remove the lane-filed label to approve it"
      : needsOwner
        ? "a lane found nothing to build, so a maintainer must close it or rewrite it and remove the needs-owner label"
        : "a maintainer must open this task themselves; adding ready by hand will not help, since a lane also checks the issue's author";
    return {
      isTask: true,
      add: [want],
      remove: [...tierLabels.filter((l) => l !== want), ...(hadReady ? ["ready"] : [])],
      comment: `${MARKER}\nTask contract complete: tier ${r.fields.tier}, ${r.fields.criteria.length} acceptance criteria, but ${why}.`,
    };
  }
  return {
    isTask: true,
    add: [want, "ready"],
    remove: tierLabels.filter((l) => l !== want),
    comment: `${MARKER}\nTask contract complete: tier ${r.fields.tier}, ${r.fields.criteria.length} acceptance criteria.`,
  };
}

/**
 * #11: the "Blocked by" form field is the source of truth; GitHub's native blocked-by relationships mirror it.
 * @param {number[]} wanted blocker numbers from `parseIssueForm(...).fields.blockedBy`
 * @param {{ id: number, number: number | null }[]} current the native blocked-by list; `number` is null for an issue
 *   in another repository, which the form cannot name, so it is always removed
 * @returns {{ add: number[], remove: { id: number, number: number | null }[] }} numbers to link, entries to unlink
 */
export function blockerDiff(wanted = [], current = []) {
  const want = [...new Set(wanted)];
  const have = new Set(current.filter((c) => c.number !== null).map((c) => c.number));
  return { add: want.filter((n) => !have.has(n)), remove: current.filter((c) => c.number === null || !want.includes(c.number)) };
}

/** One line of a failed `gh` call, bounded and with token-like strings masked: it goes into a public comment. */
const reason = (e) =>
  String(e?.stderr || e?.message || e)
    .trim()
    .split("\n")[0]
    .replace(/^gh: /, "")
    .replace(/\b(gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, "$1***")
    .slice(0, 200);

/** At most this many distinct blockers are mirrored, so one issue cannot drive an unbounded number of API calls. */
export const MAX_BLOCKERS = 20;

/** Cross-repository references (`owner/repo#N`) in the "Blocked by" text; the native list is not linked to them. */
const FOREIGN_REF = /([\w.-]+\/[\w.-]+)#(\d+)/g;

/**
 * Makes issue `n`'s native blocked-by list match its "Blocked by" field. Never throws; returns comment lines naming
 * each blocker it could not link or unlink, or the dependencies API failure.
 */
export function mirrorBlockedBy(repo, n, body, run) {
  const r = parseIssueForm(body);
  // Only a field that parses is mirrored: an empty or malformed one must not wipe the native list.
  if (r.errors.some((e) => e === "missing: blocked by" || e.startsWith("blocked by:"))) return [];
  const notes = [];
  // parseIssueForm reads `owner/repo#12` as #12; take one occurrence of each such reference back out, unless
  // `owner/repo` names this repository itself (e.g. pasted from GitHub's autocomplete), which is not foreign.
  const wanted = [...r.fields.blockedBy];
  for (const [ref, ownerRepo, num] of String(parseSections(body, "###")["blocked by"] ?? "").matchAll(FOREIGN_REF)) {
    if (ownerRepo.toLowerCase() === repo.toLowerCase()) continue;
    const i = wanted.indexOf(Number(num));
    if (i !== -1) wanted.splice(i, 1);
    notes.push(`${ref} is in another repository, not linked`);
  }
  if (new Set(wanted).size > MAX_BLOCKERS) return [...notes, `more than ${MAX_BLOCKERS} blockers are listed, so nothing was mirrored`];
  const base = `repos/${repo}/issues/${n}/dependencies/blocked_by`;
  let current;
  try {
    current = run(["api", "--paginate", base, "--jq", ".[] | {id, number, repo: .repository_url}"])
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      // Repository names are case-insensitive on GitHub.
      .map((d) => ({ id: d.id, number: String(d.repo).toLowerCase().endsWith(`/repos/${repo}`.toLowerCase()) ? d.number : null }));
  } catch (e) {
    return [...notes, `the dependencies API failed, so nothing was mirrored: ${reason(e)}`];
  }
  const { add, remove } = blockerDiff(wanted, current);
  for (const num of add) {
    if (String(num) === String(n)) {
      notes.push(`#${num} is this issue itself, not linked`);
      continue;
    }
    let target;
    try {
      target = JSON.parse(run(["api", `repos/${repo}/issues/${num}`, "--jq", "{id, pr: (.pull_request != null)}"]));
    } catch (e) {
      notes.push(`#${num} was not found, not linked: ${reason(e)}`);
      continue;
    }
    if (target.pr) {
      notes.push(`#${num} is a pull request, not linked`);
      continue;
    }
    try {
      run(["api", base, "-X", "POST", "-F", `issue_id=${target.id}`]);
    } catch (e) {
      notes.push(`#${num} could not be linked: ${reason(e)}`);
    }
  }
  for (const c of remove) {
    try {
      run(["api", `${base}/${c.id}`, "-X", "DELETE"]);
    } catch (e) {
      notes.push(`${c.number === null ? `a blocker in another repository (id ${c.id})` : `#${c.number}`} could not be unlinked: ${reason(e)}`);
    }
  }
  return notes;
}

const gh = (args) => execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

export function findExistingComment(repo, issueNumber, marker, run = gh) {
  const existing = run(["api", "--paginate", `repos/${repo}/issues/${issueNumber}/comments`, "--jq", `.[] | select(.body | startswith("${marker}")) | .id`]).trim().split("\n")[0];
  return existing;
}

/** `run` takes full `gh` arguments; tests pass a fake. */
export function main(env = process.env, run = gh) {
  const { REPO: repo, ISSUE_NUMBER: n } = env;
  const labels = JSON.parse(env.ISSUE_LABELS_JSON || "[]");
  // Only a task form needs the permission lookup; a plain issue is left alone without an extra API call.
  if (!issuePlan(env.ISSUE_BODY, labels, false).isTask) return;
  const config = existsSync("lanes.config.json") ? JSON.parse(readFileSync("lanes.config.json", "utf8")) : undefined;
  const api = (args) => run(["api", ...args]);
  // ADR 0022 part 2: under team, a lane-filed bot issue a write-access actor released is as trusted as a writer's issue.
  // The release is read fresh each run, so a later edit by a non-writer withdraws it (the next run removes `ready`).
  const canWrite = authorCanWrite(api, repo, env.ISSUE_AUTHOR) || readBotIssueRelease(api, config?.identity, repo, Number(n));
  const plan = issuePlan(env.ISSUE_BODY, labels, canWrite, config);
  const edit = ["issue", "edit", n, "-R", repo];
  if (plan.add.length) edit.push("--add-label", plan.add.join(","));
  if (plan.remove.length) edit.push("--remove-label", plan.remove.join(","));
  if (edit.length > 5) run(edit);
  // Like `ready` (C1), the mirror acts only for a trusted author: otherwise anyone who can open an issue could have
  // this job's issues:write token link their issue to any issue in the repository.
  const notes =
    canWrite === true ? mirrorBlockedBy(repo, n, env.ISSUE_BODY, run) : ["not mirrored: the issue's author does not have write access"];
  const comment = notes.length
    ? `${plan.comment}\n\n**Blocked by mirror** (the form field is the source of truth):\n${notes.map((l) => `- ${l}`).join("\n")}`
    : plan.comment;
  const existing = findExistingComment(repo, n, MARKER, run);
  if (existing) run(["api", `repos/${repo}/issues/comments/${existing}`, "-X", "PATCH", "-f", `body=${comment}`]);
  else run(["api", `repos/${repo}/issues/${n}/comments`, "-f", `body=${comment}`]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
