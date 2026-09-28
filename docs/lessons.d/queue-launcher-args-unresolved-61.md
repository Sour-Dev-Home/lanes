---
area: queue
pattern: launcher-args-unresolved
severity: important
reviewer: security-reviewer
source: "#61"
---

A command that starts another program from its arguments (Start-Process, eval, a shell's -c) must fail closed when any of those arguments is known only at run time, not only when it is literal text naming a target.
Treat every launcher the same way: an expanding argument reads as an unresolved command.
