---
description: Architecture review of an issue or PR; records the decision as an ADR
argument-hint: <issue-or-pr-number | idea text>
---
The argument is either an issue or PR number, or the idea text from `/plan-issues`: $ARGUMENTS

**An issue or PR number.** Spawn the architecture-advisor agent as a fresh subagent on #$ARGUMENTS (`gh issue view`
or `gh pr view`, and the files they link). It decides with evidence. Record the decision as
`docs/adr/NNNN-<slug>.md` (next number) in `contracts/adr-template.md`'s format, in its own tier:skip task issue and
PR, and link it from #$ARGUMENTS. If the decision changes an interface, the ADR names the contract file, and the
implementing issues list the contract issue under "Blocked by".

**Idea text from `/plan-issues`.** Spawn the architecture-advisor agent as a fresh subagent on the idea text and the
files it touches. It decides with evidence. Return the full ADR text to `/plan-issues` in
`contracts/adr-template.md`'s format, with `Status: accepted`, the next free number, and a `Governs` list naming the
files the implementing issues will change. Return it without filing an issue or opening a PR yourself: `/plan-issues`
puts it first in its draft for the owner to approve.
