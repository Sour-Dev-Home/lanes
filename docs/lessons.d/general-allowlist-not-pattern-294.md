---
area: general
pattern: allowlist-not-pattern
severity: important
reviewer: security-reviewer
source: "#294"
---

A schema string field that must never carry free text is an enum, not a lower-case pattern.
A pattern still admits a lower-cased login or title.
