---
area: queue
pattern: value-read-from-file
severity: important
reviewer: test-hunter
source: "#468"
---

When a guard treats a `gh api` field value read from a file (`-F name=@f`) as unknown, apply that to every field it
checks, not only the first one written. `gh api releases/$ID -X PATCH -F draft=@f` passed because the `@file` check
ran for `tag_name` alone. Test the `@` form for each field.
