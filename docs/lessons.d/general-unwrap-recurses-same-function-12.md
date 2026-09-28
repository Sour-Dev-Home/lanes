---
area: general
pattern: unwrap-recurses-same-function
severity: important
reviewer: test-hunter
source: "#12"
---

A fix that unwraps a wrapper type must recurse with the same function on the inner value, not handle one level by hand.
Otherwise a wrapper nested inside another wrapper skips the fix.
