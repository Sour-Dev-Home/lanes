---
area: general
pattern: pin-actions-by-sha
severity: important
reviewer: security-reviewer
source: "#649"
---

A new workflow must pin every `uses:` to a full commit SHA, as the repository's other workflows do, most of all one that
runs next to a secret such as an App key: a moved tag would run someone else's code beside it. Test that every `uses:`
matches `@<40 hex>`.
