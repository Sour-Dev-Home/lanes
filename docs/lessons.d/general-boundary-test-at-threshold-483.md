---
area: general
pattern: boundary-test-at-threshold
severity: important
reviewer: test-hunter
source: "#483"
---

A time or size threshold needs a test exactly at the limit and one step past it. Tests well inside and well
outside let `<=` flip to `<` unnoticed. The `--starts <days>` window in `startsReport` passed whole-day tests while
`>=` to `>` survived until a test at exactly N days and 1 ms older was added.
