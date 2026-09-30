---
area: general
pattern: check-module-map-before-import
severity: important
reviewer: architecture-advisor
source: "#453"
---

Before importing a helper from another lanes script, check which module owns it in `lanes.config.json` and run
`node scripts/lanes/modules.mjs`. `issue-contract.mjs` (gate module) imported `issuePaths` from `paths.mjs` (queue
module), which ADR 0008 forbids; `lib.mjs` already exported `interfacePaths`, which does the same job.
