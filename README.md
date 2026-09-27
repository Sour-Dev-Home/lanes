# lanes

A workflow for building software with parallel Claude Code sessions ("lanes"): one fresh
session per GitHub issue, contracts at every handoff, required checks as the only
gatekeeper, and unattended nights for low-risk work. See [docs/USING.md](docs/USING.md)
and the design in [docs/specs/](docs/specs/).

Install into another repository: `node scripts/lanes/install.mjs <target-dir>`.
