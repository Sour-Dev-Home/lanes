---
area: general
pattern: allowlist-the-exemption
severity: important
reviewer: security-reviewer
source: "#576"
---

An exemption for text a program only prints (a jq or awk program, a path argument) holds only while nothing consumes
the output. A guard that withdrew it only for a pipe into a named shell let the same text through when it was piped
to `xargs node` or `tee`, or redirected with `2>&1`; withdraw it for any pipe out, any redirect and any substitution.
Likewise an awk program read from a file (`-f`, `-i`) may run a `-v` value, so an exemption keyed on the program text
must not apply when the program is not on the command line.
