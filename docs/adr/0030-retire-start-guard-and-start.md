# 0030: Retire the start guard and /start; the queue is the only launcher, held by permission rules and script refusals

Status: accepted

## Context

Lanes must never launch lanes (CLAUDE.md rule 6). Until now two things enforced that. `start-guard.mjs` (981 lines, with
`shell-lex.mjs` at 1,952 and about 3,900 lines of tests) reads each Bash and PowerShell command and each prompt, lets
`start.mjs` run only in the turn the owner typed a matching `/start`, and denies a direct `claude --bg`, any `queue.mjs`
and a release-tag push (ADRs 0005, 0007 and 0017 part 3). `queue.mjs` itself exits 2 when `CLAUDECODE` is set (ADR 0007
part 3).

Three things changed since those ADRs.

- ADR 0025 made team the only profile. Lanes act as the App bot (ADR 0019), which cannot approve, merge, push workflow
  files (ADR 0023) or release its own issues (ADR 0022), and code-owner review and rulesets gate every merge (ADR
  0021). The guard is no longer the barrier that decides whether a lane's work reaches main.
- ADR 0026 made the queue the owner's one long-running launcher: it restarts itself, resumes dead lanes (#444) and finds
  its work in GitHub. ADR 0028 adds Pause and Resume buttons that gate every queue launch. So the launch decision lives in
  GitHub state (the `ready` label, lane-filed release under ADR 0022, the pause comment), and a typed `/start` is a
  second route beside it.
- The guard keeps misfiring. Its false positives were filed as #523, #576, #642 and #669, and on 2026-10-02 it refused a
  read-only `git grep` whose pattern held `start\.mjs` and a read-only helper given `queue.mjs` as a path argument. ADR
  0007 already accepts that no amount of parsing is complete, and ADR 0025 retired the approve guard for the same reason.

Facts this decision relies on, checked against Claude Code's documentation and this repository:

- `permissions.deny` rules in the project's `.claude/settings.json` hold in every permission mode, including auto and
  bypassPermissions, and in `--bg` sessions, and a user-level allow cannot override them. They are checked against each
  subcommand of a compound command (`&&`, `||`, `;`, `|`, `&`, newline) and match past leading `VAR=value` assignments and
  wrappers such as `timeout`, `nice` and `nohup`. PowerShell rules have the same shape (`PowerShell(...)`) and are checked
  against each parsed command.
- They do not catch `bash -c '...'`, an absolute program path or `npx`, and the documentation says a deny rule is not a
  security boundary around the program: the same class of limit ADR 0007 accepts for the guard.
- Claude Code sets `CLAUDECODE=1` and `CLAUDE_CODE_CHILD_SESSION=1` in its Bash and PowerShell tool processes, so a script
  can refuse itself however the command was written.
- A lane works in a worktree under `.claude/worktrees/`, and a script file run from there lives under that directory; the
  script's own `import.meta.url` says so whatever the working directory.
- `start.mjs` serves two callers that stay: `queue.mjs` imports `launchLane`, `startDecisions`, `teamSteps` and more from
  it, and the queue spawns it as `--refresh-token` (the App-token refresher) outside Claude.
- `queue.mjs` takes no arguments: what it starts is decided in GitHub.
- Adopters get `start-guard.mjs`, `shell-lex.mjs` and `.claude/settings.json` from `install.mjs`, but not `start.mjs`,
  `queue.mjs` or `.claude/commands/start.md`. An upgrade never overwrites a file the adopter edited and never deletes a
  file lanes stopped shipping; it reports it as "no longer part of lanes".

## Decision

1. **The queue is the only launcher.** `/start` is retired: `.claude/commands/start.md` is deleted, and so is the launcher
   mode of `scripts/lanes/start.mjs` (its `main()`, its issue-number and `--auto` command line, and the session-grant
   check with `grantPath`, `grantRefusal` and `readGrant`). The owner keeps `node scripts/lanes/queue.mjs` running in
   their own terminal (ADR 0026). It starts what GitHub marks `ready` and unblocked, released where ADR 0022 applies, and
   nothing while paused (ADR 0028), so choosing what runs happens in GitHub. `start.mjs` stays as a library for the queue
   and keeps its `--refresh-token` mode.
2. **Permission rules replace the hooks.** `.claude/settings.json` drops the `UserPromptSubmit` hook and both
   `PreToolUse` hooks that run `start-guard.mjs`, and `permissions.deny` gains exact-prefix rules with a trailing `:*` and
   no wildcard mid-pattern, so a read-only command that only names a script is not refused:
   - `Bash(claude --bg:*)` and `Bash(claude --background:*)`;
   - `Bash(node scripts/lanes/queue.mjs:*)`, `Bash(node ./scripts/lanes/queue.mjs:*)`,
     `Bash(node scripts/lanes/start.mjs:*)` and `Bash(node ./scripts/lanes/start.mjs:*)`;
   - the release-tag rules of part 4;
   - each of these again as `PowerShell(...)`, with the backslash spelling of the script paths as well.
   The three `git push --force` rules stay.
3. **The scripts refuse themselves.** `queue.mjs`, and `start.mjs` at its command-line entry before any work, exit 2 with
   one line, `lanes are launched only by the owner's queue in their own terminal (ADR 0030)`, when the script's own file
   (`import.meta.url`, not the working directory) is under a `.claude/worktrees/` directory, or `CLAUDECODE` or
   `CLAUDE_CODE_CHILD_SESSION` is set. One exported helper in `start.mjs` holds the check and the message; `queue.mjs`
   already imports from `start.mjs`. The refresher the queue spawns runs outside Claude and is unaffected.
