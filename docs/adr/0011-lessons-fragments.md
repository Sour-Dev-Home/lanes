# 0011: Reviewer-found lessons feed every lane as fragments, never a merged file

Status: accepted

## Context

The owner keeps a lessons-learned file in satisfactory-dash (`docs-vault/wiki/lessons-learned.md`): one sentence per
distinct bug pattern an independent review found, grouped by area, with a `(xN)` counter bumped on recurrence.
lanes has no equivalent: `docs/USING.md`'s "Common pitfalls" covers workflow mistakes, not code bugs, and `/lane`
neither reads nor writes a lessons file (issue #12).

`/lane` (`.claude/commands/lane.md`) already has the two hooks this needs. Step 4b hands each reviewer a fixed
checklist from `vendor/agent-skills/references/` before it runs. Step 6 defines the verdict JSON every reviewer
subagent returns (`findings: [{ severity: "critical"|"important"|"minor", file, line, summary, fixed }]`) and
requires `fixed` to be set truthfully; that field is already the source of honesty the issue wants, so gating a PR on
"did you write a fragment" would duplicate a signal the gate already has for free.

`/health` (`.claude/commands/health.md`) is explicitly not allowed to fix or commit anything except step 7's cleanup
of merged lanes. Issue #12's original ask ("`/health` merges fragments into `docs/lessons-learned.md` and bumps the
counter") needs `/health` to write and commit a file every week, which contradicts that constraint as written.
Either the constraint gets a second exception, or the merge step is designed away; this ADR takes the second path.

`lanes.config.json`'s `modules.entries` (ADR 0008) is optional per repo (adopters may have no `modules` key) and is
itself an owner-only path. `paths.owner` also makes `.claude/commands/(lane|night|approve).md` and everything under
`.claude/agents/` owner-only; `.claude/commands/health.md` is not on that list. `package.json` has zero dependencies
and `npm test` auto-discovers any `*.test.mjs` under `scripts/`, so a new script and its test need no new workflow
file. `scripts/lanes/install.mjs`'s `MANIFEST` is the list of files `install.mjs <target>` copies into an adopter
repo; it already lists `modules.mjs` and `structure-report.mjs`, so a new dependency-free script the workflow relies
on belongs there too.

## Decision

**No merged file; fragments are the only source of truth.** A fragment is
`docs/lessons.d/<area>-<pattern>-<issue number>.md` with frontmatter (`area`, `pattern`, `severity`, `reviewer`,
`source`) and a one-to-three-sentence lesson. `(xN)` is the count of fragments sharing `area` and `pattern`, computed
on read, never written. `/health` never commits anything for this feature, so its "do not fix anything" rule needs no
second exception, and two lanes never edit the same file, so the merge queue never serializes them over a shared
lessons file. A lane that recognizes an existing pattern reuses its slug; recurrence counting is only as good as that
reuse, which is an accepted limitation.

**Area.** When `lanes.config.json` has a `modules` key, area is the module id for the fragment's file, from the map
ADR 0008 draws; a file matching no module, or a cross-cutting finding, uses `general`. With no `modules` key, area is
the file's first path segment. A repo that never opts into the module map sees no behaviour change.

**`scripts/lanes/lessons.mjs`.** Dependency-free, three modes: `--paths <p...>` prints the lessons for the areas
those paths map to, plus `general`, one pattern per line with its `(xN)`, highest count first, bounded so a lane's
added token cost stays small; `--check` validates every fragment's frontmatter, known area and slug shape, and runs in
`scripts/lanes/lessons.test.mjs`; `--recurring [--min N]` lists patterns at or above N. Area derivation reuses the
module-map lookup through a small `moduleOf` helper exported from `scripts/lanes/modules.mjs`, instead of duplicating
the prefix match.

**`/lane`.** Step 4b runs `lessons.mjs --paths <Scope paths>` and gives its output to the test-hunter and security
reviewer alongside their checklists. Step 6: after fixing, for each finding with severity critical or important and
`fixed: true`, the lane writes one fragment in the same PR, reusing a pattern slug when the lesson matches an existing
one. The gate does not check for fragments. No file under `.claude/agents/` changes.

**`/health`.** Adds a step running `lessons.mjs --recurring` and filing one `lane-filed` Task issue per pattern at or
above the threshold, proposing a lint rule or test. `/health`'s own session files it, not the architecture-advisor
subagent, which ADR 0008 scopes to structural problems.

**Seed.** A few generic fragments carried over from satisfactory-dash's lessons file, area `general`, in the same PR
as `lessons.mjs`.

**Module map and install.** `lessons.mjs` gets a module-map entry and joins `install.mjs`'s `MANIFEST`, so every
adopter gets the script.

None of this adds an npm dependency, a workflow, an account, app or token, or a security boundary: fragments are inert
markdown quoted into reviewer prompts, never executed, and `lessons.mjs` only reads `docs/lessons.d/` and
`lanes.config.json`.

### ADR triggers checked

- New persistent state: yes. `docs/lessons.d/` grows by one small file per fixed critical or important finding.
- New dependency: no npm dependency; a new soft dependency between lanes (every lane reads a directory other lanes
  write) and a new `lessons` to `modules` edge in the module map.
- Security or auth boundary: no.
- Deployment: no.
- Contract between modules: yes. The `lessons.mjs` CLI, the fragment file name and frontmatter, and the module-map
  entry are relied on by `/lane`, `/health` and every adopter at once.

## Decisions for the owner

Approved by the owner on 2026-09-28:

- `lessons.mjs` joins a new `lessons` module with `imports: ["modules"]`, and `modules.mjs` exports `moduleOf`.
- `/health`'s recurring step skips a pattern that already has an open issue whose title carries
  `lesson:<area>/<pattern>`.
- The seed fragments stay in the lanes repository: `install.mjs` ships `lessons.mjs` but not `docs/lessons.d/`.
- `--paths` prints at most 20 patterns and about 3000 characters; `--recurring` defaults to `--min 3`.
- A fragment's file name embeds the issue number: `docs/lessons.d/<area>-<pattern>-<issue number>.md`.

## Consequences

- `/health` commits nothing for this feature; the merge queue never serializes two lanes over a lessons file.
- `docs/lessons.d/` grows without a delete or compaction path; archiving is a later, separate decision.
- Recurrence counting is only as accurate as slug reuse across lanes that never see each other's in-flight PRs; two
  lanes describing the same bug with different slugs under-count until a later fragment reuses the slug.
- A lane's lessons are a snapshot taken at step 4b; a fragment merged to `main` after that is not seen by the running
  lane.
- Adopters without a `modules` key get lessons by first path segment; opting into module areas is the owner-only
  `lanes.config.json` edit ADR 0008 describes.
- `lane.md` and `install.mjs` changes stay behind the owner-only gate; `health.md`, `lessons.mjs` and its test are
  ordinary lane changes.

## Governs

- lanes.config.json
- scripts/lanes/lessons.mjs
- scripts/lanes/lessons.test.mjs
- scripts/lanes/modules.mjs
- .claude/commands/lane.md
- .claude/commands/health.md
- scripts/lanes/install.mjs
- docs/lessons.d/
