---
area: general
pattern: refusal-test-needs-other-checks-passing
severity: important
reviewer: test-hunter
source: "#461"
---

A test for one refusal in a chain of checks must satisfy every other check, or a mutant that deletes the check under
test still passes. The `owner` reviewer name was refused only because `.claude/agents/owner.md` did not exist, so
removing the explicit `owner` check went unnoticed until a test gave `owner` a valid agent file.
