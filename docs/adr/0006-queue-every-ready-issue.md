# 0006: The queue works every ready issue, depth first, and stops only when idle

Status: accepted

## Context

ADR 0005 added `queue.mjs <N...>`: the owner names a fixed stretch of issues, and the queue exits as soon as one of
them needs the owner. In use, the owner wants issues to join a running queue: an issue skipped because it overlaps
running work should start once that work merges, and newly planned issues should join without restarting anything.
A fixed stretch cannot do either, and exiting on the first owner wait would stop the queue at every `/approve`.

When startable issues conflict on files, or the cap is full, the queue must choose which starts first.
`pickStartable` (`scripts/lanes/pick.mjs`) already ranks candidates by how many open issues each transitively
blocks, then by the lowest number, and `/start --auto` uses that ranking.

## Decision

This amends ADR 0005; everything in ADR 0005 not changed here still holds (owner's terminal only, start-guard deny,
no persistent state, global cap, cleanup each tick, `start.mjs` cleanup first).

1. `queue.mjs` takes no issue list. Every tick, its candidates are every open issue labelled `ready`, re-read from
   GitHub. The `ready` label (set by `issue-contract`, never on a `lane-filed` issue) is the owner's control over what
   the queue may start.
2. Order is depth first: the candidates are ranked and picked by `pickStartable`, unchanged, so the issue with the
   most open work transitively behind it starts first and conflicts resolve toward it. An issue skipped for an
   overlap or the cap is a candidate again on the next tick.
3. A PR or issue waiting on the owner never stops the queue. The queue prints it once each time its state changes
   and keeps working everything else.
4. The queue exits when it has been idle for three ticks in a row: nothing in flight and nothing startable. Ctrl-C
   stops it at any time.

   > Amended by [ADR 0026](0026-queue-sustains-itself.md): part 4 no longer holds. The queue does not exit when idle; it
   > polls every 15 minutes after three idle ticks.

## Consequences

- Planning or approving issues feeds a running queue with no extra step; overlap-skipped issues start on their own.
- The queue can start any `ready` issue, not only ones the owner named; `ready` and the `lane-filed` hold are the
  only gates, as they already are for `/start --auto`.
- The queue and `/start --auto` always agree on order, because both use `pickStartable`.
- A queue left running idles out instead of polling forever; the owner restarts it after planning new work. (Superseded by [ADR 0026](0026-queue-sustains-itself.md): the queue now keeps polling.)

## Governs

- scripts/lanes/queue.mjs
- scripts/lanes/queue.test.mjs
