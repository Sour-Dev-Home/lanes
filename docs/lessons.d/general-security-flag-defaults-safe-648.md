---
area: general
pattern: security-flag-defaults-safe
severity: important
reviewer: security-reviewer
source: "#648"
---

Setup that "creates" a restricted resource must also cope with one that already exists. `app-setup.mjs --workflows`
PUT an existing environment and only added the `main` branch policy, so older policies such as `*` survived and the
environment holding a workflows-write key was not main-only. List what exists and delete everything but the allowed
entry, and test with a pre-existing resource holding extra policies.
