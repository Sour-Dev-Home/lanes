# 0016: A committed upgrade lock, token budgets, and public release docs

Status: accepted

## Context

Lanes has no version, changelog or upgrade path: `install.mjs` copies its `MANIFEST` into an adopter repo once,
keeping existing files unless `--force`, which cannot tell an adopter's deliberate edit from a file that simply
predates a newer lanes release. Token spend per lane is measured (`lane-cost.mjs`'s `sessionUsage`, appended to
`.lanes/costs.jsonl` at lane removal) but nothing acts on it: a run can spend without limit. The threat model is
spread across ADRs 0004, 0007, 0010, 0012, 0014 and 0015, and there is no quick start from zero to a first merged lane.
Standing constraints: zero npm dependencies, no extra setup for adopters, no personal data or absolute local paths in
shipped files, and ADR 0005/0007: no automated path launches lanes or rewrites guard and gate files on its own.

## Decision

1. **Versioning.** `package.json` `"version"` is the single source; `CHANGELOG.md` gets one entry per release, by
   hand.
2. **Upgrade lock.** `install.mjs` (first install or `--force`) also writes `lanes.lock.json` at the adopter's repo
   root (not under `.lanes/`, which stays git-ignored and cannot hold a committed file): `{ version, files:
   { <MANIFEST path>: sha256 of the installed content } }`, one entry per file it wrote, schema at
   `contracts/lanes-lock.schema.json`. `lanes.lock.json` joins `paths.owner`, so a PR that edits it by hand waits on
   `/approve`: it is the record `upgrade.mjs` trusts to decide what it may overwrite.
3. **`scripts/lanes/upgrade.mjs <target-dir>`**, run by the owner from a newer lanes checkout in their own terminal,
   never from Claude (it exits 2 when `CLAUDECODE` is set, like `queue.mjs`). It always prints a plan first (overwrite
   / add / refuse / no longer part of lanes, one line per file) and writes nothing until a second run with `--apply`.
   A file whose hash matches the lock is overwritten; a file whose hash differs, or that is missing from the lock, is
   refused and listed; a file new in the current `MANIFEST` is added; a file the current `MANIFEST` no longer lists is
   reported only, never deleted. `lanes.config.json` is never overwritten: only new top-level keys absent from the
   adopter's copy are added, each with its default and each reported. On `--apply`, `lanes.lock.json` is rewritten
   with the new version and the new hashes of every file written.
4. **Budgets.** `lanes.config.json` gains `budget: { perNightTokens, perLaneTokens }`, defaults 100 000 000 and
   15 000 000 (from the first measured week: lane p90 8.2 M, max 19.2 M, busiest day 87 M), parsed by
   `budgetConfig(raw)` next to `startConfig` in `scripts/lanes/start.mjs`. `status.mjs --json` gains a `budget`
   field: rolling 24 h spend from `.lanes/costs.jsonl` plus running lanes' live transcript totals (local
   `lane-cost.mjs` reads only, never sent anywhere), and which running lanes exceed `perLaneTokens`. `queue.mjs`
   stops launching, printing the reason, once 24 h spend passes `perNightTokens`; a lane over `perLaneTokens` is
   reported, never killed. `.claude/commands/night.md` stops picking new issues once `budget` says over.
5. **Docs.** `docs/SECURITY.md` summarises the threat model the ADRs already decided (guards, gates, grants, owner
   paths, I4, accepted risks, what lanes does not protect against) and how to report a vulnerability; it restates,
   never re-decides. `README.md` gets a quick start, prerequisites and honest limits.

## Decisions for the owner

1. `lanes.lock.json` is an owner path; only `upgrade.mjs --apply`, run by the owner, rewrites it.
2. A file dropped from `MANIFEST` is reported, never deleted, by `upgrade.mjs`.
3. Budget defaults: 100 M tokens per rolling 24 h (stop launching) and 15 M per lane (report only); each repo tunes its own.
4. Running lanes' live transcript totals are read locally for the budget; nothing is sent anywhere.
5. `upgrade.mjs` never runs from Claude and never writes without `--apply` after a printed plan.

## Consequences

- An adopter upgrades with one command from a newer lanes checkout; an edited file is never silently overwritten,
  and they see the plan before anything is written.
- `lanes.config.json` customisations survive every upgrade.
- `.lanes/costs.jsonl` becomes load-bearing for the budget check; deleting it resets tracked spend to zero, not a crash.
- `docs/SECURITY.md` can drift from the ADRs it summarises; only review keeps them in step.

## Governs

- package.json
- CHANGELOG.md
- contracts/lanes-lock.schema.json
- scripts/lanes/contracts.test.mjs
- scripts/lanes/install.mjs
- scripts/lanes/install.test.mjs
- scripts/lanes/upgrade.mjs
- scripts/lanes/upgrade.test.mjs
- scripts/lanes/start.mjs
- scripts/lanes/start.test.mjs
- scripts/lanes/queue.mjs
- scripts/lanes/queue.test.mjs
- scripts/lanes/status.mjs
- scripts/lanes/status.test.mjs
- scripts/lanes/lane-cost.mjs
- scripts/lanes/lane-cost.test.mjs
- lanes.config.json
- .claude/commands/night.md
- docs/SECURITY.md
- README.md
