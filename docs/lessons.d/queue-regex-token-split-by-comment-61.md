---
area: queue
pattern: regex-token-split-by-comment
severity: critical
reviewer: test-hunter
source: "#61"
---

A regex that recognizes a code token such as `import\s*\(` misses the token when a comment splits it, as in `import/*x*/(…)`, which the language still parses as the same call.
Match the text once as written and once with comments replaced by a space, and count a hit in either. Never strip comments alone, because a `//` inside a string would hide real code.
