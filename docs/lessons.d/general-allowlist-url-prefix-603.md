---
area: general
pattern: allowlist-url-prefix
severity: important
reviewer: security-reviewer
source: "#603"
---

A prefix check (`https://github.com/<repo>/`) does not keep a link inside that prefix: a browser resolves `..`, `%2e`
and, for https, a backslash as path separators, so `<prefix>pull/1/..\..\other/x` lands elsewhere. Reject `\`, `%5c`,
`%2f` and dot segments in the path, in the writer and again in the page, and test each form in both layers.
