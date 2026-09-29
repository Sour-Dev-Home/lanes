---
area: queue
pattern: redos-ambiguous-quantifier
severity: important
reviewer: security-reviewer
source: "#378"
---

A guard regex with unbounded runs such as `\.\s*\(\s*\$[^)]*\)` is quadratic on repeated openers (`.( $` times 40,000),
because each start position scans to the end of the text before failing, so a long command stalls the hook and fails
open. Bound every run (`[^)]{0,64}`, `\s{0,16}`) in a regex that reads the whole command, and add a timing test.
