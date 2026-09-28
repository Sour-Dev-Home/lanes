---
area: general
pattern: typed-error-covers-every-step
severity: important
reviewer: test-hunter
source: "#12"
---

A try/catch that maps failures to a typed error must wrap every later step that can throw, not just the first call.
A parse or validation step left outside it escapes as a raw exception the caller never handles.
