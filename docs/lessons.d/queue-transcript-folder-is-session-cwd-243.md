---
area: queue
pattern: transcript-folder-is-session-cwd
severity: important
reviewer: test-hunter
source: "#243"
---

A Claude Code session's transcript is stored under the project folder of the session's own working directory, and a lane's
is its worktree, not the repository root. Look there (the root's folder second) and check the real layout on disk before
trusting an assumed one, or every lane reads as having no transcript.
