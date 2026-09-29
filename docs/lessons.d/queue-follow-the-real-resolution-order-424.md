---
area: queue
pattern: follow-the-real-resolution-order
severity: important
reviewer: test-hunter
source: "#424"
---

A guard that expands a name the way the tool would must use the tool's own lookup order, not an idealised one: git ignores an alias that shadows a built-in, so expanding `-c alias.tag=log` before reading `tag v1` let a real tag through.
Check built-ins before aliases, and test a shadowing alias for each subcommand the rule covers.
