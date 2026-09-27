---
description: Architecture review of an issue or PR; records the decision as an ADR
argument-hint: <issue-or-pr-number>
---
Spawn the architecture-advisor agent as a fresh subagent on #$ARGUMENTS (`gh issue view` or `gh pr view`, and the
files they link). It decides with evidence. Record the decision as `docs/adr/NNNN-<slug>.md` (next number; Context,
Decision, Consequences) in its own tier:skip task issue and PR, and link it from #$ARGUMENTS. If the decision changes
an interface, the ADR names the contract file, and the implementing issues list the contract issue under "Blocked by".
