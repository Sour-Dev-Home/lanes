---
area: gate
pattern: regex-on-untrusted-text
severity: important
reviewer: security-reviewer
source: "#277"
---

Bound the length of untrusted text before running a backtracking regex over it. A line pattern with overlapping `\s+`
and `.+` groups took 38 seconds on 4,000 spaces, and the issue-contract check runs it over every criterion of a public
issue body. Reject over-long lines first, and echo any regex engine message inside a code span.
