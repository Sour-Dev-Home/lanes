---
area: general
pattern: class-tests-need-mapped-paths
severity: important
reviewer: test-hunter
source: "#412"
---

A test for a rule that forces a fallback (such as "path class X prints ALL") must use inputs that would otherwise
take the narrow path. With unmapped paths the fallback fires anyway, so deleting the rule leaves the test green.
Map every path in the class test and check that removing the rule fails it.
