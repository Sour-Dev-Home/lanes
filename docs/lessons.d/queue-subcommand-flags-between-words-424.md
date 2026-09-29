---
area: queue
pattern: subcommand-flags-between-words
severity: important
reviewer: security-reviewer
source: "#424"
---

A guard that matches a CLI's subcommand path by adjacent words (`release` then `create`) misses a persistent flag the CLI accepts between them: `gh release --repo o/r create v1` created a tag the rule meant to deny.
Skip each level's own flags, with their values and glued forms, before reading the next subcommand word, and test a flag between each pair.
