---
area: general
pattern: security-flag-defaults-safe
severity: important
reviewer: security-reviewer
source: "#412"
---

A switch that turns a safety fallback off must be strict: only an absent key or exactly `true` may narrow work,
and any other value (`"false"`, `0`, `null`) must take the safe path. Testing `=== false` lets a mistyped
disable switch fail open. `ci.affectedTests` in affected-tests.mjs did exactly that until a review caught it.
