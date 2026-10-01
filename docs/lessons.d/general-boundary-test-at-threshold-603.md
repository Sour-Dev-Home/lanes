---
area: general
pattern: boundary-test-at-threshold
severity: important
reviewer: test-hunter
source: "#603"
---

A length cap on a published link (`url.length > 500`) needs a test at exactly the cap and one past it, in the snapshot
filter and in the page check. Tests well inside and well outside let `>` flip to `>=` unnoticed. The same goes for
`ownerApproved === true`: test a string, a number and an object, so a truthy check cannot replace it.
