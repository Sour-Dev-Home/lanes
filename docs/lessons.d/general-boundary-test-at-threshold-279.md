---
area: general
pattern: boundary-test-at-threshold
severity: important
reviewer: test-hunter
source: "#279"
---

A time or size threshold needs a test exactly at the limit and one step past it. Tests well inside and well
outside let `<=` flip to `<` unnoticed.
