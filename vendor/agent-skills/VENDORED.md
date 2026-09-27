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

The `security-and-hardening` skill ships its own nested `references/hardening-patterns.md`; it was copied unchanged
(its own-skill-scoped `references/hardening-patterns.md` links still resolve as-is). Only links that crossed into
the shared, no-longer-adjacent top-level `references/` directory, or pointed at a skill/reference this task did not
vendor, were rewritten:

| File | Old target | New target |
|---|---|---|
| `.claude/skills/test-driven-development/SKILL.md` | `../../references/testing-patterns.md` | `vendor/agent-skills/references/testing-patterns.md` |
| `.claude/skills/test-driven-development/SKILL.md` | `` `browser-testing-with-devtools` `` (skill link) | plain text: "the browser-testing-with-devtools skill upstream (not vendored here)" |
| `.claude/skills/incremental-implementation/SKILL.md` | `../../references/definition-of-done.md` | `vendor/agent-skills/references/definition-of-done.md` |
| `.claude/skills/incremental-implementation/SKILL.md` | `` `git-workflow-and-versioning` `` (skill link) | plain text: "the git-workflow-and-versioning skill upstream, not vendored here" |
| `.claude/skills/api-and-interface-design/SKILL.md` | `` `deprecation-and-migration` `` (skill link) | plain text: "the deprecation-and-migration skill upstream (not vendored here)" |
| `.claude/skills/planning-and-task-breakdown/SKILL.md` | `../../references/definition-of-done.md` | `vendor/agent-skills/references/definition-of-done.md` |
| `.claude/skills/frontend-ui-engineering/SKILL.md` | `../../references/accessibility-checklist.md` | `vendor/agent-skills/references/accessibility-checklist.md` |
| `.claude/skills/security-and-hardening/SKILL.md` (Destructive operations section) | `../../references/security-checklist.md` | `vendor/agent-skills/references/security-checklist.md` |
| `.claude/skills/security-and-hardening/SKILL.md` (Dependencies and supply chain section) | `../../references/security-checklist.md` | `vendor/agent-skills/references/security-checklist.md` |
| `.claude/skills/security-and-hardening/SKILL.md` (Review Checklist section) | `../../references/security-checklist.md` | `vendor/agent-skills/references/security-checklist.md` |
| `.claude/skills/security-and-hardening/SKILL.md` | `` `observability-and-instrumentation` `` (skill link) | plain text: "the observability-and-instrumentation skill upstream, not vendored here" |
| `.claude/skills/security-and-hardening/references/hardening-patterns.md` | `../../../references/security-checklist.md` | `vendor/agent-skills/references/security-checklist.md` |
| `.claude/skills/security-and-hardening/references/hardening-patterns.md` | `../../../references/security-checklist.md#owasp-top-10-quick-reference` | `vendor/agent-skills/references/security-checklist.md#owasp-top-10-quick-reference` |
| `.claude/skills/security-and-hardening/references/hardening-patterns.md` | `../../../references/security-checklist.md#destructive-path-operations` | `vendor/agent-skills/references/security-checklist.md#destructive-path-operations` |
| `.claude/skills/code-review-and-quality/SKILL.md` | `../../references/security-checklist.md` | `vendor/agent-skills/references/security-checklist.md` |
| `.claude/skills/code-review-and-quality/SKILL.md` | `` `performance-optimization` `` (skill link) | plain text: "the performance-optimization skill upstream (not vendored here)" |
| `.claude/skills/code-review-and-quality/SKILL.md` | `../../references/performance-checklist.md` | plain text: "the performance-checklist reference upstream (not vendored here)" (this reference file was not among the four vendored here, so the link is retired rather than pointed at a file that doesn't exist in this vendor tree) |

Links to skills that *are* vendored here (`security-and-hardening`, `debugging-and-error-recovery`) were left as plain
skill-name mentions unchanged; they still resolve because both live in `.claude/skills/`.

## Security read

Read in full, before copying anything: all eight `SKILL.md` files, the nested
`.claude/skills/security-and-hardening/references/hardening-patterns.md` (part of that skill's own folder), and the
four top-level reference files (`definition-of-done.md`, `testing-patterns.md`, `security-checklist.md`,
`accessibility-checklist.md`), at commit `2686b620fc1fed2e8f60c704839c766b8594c6b6`.

Looked for, per file: any instruction to fetch a URL, install a package, run a network or shell command beyond
ordinary build/test commands, read credentials or environment secrets, disable checks or hooks, push, or override
the user's or project's rules.

Findings: none of the eight skills or four references contain such an instruction. All content is descriptive
guidance, checklists, and illustrative code samples (e.g. `npm audit`, `npm ci`, `git diff --cached | grep`,
`npx axe-core`, the SSRF/rate-limiting/secrets snippets in `hardening-patterns.md`) shown as examples of patterns to
apply in the reader's own project, not as commands the vendored text asks an agent to run against this repository.
Several sections explicitly warn *against* the risky behaviors the audit was checking for (never commit secrets,
never disable security headers, never force dependency-audit remediation automatically, treat error output and LLM
output as untrusted data rather than instructions). No file asks to push, silence a hook, or exfiltrate anything.
Verdict: no BLOCKED condition.

(Two files auto-surfaced by the harness while reading inside the scratch clone -- the upstream repo's own
`CLAUDE.md` and `.claude/rules/skills-contributing.md` -- are project-configuration for the `agent-skills` repo
itself, not part of the eight skill folders or four references, and were not vendored. They were treated as data:
they describe that repo's own contribution workflow (pre-flight checks, `gh pr list`, etc.) and were not followed.)

Path scan (Step 4, second half): read the four local-path patterns listed in `.github/workflows/security.yml` (its
`printf` line, not the `$PII_PATTERNS` line), then ran `grep -r -H -n -iF` for each, case-insensitively, over the
eight skill directories and the four reference files in the scratch clone. Result: no matches (clean). Reported as
`file:line` only, per the brief; there were none to list.
