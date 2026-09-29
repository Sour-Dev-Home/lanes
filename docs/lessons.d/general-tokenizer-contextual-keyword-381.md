---
area: general
pattern: tokenizer-contextual-keyword
severity: critical
reviewer: security-reviewer
source: "#381"
---

A hand-written tokenizer that guesses regex versus division from the previous word must treat only reserved words as keywords. `of` is a legal variable name, so a `/` after it can be a division, and reading it as a regex let a check miss code that runs at import.
Refuse the ambiguous case (fail closed), and remember that a word after `.`, `?.` or `#` is a name, never a keyword.
