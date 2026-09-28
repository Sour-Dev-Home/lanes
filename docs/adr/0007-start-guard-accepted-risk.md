# 0007: The start guard is defence in depth; start.mjs checks the grant; queue.mjs refuses inside Claude

Status: accepted

## Context

`start-guard.mjs` (#51) keeps lanes and schedules from launching lanes: it lets `start.mjs` run only in the turn the
owner typed a matching `/start`, denies a direct `claude --bg`, and (ADR 0005) denies `queue.mjs` in every Claude
session. It decides by reading the command text before it runs. Like the approve guard (ADR 0004), it cannot prove
what a shell will run: each security review finds another way to build the command, for example a script name held
in a variable decoded at run time (PR #114). ADR 0004 accepted that limit for the approve guard only, so reviews of
the start guard still block on each new variant.

## Decision

1. **Accepted risk.** The start guard is best-effort defence in depth against a lane or model launching lanes by
   accident or casually, not a barrier to a determined lane. A newly found way to build a command that reaches
   `start.mjs`, `queue.mjs` or `claude --bg` is a follow-up issue rated `minor`. A regression, where something the
   guard or a script check previously caught now passes, is still `critical`. `.claude/agents/security-reviewer.md`
   and `.claude/agents/test-hunter.md` state this rule next to ADR 0004's.
2. **`start.mjs` checks the grant.** `node scripts/lanes/start.mjs ...` refuses unless the grant file the start
   guard's `UserPromptSubmit` hook writes for the current session (`.lanes/start/<CLAUDE_CODE_SESSION_ID>.json`,
   resolved relative to the script's own file) exists, is younger than `GRANT_TTL_MS`, and names the same issue numbers
   or the same `--auto` form (a dry-run grant never allows `--go`). It deletes the grant after its launches, so a
   grant is used once. The `PreToolUse` hook still decides allow or deny on the command text but no longer deletes the
   grant. So however a command reaching `start.mjs` was built, it launches nothing unless the owner just typed the
   matching `/start` in that session.
3. **`queue.mjs` refuses inside Claude.** It exits 2 with a one-line reason when the `CLAUDECODE` environment variable
   is set, which Claude Code sets in every tool shell. The owner's own terminal does not set it.

## Consequences

- Reviews of PRs touching `start-guard.mjs` stop blocking on "another way to build the command"; they file a
  follow-up. A regression still blocks.
- Every route through `start.mjs` needs the owner's fresh `/start` for the same arguments.
- A direct `claude --bg`, or a `queue.mjs` run with `CLAUDECODE` removed, is still possible for a determined lane, as
  accepted. Launched lanes show in `/status` and send their own notifications, so a launch is not silent.

## Governs

- scripts/lanes/start.mjs
- scripts/lanes/start.test.mjs
- scripts/lanes/start-guard.mjs
- scripts/lanes/start-guard.test.mjs
- scripts/lanes/queue.mjs
- scripts/lanes/queue.test.mjs
