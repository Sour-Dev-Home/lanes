---
area: queue
pattern: parser-line-end-variants
severity: important
reviewer: security-reviewer
source: "#61"
---

A parser that ends comments and statements only at LF misreads a language that also ends them at CR, NEL, U+2028 or U+2029: a comment then swallows the command after it.
Normalize every line end the language knows to LF before parsing. Build any regex holding U+2028 or U+2029 from code points, since a raw one in a JavaScript regex literal is a line break.
