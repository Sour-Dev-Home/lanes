# Lanes Workflow Template Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the reusable "lanes" workflow (task and PR contracts, the `lanes/gate` check, reviewer statuses, Claude commands, unattended-night support) in the `lanes` repo, publish it after the owner's go-ahead, and document how to use it.

**Architecture:** Dependency-free Node ESM scripts under `scripts/lanes/`. All decisions are pure functions in `lib.mjs`, unit-tested with `node:test`; thin I/O wrappers call `gh` through `execFileSync` (never a shell). GitHub Actions run the gate on PR, status and merge-queue events, always executing the default branch's copy of the scripts. Claude Code commands in `.claude/commands/` drive lanes. `install.mjs` copies the template into any other repo.

**Tech Stack:** Node 22+ (ESM, `node:test`), GitHub Actions, the `gh` CLI, GitHub rulesets and merge queue, Claude Code slash commands and settings.

**Spec:** `docs/specs/2026-09-26-workflow-overhaul-design.md` (approved by the owner 2026-09-26).

## Global Constraints

- No runtime or dev dependencies: `package.json` has no `dependencies` or `devDependencies`.
- Node 22 in CI (`actions/setup-node` `node-version: 22`); scripts must also run on Node 26 locally.
- Actions are pinned to full commit SHAs: `actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7`, `actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7`.
- `gh` is only ever called through `execFileSync("gh", [...args])`, never a shell string.
- No personal information or absolute local paths in any committed file. The only exception is the copyright line of `LICENSE` (AGPL-3.0, the copyright holder named in LICENSE); the PII check excludes exactly `LICENSE`, `.github/` and `CLAUDE.md` files.
- The PII scan reads patterns from the `PII_PATTERNS` repository **secret** and prints only `file:line` (`grep -H -n -iF -f ... | cut -d: -f1,2`).
- Status contexts: `lanes/gate`, `review/test-hunter`, `review/ui-reviewer`, `review/security-reviewer`, `review/architecture-advisor`, `review/owner`.
- Tiers: `skip`, `quick`, `full`, as issue labels `tier:skip|tier:quick|tier:full`. Other labels: `ready`, `contract:breaking`, `digest`.
- Required checks on `main`: `verify`, `security`, `lanes/gate`, plus the CodeQL code-scanning rule (high or higher blocks).
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; commits are signed per the user's global git config.
- Test command while iterating: `node --test scripts/lanes/<file>.test.mjs`; full suite: `npm test`.

## Review Focus

- A PR that edits `scripts/lanes/*` or `lanes.config.json` to weaken the gate: the gate must run the default branch's scripts, never the PR's (Task 5 pins this with a test on the workflow file).
- A PR body that is the unfilled template (only HTML comments under each heading) must fail the contract, not pass (Task 3).
- A rename that moves code into a skip path (for example `src/a.ts` → `docs/a.ts`) must not qualify as `tier:skip`: both the old and new names are classified (Tasks 4 and 5).
- A push after the owner's approval must drop the approval: statuses are per commit, and the gate on the new head must not find `review/owner` (Task 5).
- A `## ` heading inside a fenced code block in the PR body must not be read as a section (Task 3).

---

## File Structure

```
lanes/
  package.json                 scripts: test, setup; "type": "module"; no deps
  .gitattributes .gitignore LICENSE README.md
  lanes.config.json            per-project paths (skip/contract/sensitive/ui) and requiredChecks
  .githooks/pre-push           runs scripts/preflight.mjs
  .github/
    ISSUE_TEMPLATE/task.yml    the task contract (issue form)
    ISSUE_TEMPLATE/config.yml  blank issues off
    pull_request_template.md   the return contract
    workflows/verify.yml       npm test (project-specific; not installed elsewhere)
    workflows/security.yml     PII and local-path scan
    workflows/lanes-gate.yml   posts lanes/gate on PR, status and merge_group events
    workflows/issue-contract.yml validates task issues, sets tier:* and ready labels
  scripts/
    preflight.mjs (+ .test.mjs)  ported from satisfactory-dash
    lanes/
      lib.mjs (+ .test.mjs)            pure logic: config, classes, reviewers, contracts, gate decision
      gate.mjs (+ .test.mjs)           gate I/O (PR, status, merge_group)
      issue-contract.mjs (+ .test.mjs) issue I/O
      post-review.mjs (+ .test.mjs)    posts review/* statuses
      reviewers.mjs                    prints the reviewers a diff needs
      status.mjs (+ .test.mjs)         /status and the nightly digest
      install.mjs (+ .test.mjs)        copies the template into another repo
      setup-repo.mjs (+ .test.mjs)     labels, repo settings, ruleset (owner-run)
      workflow.test.mjs                static checks on the workflow files
  .claude/
    settings.json
    commands/lane.md status.md approve.md adr.md health.md night.md
  docs/USING.md                how to use it, pitfalls, rules and scripts
```

---

### Task 1: Repository scaffold and config

**Files:**
- Create: `package.json`, `.gitattributes`, `.gitignore`, `LICENSE`, `README.md`, `lanes.config.json`

**Interfaces:**
- Produces: `lanes.config.json` shape `{ requiredChecks: string[], paths: { skip: string[], contract: string[], sensitive: string[], ui: string[] } }` (regex source strings), read by `lib.mjs` `loadConfig`.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "lanes",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "license": "AGPL-3.0-only",
  "engines": { "node": ">=22" },
  "scripts": {
    "test": "node --test \"scripts/**/*.test.mjs\"",
    "setup": "git config core.hooksPath .githooks",
    "preflight": "node scripts/preflight.mjs",
    "status": "node scripts/lanes/status.mjs"
  }
}
```

- [ ] **Step 2: Create `.gitattributes`, `.gitignore`, `lanes.config.json`**

`.gitattributes`:
```
* text=auto eol=lf
```

`.gitignore`:
```
node_modules/
.env
.env.*
*.log
.preflight-patterns
```

`lanes.config.json`:
```json
{
  "requiredChecks": ["verify", "security", "lanes/gate"],
  "paths": {
    "skip": ["^docs/", "\\.md$", "\\.test\\.m?[jt]sx?$", "(^|/)__tests__/", "(^|/)test/"],
    "contract": ["^contracts/", "\\.schema\\.json$", "(^|/)schema\\.ts$"],
    "sensitive": ["^\\.github/", "^\\.claude/", "^\\.githooks/", "^scripts/lanes/", "^scripts/preflight\\.mjs$", "^lanes\\.config\\.json$", "(^|/)auth/", "(^|/)secrets?/", "^deploy/", "(^|/)\\.env"],
    "ui": ["^frontend/src/", "^src/ui/", "\\.css$"]
  }
}
```

- [ ] **Step 3: Copy the LICENSE and write the README**

Run: `cp ../satisfactory-dash/LICENSE LICENSE && head -5 LICENSE`
Expected: the AGPL-3.0 header and the copyright line naming the owner (the one allowed place for his name).

`README.md`:
```markdown
# lanes

A workflow for building software with parallel Claude Code sessions ("lanes"): one fresh
session per GitHub issue, contracts at every handoff, required checks as the only
gatekeeper, and unattended nights for low-risk work. See [docs/USING.md](docs/USING.md)
and the design in [docs/specs/](docs/specs/).

Install into another repository: `node scripts/lanes/install.mjs <target-dir>`.
```

- [ ] **Step 4: Commit**

```bash
git add package.json .gitattributes .gitignore LICENSE README.md lanes.config.json
git commit -m "chore: scaffold the lanes repo (package.json, config, license)"
```

---

### Task 2: `lib.mjs` — config, file classes, required reviewers

**Files:**
- Create: `scripts/lanes/lib.mjs`
- Test: `scripts/lanes/lib.test.mjs`

**Interfaces:**
- Consumes: `lanes.config.json` (Task 1).
- Produces:
  - `REVIEWERS: string[]` = `["test-hunter","ui-reviewer","security-reviewer","architecture-advisor"]`
  - `TIERS: string[]` = `["skip","quick","full"]`
  - `GATE_CONTEXT = "lanes/gate"`, `reviewContext(name: string): string` → `review/<name>`
  - `compileConfig(raw): Config` and `loadConfig(file = "lanes.config.json"): Config`, where `Config = { requiredChecks: string[], paths: { skip: RegExp[], contract: RegExp[], sensitive: RegExp[], ui: RegExp[] } }`
  - `classifyFiles(files: string[], config: Config): { skipOnly: boolean, contract: boolean, sensitive: boolean, ui: boolean }`
  - `requiredReviewers(tier: string, cls): string[]`

- [ ] **Step 1: Write the failing tests**

```js
// scripts/lanes/lib.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyFiles, compileConfig, requiredReviewers, reviewContext } from "./lib.mjs";

const config = compileConfig({
  requiredChecks: ["verify", "security", "lanes/gate"],
  paths: {
    skip: ["^docs/", "\\.md$", "\\.test\\.m?[jt]sx?$"],
    contract: ["^contracts/"],
    sensitive: ["^\\.github/", "^scripts/lanes/"],
    ui: ["^frontend/src/"],
  },
});

test("compileConfig rejects a missing path list", () => {
  assert.throws(() => compileConfig({ requiredChecks: ["verify"], paths: { skip: [] } }), /paths\.contract/);
});

test("compileConfig rejects empty requiredChecks", () => {
  assert.throws(() => compileConfig({ requiredChecks: [], paths: { skip: [], contract: [], sensitive: [], ui: [] } }), /requiredChecks/);
});

test("docs and tests only are skipOnly", () => {
  assert.deepEqual(classifyFiles(["docs/a.md", "src/x.test.ts"], config), { skipOnly: true, contract: false, sensitive: false, ui: false });
});

test("a sensitive markdown file is not skipOnly", () => {
  assert.equal(classifyFiles([".github/pull_request_template.md"], config).skipOnly, false);
  assert.equal(classifyFiles([".github/pull_request_template.md"], config).sensitive, true);
});

test("no files is not skipOnly", () => {
  assert.equal(classifyFiles([], config).skipOnly, false);
});

test("code plus docs is not skipOnly; contract and ui are detected", () => {
  const cls = classifyFiles(["docs/a.md", "contracts/snapshot.ts", "frontend/src/App.tsx"], config);
  assert.deepEqual(cls, { skipOnly: false, contract: true, sensitive: false, ui: true });
});

test("required reviewers by tier and class", () => {
  const none = { skipOnly: false, contract: false, sensitive: false, ui: false };
  assert.deepEqual(requiredReviewers("skip", none), []);
  assert.deepEqual(requiredReviewers("quick", none), ["test-hunter"]);
  assert.deepEqual(requiredReviewers("quick", { ...none, ui: true }), ["test-hunter", "ui-reviewer"]);
  assert.deepEqual(requiredReviewers("full", { ...none, sensitive: true, contract: true }), ["test-hunter", "security-reviewer", "architecture-advisor"]);
});

