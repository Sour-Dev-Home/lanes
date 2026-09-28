---
area: queue
pattern: tokenizer-context-from-bindable-name
severity: important
reviewer: security-reviewer
source: "#61"
---

A tokenizer that decides regex-or-division from the word before `/` must only trust reserved words: `of` is also a name a script can bind (`const of = 4`), and then `of / … /` hides real code inside a "regex".
Refuse input that binds such a word, and let every uncertain case fall to the reading that refuses.
