---
area: general
pattern: one-reader-for-external-field
severity: important
reviewer: test-hunter
source: "#730"
---

When an external tool renames or drops a field (`claude agents --json` sends `state`, no `status`), grep for every
read of the old field, not only the ones the issue lists. `waitForStop` in cleanup.mjs read `.status` alone and ended
its wait at once for a session that was still running. Route every read through one helper and test it with the new
output shape.
