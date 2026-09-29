---
area: general
pattern: tokenizer-contextual-keyword
severity: critical
reviewer: security-reviewer
source: "#381"
---

A hand-written tokenizer that guesses regex versus division from the previous word needs an allowlist, not a list of known cases. `of` is a legal name (`of / 2` divides) and `extends` takes a regex (`class A extends /'/ {}`); guessing wrong let a check miss code that runs at import.
Class every reserved and contextual word explicitly, refuse a `/` after any word whose reading depends on grammar (fail closed), and treat a word after `.`, `?.` or `#` as a name, never a keyword.
