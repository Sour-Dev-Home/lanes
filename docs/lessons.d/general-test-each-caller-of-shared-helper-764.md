---
area: general
pattern: test-each-caller-of-shared-helper
severity: important
reviewer: test-hunter
source: "#764"
---

When one helper is shared by several parsers, a test per caller must depend on that caller's own use of it.
`parsePrBody` could skip `stripHtmlComments` unnoticed because its sections and duplicate-heading paths strip on
their own; only the `Closes #N` match read the unstripped text, so test that field too.
