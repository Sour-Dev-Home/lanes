---
area: queue
pattern: allowlist-checked-against-own-runtime
severity: critical
reviewer: security-reviewer
source: "#61"
---

An allowlist that accepts "any name the guard's own runtime does not define" trusts the wrong scope: `node -e` also has every builtin module (`child_process`) as a bare name, and destructuring (`const {execSync} = child_process`) reads members with no `.` to check.
Accept only names the checked code binds itself, veto those that shadow a global or builtin, and refuse destructuring outright.
