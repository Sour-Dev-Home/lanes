---
area: queue
pattern: denylist-bypassed-by-computed-keys
severity: critical
reviewer: security-reviewer
source: "#61"
---

A list of dangerous API names is bypassed when the names are built at run time: computed keys (`const {[k]: g} = process`) and joined strings (`"constr" + "uctor"`, `"proc" + "ess"`) leave no token in the source to match.
To exempt code from a deny, prove it harmless with an allowlist of the names, members and shapes it may use, and deny everything else.
