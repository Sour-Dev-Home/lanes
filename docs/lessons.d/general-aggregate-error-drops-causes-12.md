---
area: general
pattern: aggregate-error-drops-causes
severity: important
reviewer: test-hunter
source: "#12"
---

`String(err)` on an `AggregateError` prints only its top message and drops every cause in `err.errors`.
Format the causes too when logging or reporting an error that may aggregate others.