test("reviewContext", () => {
  assert.equal(reviewContext("owner"), "review/owner");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test scripts/lanes/lib.test.mjs`
Expected: FAIL, `Cannot find module` for `./lib.mjs`.

- [ ] **Step 3: Write the implementation**

```js
// scripts/lanes/lib.mjs
// Pure logic for the lanes workflow: config, file classes, required reviewers, the task and PR contracts, and the gate
// decision. No I/O except loadConfig; everything else is a plain function so it can be unit-tested.
import { readFileSync } from "node:fs";

export const REVIEWERS = ["test-hunter", "ui-reviewer", "security-reviewer", "architecture-advisor"];
export const TIERS = ["skip", "quick", "full"];
export const GATE_CONTEXT = "lanes/gate";
export const reviewContext = (name) => `review/${name}`;

const PATH_KEYS = ["skip", "contract", "sensitive", "ui"];

export function compileConfig(raw) {
  const paths = {};
  for (const key of PATH_KEYS) {
    const list = raw?.paths?.[key];
    if (!Array.isArray(list)) throw new Error(`lanes.config.json: paths.${key} must be an array of regex strings`);
    paths[key] = list.map((source) => new RegExp(source));
  }
  const requiredChecks = raw?.requiredChecks;
  if (!Array.isArray(requiredChecks) || requiredChecks.length === 0) {
    throw new Error("lanes.config.json: requiredChecks must be a non-empty array");
  }
  return { requiredChecks, paths };
}

export function loadConfig(file = "lanes.config.json") {
  return compileConfig(JSON.parse(readFileSync(file, "utf8")));
}

const matchesAny = (patterns, file) => patterns.some((re) => re.test(file));

/** Which kinds of files a diff touches. Pass both the new and the old name of a renamed file. */
export function classifyFiles(files, config) {
  const { paths } = config;
  return {
    skipOnly: files.length > 0 && files.every((f) => matchesAny(paths.skip, f) && !matchesAny(paths.sensitive, f)),
    contract: files.some((f) => matchesAny(paths.contract, f)),
    sensitive: files.some((f) => matchesAny(paths.sensitive, f)),
    ui: files.some((f) => matchesAny(paths.ui, f)),
  };
}

/** The fresh-eyes reviewers a PR must pass, from its issue's tier and its diff. */
export function requiredReviewers(tier, cls) {
  if (tier === "skip") return [];
  const out = ["test-hunter"];
  if (cls.ui) out.push("ui-reviewer");
  if (cls.sensitive) out.push("security-reviewer");
  if (cls.contract) out.push("architecture-advisor");
  return out;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test scripts/lanes/lib.test.mjs`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/lanes/lib.mjs scripts/lanes/lib.test.mjs
git commit -m "feat(lanes): config, file classes and required reviewers"
```

---

### Task 3: `lib.mjs` — the task contract and the PR contract

**Files:**
- Modify: `scripts/lanes/lib.mjs` (append)
- Create: `.github/ISSUE_TEMPLATE/task.yml`, `.github/ISSUE_TEMPLATE/config.yml`, `.github/pull_request_template.md`
- Test: `scripts/lanes/contracts.test.mjs`

**Interfaces:**
- Produces:
  - `parseSections(body: string, marker: "##" | "###"): Record<string, string>` (keys lower-cased heading text; values trimmed; `_No response_` → `""`; HTML comments removed; headings inside ``` fences ignored)
  - `parseIssueForm(body): { ok: boolean, errors: string[], fields: { goal: string, criteria: string[], contract: string, scope: string, blockedBy: number[], tier: string } }`
  - `PR_SECTIONS: string[]`, `parsePrBody(body): { closes: number | null, missing: string[], contractChange: "none" | "additive" | "breaking" | null, sections: Record<string,string> }`

- [ ] **Step 1: Write the failing tests**

```js
// scripts/lanes/contracts.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseIssueForm, parsePrBody, parseSections } from "./lib.mjs";

const issue = (over = {}) => {
  const f = { Goal: "Add the snapshot schema", "Acceptance criteria": "- [ ] schema validates a sample\n- [ ] rejects a missing id", "Interface contract": "contracts/snapshot.ts", Scope: "In: contracts/. Out: UI.", "Blocked by": "none", Tier: "quick", ...over };
  return Object.entries(f).map(([k, v]) => `### ${k}\n\n${v}\n`).join("\n");
};

test("a complete issue form parses", () => {
  const r = parseIssueForm(issue());
  assert.equal(r.ok, true, r.errors.join("; "));
  assert.deepEqual(r.fields.criteria, ["schema validates a sample", "rejects a missing id"]);
  assert.equal(r.fields.tier, "quick");
  assert.deepEqual(r.fields.blockedBy, []);
});

test("_No response_ counts as missing", () => {
  const r = parseIssueForm(issue({ Scope: "_No response_" }));
  assert.equal(r.ok, false);
  assert.match(r.errors.join(), /missing: scope/);
});

test("criteria must be checkbox lines", () => {
  assert.match(parseIssueForm(issue({ "Acceptance criteria": "it works" })).errors.join(), /acceptance criteria/);
});

test("blocked by lists issue numbers", () => {
  assert.deepEqual(parseIssueForm(issue({ "Blocked by": "#3, #12" })).fields.blockedBy, [3, 12]);
  assert.match(parseIssueForm(issue({ "Blocked by": "the other one" })).errors.join(), /blocked by/);
});

test("tier must be known", () => {
  assert.match(parseIssueForm(issue({ Tier: "huge" })).errors.join(), /tier must be one of/);
});

test("CRLF bodies parse", () => {
  assert.equal(parseIssueForm(issue().replace(/\n/g, "\r\n")).ok, true);
});

const pr = (over = {}) => {
  const s = { "What changed": "- schema validates a sample: added", "Contract changes": "additive: new type", "Tests added": "2", "Reviewer results": "test-hunter: 0 bugs", "Needs the owner": "nothing", "Not done": "nothing", ...over };
  return "Closes #7\n\n" + Object.entries(s).map(([k, v]) => `## ${k}\n\n${v}\n`).join("\n");
};

test("a complete PR body parses", () => {
  const r = parsePrBody(pr());
  assert.equal(r.closes, 7);
  assert.deepEqual(r.missing, []);
  assert.equal(r.contractChange, "additive");
});

test("the unfilled template fails: HTML comments are not content", () => {
  const template = readFileSync(".github/pull_request_template.md", "utf8");
  const r = parsePrBody(template.replace("Closes #", "Closes #7"));
  assert.ok(r.missing.includes("what changed"));
  assert.equal(r.contractChange, null);
});

test("a heading inside a code fence is not a section", () => {
  const body = pr({ "Not done": "```\n## What changed\n```" }).replace(/## What changed\n\n- schema validates a sample: added\n/, "");
  assert.ok(parsePrBody(body).missing.includes("what changed"));
});

test("no closing keyword gives closes null", () => {
  assert.equal(parsePrBody(pr().replace("Closes #7", "Refs #7")).closes, null);
});

test("parseSections lower-cases headings", () => {
  assert.deepEqual(parseSections("### Goal\n\nx\n", "###"), { goal: "x" });
});
```

- [ ] **Step 2: Create the templates**

`.github/ISSUE_TEMPLATE/task.yml`:
```yaml
name: Task
description: One unit of work for one lane. Every field is part of the task contract.
body:
  - type: textarea
    id: goal
    attributes: { label: Goal, description: One sentence. }
    validations: { required: true }
  - type: textarea
    id: criteria
    attributes:
      label: Acceptance criteria
      description: One checkable item per line, written as "- [ ] ...". Each becomes a test.
      value: "- [ ] "
    validations: { required: true }
  - type: textarea
    id: contract
    attributes: { label: Interface contract, description: "The type, schema, endpoint or CLI shape this task produces or consumes (link the file), or none." }
    validations: { required: true }
  - type: textarea
    id: scope
    attributes: { label: Scope, description: "In scope: files and areas. Out of scope: what this task must not touch." }
    validations: { required: true }
  - type: input
    id: blocked
    attributes: { label: Blocked by, description: "Issue numbers as #N, or none.", value: none }
    validations: { required: true }
  - type: dropdown
    id: tier
    attributes:
      label: Tier
      description: "skip = docs/config/tests only; quick = UI or small fix; full = logic, data, APIs, security."
      options: [skip, quick, full]
    validations: { required: true }
```

`.github/ISSUE_TEMPLATE/config.yml`:
```yaml
blank_issues_enabled: false
```

`.github/pull_request_template.md`:
```markdown
Closes #

## What changed
<!-- One line per acceptance criterion of the issue: the criterion, then what satisfies it. -->

## Contract changes
<!-- Start with exactly one word: none, additive or breaking. Breaking needs the issue label contract:breaking. -->

## Tests added
<!-- Which tests, and which criterion each covers. -->

## Reviewer results
<!-- One line per reviewer the tier required: verdict and what it found or fixed. -->

## Needs the owner
<!-- Anything only the owner can decide, or: nothing -->

## Not done
<!-- Anything left out, with follow-up issue links, or: nothing -->
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test scripts/lanes/contracts.test.mjs`
Expected: FAIL, `parseIssueForm` is not exported.

- [ ] **Step 4: Append the implementation to `lib.mjs`**

```js
// ---- Contracts: the task issue form and the PR template ----

/** Splits a markdown body into sections by headings of exactly `marker` ("##" or "###"). */
export function parseSections(body, marker) {
  const text = String(body ?? "").replace(/\r\n/g, "\n").replace(/<!--[\s\S]*?-->/g, "");
  const raw = {};
  let current = null;
  let inFence = false;
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (!inFence && line.startsWith(`${marker} `)) {
      current = line.slice(marker.length + 1).trim().toLowerCase();
      raw[current] = [];
      continue;
    }
    if (current !== null) raw[current].push(line);
  }
  const out = {};
  for (const [key, lines] of Object.entries(raw)) {
    const value = lines.join("\n").trim();
    out[key] = value === "_No response_" ? "" : value;
  }
  return out;
}

const ISSUE_FIELDS = ["goal", "acceptance criteria", "interface contract", "scope", "blocked by", "tier"];

export function parseIssueForm(body) {
  const s = parseSections(body, "###");
  const errors = ISSUE_FIELDS.filter((f) => !s[f]).map((f) => `missing: ${f}`);
  const criteria = (s["acceptance criteria"] ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^- \[[ xX]\] \S/.test(l))
    .map((l) => l.slice(6).trim());
  if (s["acceptance criteria"] && criteria.length === 0) errors.push("acceptance criteria: write each as a '- [ ] ...' line");
  const tier = (s.tier ?? "").trim().toLowerCase();
  if (s.tier && !TIERS.includes(tier)) errors.push(`tier must be one of ${TIERS.join(", ")}`);
  const blockedRaw = (s["blocked by"] ?? "").trim();
  let blockedBy = [];
  if (blockedRaw && blockedRaw.toLowerCase() !== "none") {
    blockedBy = [...blockedRaw.matchAll(/#(\d+)/g)].map((m) => Number(m[1]));
    if (blockedBy.length === 0) errors.push("blocked by: list issues as #N, or write none");
  }
  return {
    ok: errors.length === 0,
    errors,
    fields: { goal: s.goal ?? "", criteria, contract: s["interface contract"] ?? "", scope: s.scope ?? "", blockedBy, tier },
  };
}

export const PR_SECTIONS = ["what changed", "contract changes", "tests added", "reviewer results", "needs the owner", "not done"];
const CONTRACT_CHANGES = ["none", "additive", "breaking"];

export function parsePrBody(body) {
  const text = String(body ?? "").replace(/<!--[\s\S]*?-->/g, "");
  const closes = text.match(/\b(?:closes|fixes|resolves)\s+#(\d+)\b/i);
  const sections = parseSections(text, "##");
  const missing = PR_SECTIONS.filter((k) => !sections[k]);
  const first = (sections["contract changes"] ?? "").split(/\s/)[0].toLowerCase().replace(/[^a-z]/g, "");
  return {
    closes: closes ? Number(closes[1]) : null,
    missing,
    contractChange: CONTRACT_CHANGES.includes(first) ? first : null,
    sections,
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test scripts/lanes/contracts.test.mjs scripts/lanes/lib.test.mjs`
Expected: PASS, 19 tests.

- [ ] **Step 6: Commit**

```bash
git add scripts/lanes/lib.mjs scripts/lanes/contracts.test.mjs .github/ISSUE_TEMPLATE .github/pull_request_template.md
git commit -m "feat(lanes): task issue form and PR template as parsed contracts"
```

---

### Task 4: `lib.mjs` — the gate decision

**Files:**
- Modify: `scripts/lanes/lib.mjs` (append)
- Test: `scripts/lanes/gate-decision.test.mjs`

**Interfaces:**
- Consumes: `classifyFiles`, `requiredReviewers`, `parsePrBody`, `reviewContext`, `TIERS` (Tasks 2–3).
- Produces:
  - `latestByContext(statuses: Array<{context, state, description, created_at}>): Map<string, status>`
  - `gateDecision({ prBody, issueLabels: string[], files: string[], statuses, config }): { state: "success" | "pending" | "failure", description: string, stage: "contract" | "review" | "owner" | "ready" }`

- [ ] **Step 1: Write the failing tests**

```js
// scripts/lanes/gate-decision.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { compileConfig, gateDecision } from "./lib.mjs";

const config = compileConfig({
  requiredChecks: ["verify"],
  paths: { skip: ["^docs/", "\\.md$"], contract: ["^contracts/"], sensitive: ["^\\.github/"], ui: ["^frontend/"] },
});
const body = (contract = "none") =>
  `Closes #7\n\n## What changed\nx\n## Contract changes\n${contract}\n## Tests added\nx\n## Reviewer results\nx\n## Needs the owner\nnothing\n## Not done\nnothing\n`;
const st = (context, state = "success", description = "ok", created_at = "2026-09-26T10:00:00Z") => ({ context, state, description, created_at });
const run = (over) => gateDecision({ prBody: body(), issueLabels: ["tier:quick"], files: ["src/a.ts"], statuses: [], config, ...over });

test("no Closes #N fails", () => {
  assert.equal(run({ prBody: body().replace("Closes #7", "") }).state, "failure");
});

test("missing or double tier label fails", () => {
  assert.match(run({ issueLabels: [] }).description, /tier/);
  assert.equal(run({ issueLabels: ["tier:quick", "tier:full"] }).state, "failure");
});

test("tier:skip with code fails", () => {
  assert.match(run({ issueLabels: ["tier:skip"] }).description, /skip paths/);
});

test("rename out of code into docs is not skip (old name passed too)", () => {
  assert.equal(run({ issueLabels: ["tier:skip"], files: ["docs/a.ts", "src/a.ts"] }).state, "failure");
});

test("tier:skip docs-only passes unattended with no reviewers", () => {
  assert.deepEqual(run({ issueLabels: ["tier:skip"], files: ["docs/a.md"] }), { state: "success", description: "unattended-eligible (tier:skip), reviews in", stage: "ready" });
});

test("contract files with 'none' fails; breaking needs the label", () => {
  assert.match(run({ files: ["contracts/x.ts"] }).description, /says none/);
  assert.match(run({ prBody: body("breaking"), files: ["contracts/x.ts"] }).description, /contract:breaking/);
});

test("quick waits for the test-hunter, then merges unattended", () => {
  assert.deepEqual(run({}).stage, "review");
  assert.equal(run({}).state, "pending");
  assert.equal(run({ statuses: [st("review/test-hunter")] }).state, "success");
});

test("a failing or skipped required review fails", () => {
  assert.equal(run({ statuses: [st("review/test-hunter", "failure")] }).state, "failure");
  assert.match(run({ statuses: [st("review/test-hunter", "success", "skipped: small")] }).description, /cannot be skipped/);
});

test("the newest status per context wins", () => {
  const statuses = [st("review/test-hunter", "failure", "bug", "2026-09-26T09:00:00Z"), st("review/test-hunter", "success", "fixed", "2026-09-26T11:00:00Z")];
  assert.equal(run({ statuses }).state, "success");
});

test("sensitive quick change waits on the owner, then passes with review/owner", () => {
  const files = [".github/workflows/x.yml"];
  const reviews = [st("review/test-hunter"), st("review/security-reviewer")];
  assert.deepEqual(run({ files, statuses: reviews }).stage, "owner");
  assert.equal(run({ files, statuses: [...reviews, st("review/owner")] }).state, "success");
});

test("full tier always waits on the owner", () => {
  assert.equal(run({ issueLabels: ["tier:full"], statuses: [st("review/test-hunter")] }).stage, "owner");
});

test("a new head without statuses has no owner approval", () => {
  assert.equal(run({ issueLabels: ["tier:full"], statuses: [] }).stage, "review");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test scripts/lanes/gate-decision.test.mjs`
Expected: FAIL, `gateDecision` is not exported.

- [ ] **Step 3: Append the implementation to `lib.mjs`**

```js
// ---- The gate decision ----

/** Newest status per context (GitHub keeps every status ever posted on a commit). */
export function latestByContext(statuses) {
  const out = new Map();
  const sorted = [...(Array.isArray(statuses) ? statuses : [])]
    .filter((s) => s && typeof s.context === "string")
    .sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")));
  for (const s of sorted) if (!out.has(s.context)) out.set(s.context, s);
  return out;
}

/** What `lanes/gate` should say for a PR head. Pure: every input is passed in. */
export function gateDecision({ prBody, issueLabels, files, statuses, config }) {
  const fail = (description, stage = "contract") => ({ state: "failure", description, stage });
  const labels = Array.isArray(issueLabels) ? issueLabels : [];
  const pr = parsePrBody(prBody);
  if (pr.closes === null) return fail("PR body must say 'Closes #N' for its task issue");
  const tiers = labels.filter((l) => l.startsWith("tier:")).map((l) => l.slice(5)).filter((t) => TIERS.includes(t));
  if (tiers.length !== 1) return fail(`issue #${pr.closes} needs exactly one tier:skip|quick|full label`);
  const tier = tiers[0];
  if (pr.missing.length > 0) return fail(`PR template sections missing: ${pr.missing.join(", ")}`);
  if (pr.contractChange === null) return fail("'Contract changes' must start with none, additive or breaking");
  const cls = classifyFiles(files, config);
  if (tier === "skip" && !cls.skipOnly) return fail("tier:skip but the diff changes files outside the skip paths");
  if (pr.contractChange === "none" && cls.contract) return fail("contract files changed but 'Contract changes' says none");
  if (pr.contractChange === "breaking" && !labels.includes("contract:breaking")) {
    return fail("a breaking contract change needs the issue label contract:breaking");
  }
  const latest = latestByContext(statuses);
  for (const name of requiredReviewers(tier, cls)) {
    const s = latest.get(reviewContext(name));
    if (!s) return { state: "pending", description: `waiting for review/${name}`, stage: "review" };
    if (s.state !== "success") return fail(`review/${name} is ${s.state}`, "review");
    if (String(s.description ?? "").startsWith("skipped")) {
      return fail(`review/${name} is required for this diff and cannot be skipped`, "review");
    }
  }
  if (latest.get(reviewContext("owner"))?.state === "success") {
    return { state: "success", description: "approved by owner", stage: "ready" };
  }
  const eligible = tier === "skip" || (tier === "quick" && !cls.contract && !cls.sensitive);
  if (eligible) return { state: "success", description: `unattended-eligible (tier:${tier}), reviews in`, stage: "ready" };
  return { state: "pending", description: "waiting on owner (/approve)", stage: "owner" };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test scripts/lanes/gate-decision.test.mjs`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/lanes/lib.mjs scripts/lanes/gate-decision.test.mjs
git commit -m "feat(lanes): the gate decision (contract, reviews, owner or unattended)"
```

---

### Task 5: `gate.mjs` and the `lanes-gate` workflow

**Files:**
- Create: `scripts/lanes/gate.mjs`, `.github/workflows/lanes-gate.yml`
- Test: `scripts/lanes/gate.test.mjs`, `scripts/lanes/workflow.test.mjs`

**Interfaces:**
- Consumes: `gateDecision`, `latestByContext`, `parsePrBody`, `loadConfig`, `GATE_CONTEXT` (Tasks 2–4).
- Produces:
  - `evaluatePr(api, repo: string, number: number, config): decision | null` (null for a closed PR); posts `lanes/gate` on the PR head.
  - `carry(api, repo, headRef: string, groupSha: string): { state, description }`; posts on the merge-group commit.
  - `api(args: string[]): string` is the injectable `gh api` runner.

- [ ] **Step 1: Write the failing tests**

```js
// scripts/lanes/gate.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { carry, evaluatePr } from "./gate.mjs";
import { compileConfig } from "./lib.mjs";

const config = compileConfig({ requiredChecks: ["verify"], paths: { skip: ["^docs/"], contract: [], sensitive: [], ui: [] } });
const SHA = "a".repeat(40);
const body = "Closes #7\n## What changed\nx\n## Contract changes\nnone\n## Tests added\nx\n## Reviewer results\nx\n## Needs the owner\nnothing\n## Not done\nnothing";

function fakeApi(routes) {
  const posted = [];
  const api = (args) => {
    if (args[0].endsWith(`/statuses/${args[0].split("/").pop()}`) && args.includes("-f")) {
      posted.push({ sha: args[0].split("/").pop(), fields: args.filter((a, i) => args[i - 1] === "-f") });
      return "{}";
    }
    const hit = routes[args[0]];
    if (hit === undefined) throw new Error(`unexpected gh api ${args.join(" ")}`);
    return typeof hit === "string" ? hit : JSON.stringify(hit);
  };
  return { api, posted };
}

test("evaluatePr posts lanes/gate on the PR head, using old and new names of renamed files", () => {
  const { api, posted } = fakeApi({
    "repos/o/r/pulls/5": { state: "open", body, head: { sha: SHA } },
    "repos/o/r/pulls/5/files": "docs/a.ts\nsrc/a.ts\n",
    "repos/o/r/issues/7": { labels: [{ name: "tier:skip" }] },
    [`repos/o/r/commits/${SHA}/statuses?per_page=100`]: [],
  });
  const d = evaluatePr(api, "o/r", 5, config);
  assert.equal(d.state, "failure");
  assert.equal(posted[0].sha, SHA);
  assert.ok(posted[0].fields.includes("context=lanes/gate"));
  assert.ok(posted[0].fields.includes("state=failure"));
});

test("evaluatePr treats a missing issue as having no labels", () => {
  const routes = {
    "repos/o/r/pulls/5": { state: "open", body, head: { sha: SHA } },
    "repos/o/r/pulls/5/files": "docs/a.md\n",
    [`repos/o/r/commits/${SHA}/statuses?per_page=100`]: [],
  };
  const { api } = fakeApi(routes);
  assert.match(evaluatePr(api, "o/r", 5, config).description, /tier/);
});

test("evaluatePr skips a closed PR", () => {
  const { api, posted } = fakeApi({ "repos/o/r/pulls/5": { state: "closed", body, head: { sha: SHA } } });
  assert.equal(evaluatePr(api, "o/r", 5, config), null);
  assert.equal(posted.length, 0);
});

test("carry copies a lanes/gate success from the PR head to the merge group", () => {
  const group = "b".repeat(40);
  const { api, posted } = fakeApi({
    "repos/o/r/pulls/5": { state: "open", head: { sha: SHA } },
    [`repos/o/r/commits/${SHA}/statuses?per_page=100`]: [{ context: "lanes/gate", state: "success", created_at: "2026-09-26T10:00:00Z" }],
  });
  assert.equal(carry(api, "o/r", `gh-readonly-queue/main/pr-5-${"c".repeat(40)}`, group).state, "success");
  assert.equal(posted[0].sha, group);
});

test("carry fails closed on an unknown queue ref or a non-success gate", () => {
  const group = "b".repeat(40);
  const { api } = fakeApi({
    "repos/o/r/pulls/5": { state: "open", head: { sha: SHA } },
    [`repos/o/r/commits/${SHA}/statuses?per_page=100`]: [{ context: "lanes/gate", state: "pending", created_at: "x" }],
  });
  assert.equal(carry(api, "o/r", "not-a-queue-ref", group).state, "failure");
  assert.equal(carry(api, "o/r", `gh-readonly-queue/main/pr-5-${"c".repeat(40)}`, group).state, "failure");
});
```

```js
// scripts/lanes/workflow.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("lanes-gate always runs the default branch's scripts, never the PR's", () => {
  const yml = readFileSync(".github/workflows/lanes-gate.yml", "utf8");
  assert.match(yml, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
});

test("lanes-gate ignores its own status events", () => {
  const yml = readFileSync(".github/workflows/lanes-gate.yml", "utf8");
  assert.match(yml, /github\.event\.context != 'lanes\/gate'/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test scripts/lanes/gate.test.mjs scripts/lanes/workflow.test.mjs`
Expected: FAIL, `gate.mjs` and the workflow file are missing.

- [ ] **Step 3: Write `gate.mjs`**

```js
// scripts/lanes/gate.mjs
// Posts the `lanes/gate` commit status. Run by .github/workflows/lanes-gate.yml, always from the default branch.
// Inputs (environment): REPO, EVENT_NAME, PR_NUMBER, STATUS_SHA, STATUS_CONTEXT, HEAD_REF, GROUP_SHA, GH_TOKEN.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { GATE_CONTEXT, gateDecision, latestByContext, loadConfig, parsePrBody } from "./lib.mjs";

const SHA = /^[0-9a-f]{40}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const QUEUE_REF = /^(?:refs\/heads\/)?gh-readonly-queue\/[^/]+\/pr-([1-9][0-9]{0,8})-[0-9a-f]{40}$/;

export function ghApi(args) {
  return execFileSync("gh", ["api", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function post(api, repo, sha, { state, description }) {
  api([`repos/${repo}/statuses/${sha}`, "-f", `state=${state}`, "-f", `context=${GATE_CONTEXT}`, "-f", `description=${description.slice(0, 140)}`]);
}

const statusesOf = (api, repo, sha) => JSON.parse(api([`repos/${repo}/commits/${sha}/statuses?per_page=100`]));

export function evaluatePr(api, repo, number, config) {
  const pr = JSON.parse(api([`repos/${repo}/pulls/${number}`]));
  if (pr.state !== "open") return null;
  // Both names of a renamed file: moving code into docs/ must not make a diff look docs-only.
  const files = api([`repos/${repo}/pulls/${number}/files`, "--paginate", "--jq", ".[] | .filename, (.previous_filename // empty)"])
    .split("\n")
    .filter(Boolean);
  const closes = parsePrBody(pr.body).closes;
  let issueLabels = [];
  if (closes !== null) {
    try {
      issueLabels = JSON.parse(api([`repos/${repo}/issues/${closes}`])).labels.map((l) => l.name);
    } catch {
      issueLabels = []; // unknown issue: the decision then fails on the missing tier label
    }
  }
  const decision = gateDecision({ prBody: pr.body, issueLabels, files, statuses: statusesOf(api, repo, pr.head.sha), config });
  post(api, repo, pr.head.sha, decision);
  return decision;
}

export function carry(api, repo, headRef, groupSha) {
  const match = QUEUE_REF.exec(headRef ?? "");
  let decision = { state: "failure", description: "cannot tell which PR this queue entry is for" };
  if (match) {
    const pr = JSON.parse(api([`repos/${repo}/pulls/${match[1]}`]));
    const gate = latestByContext(statusesOf(api, repo, pr.head.sha)).get(GATE_CONTEXT);
    decision = gate?.state === "success"
      ? { state: "success", description: `carried from ${pr.head.sha.slice(0, 7)}` }
      : { state: "failure", description: "no lanes/gate success on the PR head" };
  }
  post(api, repo, groupSha, decision);
  return decision;
}

function main(env = process.env, api = ghApi) {
  const repo = env.REPO ?? "";
  if (!REPO.test(repo)) throw new Error("REPO is missing or malformed");
  const config = loadConfig();
  switch (env.EVENT_NAME) {
    case "pull_request":
    case "workflow_dispatch":
      return console.log(JSON.stringify(evaluatePr(api, repo, Number(env.PR_NUMBER), config)));
    case "status": {
      if (env.STATUS_CONTEXT === GATE_CONTEXT || !SHA.test(env.STATUS_SHA ?? "")) return;
      for (const pr of JSON.parse(api([`repos/${repo}/commits/${env.STATUS_SHA}/pulls`]))) {
        if (pr.state === "open" && pr.head?.sha === env.STATUS_SHA) console.log(JSON.stringify(evaluatePr(api, repo, pr.number, config)));
      }
      return;
    }
    case "merge_group":
      if (!SHA.test(env.GROUP_SHA ?? "")) throw new Error("GROUP_SHA is missing or malformed");
      return console.log(JSON.stringify(carry(api, repo, env.HEAD_REF, env.GROUP_SHA)));
    default:
      throw new Error(`unsupported event: ${env.EVENT_NAME}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
```

- [ ] **Step 4: Write `.github/workflows/lanes-gate.yml`**

```yaml
name: lanes-gate
on:
  pull_request:
    types: [opened, edited, synchronize, reopened, ready_for_review]
  status:
  merge_group:
  workflow_dispatch:
    inputs:
      pr:
        description: PR number to re-evaluate (for example after an issue's tier label changed)
        required: true
permissions:
  contents: read
  pull-requests: read
  issues: read
  statuses: write
concurrency:
  group: lanes-gate-${{ github.event.pull_request.number || github.event.inputs.pr || github.event.sha || github.event.merge_group.head_sha }}
  cancel-in-progress: false
jobs:
  gate:
    if: github.event_name != 'status' || github.event.context != 'lanes/gate'
    runs-on: ubuntu-latest
    steps:
      # The default branch's gate and config, never the PR's: a PR must not be able to rewrite its own gate.
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7
        with:
          ref: ${{ github.event.repository.default_branch }}
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7
        with:
          node-version: 22
      - run: node scripts/lanes/gate.mjs
        env:
          GH_TOKEN: ${{ github.token }}
          REPO: ${{ github.repository }}
          EVENT_NAME: ${{ github.event_name }}
          PR_NUMBER: ${{ github.event.pull_request.number || github.event.inputs.pr }}
          STATUS_SHA: ${{ github.event.sha }}
          STATUS_CONTEXT: ${{ github.event.context }}
          HEAD_REF: ${{ github.event.merge_group.head_ref }}
          GROUP_SHA: ${{ github.event.merge_group.head_sha }}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test scripts/lanes/gate.test.mjs scripts/lanes/workflow.test.mjs`
Expected: PASS, 7 tests. If the fake API's status-post detection misfires, fix the test helper, not the gate.

- [ ] **Step 6: Commit**

```bash
git add scripts/lanes/gate.mjs scripts/lanes/gate.test.mjs scripts/lanes/workflow.test.mjs .github/workflows/lanes-gate.yml
git commit -m "feat(lanes): the lanes/gate workflow for PR, status and merge-queue events"
```

---

### Task 6: Issue contract check

**Files:**
- Create: `scripts/lanes/issue-contract.mjs`, `.github/workflows/issue-contract.yml`
- Test: `scripts/lanes/issue-contract.test.mjs`

**Interfaces:**
- Consumes: `parseIssueForm` (Task 3).
- Produces: `issuePlan(body: string, labels: string[]): { isTask: boolean, add: string[], remove: string[], comment: string }`, and `MARKER = "<!-- lanes:issue-contract -->"`.

- [ ] **Step 1: Write the failing tests**

```js
// scripts/lanes/issue-contract.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { issuePlan, MARKER } from "./issue-contract.mjs";

const body = "### Goal\n\ng\n\n### Acceptance criteria\n\n- [ ] a\n\n### Interface contract\n\nnone\n\n### Scope\n\ns\n\n### Blocked by\n\nnone\n\n### Tier\n\nfull\n";

test("a complete task gets its tier and ready; other tier labels go", () => {
  const p = issuePlan(body, ["tier:quick", "bug"]);
  assert.deepEqual(p.add, ["tier:full", "ready"]);
  assert.deepEqual(p.remove, ["tier:quick"]);
  assert.ok(p.comment.startsWith(MARKER));
});

test("an incomplete task loses ready and lists what is missing", () => {
  const p = issuePlan(body.replace("\ns\n", "\n_No response_\n"), ["ready", "tier:full"]);
  assert.deepEqual(p.remove, ["ready"]);
  assert.match(p.comment, /missing: scope/);
});

test("an issue that is not a task form is left alone", () => {
  assert.equal(issuePlan("just a note", []).isTask, false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test scripts/lanes/issue-contract.test.mjs`
Expected: FAIL, module not found.

- [ ] **Step 3: Write `issue-contract.mjs`**

```js
// scripts/lanes/issue-contract.mjs
// Checks a task issue against the task contract and sets its labels: tier:<tier> and `ready` when complete.
// Run by .github/workflows/issue-contract.yml. Inputs: REPO, ISSUE_NUMBER, ISSUE_BODY, ISSUE_LABELS_JSON, GH_TOKEN.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseIssueForm } from "./lib.mjs";

export const MARKER = "<!-- lanes:issue-contract -->";

export function issuePlan(body, labels) {
  if (!/^### Goal\s*$/m.test(String(body ?? "").replace(/\r\n/g, "\n"))) return { isTask: false, add: [], remove: [], comment: "" };
  const r = parseIssueForm(body);
  const tierLabels = labels.filter((l) => l.startsWith("tier:"));
  if (!r.ok) {
    return {
      isTask: true,
      add: [],
      remove: labels.includes("ready") ? ["ready"] : [],
      comment: `${MARKER}\n**Task contract incomplete**, so this issue is not ready:\n${r.errors.map((e) => `- ${e}`).join("\n")}`,
    };
  }
  const want = `tier:${r.fields.tier}`;
  return {
    isTask: true,
    add: [want, "ready"],
    remove: tierLabels.filter((l) => l !== want),
    comment: `${MARKER}\nTask contract complete: tier ${r.fields.tier}, ${r.fields.criteria.length} acceptance criteria.`,
  };
}

const gh = (args) => execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function main(env = process.env) {
  const { REPO: repo, ISSUE_NUMBER: n } = env;
  const plan = issuePlan(env.ISSUE_BODY, JSON.parse(env.ISSUE_LABELS_JSON || "[]"));
  if (!plan.isTask) return;
  const edit = ["issue", "edit", n, "-R", repo];
  if (plan.add.length) edit.push("--add-label", plan.add.join(","));
  if (plan.remove.length) edit.push("--remove-label", plan.remove.join(","));
  if (edit.length > 5) gh(edit);
  const existing = gh(["api", `repos/${repo}/issues/${n}/comments?per_page=100`, "--jq", `.[] | select(.body | startswith("${MARKER}")) | .id`]).trim().split("\n")[0];
  if (existing) gh(["api", `repos/${repo}/issues/comments/${existing}`, "-X", "PATCH", "-f", `body=${plan.comment}`]);
  else gh(["api", `repos/${repo}/issues/${n}/comments`, "-f", `body=${plan.comment}`]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
```

- [ ] **Step 4: Write `.github/workflows/issue-contract.yml`**

```yaml
name: issue-contract
on:
  issues:
    types: [opened, edited]
permissions:
  contents: read
  issues: write
jobs:
  contract:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7
        with:
          ref: ${{ github.event.repository.default_branch }}
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7
        with:
          node-version: 22
      - run: node scripts/lanes/issue-contract.mjs
        env:
          GH_TOKEN: ${{ github.token }}
          REPO: ${{ github.repository }}
          ISSUE_NUMBER: ${{ github.event.issue.number }}
          ISSUE_BODY: ${{ github.event.issue.body }}
          ISSUE_LABELS_JSON: ${{ toJson(github.event.issue.labels.*.name) }}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test scripts/lanes/issue-contract.test.mjs`
Expected: PASS, 3 tests.

- [ ] **Step 6: Commit**

```bash
git add scripts/lanes/issue-contract.mjs scripts/lanes/issue-contract.test.mjs .github/workflows/issue-contract.yml
git commit -m "feat(lanes): issue-contract check sets tier and ready labels"
```

---

### Task 7: Reviewer statuses — `post-review.mjs` and `reviewers.mjs`

Spec amendment (2026-09-26): a reviewer's success or failure is a JSON verdict validated before posting ("Reviewer verdicts are contracts too" in the spec). Free-text posting remains only for the owner's approval and for `skipped`.

**Files:**
- Create: `scripts/lanes/post-review.mjs`, `scripts/lanes/reviewers.mjs`
- Modify: `.gitignore` (add `.lanes/`, where lanes write verdict files)
- Test: `scripts/lanes/post-review.test.mjs`

**Interfaces:**
- Consumes: `REVIEWERS`, `reviewContext`, `classifyFiles`, `requiredReviewers`, `loadConfig` (Task 2); `parsePrBody`, `parseIssueForm` (Task 3).
- Produces:
  - `buildStatus(reviewer: string, verdict: "success" | "skipped", summary: string): { context, state, description }`, only for `owner` + `success` or any reviewer + `skipped`.
  - `validateVerdict(verdict: unknown, { criteriaCount: number }): { ok: boolean, errors: string[], status: { context, state, description } | null }`
  - Verdict JSON: `{ reviewer, verdict: "success"|"failure", summary, criteria: [{ index, result: "pass"|"fail"|"not-applicable", evidence }], findings: [{ severity: "critical"|"important"|"minor", file?, line?, summary, fixed: boolean }] }`
  - CLI `node scripts/lanes/post-review.mjs --file <verdict.json> [--pr N]` (posts the status and the JSON as a PR comment marked `<!-- lanes:verdict <reviewer> -->`), and `node scripts/lanes/post-review.mjs <owner|reviewer> <success|skipped> "<summary>" [--pr N]`
  - CLI `node scripts/lanes/reviewers.mjs <tier>` prints the required reviewers for `git diff --name-status origin/main...HEAD`, one per line, or `none`.

- [ ] **Step 1: Write the failing tests**

```js
// scripts/lanes/post-review.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStatus, validateVerdict } from "./post-review.mjs";

test("skipped is a success whose description starts with skipped", () => {
  assert.deepEqual(buildStatus("ui-reviewer", "skipped", "no visible change"), { context: "review/ui-reviewer", state: "success", description: "skipped: no visible change" });
});

test("a reviewer's success or failure must come as a JSON verdict", () => {
  assert.throws(() => buildStatus("test-hunter", "success", "x"), /--file/);
  assert.throws(() => buildStatus("test-hunter", "failure", "x"), /--file/);
});

test("unknown reviewer and empty summary are refused", () => {
  assert.throws(() => buildStatus("me", "skipped", "x"), /reviewer/);
  assert.throws(() => buildStatus("test-hunter", "skipped", "  "), /summary/);
});

test("the owner can only approve", () => {
  assert.equal(buildStatus("owner", "success", "approved").context, "review/owner");
  assert.throws(() => buildStatus("owner", "skipped", "x"), /owner/);
});

test("descriptions are cut to 140 characters", () => {
  assert.equal(buildStatus("test-hunter", "skipped", "x".repeat(200)).description.length, 140);
});

const verdict = (over = {}) => ({
  reviewer: "test-hunter",
  verdict: "success",
  summary: "4 tests added, 1 bug fixed",
  criteria: [
    { index: 1, result: "pass", evidence: "rejects a duplicate name" },
    { index: 2, result: "not-applicable", evidence: "no UI in this change" },
  ],
  findings: [{ severity: "important", file: "src/a.mjs", line: 3, summary: "off by one", fixed: true }],
  ...over,
});

test("a valid verdict becomes a status with derived counts", () => {
  assert.deepEqual(validateVerdict(verdict(), { criteriaCount: 2 }), {
    ok: true,
    errors: [],
    status: { context: "review/test-hunter", state: "success", description: "1/2 criteria pass, 1 fixed: 4 tests added, 1 bug fixed" },
  });
});

test("the test-hunter and ui-reviewer must assess every criterion exactly once", () => {
  assert.match(validateVerdict(verdict({ criteria: [verdict().criteria[0]] }), { criteriaCount: 2 }).errors.join(), /all 2 criteria/);
  const dup = [verdict().criteria[0], verdict().criteria[0]];
  assert.match(validateVerdict(verdict({ criteria: dup }), { criteriaCount: 2 }).errors.join(), /appears twice/);
  const out = [{ index: 3, result: "pass", evidence: "x" }];
  assert.match(validateVerdict(verdict({ criteria: out }), { criteriaCount: 2 }).errors.join(), /not 1\.\.2/);
});

test("success is refused with a failing criterion or an unfixed important finding", () => {
  const failing = [{ index: 1, result: "fail", evidence: "x" }, verdict().criteria[1]];
  assert.match(validateVerdict(verdict({ criteria: failing }), { criteriaCount: 2 }).errors.join(), /a criterion fails/);
  const open = [{ severity: "important", summary: "leak", fixed: false }];
  assert.match(validateVerdict(verdict({ findings: open }), { criteriaCount: 2 }).errors.join(), /unfixed/);
  assert.equal(validateVerdict(verdict({ verdict: "failure", findings: open }), { criteriaCount: 2 }).status.state, "failure");
});

test("an unfixed minor finding does not block success", () => {
  assert.equal(validateVerdict(verdict({ findings: [{ severity: "minor", summary: "naming", fixed: false }] }), { criteriaCount: 2 }).ok, true);
});

test("the security reviewer may leave criteria empty", () => {
  const r = validateVerdict(verdict({ reviewer: "security-reviewer", criteria: [], findings: [] }), { criteriaCount: 2 });
  assert.equal(r.ok, true);
  assert.equal(r.status.description, "0 fixed: 4 tests added, 1 bug fixed");
});

test("malformed verdicts are refused with every problem listed", () => {
  assert.deepEqual(validateVerdict(null, { criteriaCount: 1 }).errors, ["verdict must be a JSON object"]);
  const r = validateVerdict({ reviewer: "owner", verdict: "ok", summary: "", criteria: "x", findings: [{ severity: "huge" }] }, { criteriaCount: 1 });
  assert.equal(r.ok, false);
  for (const re of [/reviewer must be/, /verdict must be/, /summary is required/, /criteria must be an array/, /severity must be/, /fixed must be/]) {
    assert.match(r.errors.join("\n"), re);
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test scripts/lanes/post-review.test.mjs`
Expected: FAIL, module not found.

- [ ] **Step 3: Write `post-review.mjs`**

```js
// scripts/lanes/post-review.mjs
// Posts a review result as the commit status review/<reviewer> on a PR's current head.
// A reviewer's success or failure is a JSON verdict (the reviewer contract), validated first:
//   node scripts/lanes/post-review.mjs --file .lanes/verdicts/test-hunter.json [--pr N]
// Free text only for the owner's approval and for a reviewer the tier does not need:
//   node scripts/lanes/post-review.mjs owner success "approved by owner" --pr N   (asks for permission)
//   node scripts/lanes/post-review.mjs ui-reviewer skipped "no visible change"
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseIssueForm, parsePrBody, REVIEWERS, reviewContext } from "./lib.mjs";

const RESULTS = ["pass", "fail", "not-applicable"];
const SEVERITIES = ["critical", "important", "minor"];
/** Reviewers that judge the acceptance criteria themselves, so they must assess every one. */
const MUST_COVER = ["test-hunter", "ui-reviewer"];

export function buildStatus(reviewer, verdict, summary) {
  if (![...REVIEWERS, "owner"].includes(reviewer)) throw new Error(`reviewer must be one of ${[...REVIEWERS, "owner"].join(", ")}`);
  if (reviewer === "owner" && verdict !== "success") throw new Error("the owner verdict is only 'success' (approve); to reject, comment on the PR");
  if (reviewer !== "owner" && verdict !== "skipped") throw new Error("a reviewer posts success or failure as a JSON verdict: --file <verdict.json>");
  const text = String(summary ?? "").trim();
  if (!text) throw new Error("summary is required");
  return {
    context: reviewContext(reviewer),
    state: "success",
    description: (verdict === "skipped" ? `skipped: ${text}` : text).slice(0, 140),
  };
}

export function validateVerdict(v, { criteriaCount }) {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return { ok: false, errors: ["verdict must be a JSON object"], status: null };
  const errors = [];
  if (!REVIEWERS.includes(v.reviewer)) errors.push(`reviewer must be one of ${REVIEWERS.join(", ")}`);
  if (!["success", "failure"].includes(v.verdict)) errors.push("verdict must be success or failure");
  if (typeof v.summary !== "string" || !v.summary.trim()) errors.push("summary is required");
  let criteria = [];
  if (Array.isArray(v.criteria)) criteria = v.criteria;
  else errors.push("criteria must be an array");
  let findings = [];
  if (Array.isArray(v.findings)) findings = v.findings;
  else errors.push("findings must be an array");

  const seen = new Set();
  for (const c of criteria) {
    const index = c?.index;
    if (!Number.isInteger(index) || index < 1 || index > criteriaCount) errors.push(`criterion index ${index} is not 1..${criteriaCount}`);
    else if (seen.has(index)) errors.push(`criterion ${index} appears twice`);
    else seen.add(index);
    if (!RESULTS.includes(c?.result)) errors.push(`criterion ${index}: result must be ${RESULTS.join(", ")}`);
    if (typeof c?.evidence !== "string" || !c.evidence.trim()) errors.push(`criterion ${index}: evidence is required`);
  }
  if (MUST_COVER.includes(v.reviewer) && seen.size !== criteriaCount) {
    errors.push(`${v.reviewer} must assess all ${criteriaCount} criteria (got ${seen.size})`);
  }
  findings.forEach((f, i) => {
    if (!SEVERITIES.includes(f?.severity)) errors.push(`finding ${i + 1}: severity must be ${SEVERITIES.join(", ")}`);
    if (typeof f?.summary !== "string" || !f.summary.trim()) errors.push(`finding ${i + 1}: summary is required`);
    if (typeof f?.fixed !== "boolean") errors.push(`finding ${i + 1}: fixed must be true or false`);
  });
  if (v.verdict === "success") {
    if (criteria.some((c) => c?.result === "fail")) errors.push("success is refused: a criterion fails");
    if (findings.some((f) => (f?.severity === "critical" || f?.severity === "important") && f?.fixed !== true)) {
      errors.push("success is refused: an unfixed critical or important finding");
    }
  }
  if (errors.length) return { ok: false, errors, status: null };

  const fixed = findings.filter((f) => f.fixed).length;
  const pass = criteria.filter((c) => c.result === "pass").length;
  const counts = criteria.length ? `${pass}/${criteriaCount} criteria pass, ${fixed} fixed` : `${fixed} fixed`;
  return {
    ok: true,
    errors: [],
    status: { context: reviewContext(v.reviewer), state: v.verdict, description: `${counts}: ${v.summary.trim()}`.slice(0, 140) },
  };
}

const gh = (args) => execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const flagValue = (argv, flag) => (argv.indexOf(flag) >= 0 ? argv[argv.indexOf(flag) + 1] : undefined);

function main(argv = process.argv.slice(2)) {
  const prNumber = flagValue(argv, "--pr");
  const pr = JSON.parse(gh(["pr", "view", ...(prNumber ? [prNumber] : []), "--json", "number,headRefOid,body"]));
  const repo = gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]).trim();
  const file = flagValue(argv, "--file");
  let status;
  let comment = null;
  if (file) {
    const closes = parsePrBody(pr.body).closes;
    if (closes === null) throw new Error("the PR body has no 'Closes #N' outside code fences; fix the PR body first");
    const issue = JSON.parse(gh(["issue", "view", String(closes), "--json", "body"]));
    const verdict = JSON.parse(readFileSync(file, "utf8"));
    const result = validateVerdict(verdict, { criteriaCount: parseIssueForm(issue.body).fields.criteria.length });
    if (!result.ok) throw new Error(`verdict refused:\n- ${result.errors.join("\n- ")}`);
    status = result.status;
    comment = `<!-- lanes:verdict ${verdict.reviewer} -->\n\`\`\`json\n${JSON.stringify(verdict, null, 2)}\n\`\`\``;
  } else {
    const positional = argv.filter((a, i) => !a.startsWith("--") && !(argv[i - 1] ?? "").startsWith("--"));
    status = buildStatus(...positional);
  }
  gh(["api", `repos/${repo}/statuses/${pr.headRefOid}`, "-f", `state=${status.state}`, "-f", `context=${status.context}`, "-f", `description=${status.description}`]);
  if (comment) gh(["pr", "comment", String(pr.number), "--body", comment]);
  console.log(`${status.context}=${status.state} on #${pr.number} at ${pr.headRefOid.slice(0, 7)}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
```

- [ ] **Step 4: Write `reviewers.mjs`**

```js
// scripts/lanes/reviewers.mjs
// Prints the reviewers this branch's diff needs for a tier: node scripts/lanes/reviewers.mjs <skip|quick|full>
import { execFileSync } from "node:child_process";
import { classifyFiles, loadConfig, requiredReviewers, TIERS } from "./lib.mjs";

const tier = process.argv[2];
if (!TIERS.includes(tier)) throw new Error(`usage: reviewers.mjs <${TIERS.join("|")}>`);
// --name-status lists both names of a rename (R100<TAB>old<TAB>new), like the gate does.
const files = execFileSync("git", ["diff", "--name-status", "origin/main...HEAD"], { encoding: "utf8" })
  .split("\n")
  .filter(Boolean)
  .flatMap((line) => line.split("\t").slice(1));
const cls = classifyFiles(files, loadConfig());
if (tier === "skip" && !cls.skipOnly) console.log("NOT SKIP: the diff changes files outside the skip paths; use quick or full");
const list = requiredReviewers(tier, cls);
console.log(list.length ? list.join("\n") : "none");
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test scripts/lanes/post-review.test.mjs`
Expected: PASS, 11 tests.

- [ ] **Step 6: Ignore the lanes' local verdict files**

Append this line to `.gitignore`:
```
.lanes/
```

- [ ] **Step 7: Commit**

```bash
git add scripts/lanes/post-review.mjs scripts/lanes/post-review.test.mjs scripts/lanes/reviewers.mjs .gitignore
git commit -m "feat(lanes): JSON reviewer verdicts, post-review and reviewers CLIs"
```

---

### Task 8: CI (`verify`, `security`), preflight and the pre-push hook

**Files:**
- Create: `.github/workflows/verify.yml`, `.github/workflows/security.yml`, `.githooks/pre-push`
- Create (ported): `scripts/preflight.mjs`, `scripts/preflight.test.mjs`

**Interfaces:**
- Produces: required checks named `verify` and `security` (job names), running on `pull_request` and `merge_group`.

- [ ] **Step 1: Write `.github/workflows/verify.yml`**

```yaml
name: verify
on:
  pull_request:
  merge_group:
permissions:
  contents: read
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7
        with:
          node-version: 22
      - run: npm test
```

- [ ] **Step 2: Write `.github/workflows/security.yml`** (ported from satisfactory-dash's `security` job)

```yaml
name: security
on:
  pull_request:
  merge_group:
permissions:
  contents: read
jobs:
  security:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7
      - name: Check for PII or hardcoded local paths
        # Patterns come from the PII_PATTERNS repository SECRET (one fixed string per line), never a variable:
        # Actions prints a step's env block unmasked, and only secrets are masked. Only file:line is printed.
        # -H is required: with a single file grep omits the filename and cut would keep the matched text.
        env:
          PII_PATTERNS: ${{ secrets.PII_PATTERNS }}
        run: |
          PATTERNS=$(mktemp)
          printf '%s\n' "$PII_PATTERNS" | sed '/^[[:space:]]*$/d' > "$PATTERNS"
          # Appends the four local-path patterns listed in .github/workflows/security.yml (not repeated here).
          if [ -z "$PII_PATTERNS" ]; then
            echo "::warning::PII_PATTERNS secret is not available; only checking for local paths."
          fi
          # LICENSE names the copyright holder on purpose; .github/ and CLAUDE.md files document the patterns.
          HITS=$(git ls-files | grep -vE '^(\.github/|.*CLAUDE\.md$|LICENSE$)' | xargs -r grep -H -n -iF -f "$PATTERNS" | cut -d: -f1,2 || true)
          if [ -n "$HITS" ]; then
            echo "$HITS"
            echo "::error::Possible PII or hardcoded-path leak at the file:line locations above."
            exit 1
          fi
```

- [ ] **Step 3: Port the preflight script**

Run: `MSYS_NO_PATHCONV=1 git -C ../satisfactory-dash show origin/main:scripts/preflight.mjs > scripts/preflight.mjs` and the same for `scripts/preflight.test.mjs`. If satisfactory-dash PR #299 has not merged yet, use `6b7322f0b038d791bc147150bdfb032c3ecdf392` instead of `origin/main`.
Then open `scripts/preflight.mjs`, find its exemption list (it mirrors satisfactory-dash's ci.yml security exclusions), and change it to exactly `.github/`, `CLAUDE.md` files and `LICENSE`, matching Step 2. Remove any satisfactory-dash-only checks (for example a `node_modules` check for workspaces that do not exist here) and their tests.

- [ ] **Step 4: Run the ported tests**

Run: `node --test scripts/preflight.test.mjs`
Expected: PASS. Fix the tests that referenced removed checks by deleting them, not by weakening the remaining ones.

- [ ] **Step 5: Write the hook and enable it**

`.githooks/pre-push`:
```sh
#!/bin/sh
# Runs the same PII, path and conflict checks as CI before anything leaves this machine.
exec node scripts/preflight.mjs
```

Run: `chmod +x .githooks/pre-push && npm run setup && git config core.hooksPath`
Expected: `.githooks`

- [ ] **Step 6: Run the full suite**

Run: `set -o pipefail; npm test 2>&1 | tail -8`
Expected: the summary line shows `fail 0`.

- [ ] **Step 7: Commit**

```bash
git add .github/workflows/verify.yml .github/workflows/security.yml .githooks/pre-push scripts/preflight.mjs scripts/preflight.test.mjs
git commit -m "ci: verify and security checks, preflight and pre-push hook"
```

---

### Task 9: `/status` and the nightly digest — `status.mjs`

**Files:**
- Create: `scripts/lanes/status.mjs`
- Test: `scripts/lanes/status.test.mjs`

**Interfaces:**
- Consumes: `parsePrBody`, `GATE_CONTEXT` (Tasks 3–4).
- Produces:
  - `summarize({ prs, issues, merged }): { waitingOnOwner: Item[], inFlight: Item[], ready: Item[], merged: Item[] }` where `Item = { number: number, title: string, stage: string, note: string }`
  - `render(summary, sinceLabel: string): string`
  - CLI `node scripts/lanes/status.mjs [--since 24h] [--json]`. The `--json` output is **snapshot v0**, the seed of the dashboard's contract (the dashboard spec may replace it).

- [ ] **Step 1: Write the failing tests**

```js
// scripts/lanes/status.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { render, summarize } from "./status.mjs";

const body = (needs = "nothing") => `Closes #1\n## What changed\nx\n## Contract changes\nnone\n## Tests added\nx\n## Reviewer results\nx\n## Needs the owner\n${needs}\n## Not done\nnothing`;
const gate = (state, description) => ({ __typename: "StatusContext", context: "lanes/gate", state, description });
const pr = (number, rollup, extra = {}) => ({ number, title: `pr ${number}`, body: body(), statusCheckRollup: rollup, autoMergeRequest: null, closingIssuesReferences: [], ...extra });

test("stages come from lanes/gate and failing checks", () => {
  const s = summarize({
    prs: [
      pr(1, [gate("PENDING", "waiting on owner (/approve)")]),
      pr(2, [gate("PENDING", "waiting for review/test-hunter")]),
      pr(3, [gate("SUCCESS", "ok")], { autoMergeRequest: {} }),
      pr(4, [{ __typename: "CheckRun", name: "verify", status: "COMPLETED", conclusion: "FAILURE" }]),
      pr(5, []),
    ],
    issues: [],
    merged: [],
  });
  assert.deepEqual(s.waitingOnOwner.map((i) => i.number), [1]);
  assert.deepEqual(s.inFlight.map((i) => [i.number, i.stage]), [[2, "review"], [3, "queued"], [4, "failing"], [5, "starting"]]);
  assert.match(s.inFlight.find((i) => i.number === 4).note, /verify/);
});

test("a PR whose body needs the owner is waiting on him even mid-review", () => {
  const s = summarize({ prs: [pr(6, [gate("PENDING", "waiting for review/test-hunter")], { body: body("pick a name for the package") })], issues: [], merged: [] });
  assert.deepEqual(s.waitingOnOwner.map((i) => [i.number, i.note]), [[6, "needs: pick a name for the package"]]);
});

test("ready issues exclude ones an open PR already closes", () => {
  const s = summarize({
    prs: [pr(7, [], { closingIssuesReferences: [{ number: 10 }] })],
    issues: [{ number: 10, title: "a", labels: [{ name: "tier:quick" }] }, { number: 11, title: "b", labels: [{ name: "tier:skip" }] }],
    merged: [],
  });
  assert.deepEqual(s.ready.map((i) => [i.number, i.stage]), [[11, "skip"]]);
});

test("render prints the four sections with counts", () => {
  const text = render({ waitingOnOwner: [], inFlight: [{ number: 2, title: "t", stage: "review", note: "waiting for review/test-hunter" }], ready: [], merged: [] }, "24h");
  assert.match(text, /WAITING ON YOU \(0\)/);
  assert.match(text, /IN FLIGHT \(1\)\n  #2 \[review\] t — waiting for review\/test-hunter/);
  assert.match(text, /MERGED, last 24h \(0\)/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test scripts/lanes/status.test.mjs`
Expected: FAIL, module not found.

- [ ] **Step 3: Write `status.mjs`**

```js
// scripts/lanes/status.mjs
// /status and the nightly digest: what waits on the owner, what is in flight, what is ready, what merged.
// Usage: node scripts/lanes/status.mjs [--since 24h] [--json]
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { GATE_CONTEXT, parsePrBody } from "./lib.mjs";

const FAILED = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"]);

function prStage(pr) {
  const rollup = pr.statusCheckRollup ?? [];
  const failing = rollup
    .filter((c) => c.context !== GATE_CONTEXT && (FAILED.has(c.conclusion) || FAILED.has(c.state)))
    .map((c) => c.name ?? c.context);
  if (failing.length) return { stage: "failing", note: `failing: ${failing.join(", ")}` };
  const gate = rollup.find((c) => c.context === GATE_CONTEXT);
  if (!gate) return { stage: "starting", note: "no lanes/gate yet" };
  if (gate.state === "SUCCESS") return pr.autoMergeRequest ? { stage: "queued", note: "auto-merge on" } : { stage: "ready", note: "auto-merge is off" };
  if (gate.state === "FAILURE" || gate.state === "ERROR") return { stage: "contract", note: gate.description ?? "" };
  if (String(gate.description).startsWith("waiting on owner")) return { stage: "owner", note: gate.description };
  return { stage: "review", note: gate.description ?? "" };
}

export function summarize({ prs, issues, merged }) {
  const out = { waitingOnOwner: [], inFlight: [], ready: [], merged: [] };
  const taken = new Set();
  for (const pr of prs) {
    for (const ref of pr.closingIssuesReferences ?? []) taken.add(ref.number);
    const { stage, note } = prStage(pr);
    const needs = (parsePrBody(pr.body).sections["needs the owner"] ?? "").trim();
    const item = { number: pr.number, title: pr.title, stage, note };
    if (stage === "owner") out.waitingOnOwner.push(item);
    else if (needs && !/^nothing\b/i.test(needs)) out.waitingOnOwner.push({ ...item, note: `needs: ${needs.split("\n")[0]}` });
    else out.inFlight.push(item);
  }
  for (const issue of issues) {
    if (taken.has(issue.number)) continue;
    const tier = (issue.labels ?? []).map((l) => l.name).find((n) => n.startsWith("tier:"))?.slice(5) ?? "?";
    out.ready.push({ number: issue.number, title: issue.title, stage: tier, note: "" });
  }
  for (const pr of merged) out.merged.push({ number: pr.number, title: pr.title, stage: "merged", note: "" });
  return out;
}

export function render(summary, sinceLabel) {
  const block = (title, items, withStage = true) =>
    [`${title} (${items.length})`, ...items.map((i) => `  #${i.number}${withStage ? ` [${i.stage}]` : ""} ${i.title}${i.note ? ` — ${i.note}` : ""}`)].join("\n");
  return [
    block("WAITING ON YOU", summary.waitingOnOwner),
    block("IN FLIGHT", summary.inFlight),
    block("READY TO START", summary.ready),
    block(`MERGED, last ${sinceLabel}`, summary.merged, false),
  ].join("\n\n");
}

const gh = (args) => JSON.parse(execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));

function main(argv = process.argv.slice(2)) {
  const sinceIdx = argv.indexOf("--since");
  const sinceLabel = sinceIdx >= 0 ? argv[sinceIdx + 1] : "24h";
  const hours = Number(/^(\d+)h$/.exec(sinceLabel)?.[1]);
  if (!hours) throw new Error("--since takes hours, for example 12h");
  const since = new Date(Date.now() - hours * 3600_000).toISOString().slice(0, 19);
  const data = {
    prs: gh(["pr", "list", "--state", "open", "--limit", "100", "--json", "number,title,body,statusCheckRollup,autoMergeRequest,closingIssuesReferences"]),
    issues: gh(["issue", "list", "--state", "open", "--label", "ready", "--limit", "100", "--json", "number,title,labels"]),
    merged: gh(["pr", "list", "--state", "merged", "--search", `merged:>=${since}`, "--limit", "100", "--json", "number,title"]),
  };
  const summary = summarize(data);
  console.log(argv.includes("--json") ? JSON.stringify({ version: 0, generatedAt: new Date().toISOString(), since: sinceLabel, ...summary }, null, 2) : render(summary, sinceLabel));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test scripts/lanes/status.test.mjs`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/lanes/status.mjs scripts/lanes/status.test.mjs
git commit -m "feat(lanes): /status and digest summary (snapshot v0)"
```

---

### Task 10: Claude commands and settings

**Files:**
- Create: `.claude/settings.json`, `.claude/commands/lane.md`, `status.md`, `approve.md`, `adr.md`, `health.md`, `night.md`, `plan-issues.md` (spec amendment 2026-09-26)
- Test: extend `scripts/lanes/workflow.test.mjs`

**Interfaces:**
- Consumes: the CLIs from Tasks 7 and 9.

- [ ] **Step 1: Add the failing tests to `workflow.test.mjs`**

```js
test("settings: the owner's approval always asks; reviewers are allowed; no force push", () => {
  const s = JSON.parse(readFileSync(".claude/settings.json", "utf8"));
  assert.ok(s.permissions.ask.includes("Bash(node scripts/lanes/post-review.mjs owner:*)"));
  assert.ok(!s.permissions.allow.some((r) => r.includes("post-review.mjs owner")));
  assert.ok(s.permissions.allow.includes("Bash(node scripts/lanes/post-review.mjs --file:*)"));
  assert.ok(s.permissions.allow.includes("Bash(node scripts/lanes/post-review.mjs test-hunter:*)"));
  assert.ok(s.permissions.deny.includes("Bash(git push --force:*)"));
  // agent-skills is this repo's practice layer; two process frameworks must not compete (owner, 2026-09-26).
  assert.equal(s.enabledPlugins["superpowers@superpowers-marketplace"], false);
});

test("every command file has a description", () => {
  for (const name of ["lane", "status", "approve", "adr", "health", "night", "plan-issues"]) {
    assert.match(readFileSync(`.claude/commands/${name}.md`, "utf8"), /^---\ndescription: .+/, name);
  }
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test scripts/lanes/workflow.test.mjs`
Expected: FAIL, ENOENT for `.claude/settings.json`.

- [ ] **Step 3: Write `.claude/settings.json`**

```json
{
  "permissions": {
    "allow": [
      "Bash(npm test)",
      "Bash(npm test:*)",
      "Bash(npm run preflight)",
      "Bash(npm run status:*)",
      "Bash(node --test:*)",
      "Bash(node scripts/lanes/status.mjs:*)",
      "Bash(node scripts/lanes/reviewers.mjs:*)",
      "Bash(node scripts/lanes/post-review.mjs test-hunter:*)",
      "Bash(node scripts/lanes/post-review.mjs ui-reviewer:*)",
      "Bash(node scripts/lanes/post-review.mjs security-reviewer:*)",
      "Bash(node scripts/lanes/post-review.mjs architecture-advisor:*)",
      "Bash(node scripts/lanes/post-review.mjs --file:*)",
      "Bash(gh pr view:*)",
      "Bash(gh pr diff:*)",
      "Bash(gh pr list:*)",
      "Bash(gh pr checks:*)",
      "Bash(gh pr create:*)",
      "Bash(gh pr merge:*)",
      "Bash(gh issue view:*)",
      "Bash(gh issue list:*)",
      "Bash(gh issue create:*)",
      "Bash(gh issue comment:*)",
      "Bash(gh run view:*)",
      "Bash(gh run list:*)",
      "Bash(git status:*)",
      "Bash(git diff:*)",
      "Bash(git log:*)",
      "Bash(git fetch:*)",
      "Bash(git worktree:*)",
      "Bash(git switch:*)",
      "Bash(git add:*)",
      "Bash(git commit:*)",
      "Bash(git merge origin/main:*)",
      "Bash(git push:*)"
    ],
    "ask": ["Bash(node scripts/lanes/post-review.mjs owner:*)"],
    "deny": ["Bash(git push --force:*)", "Bash(git push -f:*)", "Bash(git push --force-with-lease:*)"]
  },
  "enabledPlugins": {
    "superpowers@superpowers-marketplace": false
  }
}
```

- [ ] **Step 4: Write the commands**

`.claude/commands/lane.md`:
```markdown
---
description: Work one task issue end to end as a lane (worktree, tests first, reviewers by tier, PR with the return contract)
argument-hint: <issue-number>
---
You are a lane for issue #$ARGUMENTS. You own this one issue until its PR is open with auto-merge on. Do not work on
anything else, and never message other sessions: everything you need is in the issue and the files it links.

1. `gh issue view $ARGUMENTS --json title,body,labels,state`. Stop and report if it is not open, lacks the `ready`
   label, or lacks exactly one `tier:*` label.
2. For each issue under "Blocked by": `gh issue view <N> --json state`. Stop and report if any is OPEN.
3. `git fetch origin`, then work in a new worktree on branch `issue-$ARGUMENTS-<short-slug>` from `origin/main`
   (use the EnterWorktree tool when available, otherwise `git worktree add`). Run `npm run setup` in it.
4. Read the issue's Interface contract and Scope. Touch nothing out of scope. If the contract is wrong or missing,
   stop and file a new task issue for the contract instead of inventing one.
5. Tests first: one failing test per acceptance criterion. Run it narrowly (`node --test <file>` or the project's
   equivalent) and watch it fail, then implement until it passes. Run the full suite once at the end.
6. `node scripts/lanes/reviewers.mjs <tier>` lists the reviewers this diff needs. Spawn each as a fresh subagent,
   never a fork, with model sonnet: test-hunter (FULL for tier full, QUICK for tier quick), ui-reviewer,
   security-reviewer, architecture-advisor. Give each the issue's numbered acceptance criteria and require its final
   message to end with a JSON verdict: `{ "reviewer", "verdict": "success"|"failure", "summary", "criteria":
   [{ "index", "result": "pass"|"fail"|"not-applicable", "evidence" }], "findings": [{ "severity":
   "critical"|"important"|"minor", "file", "line", "summary", "fixed" }] }`. The test-hunter and ui-reviewer assess
   every criterion by its 1-based index. Fix what they find (one more round only if they found real bugs), set
   `fixed` truthfully, and save each verdict to `.lanes/verdicts/<reviewer>.json`. After the final push, post each:
   `node scripts/lanes/post-review.mjs --file .lanes/verdicts/<reviewer>.json`. A refused verdict prints why; fix the
   JSON or the code, never the facts. Never post a verdict for a review you did not run.
7. `npm run preflight`, push, then `gh pr create` with the PR template filled in completely: "Closes #$ARGUMENTS",
   every acceptance criterion mapped under "What changed", "Contract changes" starting with none, additive or
   breaking, and "Needs the owner" saying exactly what he must decide, or "nothing". Then `gh pr merge <N> --auto`.
8. Follow-up work becomes new issues from the Task form (`gh issue create --template task.yml` or the web form),
   with every field filled. Never leave follow-ups only in the PR text.
9. If CI fails twice on the same cause, stop: comment the cause on the PR and file an issue. Do not loop.
10. End with the PR URL, the lanes/gate state and a two-sentence summary.
```

`.claude/commands/status.md`:
```markdown
---
description: Show what waits on the owner, what is in flight, what is ready and what merged
argument-hint: "[--since 12h]"
---
Run `node scripts/lanes/status.mjs $ARGUMENTS` and show its output as is. Do not act on anything it lists.
```

`.claude/commands/approve.md`:
```markdown
---
description: The owner approves a PR (posts review/owner on its head). Owner only; never run from a lane.
argument-hint: <pr-number>
---
This is the owner's approval of PR #$ARGUMENTS. If you are a lane or were started by a schedule, stop now.

1. Show `gh pr view $ARGUMENTS --json title,body,headRefOid` (title, "Needs the owner", "Contract changes") and
   `gh pr diff $ARGUMENTS --name-only`.
2. Run `node scripts/lanes/post-review.mjs owner success "approved by owner" --pr $ARGUMENTS`. This asks for
   permission on purpose: the owner's approval of the prompt is the approval.
3. Run `gh pr merge $ARGUMENTS --auto` and report the lanes/gate state.
```

`.claude/commands/adr.md`:
```markdown
---
description: Architecture review of an issue or PR; records the decision as an ADR
argument-hint: <issue-or-pr-number>
---
Spawn the architecture-advisor agent as a fresh subagent on #$ARGUMENTS (`gh issue view` or `gh pr view`, and the
files they link). It decides with evidence. Record the decision as `docs/adr/NNNN-<slug>.md` (next number; Context,
Decision, Consequences) in its own tier:skip task issue and PR, and link it from #$ARGUMENTS. If the decision changes
an interface, the ADR names the contract file, and the implementing issues list the contract issue under "Blocked by".
```

`.claude/commands/health.md`:
```markdown
---
description: Weekly health check (stale work, red main, flaky checks, stuck chains)
---
Report, in at most 15 lines:
1. `node scripts/lanes/status.mjs --since 168h`.
2. Ready issues older than 7 days and open PRs older than 3 days (`gh issue list` / `gh pr list` with `--json createdAt`).
3. `gh run list --branch main --status failure --limit 10`: is main red now, and which workflows failed more than once.
4. PRs whose lanes/gate failed on the contract (stage `contract`): the fix is usually the PR body or the issue's tier.
File one task issue per real problem (tier skip or quick). Do not fix anything in this session.
```

`.claude/commands/night.md`:
```markdown
---
description: The unattended night run (for a scheduled cloud session). Low-risk lanes only, capped.
---
You are the unattended night run. Nobody is watching; nothing you do may need a permission prompt or the owner.

1. `gh run list --branch main --limit 5 --json conclusion`: if main's latest run failed, do no lane work; go to step 4.
2. `node scripts/lanes/status.mjs --json`: pick at most 3 issues from `ready` with stage `skip` or `quick`, oldest
   first, whose "Blocked by" issues are all closed.
3. For each, follow `.claude/commands/lane.md` exactly, one at a time. Never post `review/owner`; never touch
   `.github/`, `.claude/`, `scripts/lanes/` or `lanes.config.json` (those PRs need the owner anyway). Stop a lane after
   2 CI failures. Stop the whole run after 3 PRs or 3 hours.
4. The digest: `node scripts/lanes/status.mjs --since 12h`. Post it as a comment on the open issue labelled `digest`
   (create it titled "Lanes digest" with that label if none exists), headed with today's date.
5. Never run `/plan-issues` or `/approve`: both need the owner.
```

`.claude/commands/plan-issues.md`:
```markdown
---
description: Turn a short idea into Task issues (a draft for the owner to approve first). Owner only; never unattended.
argument-hint: "<the idea in 1-4 sentences>"
---
You are the planner. The idea: $ARGUMENTS

1. Read enough of the repository to ground the plan (README, docs/, the areas the idea touches). Do not write code.
2. Draft at most 6 Task issues into `.lanes/plans/<short-slug>.md`, each with every field of the Task form: Goal (one
   sentence), Acceptance criteria (checkable `- [ ]` lines, each one testable), Interface contract (a file path, or
   none), Scope (in and out), Blocked by, Tier (skip, quick or full). If two issues meet at an interface, the first
   issue is the contract itself (a type plus schema plus contract test) and the others list it under Blocked by.
   Prefer fewer, sharper issues; leave anything speculative out and list it under "Not planned" at the end.
3. Show the owner the draft: one line per issue (title, tier, blocked by), then the path. Stop and wait. Do not create
   anything on GitHub until the owner approves, and apply every edit the owner asks for to the draft first.
4. After approval, create the issues in order with `gh issue create --title "<title>" --body-file <file>`, writing
   each body in the Task form's layout (`### Goal`, `### Acceptance criteria`, `### Interface contract`, `### Scope`,
   `### Blocked by`, `### Tier`), and replace draft references ("issue 1") with the real numbers as they are created.
5. Report the created issue numbers. The issue-contract check labels each complete one `tier:*` and `ready`.
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test scripts/lanes/workflow.test.mjs`
Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
git add .claude scripts/lanes/workflow.test.mjs
git commit -m "feat(lanes): Claude commands (/lane /status /approve /adr /health /night /plan-issues) and permissions"
```

---

### Task 10b: The in-lane practice layer — vendor agent-skills at a pinned commit

Owner decision (2026-09-26): Addy Osmani's agent-skills (MIT) is the practice layer inside a lane, vendored at a reviewed commit and never tracking `main`, because unattended lanes follow these prompts. Lanes' gates and contracts are unchanged. Superpowers is off in this repo (Task 10's settings).

**Files:**
- Create: `.claude/skills/<name>/` for exactly these skills: `test-driven-development`, `incremental-implementation`, `api-and-interface-design`, `planning-and-task-breakdown`, `debugging-and-error-recovery`, `frontend-ui-engineering`, `security-and-hardening`, `code-review-and-quality`
- Create: `vendor/agent-skills/references/` with exactly `definition-of-done.md`, `testing-patterns.md`, `security-checklist.md`, `accessibility-checklist.md`
- Create: `vendor/agent-skills/LICENSE` (the upstream MIT licence, verbatim) and `vendor/agent-skills/VENDORED.md`
- Modify: `.claude/commands/lane.md`, `.claude/commands/plan-issues.md`
- Test: extend `scripts/lanes/workflow.test.mjs`

**Interfaces:**
- Upstream: `https://github.com/addyosmani/agent-skills` at commit `2686b620fc1fed2e8f60c704839c766b8594c6b6`. Do NOT vendor its commands (`/plan`, `/review`, ...): they would clash with lanes' commands.

- [ ] **Step 1: Write the failing tests** (append to `scripts/lanes/workflow.test.mjs`)

```js
const VENDORED_SKILLS = ["test-driven-development", "incremental-implementation", "api-and-interface-design", "planning-and-task-breakdown", "debugging-and-error-recovery", "frontend-ui-engineering", "security-and-hardening", "code-review-and-quality"];

test("the vendored agent-skills are pinned, licensed and complete", () => {
  const vendored = readFileSync("vendor/agent-skills/VENDORED.md", "utf8");
  assert.match(vendored, /2686b620fc1fed2e8f60c704839c766b8594c6b6/);
  assert.match(readFileSync("vendor/agent-skills/LICENSE", "utf8"), /MIT License/);
  for (const name of VENDORED_SKILLS) assert.match(readFileSync(`.claude/skills/${name}/SKILL.md`, "utf8"), /^---\nname: /, name);
});

test("lanes point at the practice layer", () => {
  const lane = readFileSync(".claude/commands/lane.md", "utf8");
  for (const name of ["test-driven-development", "incremental-implementation", "api-and-interface-design"]) assert.match(lane, new RegExp(name));
  assert.match(readFileSync(".claude/commands/plan-issues.md", "utf8"), /planning-and-task-breakdown/);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test scripts/lanes/workflow.test.mjs`
Expected: FAIL, ENOENT for `vendor/agent-skills/VENDORED.md`.

- [ ] **Step 3: Fetch exactly the pinned commit**

Run (from the repo root; the scratch clone stays outside the repo):
```bash
git clone --quiet https://github.com/addyosmani/agent-skills ../agent-skills-pin && git -C ../agent-skills-pin checkout --quiet 2686b620fc1fed2e8f60c704839c766b8594c6b6 && git -C ../agent-skills-pin log -1 --format=%H
```
Expected: `2686b620fc1fed2e8f60c704839c766b8594c6b6`.

- [ ] **Step 4: Security read before copying anything**

Read every file of the eight skill folders and the four reference files in full. Report in `VENDORED.md` under "Security read": any instruction to fetch URLs or install packages, run network or shell commands beyond ordinary build and test commands, read credentials or environment secrets, disable checks or hooks, push, or override the user's or project's rules. If any file does one of these, STOP and report BLOCKED with the file and line; do not vendor it.
Also run the repository's own path scan over those files: read the four local-path patterns from `.github/workflows/security.yml` (the fixed `printf` line, not the one built from `$PII_PATTERNS`) and grep, case-insensitively and fixed-string, for each of them across `../agent-skills-pin/skills/{test-driven-development,incremental-implementation,api-and-interface-design,planning-and-task-breakdown,debugging-and-error-recovery,frontend-ui-engineering,security-and-hardening,code-review-and-quality}` and `../agent-skills-pin/references/{definition-of-done,testing-patterns,security-checklist,accessibility-checklist}.md`.
If it prints anything, STOP and report NEEDS_CONTEXT with the `file:line` list only (the security CI check would fail on those lines).

- [ ] **Step 5: Copy, fix reference links, write VENDORED.md**

Copy the eight skill folders unchanged into `.claude/skills/`, the four reference files into `vendor/agent-skills/references/`, and upstream `LICENSE` into `vendor/agent-skills/LICENSE`. Where a vendored skill links to `references/<file>` or to a skill that was NOT vendored, rewrite only that link: references to `vendor/agent-skills/references/<file>`; links to non-vendored skills become plain text. Record every rewrite in `VENDORED.md`.

`vendor/agent-skills/VENDORED.md`:
```markdown
# Vendored: agent-skills

- Upstream: https://github.com/addyosmani/agent-skills (MIT, see LICENSE in this folder)
- Commit: 2686b620fc1fed2e8f60c704839c766b8594c6b6
- Skills (in `.claude/skills/`): test-driven-development, incremental-implementation, api-and-interface-design,
  planning-and-task-breakdown, debugging-and-error-recovery, frontend-ui-engineering, security-and-hardening,
  code-review-and-quality
- References (here): definition-of-done, testing-patterns, security-checklist, accessibility-checklist
- Not vendored on purpose: the upstream commands (they clash with /lane and /plan-issues), and every other skill.

To update: pick a new commit, repeat the security read on the diff between the two commits, and change the commit
above in the same PR (tier full, owner review: unattended lanes follow these prompts).

## Link rewrites
<one line per rewritten link: file, old target, new target>

## Security read
<the Step 4 result>
```

- [ ] **Step 6: Point the commands at the practice layer**

In `.claude/commands/lane.md`, insert after step 4:
```markdown
4b. Practice (the project skills, agent-skills): build in thin vertical slices with `incremental-implementation` and
    `test-driven-development`; a contract issue follows `api-and-interface-design`; an unexpected failure goes through
    `debugging-and-error-recovery`; UI work follows `frontend-ui-engineering` and the project's design tokens.
    Hand reviewers the matching checklist from `vendor/agent-skills/references/`: the test-hunter gets
    `definition-of-done.md` and `testing-patterns.md`, the security reviewer `security-checklist.md`, the ui-reviewer
    `accessibility-checklist.md`.
```
In `.claude/commands/plan-issues.md`, add to step 2: "Follow `planning-and-task-breakdown`: each issue is one vertical slice of roughly 100 changed lines of code or less; split anything larger."

- [ ] **Step 7: Run the tests to verify they pass, then clean up**

Run: `node --test scripts/lanes/workflow.test.mjs` → PASS. Then `rm -rf ../agent-skills-pin`.

- [ ] **Step 8: Commit**

```bash
git add .claude/skills vendor/agent-skills .claude/commands/lane.md .claude/commands/plan-issues.md scripts/lanes/workflow.test.mjs
git commit -m "feat(lanes): vendor agent-skills (MIT) at 2686b62 as the in-lane practice layer"
```

---

### Task 11: `install.mjs` and `setup-repo.mjs`

**Files:**
- Create: `scripts/lanes/install.mjs`, `scripts/lanes/setup-repo.mjs`
- Test: `scripts/lanes/install.test.mjs`, `scripts/lanes/setup-repo.test.mjs`

**Interfaces:**
- Consumes: `loadConfig` (Task 2).
- Produces:
  - `MANIFEST: string[]`, `install(source: string, target: string, { force = false }): { copied: string[], skipped: string[] }`
  - `LABELS: Array<{ name, color, description }>`, `buildRuleset(requiredChecks: string[]): object`
  - CLI `node scripts/lanes/setup-repo.mjs <owner/repo>` (owner-run; changes repo settings, labels and the ruleset)

- [ ] **Step 1: Write the failing tests**

```js
// scripts/lanes/install.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { install, MANIFEST } from "./install.mjs";

test("every manifest file exists in this repo", () => {
  for (const f of MANIFEST) assert.ok(existsSync(f), f);
});

test("install copies the manifest and never overwrites without force", () => {
  const target = mkdtempSync(path.join(tmpdir(), "lanes-"));
  mkdirSync(path.join(target, "docs"), { recursive: true });
  writeFileSync(path.join(target, "lanes.config.json"), "{}");
  const r = install(".", target, {});
  assert.ok(r.skipped.includes("lanes.config.json"));
  assert.equal(readFileSync(path.join(target, "lanes.config.json"), "utf8"), "{}");
  assert.ok(existsSync(path.join(target, "scripts/lanes/gate.mjs")));
  assert.equal(install(".", target, { force: true }).skipped.length, 0);
});
```

```js
// scripts/lanes/setup-repo.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRuleset, LABELS } from "./setup-repo.mjs";

test("the ruleset requires the checks, a merge queue and CodeQL, with no bypass", () => {
  const r = buildRuleset(["verify", "security", "lanes/gate"]);
  assert.deepEqual(r.bypass_actors, []);
  const byType = Object.fromEntries(r.rules.map((x) => [x.type, x.parameters]));
  assert.deepEqual(byType.required_status_checks.required_status_checks.map((c) => c.context), ["verify", "security", "lanes/gate"]);
  assert.equal(byType.merge_queue.merge_method, "SQUASH");
  assert.equal(byType.code_scanning.code_scanning_tools[0].security_alerts_threshold, "high_or_higher");
  assert.ok("non_fast_forward" in byType && "deletion" in byType);
});

test("labels include the tiers, ready, contract:breaking and digest", () => {
  const names = LABELS.map((l) => l.name);
  for (const n of ["tier:skip", "tier:quick", "tier:full", "ready", "contract:breaking", "digest"]) assert.ok(names.includes(n), n);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test scripts/lanes/install.test.mjs scripts/lanes/setup-repo.test.mjs`
Expected: FAIL, modules not found.

- [ ] **Step 3: Write `install.mjs`**

```js
// scripts/lanes/install.mjs
// Copies the lanes workflow into another repository: node scripts/lanes/install.mjs <target-dir> [--force]
// Existing files are kept unless --force. Afterwards edit the target's lanes.config.json paths for its layout.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MANIFEST = [
  "lanes.config.json",
  ".github/ISSUE_TEMPLATE/task.yml",
  ".github/ISSUE_TEMPLATE/config.yml",
  ".github/pull_request_template.md",
  ".github/workflows/lanes-gate.yml",
  ".github/workflows/issue-contract.yml",
  ".github/workflows/security.yml",
  ".githooks/pre-push",
  ".claude/settings.json",
  ".claude/commands/lane.md",
  ".claude/commands/status.md",
  ".claude/commands/approve.md",
  ".claude/commands/adr.md",
  ".claude/commands/health.md",
  ".claude/commands/night.md",
  ".claude/commands/plan-issues.md",
  "scripts/preflight.mjs",
  "scripts/lanes/lib.mjs",
  "scripts/lanes/gate.mjs",
  "scripts/lanes/issue-contract.mjs",
  "scripts/lanes/post-review.mjs",
  "scripts/lanes/reviewers.mjs",
  "scripts/lanes/status.mjs",
  "scripts/lanes/setup-repo.mjs",
  "docs/USING.md",
];

export function install(source, target, { force = false } = {}) {
  const copied = [];
  const skipped = [];
  for (const rel of MANIFEST) {
    const to = path.join(target, rel);
    if (existsSync(to) && !force) {
      skipped.push(rel);
      continue;
    }
    mkdirSync(path.dirname(to), { recursive: true });
    copyFileSync(path.join(source, rel), to);
    copied.push(rel);
  }
  return { copied, skipped };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const target = process.argv[2];
  if (!target) throw new Error("usage: install.mjs <target-dir> [--force]");
  const r = install(".", target, { force: process.argv.includes("--force") });
  console.log(`copied ${r.copied.length}, kept ${r.skipped.length} existing${r.skipped.length ? `: ${r.skipped.join(", ")}` : ""}`);
  console.log("Next: edit lanes.config.json, add `setup` and `preflight` npm scripts, then run setup-repo.mjs (owner).");
}
```

- [ ] **Step 4: Write `setup-repo.mjs`**

```js
// scripts/lanes/setup-repo.mjs
// OWNER ONLY. Configures a GitHub repo for lanes: merge settings, labels, CodeQL default setup, and the main ruleset.
// Usage: node scripts/lanes/setup-repo.mjs <owner/repo>
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./lib.mjs";

export const LABELS = [
  { name: "tier:skip", color: "c5def5", description: "Docs, config or tests only" },
  { name: "tier:quick", color: "fbca04", description: "UI or a small fix" },
  { name: "tier:full", color: "d93f0b", description: "Logic, data, APIs or security" },
  { name: "ready", color: "0e8a16", description: "Task contract complete; a lane may start" },
  { name: "contract:breaking", color: "b60205", description: "This task may break an interface contract" },
  { name: "digest", color: "5319e7", description: "The nightly digest thread" },
];

export function buildRuleset(requiredChecks) {
  return {
    name: "main (lanes)",
    target: "branch",
    enforcement: "active",
    conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
    bypass_actors: [],
    rules: [
      { type: "deletion" },
      { type: "non_fast_forward" },
      {
        type: "pull_request",
        parameters: {
          required_approving_review_count: 0,
          dismiss_stale_reviews_on_push: false,
          require_code_owner_review: false,
          require_last_push_approval: false,
          required_review_thread_resolution: false,
          allowed_merge_methods: ["squash"],
        },
      },
      {
        type: "required_status_checks",
        parameters: { strict_required_status_checks_policy: false, required_status_checks: requiredChecks.map((context) => ({ context })) },
      },
      {
        type: "merge_queue",
        parameters: {
          check_response_timeout_minutes: 60,
          grouping_strategy: "ALLGREEN",
          max_entries_to_build: 5,
          max_entries_to_merge: 5,
          merge_method: "SQUASH",
          min_entries_to_merge: 1,
          min_entries_to_merge_wait_minutes: 1,
        },
      },
      {
        type: "code_scanning",
        parameters: { code_scanning_tools: [{ tool: "CodeQL", security_alerts_threshold: "high_or_higher", alerts_threshold: "errors" }] },
      },
    ],
  };
}

const gh = (args, input) => execFileSync("gh", args, { encoding: "utf8", input, stdio: [input ? "pipe" : "ignore", "pipe", "pipe"] });

function main(repo = process.argv[2]) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo ?? "")) throw new Error("usage: setup-repo.mjs <owner/repo>");
  gh(["repo", "edit", repo, "--enable-auto-merge", "--delete-branch-on-merge", "--enable-squash-merge", "--enable-merge-commit=false", "--enable-rebase-merge=false"]);
  for (const l of LABELS) gh(["label", "create", l.name, "-R", repo, "--color", l.color, "--description", l.description, "--force"]);
  gh(["api", `repos/${repo}/code-scanning/default-setup`, "-X", "PATCH", "-f", "state=configured"]);
  gh(["api", `repos/${repo}/rulesets`, "-X", "POST", "--input", "-"], JSON.stringify(buildRuleset(loadConfig().requiredChecks)));
  console.log(`configured ${repo}: settings, ${LABELS.length} labels, CodeQL, ruleset`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test scripts/lanes/install.test.mjs scripts/lanes/setup-repo.test.mjs`
Expected: the setup-repo tests PASS. The install test fails until `docs/USING.md` exists (Task 12); create an empty `docs/USING.md` placeholder file now only if you run Task 11 before Task 12, and Task 12 overwrites it.

- [ ] **Step 6: Commit**

```bash
git add scripts/lanes/install.mjs scripts/lanes/install.test.mjs scripts/lanes/setup-repo.mjs scripts/lanes/setup-repo.test.mjs
git commit -m "feat(lanes): install into other repos, and the owner's repo setup (labels, ruleset)"
```

---

### Task 12: `docs/USING.md` — how to use it, pitfalls, rules and scripts

**Files:**
- Create: `docs/USING.md`

- [ ] **Step 1: Write the guide**

```markdown
# Using lanes

## The daily loop

1. **Write tasks as issues** with the Task form. Every field is the contract a lane works from: a one-sentence goal,
   checkbox acceptance criteria, the interface contract (a file, or none), scope in and out, blocked-by links, and a
   tier. The `issue-contract` check labels a complete issue `tier:*` and `ready`, or comments what is missing.
   Faster: `/plan-issues "<your idea in 1-4 sentences>"` drafts up to 6 such issues (the contract issue first) into
   `.lanes/plans/`; edit or approve the draft, and only then are they created.
2. **Start up to 3 lanes**: open a fresh Claude Code session per issue and run `/lane <issue>`. Each lane works in its
   own worktree, writes the failing tests first, runs its reviewers, opens the PR and turns auto-merge on, then ends.
3. **Watch with `/status`**: WAITING ON YOU, IN FLIGHT (each PR's stage), READY TO START, MERGED.
4. **Approve with `/approve <pr>`** when a PR waits on you: read its "Needs the owner" and the diff, then approve the
   permission prompt. The merge queue does the rest.
5. **At night** a scheduled cloud session runs `/night`: up to 3 skip or quick tasks, merged only if CI finds them
   unattended-eligible. In the morning read the digest comment on the "Lanes digest" issue, and `/approve` the rest.
6. **Weekly `/health`** files issues for stale work, a red main and flaky checks.

## What merges without you

A PR merges on green checks alone only when its issue is `tier:skip` and it touches only skip paths, or `tier:quick`
with no contract file and nothing under `.github/`, `.claude/`, `.githooks/`, `scripts/lanes/`, `lanes.config.json`,
auth, secrets, deploy or `.env` paths. Everything else waits for `/approve`. CI decides this from the diff; a lane
cannot grant it to itself.

## Contracts, in one place

| Handoff | Contract | Enforced by |
| --- | --- | --- |
| Owner → lane | The Task issue form | `issue-contract` (labels `ready`) |
| Lane → lane | A contract file (type + schema + contract test) merged first; "Blocked by" | `/lane` refuses open blockers; `lanes/gate` requires "Contract changes" to match the diff |
| Lane → owner | The PR template | `lanes/gate` (all sections, `Closes #N`, contract word) |
| Idea → issues | `/plan-issues` draft in `.lanes/plans/`, approved by the owner | Nothing is created on GitHub before approval |
| Reviewer → gate | A JSON verdict (pass or fail per acceptance criterion, findings with `fixed`), posted as `review/<name>` | `post-review.mjs --file` refuses invalid or dishonest-looking verdicts; `lanes/gate` requires the reviewers per tier and diff |
| Owner → merge | `review/owner` status | `lanes/gate`; dropped automatically by any new push |

## Common pitfalls

- **Vague issues make vague PRs.** If an acceptance criterion cannot be written as a test, rewrite it before the lane
  starts. "Works well" is not a criterion; "returns 409 for a duplicate name" is.
- **Two lanes on one interface.** Land the contract first as its own small PR; list it under "Blocked by" in both
  issues. Never let two lanes each invent their half of an interface.
- **Overlapping files.** Two ready issues that edit the same files will conflict in the queue. Put one under the
  other's "Blocked by", or merge them into one issue.
- **Wrong tier.** A `tier:skip` issue whose PR touches code fails the gate. Fix the issue's tier label, then re-run
  the gate: `gh workflow run lanes-gate -f pr=<N>` (label changes on the issue do not re-trigger it by themselves).
- **Pushing after approval.** Any new commit drops `review/owner` and the reviewer statuses (they are per commit).
  Reviewers post after the final push; if you asked for a change, approve again after it lands.
- **The first run of a new check.** A required check that has never run blocks every PR. After adding a workflow,
  land it on `main` before adding its name to `requiredChecks`.
- **Required checks must also run on `merge_group`.** A workflow without that trigger never reports in the merge queue,
  and the queue times out.
- **Everything is one GitHub account.** `review/owner` is protected by the permission prompt, not by GitHub identity.
  Never allow `post-review.mjs owner` in any settings file, and never run `/approve` from a lane or a schedule.
- **Silenced errors.** Never `2>/dev/null` a git, gh, npm or test command; use `set -o pipefail` with `tail`.
- **Local servers.** Lanes run tests, not dev servers. A lane that needs a running server (UI review) asks the owner.

## Rules and scripts to have in place before the first lane

| What | Where | Why |
| --- | --- | --- |
| The `main` ruleset (required checks, merge queue, CodeQL, no bypass, no force push) | `setup-repo.mjs` (owner) | The gate only works if it is required |
| Labels `tier:*`, `ready`, `contract:breaking`, `digest` | `setup-repo.mjs` | The issue check and the gate read them |
| The `PII_PATTERNS` secret | `gh secret set PII_PATTERNS` (owner) | The security check and preflight |
| `npm run setup` (pre-push hook) in every clone and worktree | `package.json` | Leaks are caught before a push |
| `lanes.config.json` paths for this repo's layout | edit after `install.mjs` | Tiers and eligibility depend on them |
| `.claude/settings.json` narrow allow rules | committed | Lanes run without permission prompts, except the owner's |
| The night schedule (`/night`, once a day) | a scheduled cloud session (owner, via `/schedule`) | Unattended progress |
| A test command that runs in under a minute locally | the project's `package.json` | Lanes run narrow tests constantly |

## Adopting it in another repository

`node scripts/lanes/install.mjs <target>`, copy `.claude/skills/` and `vendor/agent-skills/` too if the target should use
the same practice layer (agent-skills, MIT, pinned; see `vendor/agent-skills/VENDORED.md`), edit the target's `lanes.config.json`, add `setup` and `preflight` npm
scripts and a `verify` workflow for the project's own tests, push to `main`, then (owner) set the `PII_PATTERNS` secret
and run `node scripts/lanes/setup-repo.mjs <owner/repo>`.
```

- [ ] **Step 2: Run the full suite**

Run: `set -o pipefail; npm test 2>&1 | tail -8`
Expected: `fail 0`.

- [ ] **Step 3: Commit**

```bash
git add docs/USING.md
git commit -m "docs: how to use lanes, pitfalls, and what to set up first"
```

---

### Task 12b: Delivery metrics, ported from satisfactory-dash (owner-approved 2026-09-26)

The spec's trial review tests each gate against delivery metrics. satisfactory-dash already has a privacy-tested script for them (#280, architect-approved: aggregates only, stable `schemaVersion` 1 JSON). It is GitHub-generic except for two assumptions, which become config here.

**Files:**
- Create (ported): `scripts/lanes/delivery-metrics.mjs`, `scripts/lanes/delivery-metrics.test.mjs`
- Modify: `lanes.config.json` (add a `metrics` block), `package.json` (add the `delivery-metrics` script), `.claude/commands/health.md`

**Interfaces:**
- Consumes: `lanes.config.json` `metrics: { mainWorkflow: string, fragmentsDir: string | null }`.
- Produces: CLI `npm run delivery-metrics -- [--days N] [--json] [--out <dir>]`, output unchanged from the source (`schemaVersion` 1).

- [ ] **Step 1: Port both files**

Run: `MSYS_NO_PATHCONV=1 git -C ../satisfactory-dash show origin/main:scripts/delivery-metrics.mjs > scripts/lanes/delivery-metrics.mjs` and the same for `delivery-metrics.test.mjs`. Run `node --test scripts/lanes/delivery-metrics.test.mjs`; fix only import paths if they fail.

- [ ] **Step 2: Add the config and a failing test**

Add to `lanes.config.json`:
```json
"metrics": { "mainWorkflow": "verify.yml", "fragmentsDir": null }
```
Add a test to `delivery-metrics.test.mjs` for a new exported pure function `metricsSettings(rawConfig)` that returns `{ mainWorkflow: "verify.yml", fragmentsDir: null }` for that block, returns the same defaults when the block is missing, and throws when `mainWorkflow` is not a non-empty string ending in `.yml` or `.yaml`. Run it and watch it fail.

- [ ] **Step 3: Use the settings**

In `delivery-metrics.mjs`: implement `metricsSettings`, read `lanes.config.json` from the repo root, pass `mainWorkflow` to the `gh run list ... --workflow` call instead of the literal `ci.yml`, and read log fragments only when `fragmentsDir` is a string (resolved against the repo root); with `null`, fragment dates are `[]`, which the report already handles. Remove satisfactory-dash references from comments (issue numbers, `docs-vault` paths); keep the privacy rules and the no-PII test exactly as they are.

- [ ] **Step 4: Wire it up**

`package.json` scripts: `"delivery-metrics": "node scripts/lanes/delivery-metrics.mjs"`. In `.claude/commands/health.md`, add a step: `npm run delivery-metrics -- --days 7` and report lead time, merge-queue bounce rate and change-failure rate next to the previous week's (the end-of-trial gate review uses these).

- [ ] **Step 5: Verify and commit**

Run: `node --test scripts/lanes/delivery-metrics.test.mjs`, then `set -o pipefail; npm test 2>&1 | tail -6` (fail 0), then a live read-only check against a public repo with history: `GH_REPO=Sour-Dev-Home/satisfactory-dash node scripts/lanes/delivery-metrics.mjs --days 7 --json | head -20` (the workflow name differs there, so its run counts may be zero; PR metrics must be populated).
```bash
git add scripts/lanes/delivery-metrics.mjs scripts/lanes/delivery-metrics.test.mjs lanes.config.json package.json .claude/commands/health.md
git commit -m "feat(lanes): delivery metrics for the trial's gate review (ported, config-driven)"
```

### The pilot's first real lane task (after Task 13, owner-approved 2026-09-26)

File it with `/plan-issues` (or the Task form) once the repo is live, tier full, and run it as a lane end to end:
**Vendor the OWASP Cheat Sheet Series as the security reviewer's authority.** Pin a commit of `OWASP/CheatSheetSeries`
(confirm its licence, expected CC BY-SA 4.0, and keep the attribution and licence file); vendor only the sheets for this
stack (Authentication, Session Management, Authorization, OAuth 2.0, CSRF, XSS, Content Security Policy, Input
Validation, REST Security, Server-Side Request Forgery, Secrets Management, Logging, Node.js Security, CI/CD Security,
Docker Security) under `vendor/owasp-cheatsheets/` with the same security read as Task 10b; add an `INDEX.md` (about
1-2k tokens) mapping paths and topics to sheets. The security reviewer reads the index, then only the 1-3 matching
sheets, and cites sheet and section in each finding; OWASP wins over the agent-skills checklist where they differ.
Follow-up (coordinator, owner OK): point the workspace `security-reviewer` agent used by satisfactory-dash at the same
pinned sheets and index.

### Carry into the dashboard project's brief (not tasks here)

- Playwright pinned to `127.0.0.1` for both the preview server and every URL (satisfactory-dash #296: on Windows, `localhost` resolves to IPv6 only and local runs time out).
- `e2e:report` (satisfactory-dash #293/#300): a head's CI, failures, CLS and screenshot baselines in one command, capped at 60 minutes.
- Local database tests from day one (satisfactory-dash #294/#304 pattern), adapted to D1.
- Screenshot baselines regenerated in CI, with sub-threshold rasterisation drift sorted automatically (#285's finding).

---

### Task 13: Publish and configure (owner's go-ahead required)

This task changes public state. Do not run any step until the owner has said to publish.

- [ ] **Step 1: Final checks**

Run: `set -o pipefail; npm test 2>&1 | tail -4 && node scripts/preflight.mjs && git status --short | head`
Expected: `fail 0`, preflight clean, empty status.

- [ ] **Step 2: Create the public repo and push `main`** (before the ruleset, so the workflows are on main first)

Run: `gh repo create Sour-Dev-Home/lanes --public --source . --push --description "Parallel Claude Code lanes: contracts, gates and unattended nights"`

- [ ] **Step 3: The owner sets the secret** (he types the patterns; they never appear in the transcript)

Owner runs: `! gh secret set PII_PATTERNS -R Sour-Dev-Home/lanes`

- [ ] **Step 4: Configure the repo** (owner approves this command)

Run: `node scripts/lanes/setup-repo.mjs Sour-Dev-Home/lanes`
Expected: `configured Sour-Dev-Home/lanes: settings, 6 labels, CodeQL, ruleset`

- [ ] **Step 5: Smoke test**

1. Create a Task issue: goal "Add a CONTRIBUTING.md pointing at docs/USING.md", one criterion, contract none,
   tier skip. Expected: labels `tier:skip` and `ready`, and a "Task contract complete" comment.
2. In a fresh session: `/lane <that issue>`. Expected: a PR whose `lanes/gate` is success
   ("unattended-eligible (tier:skip)") and which merges through the queue with no `/approve`.
3. Create a second Task issue, tier quick, that edits `.github/pull_request_template.md` (a sensitive path).
   Expected: after its reviewers post, `lanes/gate` is pending "waiting on owner (/approve)", and `/status` lists it
   under WAITING ON YOU. Then `/approve` it and watch it merge.

### Task 14: Unattended nights (owner)

- [ ] **Step 1: Cloud access.** The owner runs `/web-setup` so cloud sessions can use GitHub.
- [ ] **Step 2: The schedule.** With the owner, create a daily scheduled cloud session (the `/schedule` skill) on
  `Sour-Dev-Home/lanes` at 01:00 local time whose prompt is `/night`.
- [ ] **Step 3: First night.** Leave two ready skip or quick issues. The next morning, check the digest comment and
  that only unattended-eligible PRs merged.
```
