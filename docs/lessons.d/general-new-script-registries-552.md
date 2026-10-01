---
area: general
pattern: new-script-registries
severity: important
reviewer: security-reviewer
source: "#552"
---

A new lanes script is registered in more places than its module entry. One that imports `node:child_process` needs a
line in `vendor/owasp-cheatsheets/INDEX.md` (ADR 0009), and one a command file runs needs a line in `install.mjs`'s
`MANIFEST`. Run the full suite before review, since `vendor.test.mjs` and `install.test.mjs` catch both and an issue's
Scope may name neither file.
