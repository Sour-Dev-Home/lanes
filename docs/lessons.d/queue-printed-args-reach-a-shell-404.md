---
area: queue
pattern: printed-args-reach-a-shell
severity: critical
reviewer: security-reviewer
source: "#404"
---

A guard that stops reading a command's arguments as runnable because the command "only prints" (echo, printf) fails
open: what it prints reaches a shell through a pipe, and also through `bash <(echo …)`, `sh < <(echo …)`,
`bash <<< $(echo …)` or a function piped to `sh`, shapes a pipe-only check never sees. Exempt only commands whose
arguments are file names or patterns that are never printed as given (grep, cat, ls), and test every shape that feeds
output to a shell against the base branch before calling a false-positive fix done.
