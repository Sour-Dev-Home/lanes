---
area: metrics
pattern: reduced-shape-keeps-downstream-inputs
severity: important
reviewer: architecture-advisor
source: "#295"
---

When a normaliser reduces raw data to aggregates-safe fields, check the accepted ADR for what the next stage needs to
derive from it. Reducing an issue body to counts dropped the Scope paths that scope drift needs, and the shared parsers
(`parseIssueForm`, `issuePaths`) could have kept them without leaking text.
