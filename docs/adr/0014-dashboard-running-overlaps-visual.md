# 0014: A running-lane label, snapshot overlaps and a local dashboard visual check

Status: accepted

## Context

Three gaps in the public dashboard (owner, 2026-09-29), each grounded in the code as it stands:

1. `dashboard/app.js`'s `stageOf` has no case for the snapshot's `"ready"`, `"not-ready"` or `"already met"` stages,
   so its `default` returns `"queued"` for all three, and a lane running with no PR looks untouched. ADR 0012
   decision 4 refused a write path for "a lane is writing"; that refusal stands for lanes, but nothing lets the
   owner-side launch tooling itself mark a lane as running.
2. The graph renders only `edges` ("Blocked by"); none are open now, and there is no empty-state note, so it shows
   nothing rather than the Scope-path overlaps that actually serialize work. `scripts/lanes/paths.mjs` already
   exports `issuePaths` and `pathsOverlap`, the check `status.mjs` and `pick.mjs` use.
3. No reviewer with a browser has ever rendered `dashboard/`, so spacing, clipping and missing-info bugs ship unseen.
   `scripts/lanes/structure-report.mjs` already runs a tool through `npx --yes` at a pinned version with install
   scripts off (`JSCPD_PACKAGE`), the repo's precedent for a dependency-free, on-demand external tool.

Triggers: persistent state (a GitHub issue label, `lane:running`); a security boundary (a new owner-side label write,
and a wider published snapshot, still aggregates only and no paths); a changed contract
(`contracts/snapshot.schema.json` gains a stage and a top-level field, both additive). No npm dependency and no
deployment change.

## Decision

1. **`lane:running` label, amending ADR 0012 decision 4.** `start.mjs`'s and `queue.mjs`'s launch paths add it to the
   issue right after a successful `claude --bg` launch (`parseSessionId` succeeds); `cleanup.mjs` removes it in the
   step that removes a merged, closed or orphaned lane. A label add or remove that fails is logged and never fails a
   launch or a cleanup. No lane session gains a write path; only the owner's launch and cleanup tooling touches it.
2. **Accepted staleness.** A lane that hangs past `reap.mjs`'s `GIVE_UP_MS` / `GIVE_UP_FAILURES` (48 h / 3 failed
   polls) keeps its label, since giving up logs and exits without removing the lane: the same bound the worktree and
   session already carry under ADR 0010.
3. **Snapshot contract.** `issues[].stage` gains `"running"` (open issue, `lane:running` label, no PR). A top-level
   `overlaps: [{ a, b }]` (issue numbers, `a < b`) lists every pair of open ready or running issues whose
   `issuePaths()` paths `pathsOverlap`, soft paths excluded, the check `pick.mjs` and `status.mjs` run. `snapshot.mjs`
   imports `issuePaths` and `pathsOverlap` from `paths.mjs` rather than re-deriving them. No file path is published.
   Both changes are additive: an old page reading a new snapshot only misses the new stage and pairs.
4. **Page.** `stageOf` gets explicit cases for `"ready"`, `"not-ready"`, `"already met"` and `"running"`, each its own
   `STAGES` entry and legend chip; `overlaps` render as dashed undirected lines beside the solid "Blocked by" arrows;
   the graph shows a one-line empty-state note when both are empty.
5. **Local visual check.** `scripts/dashboard-visual.mjs` (gate module in `lanes.config.json`) runs on demand only,
   never in `verify.yml`, the gate or `dashboard.yml`. It renders `dashboard/` against a checked-in fixture,
   `contracts/dashboard-visual.fixture.json` (outside `dashboard/`, so the Pages copy never ships it), covering every
   stage, blocker kind, edge and overlap. It drives Playwright through `npx --yes` at a pinned version (a
   `PLAYWRIGHT_PACKAGE` constant) with install scripts off, at 375, 768 and 1280 px in light and dark; writes
   screenshots under git-ignored `.lanes/visual/`; and prints a defect count (overflow or clipping, overlapping boxes,
   off-screen elements, empty required fields) usable in a `validate:` criterion. Playwright's browser download
   happens outside npm's install-scripts guard on first run, a larger trust surface than jscpd's, accepted only
   because the script is opt-in, local, and never a CI or gate dependency.

## Decisions for the owner

1. `lane:running` is a plain label; its colour in the label list is the owner's choice.
2. The label's staleness bound is `reap.mjs`'s existing give-up: no new timer.
3. The visual-check fixture lives at `contracts/dashboard-visual.fixture.json`, never under `dashboard/`.
4. `scripts/dashboard-visual.mjs` is opt-in only; it is never a required check or part of any workflow.
5. Playwright's browser download is an accepted on-demand supply-chain risk, never a CI-time one.

## Consequences

- The dashboard shows a lane's real state without CI seeing a local session, at the cost of one label the owner's
  tooling keeps in sync; a hung lane can show "running" for up to 48 h, no worse than today's worktree leak.
- The overlaps list gives the graph a second, real edge type without publishing any file path.
- Layout bugs are caught before a ui-reviewer needs a browser, at the cost of a first-run Playwright download that
  only whoever opts in triggers.
- `dashboard/` and `lanes.config.json` keep a security review on every change (ADR 0012); `paths.sensitive` and
  `paths.ui` already cover `^dashboard/`.

## Governs

- scripts/lanes/start.mjs
- scripts/lanes/start.test.mjs
- scripts/lanes/queue.mjs
- scripts/lanes/queue.test.mjs
- scripts/lanes/cleanup.mjs
- scripts/lanes/cleanup.test.mjs
- scripts/lanes/snapshot.mjs
- scripts/lanes/snapshot.test.mjs
- contracts/snapshot.schema.json
- contracts/dashboard-visual.fixture.json
- dashboard/
- scripts/dashboard-visual.mjs
- scripts/dashboard-visual.test.mjs
- lanes.config.json
