---
area: general
pattern: issue-tier-matches-sensitive-paths
severity: important
reviewer: security-reviewer
source: "#429"
---

A planner rule that drafts an issue at `tier skip` must check that every file the issue changes is a skip path.
`lanes.config.json` is a sensitive path, so an issue whose only change is that file needs `tier quick` and the
security-reviewer, or its PR fails the gate.
