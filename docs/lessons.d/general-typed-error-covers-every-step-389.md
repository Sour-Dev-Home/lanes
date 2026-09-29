---
area: general
pattern: typed-error-covers-every-step
severity: important
reviewer: security-reviewer
source: "#389"
---

A try/catch that maps failures to a typed error must wrap every later step that can throw, not just the first call.
In upgrade.mjs `main` rethrew everything except its own refusal, so a directory at a managed path escaped as a stack trace with exit 1.
