# Lanes depends on the owner's machine (2026-10-02)

Status: recorded, deferred by the owner on 2026-10-02.

## The fact

The queue (`scripts/lanes/queue.mjs`) runs in the owner's terminal, and every lane is a local background Claude
session in a local git worktree. If the machine sleeps or shuts down, the queue stops, running lanes stop, and nothing
launches or merges until it is back. GitHub keeps working meanwhile: open PRs, the merge queue and the gate's status
still move, but no lane fixes a failing check and no new lane starts. The watchdog (ADR 0027) can say that progress
stopped; it cannot restart anything.

This is a property of the design, not a defect: the solo-first shape needs no account, server or credential beyond the
owner's own machine (ADRs 0004 and 0007), and the team profile adds only a GitHub App (ADRs 0019, 0021).

## Options considered

| Option | What it buys | Cost | Credentials and security |
|---|---|---|---|
| Stay local (today) | Nothing to host or pay for; lanes use the owner's existing Claude subscription and tools | Progress stops with the machine; the owner must restart the queue after a lanes merge (it exits 3 on changed scripts) | The App key and tokens never leave the machine; the exposure is a compromised local machine |
| Cloud sessions (a scheduled or remote Claude session running the queue) | Runs while the machine is off | Usage billed per session; a cloud session starts cold and has no persistent local worktrees, so each tick re-clones and re-derives context; fewer permission and shell guarantees than the local hooks | The App key or a minted token has to be given to a cloud environment, widening where the secret lives; the guards (start guard, approve guard, identity check) were built for a local session and need re-verifying there |
| Self-hosted runner (a machine the owner keeps on, running the queue as a service) | Always on, local tooling and hooks preserved | The owner maintains a machine, updates and uptime; electricity or a small server bill | Runs untrusted PR-driven work next to long-lived credentials; on a public repository a self-hosted runner is a known risk, so it must run default-branch code only, as the dashboard workflow does |
| GitHub-hosted runner (a workflow that runs the queue) | No machine to keep on | Runner minutes; Claude usage still needs an API key or equivalent; lanes are interactive sessions and do not map to a short workflow job without redesign | An API key and the App key become Actions secrets; any workflow-injection bug exposes them, and the App has no `workflows` permission by design (ADR 0023) |

No option was costed with a measurement; the figures above are qualitative and would need a trial before a decision.

## Decision

On 2026-10-02 the owner deferred moving lanes off the local machine. Lanes stays local for now. The operations
runbook ([docs/OPERATIONS.md](../OPERATIONS.md)) covers what to do when it stops, in the `paused` and `no-progress`
sections.

## What would reopen it

- Lanes is adopted by someone who cannot keep a machine on during working hours.
- The weekly health report shows repeated `no-progress` caused by the machine being off.
- A hosted option appears that keeps the App key out of long-lived secrets.

A change would go through an ADR first, like every restructure decision.