4. **Release tags move to rules.** The deny list carries `Bash(git tag:*)`, `Bash(git push --tags:*)`,
   `Bash(git push --follow-tags:*)` and `Bash(git push origin v*:*)`, with their PowerShell forms. They are broader than
   ADR 0017 part 3 on purpose: no lane needs `git tag`, so refusing a read-only `git tag -l` costs little and needs no
   parsing. A GitHub tag ruleset limiting `v*` creation to the owner is recommended for this repository, since under team
   it is a real barrier: the lane App is not a bypass actor.
5. **The accepted risk stands.** As in ADR 0007 part 1, the rules and refusals are best-effort defence in depth against a
   lane or model launching lanes or tagging a release by accident, not a barrier to a determined lane (`bash -c`, an
   absolute path or `npx` pass a rule; a scrubbed environment and a copied script pass the refusal). A newly found way
   past them is a follow-up rated `minor`; a regression, where a form the rules or refusals list now passes, is
   `critical`. `.claude/agents/security-reviewer.md` and `.claude/agents/test-hunter.md` cite this ADR in place of ADR
   0007's guard paragraph. What a launched lane can do stays bounded by the App's permissions (ADR 0019) and the
   rulesets.
6. **Deletions.** `scripts/lanes/start-guard.mjs` and its test; `scripts/lanes/shell-lex.mjs`, its test and its
   fixtures, which only the guard imports; their entries in `.github/CODEOWNERS`, in `lanes.config.json` (module paths and
   owner-path patterns), in `vendor/owasp-cheatsheets/INDEX.md` and in `install.mjs`'s MANIFEST. `start.mjs` and
   `.claude/settings.json` stay owner paths.
7. **Adopters.** The shipped `.claude/settings.json` carries the part 2 and part 4 rules and no guard hook. An upgrade
   replaces an unedited `settings.json` as it does any shipped file and reports the guard and lexer as no longer part of
   lanes. If the adopter edited `settings.json` and it still names `start-guard.mjs`, the upgrade prints one line saying to
   remove that hook and add the deny rules.
8. **Docs and recovery text.** CLAUDE.md rule 4 says the queue skips an issue whose Scope names no paths, and rule 6 names
   `/plan-issues`, the queue and the GitHub review as the owner's, keeping "a denial or refusal is reported, never routed
   around". `scripts/lanes/status.mjs` stops saying "run /start N again": for an idle lane session the recovery is to
   message it, or stop it so the queue relaunches it. `docs/USING.md`, `docs/OPERATIONS.md`, `docs/SECURITY.md` and the
   README describe the queue as the only launcher. Dated amendment notes go under ADR 0005 (its `/start` and guard
   lines), ADR 0007 (parts 1 and 2 end; part 3 stands), ADR 0017 part 3 (the tag rule now lives in the deny list) and ADR
   0025 part 4 (the guard no longer stays).
9. **ADR 0028.** Its part 5 (`/start` refuses while paused) is moot and is removed from #645 before it starts, with its
   `start.mjs` and `start.test.mjs` criteria and Scope. #669 was fixed by PR #671 before this decision; nothing is left
   to close.
10. **Order of landing.** The `/start` retirement and the script refusals land first. One later change adds the deny rules
    (tag rules included) and removes the hooks, the guard and the lexer together, so no commit has neither.

## Decisions for the owner

Decided by the owner on 2026-10-02 in /plan-issues: retire the start guard and `/start` (team only), make the queue the
only launcher, replace the guard with `permissions.deny` rules and script refusals.

Approved with this plan: delete `start.mjs`'s launcher mode rather than keep a refusing one; keep the release-tag rule as
deny rules, `git tag -l` included; recommend a GitHub tag ruleset for `v*`; rate a bypass `minor` and a regression
`critical`; drop ADR 0028 part 5 from #645.

## Consequences

- About 6,800 lines of guard, lexer and tests go, with the false refusals that kept being filed. A refused command now
  matches an exact prefix the owner can read in `settings.json`, not a parse the owner cannot predict.
- Against a lane launching lanes, the rules are weaker than the guard on forms such as `bash -c`, an absolute path or
  `npx`, which the guard also missed in variants (ADR 0007). The script refusals still stop those unless the environment
  is scrubbed and the script copied out of the worktree. A launched lane still shows in `/status` and in the health
  issue, and what it can do is bounded by the App and the rulesets.
- The owner can no longer launch a chosen issue by hand. The queue starts whatever is ready; to hold an issue back, remove
  its `ready` label or press Pause. A stopped lane with an idle session is relaunched by stopping that session.
- Deny rules hold in every permission mode, as the hook did.
- `git tag -l` is refused in every Claude session; `git ls-remote --tags` still works.
- An adopter who edited `settings.json` keeps the old guard working until they follow the upgrade's one-line notice.

## Governs

- .claude/settings.json
- .claude/commands/start.md
- .claude/commands/plan-issues.md
- .claude/agents/security-reviewer.md
- .claude/agents/test-hunter.md
- .github/CODEOWNERS
- CLAUDE.md
- lanes.config.json
- scripts/lanes/start-guard.mjs
- scripts/lanes/shell-lex.mjs
- scripts/lanes/start.mjs
- scripts/lanes/queue.mjs
- scripts/lanes/status.mjs
- scripts/lanes/install.mjs
- scripts/lanes/upgrade.mjs
- docs/USING.md
- docs/OPERATIONS.md
- docs/SECURITY.md
