---
area: general
pattern: injected-dependency-default-bypass
severity: important
reviewer: test-hunter
source: "#267"
---

When a function takes an injected dependency, every default it computes for its other parameters must go through that same dependency.
A default such as `root = repoRoot()` that calls the private implementation silently bypasses the injection, so a test or caller believes every read is faked while one still runs for real.
