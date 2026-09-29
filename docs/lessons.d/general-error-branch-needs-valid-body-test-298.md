---
area: general
pattern: error-branch-needs-valid-body-test
severity: important
reviewer: test-hunter
source: "#298"
---

A test for a failed-response branch (`!response.ok`) must give the failure a body that would pass validation. If the
fixture body is also invalid, a mutant that deletes the status check still hides the result and survives.
