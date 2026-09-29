---
area: general
pattern: redos-guard-needs-probe
severity: important
reviewer: security-reviewer
source: "#409"
---

A guard that refuses ReDoS-prone regex text by shape (a quantified group, a length cap) misses group-free blowups:
`a?` x28 then `a` x28, or `a*a*a*a*a*a*b`, which is polynomial at about n^6. Cap the number of quantifier tokens low
(two), and time a probe of each shape with a timeout instead of trusting the rule to cover them.
