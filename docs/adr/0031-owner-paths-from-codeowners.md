# 0031: Owner paths come from .github/CODEOWNERS; sensitivity is the explicit list widened by module risk; a floor test pins both

Status: accepted

## Context

Operability item 3 asked for one list that drives `paths.owner`, `paths.sensitive` and `.github/CODEOWNERS`, derived
from the module map, so an adopter edits the map only. Today there are three hand-kept lists. `paths.owner` has 25
regexes and `paths.sensitive` has 16, both in `lanes.config.json`. CODEOWNERS has one line per alternative.
`workflow.test.mjs` keeps CODEOWNERS and `paths.owner` equal, using `codeownersRegex` to turn a CODEOWNERS pattern into
a regex. The checks in the code:

- Only `compileConfig` and `classifyFiles` in `scripts/lanes/lib.mjs` read `paths.owner` and `paths.sensitive`.
- `risk` and `owner` on a module entry are validated by `scripts/lanes/modules.mjs` and used nowhere else. ADR 0018
  phase 1 made both "data only"; `contracts/module-map.schema.json` says the same.
- `.github/CODEOWNERS` is already read by the gate. `readNativeApproval` reads it from the default-branch checkout, for
  the user owners (ADR 0021). GitHub's own code-owner rule enforces it, independently of lanes.

Deriving the lists from the module map fails on the facts:

1. The map covers only code under `scripts/` and `contracts/module-map.`. Most owner and sensitive entries are not
   code and match anywhere in the tree: `^\.github/`, `^docs/adr/`, `^vendor/`, `(^|/)CLAUDE\.md$`, `(^|/)\.env`,
   `(^|/)auth/`, `(^|/)secrets?/`, `^deploy/`, the lock files, `.gitattributes`, `lanes.lock.json`,
   `.claude/settings.json`, `.claude/agents/` and two files under `.claude/commands/`. No module can hold them.
2. Owner files cut across modules. `queue.mjs` is owner and `snapshot.mjs`, in the same module, is not. `blockers.mjs`
   is in the gate module. `health.mjs` became owner in #688 because the queue imports it (ADR 0026, the closure
   rule). A per-module owner flag has the wrong granularity.
3. `paths.sensitive` holds the blanket `^scripts/lanes/`. The modules `gate`, `modules` and `preflight` are marked
   `risk: normal` and are sensitive today. Deriving sensitivity from `risk` alone would narrow security review, which
   standing rule 2 forbids.
4. CODEOWNERS is gitignore-style globs and `paths.owner` is regexes. Generating one from the other needs an exact
   translation, and there is none for every regex.

ADR 0021 declined per-path CODEOWNERS matching in lanes "for no gain", because the file was kept in step with
`paths.owner` by a test. That reasoning changes if the matching removes the second list.

## Decision

Keep CODEOWNERS and `paths.owner` from being two lists by deleting the second, not by generating one from the other.
Use the module map only where it fits, which is `risk`.

**1. CODEOWNERS is the only owner-path list.** `scripts/lanes/lib.mjs` gains `parseOwnerPatterns(text)` and a matcher,
moving `codeownersRegex` out of `workflow.test.mjs`. `loadConfig` reads `.github/CODEOWNERS` from the same checkout as
`lanes.config.json` and passes its text to `compileConfig` as an optional second argument, so no caller changes. The
gate runs in the default-branch checkout, so it reads the default branch's CODEOWNERS, never the PR's copy, and a PR
cannot narrow its own ownership. `classifyFiles` computes `owner` from the CODEOWNERS patterns plus any `paths.owner`
regexes still in the config. The two are a union, so the change can only widen what is owner-only.

**2. The matcher accepts a strict subset of GitHub's syntax and fails closed on the rest.**

- Allowed: a leading `/` (anchor), a trailing `/` (directory and everything under it), and `*` only inside a single
  segment of a pattern with no inner `/`, as in `.env*`.
- Rejected, with an error that stops the gate with an `error` status: `**`, `?`, `[`, `]`, `!`, a backslash, and a
  `*` in a pattern that has an inner `/`.
