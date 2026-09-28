---
area: general
pattern: allowlist-not-pattern
severity: important
reviewer: security-reviewer
source: "#294"
---

A schema string field that must never carry free text should be an enum, not a character-class pattern.
A pattern of lower-case letters and spaces still accepts a lower-cased login or a short title, and a test using capitals or an `@` will not show it.
