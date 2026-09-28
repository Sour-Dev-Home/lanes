---
area: queue
pattern: redos-ambiguous-quantifier
severity: important
reviewer: security-reviewer
source: "#61"
---

A regex that repeats a group whose class can match the group's own delimiters (`(?:\[[…[\] ]+\]\s*)*`) backtracks exponentially on a crafted input, and a guard hook that times out lets the call through.
Keep every repeated group unambiguous (no delimiter or separator inside its class), and add a timing test with a long crafted input.
