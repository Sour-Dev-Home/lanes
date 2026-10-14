# 0033: Bounded Scope extensions for tests and registration lines

Status: accepted

## Context

CLAUDE.md rule 4 makes every Task issue's Scope name concrete repository paths, and `.claude/commands/lane.md` step 4
tells the lane to "Touch nothing out of scope". Step 5 (from #666) adds that when `npm test` needs a file outside Scope
only because of a file the lane adds (a manifest, an index or a module map), the lane stops with
`Lane stopped: Scope needs <paths>` so the owner extends Scope. Step 7 already requires the PR's "Outside Scope"
section, one line per changed file outside Scope "In" with its reason, and `gateDecision` in `scripts/lanes/lib.mjs`
(#635) appends "; N files outside Scope, see PR body" to the gate description without changing the state.

Between 2026-10-02 and 2026-10-05 about 11 lanes stopped on Scope. Seven stops were mechanical, with one obvious
answer and no design in it: a test whose assertions pin text or structure the issue itself changes (#621, #647, #715
`new-project.test.mjs`), and a registration line for a file the lane created (#634 and #665, #645 and #713
`vendor/owasp-cheatsheets/INDEX.md`; #688 a `.github/CODEOWNERS` line for a file the queue loads). The other stops
were design or coupling questions: #630 (a missing export), #651 and #747 (the same bug in other code) and #730 (a
module cycle). The owner should still decide those.

Each mechanical stop costs a lane run, an owner comment and a Scope edit, and the edit adds no information. The
planner side of this (predicting such files when it drafts Scope) is a separate issue and is not governed here. The
risk to bound is that a wide exception makes Scope meaningless, so any extension must stay narrow, visible and
reviewed like any other change.

## Decision

A lane may change two kinds of file outside its issue's Scope without stopping. Everything else outside Scope, code
included, still stops the lane with `Lane stopped: Scope needs <paths>` (or `conflict needs <paths>` for a rebase).

1. **Pinned tests.** A file named `*.test.mjs` whose failing assertion reads text, or a file, that the issue's Scope
   changes. The lane may update the expected text or structure so the assertion pins the new value. It never weakens
   what an assertion means: no deleted or skipped test, no loosened matcher, no removed case, and no change to what
   behaviour the test checks. A test that fails for any other reason is not covered.
2. **Registration lines.** A line that registers a file the lane itself created in this issue, in an existing
   registry: a child-process bullet in `vendor/owasp-cheatsheets/INDEX.md`, a module path prefix in
   `lanes.config.json`, a line in `.github/CODEOWNERS` for a script the queue loads. Registration means adding one
   entry for the lane's own new file only. The lane never removes, reorders or edits another entry, and never edits a
   registry for a file it did not create.

Conditions on every extension:

- Each extension file is listed under the PR's "Outside Scope" section with its reason, naming the kind (`pinned test`
  or `registration`) and the Scope file or new file it follows. Step 7's one line per file stays the record.
- The gate keeps flagging every out-of-Scope file with "; N files outside Scope, see PR body" (#635). `gateDecision` is
  not changed to exempt them.
- Reviewers, owner-path review and `paths.sensitive` are unchanged. An extension file that is an owner path (for
  example `.github/CODEOWNERS`, `vendor/` or `lanes.config.json`) still needs the owner's code-owner review, and one
  under `paths.sensitive` still gets every security review (standing rule 2). A reused verdict is valid only for
  byte-identical reviewed code.
- The queue's overlap check (`pathsOverlap` in `scripts/lanes/lib.mjs`, used by `pick.mjs`) works on Scope paths, so an
  extension file is not claimed by the issue's Scope. Once the PR exists its changed files are claimed, as today, and
  a second lane whose Scope names the same file is held until that PR merges or closes. Before the PR exists, a
  collision on a registry line shows up as a rebase conflict, which stops the lane under step 3's conflict rule. This
  ADR adds no new claim mechanism.
- Scope in the issue still has to name concrete paths for the work itself (rule 4). The planner is expected to list
  likely extension files when it can, and an extension is the fallback when it did not.

`lane.md` step 4 and step 5 are reworded to state this and to keep the stop for everything else; `workflow.test.mjs`
pins the new wording.

## Decisions for the owner

Decided by the owner on 2026-10-05: the two kinds above, the "Outside Scope" listing, the unchanged gate and review
rules, and that any other out-of-Scope file, code included, still stops the lane.

## Consequences

- The seven mechanical stops of the sample would not have stopped, so fewer owner comments, Scope edits and reruns.
- Scope is no longer a hard fence for these two kinds, only for the rest. The gate note and the "Outside Scope" lines
  keep the deviation visible in the PR, and owner-path and security review still see every changed file.
- "Does not weaken an assertion" is a judgement the lane makes and the test-hunter checks. A lane could pass off a
  weakened test as a pin. The test-hunter reviews test changes with the definition of done, and the owner reads the
  "Outside Scope" lines.
- An extension on a registry that two open PRs both edit can conflict. It resolves through the existing conflict
  rule, not through a claim.
- Superseding this rule means editing `lane.md` and `workflow.test.mjs` under a new ADR.

## Governs

- .claude/commands/lane.md
- scripts/lanes/workflow.test.mjs
