---
area: lib
pattern: test-value-equal-to-threshold
severity: important
reviewer: test-hunter
source: "#276"
---

Test a comparison at exactly its threshold, not only on either side of it. A mutant that turned `<=` into `<` survived
because no test used a value equal to the threshold.
