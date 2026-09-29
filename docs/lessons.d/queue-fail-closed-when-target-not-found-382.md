---
area: queue
pattern: fail-closed-when-target-not-found
severity: important
reviewer: test-hunter
source: "#382"
---

A destructive step that first looks up its target (a lane's worktree) must refuse when the lookup finds nothing.
Treating "not found" as "nothing to check" removed the session and relaunched without the dirty and unpushed
checks. Match the target by the session's own cwd as well as by name, and leave the lane for the owner otherwise.
