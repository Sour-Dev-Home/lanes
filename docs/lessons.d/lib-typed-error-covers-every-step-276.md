---
area: lib
pattern: typed-error-covers-every-step
severity: important
reviewer: test-hunter
source: "#276"
---

A script that maps failures to a documented exit code must also wrap its file writes, log reads and child-process calls.
An unwrapped `mkdirSync` or `appendFileSync` crashed with exit 1, which a retry loop reads as "attempts remain".
