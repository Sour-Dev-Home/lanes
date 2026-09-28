---
area: general
pattern: security-flag-defaults-safe
severity: critical
reviewer: security-reviewer
source: "#12"
---

A security-relevant flag or option must default to the safe behaviour when it is missing, empty or malformed.
Opting out of a check should take an explicit value, never the absence of one.
