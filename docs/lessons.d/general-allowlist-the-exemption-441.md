---
area: general
pattern: allowlist-the-exemption
severity: important
reviewer: test-hunter
source: "#441"
---

When a guard's false positive is fixed by exempting a word in argument position, exempt only after a short list of
programs known to take subcommands (`gh`, `git`, `docker`), never by requiring a list of launchers before it. A
launcher list misses `{`, `!`, `then`, `taskset`, `nsenter` and the rest, and the guard fails open where it failed
closed.
