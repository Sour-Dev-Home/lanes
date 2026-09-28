---
area: queue
pattern: security-flag-defaults-safe
severity: important
reviewer: security-reviewer
source: "#61"
---

When a guard's reader gives up on input the real interpreter still runs (a marker character, nesting past the reader's limit), a names-only fallback lets computed names through.
Make the reader accept such input, or deny outright when the failure is a limit of the reader rather than of the language.
