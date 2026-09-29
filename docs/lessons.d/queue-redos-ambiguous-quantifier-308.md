---
area: queue
pattern: redos-ambiguous-quantifier
severity: important
reviewer: security-reviewer
source: "#308"
---

A glob turned into a regex by writing `.*` for each `*` makes a run of stars (`********************.mjs`) backtrack exponentially, so a 20-character command hangs the guard hook.
Match a glob built from untrusted text without a backtracking regex (walk a set of positions), cap the word's length, and add a timing test with a long run of stars.
