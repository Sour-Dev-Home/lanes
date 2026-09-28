---
area: queue
pattern: denylist-bypassed-by-computed-keys
severity: important
reviewer: security-reviewer
source: "#61"
---

A list of dangerous API names is bypassed by computed keys such as `const {[k]: g} = process`, where the name is only built at run time.
Match the roots that reach those APIs (process, global, globalThis, this, arguments, require, import) as well as the names.
