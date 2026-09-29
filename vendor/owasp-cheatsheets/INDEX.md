# OWASP sheet index for lanes

lanes' own text (MIT, like the rest of the repository; not adapted from the sheets, see `VENDORED.md`). The security
reviewer reads this file first, finds the rows that match the diff, and then reads at most three of the sheets named
there. Cite findings as sheet and section, for example "OS Command Injection Defense, Defense option 3". Where a sheet
and `vendor/agent-skills/references/security-checklist.md` differ, the sheet wins (ADR 0009).

## By path in this repository

| Path | Why it is sensitive | Read |
|---|---|---|
| `scripts/lanes/approve-guard.mjs`, `scripts/lanes/start-guard.mjs` | Hooks that parse untrusted command and prompt text to allow or deny `/approve` and `/start` | `sheets/OS_Command_Injection_Defense_Cheat_Sheet.md` (Argument Injection, Defense option 3), `sheets/Input_Validation_Cheat_Sheet.md` (Allowlist vs Denylist, Regular Expressions) |
| Scripts that run a child process (list below) | `gh`, `git` and `claude` run with arguments built from issue, PR and branch text | `sheets/OS_Command_Injection_Defense_Cheat_Sheet.md` (Primary Defenses), `sheets/Nodejs_Security_Cheat_Sheet.md` (Do not use dangerous functions) |
| `.github/workflows/lanes-gate.yml` | `pull_request_target`: runs with default-branch secrets on a PR event | `sheets/CI_CD_Security_Cheat_Sheet.md` (Pipeline and Execution Environment, Least Privilege), `sheets/Secrets_Management_Cheat_Sheet.md` (3.1 Hardening your CI/CD pipeline) |
| `.github/workflows/` (all), `.githooks/pre-push`, `scripts/preflight.mjs` | CI permissions, the `PII_PATTERNS` secret, checks a push must pass | `sheets/CI_CD_Security_Cheat_Sheet.md` (Secure Configuration, Secrets Management), `sheets/Secrets_Management_Cheat_Sheet.md` (3.2.1 As part of your CI/CD tooling) |
| `scripts/lanes/gate.mjs`, `scripts/lanes/post-review.mjs`, `scripts/lanes/lib.mjs` | Decide merge eligibility from review verdicts and statuses | `sheets/Authorization_Cheat_Sheet.md` (Deny by Default, Validate the Permissions on Every Request, Exit Safely when Authorization Checks Fail) |
| `scripts/lanes/notify-hook.mjs` | Sends text off the machine; must not carry secrets, paths or personal data | `sheets/Logging_Cheat_Sheet.md` (Data to exclude), `sheets/Secrets_Management_Cheat_Sheet.md` (8.3 Detection lifecycle) |
| `.claude/settings.json`, `.claude/agents/`, `.claude/commands/` | Hook wiring and the prompts unattended lanes follow | `sheets/CI_CD_Security_Cheat_Sheet.md` (Pipeline and Execution Environment), `sheets/Authorization_Cheat_Sheet.md` (Enforce Least Privileges) |
| `vendor/` | Third-party text that agents read and follow | `sheets/CI_CD_Security_Cheat_Sheet.md` (Dependency Management, Integrity Assurance) |
| `package.json`, `package-lock.json` | Dependencies and install scripts | `sheets/CI_CD_Security_Cheat_Sheet.md` (Dependency Management), `sheets/Nodejs_Security_Cheat_Sheet.md` (Keep your packages up-to-date) |

Scripts that import `node:child_process` (each call site runs `gh`, `git`, `claude` or a notifier):
`scripts/preflight.mjs`, `scripts/lanes/blockers.mjs`, `scripts/lanes/cleanup.mjs`,
`scripts/lanes/delivery-metrics.mjs`, `scripts/lanes/diff-coverage.mjs`, `scripts/lanes/gate.mjs`, `scripts/lanes/install.mjs` (asks `gh repo view` whether the target is public), `scripts/lanes/issue-contract.mjs`,
`scripts/lanes/lane-metrics.mjs`, `scripts/lanes/new-project.mjs`, `scripts/lanes/notify-hook.mjs`, `scripts/lanes/post-review.mjs`,
`scripts/lanes/queue.mjs`, `scripts/lanes/reap.mjs`, `scripts/lanes/reviewers.mjs`, `scripts/lanes/review-metrics.mjs`,
`scripts/lanes/setup-repo.mjs`, `scripts/lanes/snapshot.mjs`, `scripts/lanes/start.mjs`, `scripts/lanes/status.mjs`,
`scripts/lanes/structure-report.mjs` (runs `npx` with `shell: true` on Windows),
`scripts/lanes/validate.mjs` (runs a validation-loop criterion's command as an argument array, `shell: false`). `scripts/lanes/vendor.test.mjs` fails when a script gains a
child process without a line here; since `vendor/` is an owner path, adding that line brings the PR to owner review.

## By change topic

| The diff... | Read |
|---|---|
| builds a command line, uses `exec`/`execSync`/`shell: true`, or passes text that could start with `-` to `gh`/`git` | `sheets/OS_Command_Injection_Defense_Cheat_Sheet.md` |
| parses issue, PR, comment, branch or hook-input text; adds or changes a regular expression | `sheets/Input_Validation_Cheat_Sheet.md` |
| touches secrets or tokens: `GITHUB_TOKEN`, `gh` auth, workflow `secrets.*`, `.env`, a value that must not be printed | `sheets/Secrets_Management_Cheat_Sheet.md`, `sheets/CI_CD_Security_Cheat_Sheet.md` (Secrets Management) |
| adds or changes logging, console output, notifications, PR or issue comments carrying data | `sheets/Logging_Cheat_Sheet.md` (Data to exclude, Event collection) |
| changes a workflow trigger, `permissions:`, checkout ref or third-party action | `sheets/CI_CD_Security_Cheat_Sheet.md` |
| changes who may approve, merge or bypass a check | `sheets/Authorization_Cheat_Sheet.md` |
| any other Node.js code: `eval`, `vm`, `fs` with a computed path, uncaught errors, ReDoS | `sheets/Nodejs_Security_Cheat_Sheet.md` |
| fetches a URL built from input, or follows redirects | `sheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.md` |
| adds a Dockerfile or container config | `sheets/Docker_Security_Cheat_Sheet.md` |

## For web applications built with lanes

These sheets cover projects created from this template rather than lanes itself:

| The diff... | Read |
|---|---|
| login, passwords, MFA, account recovery | `sheets/Authentication_Cheat_Sheet.md` |
| sessions, cookies, logout, timeouts | `sheets/Session_Management_Cheat_Sheet.md` |
| OAuth or OpenID Connect | `sheets/OAuth2_Cheat_Sheet.md` |
| state-changing requests from a browser | `sheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.md` |
| rendering user data as HTML, `dangerouslySetInnerHTML`, `innerHTML` | `sheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.md` |
| response headers or a `Content-Security-Policy` | `sheets/Content_Security_Policy_Cheat_Sheet.md` |
| an HTTP API: routes, status codes, CORS, JWT | `sheets/REST_Security_Cheat_Sheet.md` |
