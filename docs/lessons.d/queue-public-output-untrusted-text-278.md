---
area: queue
pattern: public-output-untrusted-text
severity: important
reviewer: security-reviewer
source: "#278"
---

Text that reaches a published file must come only from sources the repository controls. A fork's pull request can name its own check runs and claim `Fixes #N`, so its check names must never be published.
Accept a pull request only when it is proven same-repo (`isCrossRepository === false`), and treat a missing field as a stranger's, since a published value that a secret-pattern scan later compares becomes an oracle for that secret.
