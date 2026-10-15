---
area: general
pattern: allowlist-the-exemption
severity: important
reviewer: test-hunter
source: "#781"
---

A ruleset check that skips a bypass only in `always` mode is a denylist: `exempt`, a missing or unknown `bypass_mode` and a
malformed list still counted as protected. Accept only the one allowed mode (`pull_request`) and let anything else fail
closed, and test each of those values.
