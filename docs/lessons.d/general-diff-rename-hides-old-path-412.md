---
area: general
pattern: diff-rename-hides-old-path
severity: important
reviewer: security-reviewer
source: "#412"
---

`git diff --name-only` with default rename detection lists only the new path of a rename, so a check keyed on
the changed paths misses a file moved out of a sensitive directory. Pass `--no-renames` (and `-z`, so paths are
raw and NUL-separated) whenever the old path matters to a fail-safe decision.
