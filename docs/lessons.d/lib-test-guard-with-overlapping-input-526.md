---
area: lib
pattern: test-guard-with-overlapping-input
severity: important
reviewer: test-hunter
source: "#526"
---

Test a defence-in-depth guard with an input that the outer check would let through. The `name !== "owner"` guard in
`trustedStatuses` only matters when a caller's reviewer names wrongly include `owner`; every test passed names without
it, so a mutant that broke the guard survived until a test passed `owner` in the list.
