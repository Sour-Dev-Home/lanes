---
area: general
pattern: security-flag-defaults-safe
severity: important
reviewer: security-reviewer
source: "#294"
---

A required privacy flag such as `public` must be required by the schema.
A rule that applies only when the flag is explicitly true fails open when the flag is missing.
