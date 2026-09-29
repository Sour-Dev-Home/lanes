---
area: general
pattern: name-and-cwd-both-attach
severity: important
reviewer: test-hunter
source: "#341"
---

When a safety check attaches a running session to a resource by two keys (a name and a cwd), attach it by every key that matches, not the first. Placing by cwd and falling back to the name only when the cwd matched nothing lets a session named for issue N but sitting in another issue's folder escape N's protection.
