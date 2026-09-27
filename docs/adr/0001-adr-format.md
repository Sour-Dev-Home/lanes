# 0001: Architecture decision records have one machine-readable format

Status: accepted

## Context

Design decisions were recorded as prose, if at all. `/adr` (and `/plan-issues`, #46) should write them, and the gate
and `reviewers.mjs` (#45) should know which files a decision governs so a diff touching them gets the
architecture-advisor. Neither works unless an ADR is something a script can read, and a malformed ADR is caught
before it merges.

## Decision

An ADR is `docs/adr/NNNN-<slug>.md` in the format that `contracts/adr-template.md` defines: a `# NNNN: <title>`, a
`Status:` line (`proposed`, `accepted` or `superseded by NNNN`), the sections Context, Decision, Decisions for the
owner and Consequences, and `## Governs`, a list of repo-relative paths where a trailing `/` means a directory.

`parseAdr(text)` in `scripts/lanes/lib.mjs` returns `{ number, title, status, governs }` (plus `supersededBy` for a
superseded ADR) or `{ error }` naming what is wrong. `adrGoverns(adrs, file)` returns the numbers of the accepted ADRs
that govern `file`. `contracts.test.mjs` parses the template's example and every `docs/adr/*.md`, and checks the file
name's number matches the title's.

Governs entries are plain paths, not globs or regexes: exact files and directory prefixes are enough, are easy to
review, and can't silently match more than the author meant. Only accepted ADRs govern; a proposed one is not yet a
decision and a superseded one has been replaced.

## Decisions for the owner

nothing. The format is the one specified in #44, which the owner marked ready.

## Consequences

The planner can write ADRs and the gate can read them (#45, #46). A malformed ADR fails `contracts.test.mjs` and
can't merge. Changing the format is a contract change to `contracts/adr-template.md` and needs its own ADR that
supersedes this one. Globs are unavailable: an ADR governing many scattered files lists each one.

## Governs

- contracts/adr-template.md
