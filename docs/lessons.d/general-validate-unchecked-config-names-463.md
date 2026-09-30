---
area: general
pattern: validate-unchecked-config-names
severity: important
reviewer: security-reviewer
source: "#463"
---

A name read from a config block that `loadConfig` leaves unchecked must be checked against the agent-name shape before
a guard trusts it: excluding only the exact string `owner` let `Owner` or `review/owner` through as a reviewer. On one
bad name, fall back to the built-in set rather than dropping just that name.
