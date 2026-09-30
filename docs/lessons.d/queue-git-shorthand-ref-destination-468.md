---
area: queue
pattern: git-shorthand-ref-destination
severity: important
reviewer: test-hunter
source: "#468"
---

A guard that reads a refspec destination must also read git's shorthand: `git fetch . HEAD:tags/v1` writes
`refs/tags/v1`, because git completes `tags/`, `heads/` and `remotes/` to `refs/…` itself. Match the completed
name as well as the full one, and test the bare form.
