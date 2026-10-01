---
area: general
pattern: allowlist-the-exemption
severity: important
reviewer: test-hunter
source: "#588"
---

A guard that reads a program's text only when its output feeds a shell must treat every way a shell can read that output the same: `| sh`, and also `bash <(awk ...)`. The #588 awk check keyed on a pipe alone and let `bash <(awk 'BEGIN{print "node queue.mjs"}')` through while the `echo` equivalent was denied. Test each consumer form (pipe, process substitution, command substitution) for every exemption.
