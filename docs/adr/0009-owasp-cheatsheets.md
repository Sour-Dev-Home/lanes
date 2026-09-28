# 0009: Vendor the OWASP Cheat Sheet Series as the security reviewer's cited authority

Status: accepted

## Context

`.claude/agents/security-reviewer.md` today cites only `vendor/agent-skills/references/security-checklist.md`
(vendored MIT, ADR-free, documented in `vendor/agent-skills/VENDORED.md`). The plan
(`docs/superpowers/plans/2026-09-26-workflow-template.md`, "The pilot's first real lane task", owner-approved
2026-09-26) calls for vendoring the OWASP Cheat Sheet Series so findings can cite a named sheet and section instead
of a paraphrased checklist line, for a fixed list of sheets chosen for the owner's web-app stack (Authentication,
Session Management, Authorization, OAuth 2.0, CSRF, XSS, Content Security Policy, Input Validation, REST Security,
SSRF, Secrets Management, Logging, Node.js Security, CI/CD Security, Docker Security). OWASP/CheatSheetSeries is
CC BY-SA 4.0, unlike lanes' own MIT licence and unlike the MIT-licensed `vendor/agent-skills/` tree; both `vendor/`
and `.claude/agents/` are already owner-only paths (`lanes.config.json` `paths.owner`), so an implementing PR needs
owner review either way. `vendor/agent-skills/VENDORED.md` sets the precedent: pin a commit, do a security read for
fetch/install/secret/hook-disabling instructions before copying, and repeat that read on any future commit bump.
lanes' own highest-risk surface — `scripts/lanes/approve-guard.mjs` and `start-guard.mjs` parsing command text,
`execFileSync` calls to `gh`/`git`/`claude`, and `pull_request_target` in `.github/workflows/lanes-gate.yml` — is
shell-command-injection risk, which is not one of the plan's 15 sheets (chosen for the web-app stack, not for lanes
itself).

## Decision

1. **Vendor unchanged, pinned, attributed.** Pin one commit of `OWASP/CheatSheetSeries`; confirm its licence at that
   commit (expected CC BY-SA 4.0); copy only the 15 sheets named in the plan plus OS Command Injection Defense (owner
   decision, 2026-09-28) into `vendor/owasp-cheatsheets/`, verbatim, keeping the upstream licence file and
   attribution. If the licence at that commit is not CC BY-SA 4.0, stop and return to the owner for a licence
   decision instead of vendoring. Add `vendor/owasp-cheatsheets/VENDORED.md` in the same shape as
   `vendor/agent-skills/VENDORED.md`: upstream URL, pinned commit, the sheet list, and the security read's findings
   (fetch/install/secret/hook-disabling instructions, or none). A future commit bump repeats that read on the diff
   between old and new commit, in the same PR, tier full, owner review — the existing rule, not a new one.
2. **`INDEX.md` is lanes' own text.** `vendor/owasp-cheatsheets/INDEX.md` (about 1-2k tokens) maps this repo's paths
   and topics to the vendored sheets. It is original mapping text written for lanes, not an adaptation of any sheet's
   content, so it carries lanes' own MIT licence like the rest of the repo; it is not itself CC BY-SA content.
3. **The reviewer reads the index, then at most three sheets.** `.claude/agents/security-reviewer.md` reads
   `INDEX.md` first, then only the 1-3 sheets it points to for the diff at hand, never the whole vendored set. Every
   finding cites sheet and section. Where a vendored sheet and
   `vendor/agent-skills/references/security-checklist.md` differ, the sheet wins. The existing ADR 0004 and ADR 0007
   accepted-risk paragraphs in that file stay exactly as they are; this ADR does not touch them.
4. **ShareAlike stays contained.** The CC BY-SA sheets live only under `vendor/owasp-cheatsheets/`, unchanged, with
   their own licence file and attribution, alongside a differently-licensed vendor tree (`vendor/agent-skills/`,
   MIT) already in the repo. `INDEX.md` and the `security-reviewer.md` prompt text referencing it are lanes' own
   MIT-licensed material, not derivatives of the sheets, so ShareAlike does not extend to the rest of the repository.

## Decisions for the owner

1. Add "OS Command Injection Defense" as a 16th sheet, to cover lanes' own shell-command surface: decided yes by the
   owner on 2026-09-28.
2. Confirm the pinned commit's licence is CC BY-SA 4.0 before vendoring; if it differs, the implementing issue stops
   and comes back for a licence decision: decided by the owner on 2026-09-28.

## Consequences

- Security findings on auth, session, CSRF/XSS, SSRF, secrets, logging, Node.js, CI/CD, Docker and shell-command code
  gain a named, citable sheet and section instead of a paraphrased checklist line.
- Token cost per review stays bounded: `INDEX.md` plus at most three sheets, never the full vendored set.
- A second, differently-licensed content tree (CC BY-SA 4.0) sits in the repo for the first time, isolated under
  `vendor/owasp-cheatsheets/` with its own licence and attribution; it does not change the licence of anything
  outside that folder.
- A future commit bump is a `vendor/` change: owner-gated, tier full, with a repeated security read on the diff,
  same as `vendor/agent-skills/`'s existing rule.

## Governs

- vendor/owasp-cheatsheets/
- .claude/agents/security-reviewer.md
