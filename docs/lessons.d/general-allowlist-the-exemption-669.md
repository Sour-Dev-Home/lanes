---
area: general
pattern: allowlist-the-exemption
severity: important
reviewer: security-reviewer
source: "#669"
---

When a guard treats a quoted `$` as text because the command only prints it, the exemption holds only while the output
stays text. A "text sink" list must exclude every program that writes a file or runs a helper without a redirect:
`sort -o f`, an abbreviated `--out=f`, `sort --compress-program=sh`, and `uniq - f` all passed a denylist of `-o` and
`--output`, and a later `bash f` then ran the text. Allowlist the sinks (`head`, `wc`, `grep`) and leave out any program
with an output-file option.
