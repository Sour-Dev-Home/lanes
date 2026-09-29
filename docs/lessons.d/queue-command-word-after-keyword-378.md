---
area: queue
pattern: command-word-after-keyword
severity: important
reviewer: test-hunter
source: "#378"
---

A rule that reads a simple command's first word as its command word misses the same command after a shell keyword
(`if …; then eval "$X"`, `do`, `while`, `{`, `!`, `time`), which a lexer that splits on `;` leaves at the front of the
words. Skip those reserved words before matching, and test each keyword form beside the plain one.
