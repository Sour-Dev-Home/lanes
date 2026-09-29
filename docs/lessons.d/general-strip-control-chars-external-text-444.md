---
area: general
pattern: strip-control-chars-external-text
severity: important
reviewer: security-reviewer
source: "#444"
---

A line printed to the owner's terminal must not carry external text (check names, status descriptions, PR titles)
with its control characters. Strip them where the line is printed, not only in the one digest that already did, or a
new message built from the same text lets an ANSI escape through.
