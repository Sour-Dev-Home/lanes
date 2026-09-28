---
area: general
pattern: security-flag-defaults-safe
severity: important
reviewer: security-reviewer
source: "#294"
---

A privacy flag such as `public` must be required by the schema, so a report that forgets it is rejected instead of leaking local-only fields.
A rule that applies only when the flag is explicitly true fails open.
