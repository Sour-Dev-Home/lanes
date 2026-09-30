# 0018: Restructure lanes into a core plus per-project profiles, starting with a module-map schema and per-module reviewers

Status: accepted

## Context

lanes is one repo's tooling: reviewer names, the scheduler and the guards assume this repo and the owner's own account
(ADRs 0004, 0007). The owner decided on 2026-09-29 (docs/history/2026-09-29-lanes-v0.1.0-snapshot.md, decision 2) to
make it a reusable core with per-project profiles.

Facts this rests on:

- ADR 0008 added an optional `modules` key to `lanes.config.json`, `{ entries: [{ id, paths, imports }], allowCycles }`,
  validated in code by `scripts/lanes/modules.mjs`, and said it was "not a new file or schema". It covers `scripts/`
  only; `contracts/` and `.claude/` are unclaimed.
- Reviewer choice is hard-coded. `requiredReviewers(tier, cls)` in `scripts/lanes/lib.mjs` picks test-hunter,
  ui-reviewer (paths.ui), security-reviewer (paths.sensitive) and architecture-advisor (contract or architecture
  change). The names also appear in `lib.mjs` (`REVIEWERS`, used by its verdict parser, `REUSABLE_REVIEWERS`, the
  review-inputs map), in `approve-guard.mjs` (`NON_OWNER_REVIEWERS`, the only names a session may post verdicts for;
  `owner` is the owner's approval and a lane must never post it) and in `post-review.mjs` (`MUST_COVER`).
- `contracts/*.schema.json` files are checked against the code that reads them.
- Standing constraints (CLAUDE.md, docs/SECURITY.md): security review is never narrowed to save tokens; adopters need
  no extra setup (the solo profile is the default, no new account, no npm dependency); `lanes.config.json` is an
  owner-only path.

## Decision

**Direction (not decided in detail here).** lanes becomes a core (the task contract, the `/lane` loop, pluggable
reviewers, lessons) plus per-project profiles. A module map becomes the central config (paths, owner, contracts, risk,
reviewers, test command). Phases, in order, each with its own `/plan-issues` and an ADR where it needs one:

1. This ADR: the module-map schema and reviewers chosen per project from config.
2. Per-module locks replacing the Scope-path overlap scheduler (would amend ADRs 0005/0006).
3. Platform features replacing custom machinery where they can: CODEOWNERS generated from the module map, branch
   protection, the native merge queue.
4. Identity profiles: `solo` (the owner's account with the guards, today's model, ADRs 0004/0007; stays the default)
   and `team` (a separate agent identity, native reviews, guards off; needs its own ADR because it changes the
   security posture).
5. Packaging as a Claude Code plugin.

Until phase 4, every repo runs the solo profile unchanged.

**Phase 1: amending ADR 0008.** The `modules` key stays inside `lanes.config.json`. Each entry gains optional fields,
and the map gets a schema file, `contracts/module-map.schema.json`, checked against `modules.mjs`'s validator in
`modules.test.mjs`. A config with none of the new fields, or with no `modules` key, behaves exactly as today. The new
per-entry fields:

- `reviewers`: an array of extra reviewer names. Read by code in phase 1.
- `contracts`: an array of contract path prefixes. Data only in phase 1.
- `owner`: a boolean marking the module's paths as owner-only. Data only in phase 1; `paths.owner` stays the enforced
  list.
- `risk`: `"normal"` or `"sensitive"`. Data only in phase 1; `paths.sensitive` stays the enforced list.
- `test`: the module's test command. Data only; nothing executes it in phase 1.

`modules.mjs` validates all five, rejects a wrong type with a clear error, and rejects unknown keys so a typo is not
silently ignored. `contracts/` and `.claude/` may be mapped as ordinary modules; the import scanner ignores
non-`.mjs` files. The `lib` module may import `modules`, so reviewer selection reads the map through `modules.mjs`.

**Reviewers from config.** `requiredReviewers` keeps its four built-in rules and their triggers exactly as they are,
then adds the union of `reviewers` from every module whose `paths` contain a changed file. Config can only add: the
schema has no key that removes or narrows a reviewer, so security-reviewer still runs wherever `paths.sensitive`
matches and architecture-advisor wherever a contract or architecture changes. `tier: skip` still returns no reviewers.

A reviewer name must match `^[a-z][a-z0-9-]*$`, must not be `owner`, and must have a `.claude/agents/<name>.md` in the
repo; `modules.mjs` checks all three. The gate's verdict parser, the verdict-posting guard (`approve-guard.mjs`) and
`post-review.mjs` take their allowed set from one exported helper in `lib.mjs`: the built-in four plus the configured
names; `owner` can never enter it. The guard reads the main checkout's `lanes.config.json`, never a worktree's copy, so
a lane cannot widen the set by editing its own checkout; if that config cannot be read or fails validation, the guard
falls back to the built-in four. Configured reviewers' verdicts are never reused across commits.

**The `test` command.** Data only in phase 1. The guards read shell text, so a config string run as a command would
bypass their reading. A later phase may run it only under the safety rule chosen below; whichever rule is chosen, the
command is never passed through a shell, and a lane never runs a value it wrote.

## Decisions for the owner

- Test-command safety rule (needed before any phase runs it). Recommended: `test` is an argv array, not a string, run
  without a shell and only from the base branch's config. Alternative: keep it a string and run it only inside CI
  (`verify.yml`), never from a lane session.
- Whether the `team` profile is in scope for the first release, or the first release is solo only with the schema and
  reviewer config, so phases 2-4 wait. Recommended: solo only.
- Plugin packaging timeline (phase 5). Recommended: no commitment until phases 2 and 3 land, since packaging freezes
  the config surface.
- Decided by accepting this ADR: the order of phases 1-5 above, and that config may add reviewers but never remove one.

## Consequences

- Good: existing adopters and this repo's config stay valid with no edit. Adding a reviewer for a module is one
  owner-only config edit plus one agent file, with no code change. The reviewer names are no longer hard-coded in
  three files.
- Good: the security and architecture reviews cannot be configured away.
- Bad: the guard now reads config at verdict time. A malformed config degrades to the built-in four rather than
  opening anything.
- Bad: the data-only fields `contracts`, `owner` and `risk` duplicate `paths.*` until phase 3, so they can drift.
  `modules.test.mjs` flags a module marked `risk: "sensitive"` or `owner: true` whose paths `paths.sensitive` or
  `paths.owner` do not cover.
- The amendment to ADR 0008 is additive: no `contract:breaking` label is needed.
- Open issue #441 (guards, ADR 0017 tag coverage) is kept unchanged: the solo profile keeps the guards. It shares
  `approve-guard.mjs` with phase 1, so the two run one after the other.
- Open issue #448 is kept. Its ADR 0005 note also says that phase 2's per-module locks will supersede the Scope-path
  scheduler (ADRs 0005 and 0006). It has no overlap with phase 1.

## Governs

- lanes.config.json
- contracts/module-map.schema.json
- scripts/lanes/modules.mjs
- scripts/lanes/modules.test.mjs
- scripts/lanes/lib.mjs
- scripts/lanes/lib.test.mjs
- scripts/lanes/reviewers.mjs
- scripts/lanes/approve-guard.mjs
- scripts/lanes/approve-guard.test.mjs
- scripts/lanes/post-review.mjs
- scripts/lanes/post-review.test.mjs
- docs/adr/0008-module-map.md
- .claude/commands/lane.md
