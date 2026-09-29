---
area: general
pattern: boundary-test-at-threshold
severity: important
reviewer: test-hunter
source: "#416"
---

A time or size threshold needs a test exactly at the limit and one step past it. Tests well inside and well
outside let `<=` flip to `<` unnoticed. The PATH-length note in `launchEnv` passed a 72-entry test while `>= 60`
survived until a 60/61 test was added.
