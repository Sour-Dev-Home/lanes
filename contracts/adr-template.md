# ADR format

An architecture decision record lives at `docs/adr/NNNN-<slug>.md`: `NNNN` is the next free four-digit number, the
same number as in its title, and `<slug>` is lower-case words joined by `-`. `parseAdr` in `scripts/lanes/lib.mjs`
reads it, and `scripts/lanes/contracts.test.mjs` fails on any ADR in `docs/adr/` that doesn't parse, so a malformed
ADR can't merge.

## Fields

- **Title**: the first `# ` line, `# NNNN: <title>`. `parseAdr` returns `number` (an integer) and `title`.
- **Status**: a line `Status: <status>` below the title, where `<status>` is exactly one of:
  - `proposed`: drafted, not yet decided. It governs nothing.
  - `accepted`: decided. It governs the paths in `## Governs`.
  - `superseded by NNNN`: replaced by ADR `NNNN`. It governs nothing. `parseAdr` returns `status: "superseded"` and
    `supersededBy: NNNN` (an integer).
- **Sections**, each a `## ` heading, in this order: `Context` (the forces and the problem), `Decision` (what we do),
  `Decisions for the owner` (what the owner must decide or has decided, or `nothing`), `Consequences` (what follows,
  good and bad).
- **`## Governs`**: a list (`- ` items) of repo-relative paths this decision governs. A trailing `/` means a
  directory and everything under it; otherwise the entry names one file exactly. An entry may be wrapped in
  backticks. `parseAdr` rejects, with `{ error }`: an empty list, a line that is not a list item, an absolute path,
  a backslash, a `..`, `.` or empty segment, and a glob character (`* ? [ ] { } !`).

`adrGoverns(adrs, file)` returns the numbers of the **accepted** ADRs whose `Governs` lists `file` exactly or a
directory containing it. `scripts/lanes2/x.mjs` is not under `scripts/lanes/`.

HTML comments and anything inside a code fence are ignored when parsing.

## Example

```markdown
# 0007: Cache the snapshot per commit

Status: accepted

## Context

Loading the snapshot on every request is slow and the snapshot only changes when a commit lands.

## Decision

Cache it keyed by commit SHA, in the snapshot module only.

## Decisions for the owner

nothing

## Consequences

Reads are fast. A cache bug serves a stale snapshot until the next commit.

## Governs

- src/snapshot/
- contracts/snapshot.schema.json
```
