# 0008: A dependency-free module map bounds imports and gates cross-module issues

Amended by 0018 (optional per-entry fields and a schema file).

Status: accepted

## Context

lanes now runs ~20 ESM scripts in `scripts/lanes/` that import each other by relative path, with no declared
boundaries: `pick.mjs` and `status.mjs` already import each other, a live cycle. As more lanes add issues in
parallel, nothing stops a new file from importing across an intended boundary or growing a new cycle, and nothing
tells an issue which part of the codebase it belongs to before a lane starts touching it.

`package.json` has zero dependencies; `node --test` and `verify.yml` are the whole toolchain. `package.json` and the
lockfiles are owner-only paths (`lanes.config.json` `paths.owner`), so adding the first npm dependency is an owner
decision, not something an ADR grants outright. `lanes.config.json` already carries per-repo config (`paths.*`,
`start.*`) and is installed into every adopter repo (`install.mjs`, `new-project.mjs`); it is itself an owner-only
path, so anything added there inherits that gate for free. The Task form has no field for which part of the codebase
an issue touches; `status.mjs`'s `issuePaths()` already derives paths from Scope and the Interface contract.

Standing constraints: no extra setup for adopters (no new account, app or token); scripts over Claude workflows
where a script suffices (owner decision, repo-wide); a lane-filed issue always carries `lane-filed` and waits for
the owner (I4, `issue-contract.mjs`).

## Decision

Add a **module map**: an optional `modules` key inside `lanes.config.json`, not a new file or schema. Each entry
names a module id, its path prefix(es), and the module ids it may import from. It is per-repo config like the rest
of `lanes.config.json`, owner-only to edit, and absent by default: a repo with no `modules` key gets no boundary
check and no cross-module gate, so every existing adopter sees no change until the owner opts in.

Add `scripts/lanes/modules.mjs`, dependency-free: it regex-scans relative ESM import specifiers (`from "./x.mjs"`,
`from "../y/z.mjs"`) under the mapped paths, builds the import graph, and reports every import that crosses a
boundary the map doesn't allow and every cycle in the graph. It needs no new npm dependency (rejecting
dependency-cruiser for now: it would be the project's first dependency, and `package.json`/lockfiles are owner-only
paths for that reason). `scripts/lanes/modules.test.mjs` runs it against this repo's own map (once drawn) and fails
the test on any violation or unlisted cycle, so `npm test` and `verify.yml` catch it with no new workflow file. A
map entry may name an explicit, visible cycle allow-list (e.g. `pick.mjs` / `status.mjs` today); an allow-listed
cycle never fails the check but always appears in the report, so it stays visible rather than silently accepted.
Fixing that cycle for real is a separate, ordinary refactor issue, not a precondition for turning the checker on.

`/health` (`.claude/commands/health.md`) gains a structural report step: `modules.mjs`'s cycles and boundary
violations, growth from `git log --numstat` over the report's window, lane hotspots from the merged lane PRs of
that window (one `gh pr list` call, keeping the PRs whose head branch starts with `issue-`; not from
`git log --numstat`), and duplicated code from `npx jscpd` run on demand in that step only, pinned to 5.3.3 and run
with `npm_config_ignore_scripts=true` so none of its install scripts run. None of these adds a dependency:
jscpd is never added to `package.json` and never runs in CI.
The architecture-advisor reads this report weekly as part of `/health` and files refactor issues the normal way:
Task issues carrying `lane-filed`, which wait for the owner before they can become `ready` (I4), same as every other
lane-filed follow-up.

An issue's module is derived, not a new form field: `issue-contract.mjs` runs the existing `issuePaths()` (Interface
contract + Scope "In:") against the map and refuses `ready` when those paths resolve to more than one module,
unless the Interface contract names a path and "Blocked by" names an issue whose own Scope contains that path, or
the path already exists on `main`. With no `modules` key configured, this check no-ops and `ready` behaves exactly
as today. `/plan-issues` is updated to assign each drafted issue to one module from the map when one exists, and to
split it or add a blocking contract issue itself, before showing the draft to the owner, rather than leaving it for
`issue-contract.mjs` to reject after the issue is filed.

## Decisions for the owner

- Whether `npx jscpd` (fetching a package pinned to 5.3.3 from the registry on every `/health` run, with install
  scripts off, on demand, never in CI) is acceptable, or duplicate-code detection should wait until it can be
  vendored.
- Whether to draw the first `modules` entries for `scripts/lanes/` itself as part of the first implementing issue
  (dogfooding), and whether the `pick.mjs`/`status.mjs` cycle is allow-listed or fixed first; this ADR permits
  either but does not choose.
- Whether dependency-cruiser (or another vetted tool) should later replace the regex scanner if it misses import
  forms (dynamic `import()`, re-exports) the regex can't reach; that would be the project's first npm dependency
  and needs its own sign-off.

## Consequences

- A boundary violation or an unresolved cycle fails `verify`, the same gate every other check runs through, with no
  new workflow file and no new dependency.
- Every adopter without a `modules` key sees no behavior change; opting in is one owner-only edit to
  `lanes.config.json`.
- An issue whose Scope spans modules now needs either a single-module Scope or an explicit contract issue in
  "Blocked by" before it can reach `ready`; this is a new, declared dependency between lanes, not a hidden one, and
  it is enforced by the same owner-gated `issue-contract.mjs` that already enforces I4 and C1.
- `git log --numstat`, the `gh pr list` call and `npx jscpd` add runtime cost only to `/health`, an owner-triggered,
  weekly path, never to `verify` or any lane. The `gh pr list` call needs `gh` authenticated on the machine that
  runs the report, and the report says the hotspots are unavailable when it fails; `npx jscpd` needs the registry
  reachable, and runs pinned to 5.3.3 with `npm_config_ignore_scripts=true`.

## Amendment (2026-10-01)

Issues are sized by changed lines, not by module, and may span modules (`docs/history/2026-09-30-lane-size-and-cost.md`).
The issue-contract module check the Decision describes (refusing `ready` when an issue's paths resolve to more than
one module) was never implemented and is withdrawn. The map still drives boundary checks, reviewers, lessons and
affected tests.

## Governs

- lanes.config.json
- scripts/lanes/modules.mjs
- scripts/lanes/modules.test.mjs
- scripts/lanes/issue-contract.mjs
- scripts/lanes/issue-contract.test.mjs
- scripts/lanes/lib.mjs
- scripts/lanes/lib.test.mjs
- .claude/commands/health.md
- .claude/commands/plan-issues.md
- scripts/lanes/structure-report.mjs
- scripts/lanes/structure-report.test.mjs
- scripts/lanes/paths.mjs
- scripts/lanes/paths.test.mjs
