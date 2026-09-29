# Changelog

## [0.1.0] - 2026-09-29

First tracked release. Lanes ships:

- Lane workflow: the `/lane`, `/start`, `/status`, `/approve`, `/approvals`, `/adr`, `/health`, `/night` and `/plan-issues` commands, with the reviewer agents (test-hunter, security-reviewer, ui-reviewer, architecture-advisor).
- The `lanes/gate` status check and its review, owner-approval and CI rules, with the issue-contract and security workflows.
- Guards: the approve and start guards, the pre-push hook and the shell lexer they share.
- Tooling: blockers, overlap picking, validation loops, lessons, cost and review metrics, cleanup, and the dashboard with its snapshot.
- Vendored agent skills and OWASP cheat sheets.
- `install.mjs`, which copies the workflow into another repository and records the version and the sha256 of each file it wrote in `lanes.lock.json` (contract: `contracts/lanes-lock.schema.json`).
