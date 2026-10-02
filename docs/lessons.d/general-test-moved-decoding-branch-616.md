---
area: general
pattern: test-moved-decoding-branch
severity: important
reviewer: test-hunter
source: "#616"
---

When code moves with only the tests its old owner had, check which of its branches those tests reached through the new home.
The `-EncodedCommand` decoding in `powershellAsBash` (`isEncodedFlag` prefix test, `BASE64_RE` charset) was reached by no test, so breaking either survived; a mutation run found both, and one test of accepted and rejected flags and a base64 value with `+`, `/` and `=` kills them.