- A line with no owner is rejected, because in GitHub it un-owns a path.
- A missing CODEOWNERS with no `paths.owner` is an error under the team profile (ADR 0025), never "no owner paths".
- Where lanes' matcher is narrower than GitHub's, the ruleset still blocks the merge. Where it is wider, the gate waits
  longer. Neither lets a PR through without the owner. The gate's "approved" still relies on the ruleset being on, as
  in ADR 0021.

**3. Sensitivity is the explicit list widened by module risk.** `compileConfig` builds the effective sensitive set as
`paths.sensitive` plus a literal-prefix pattern for every `paths` entry of a module with `risk: "sensitive"`. The list
stays the blanket for non-code paths. It keeps `^scripts/lanes/`, so `gate`, `modules` and `preflight` stay sensitive.
`risk` becomes read data and can only add review. A module's `risk` is not a way to remove it, and ADR 0018's "config
can only add" rule holds.

**4. The module `owner` flag is not used.** It stays valid and ignored, so no adopter's map breaks. The schema
description says CODEOWNERS is the owner list. It is not removed in this ADR, since removing a key is a breaking
contract change and gains nothing.

**5. A floor test pins both lists.** `workflow.test.mjs` holds a frozen copy of today's 25 owner and 16 sensitive
regexes, as `OWNER_FLOOR` and `SENSITIVE_FLOOR`. For every tracked file plus a fixed sample set (`.env.local`,
`x/.env`, `a/auth/x.js`, `secret/x`, `deploy/x`, nested `CLAUDE.md`, nested `yarn.lock`, `lanes.lock.json`,
`package-lock.json`), a file the floor classes as owner must be owner under the real config and CODEOWNERS, and a file
the floor classes as sensitive must be sensitive. The floor only grows; shrinking it needs an ADR. The existing check
that every CODEOWNERS entry is reached by a tracked file or sample stays, so a typo cannot hide. The old
"CODEOWNERS equals `paths.owner`" test goes once `paths.owner` is empty.

**6. "Adopters edit the module map only" is softened to what is true.** An adopter edits CODEOWNERS for owner paths, as
the code-owner ruleset already requires. It edits the module map for `risk`. It keeps `paths.sensitive` for the blanket
and non-code paths. Two files and one list are fewer than the three lists now, and each name is GitHub's own or the
map's own.

**7. Migration is three steps and never has a window that narrows.** First the parser and union land with
`paths.owner` untouched. Then the floor test and the risk union land. Last `paths.owner` in this repository's
`lanes.config.json` is emptied, and `upgrade` leaves an adopter's own `paths.owner` in place, still honoured as extra
patterns, with a note in USING.md that it is deprecated.

## Decisions for the owner

1. CODEOWNERS as the single owner list, replacing `paths.owner` here: approved with this ADR.
2. Module-derived owner flag rejected, for the reasons in Context 1 and 2: approved with this ADR.
3. The strict-subset matcher that fails closed on unsupported syntax: approved with this ADR.
4. `risk` widens `paths.sensitive` and never narrows it; the blanket stays: approved with this ADR.
5. The adopter-facing statement is "CODEOWNERS plus `risk`", not "the module map only": approved with this ADR.

## Consequences

- One owner list, in the syntax GitHub enforces. The drift test between two lists goes away, and a drift between
  lanes and GitHub is bounded by the strict subset.
- `risk` finally means something. A sensitive module added to the map is reviewed by the security-reviewer without a
  second edit.
- `lib.mjs`, `gate.mjs` and `workflow.test.mjs` are owner paths, so all three steps need owner approval.
- ADR 0021's "per-path matching would duplicate the semantics" is amended: lanes now matches CODEOWNERS patterns, but
  only a subset, and only to decide when the gate waits for the owner. Who counts as an owner is still any listed user.
- The floor lists are a permanent copy of today's regexes in a test. A reader sees why: it is the proof of rule 2.
- Adopters with a CODEOWNERS that uses `**` or character classes get an error until they simplify it or move those
  paths to `paths.owner`.

## Governs

- lanes.config.json
- .github/CODEOWNERS
- scripts/lanes/lib.mjs
- scripts/lanes/lib.test.mjs
- scripts/lanes/modules.mjs
- scripts/lanes/gate.mjs
- scripts/lanes/workflow.test.mjs
- contracts/module-map.schema.json
