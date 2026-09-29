---
area: queue
pattern: printed-args-reach-a-shell
severity: critical
reviewer: security-reviewer
source: "#404"
---

A guard that stops reading a command's arguments as runnable because the command "only prints" or "only reads" fails
open: echo and printf print their arguments, ls and `grep -l` print the names they are given, and cat, head, tail and
grep print a here-string, and any of that output reaches a shell through `bash <(…)`, `sh < <(…)`, `bash <<< $(…)`, a
file run later or `tee`, shapes a pipe-only check never sees. Exempt the narrowest word that is never printed as given
(a search pattern, not the whole command), and test every shape that feeds output to a shell against the base branch
before calling a false-positive fix done.
