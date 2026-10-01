# 0020: The gate trusts review output from the configured lane App bot under team

Status: accepted

## Context

ADR 0019 has lanes act as a GitHub App under the `team` profile. Its part 7 covers the owner stage and leaves the
reviewer path unspecified, and that path breaks. The lane posts `review/*` statuses and verdict comments through the
App's installation token, so their author is a bot (here `sour-dev-lanes[bot]`, type `Bot`, user id 336249257, App id
5140388). The gate drops both:

- `trustedStatuses` (`scripts/lanes/lib.mjs`) removes every `review/*` status for which `isBotStatus` is true. That is
  any creator of type `Bot` or whose login ends in `[bot]`, and any status with no creator. This is the I3 rule. It
  exists so a PR's own workflow cannot post `review/*` with `GITHUB_TOKEN` (login `github-actions[bot]`). It is used by
  gate-decision (lib.mjs ~592), reuse (~652), owner carry (~675), the gate's other status paths (~767), and gate.mjs
  (193, 299).
- Verdict comments are kept only when `authorCanWrite` (lib.mjs:506, called at gate.mjs:97) accepts the author. Its
  `LOGIN` pattern rejects any login containing `[bot]`. The collaborator-permission endpoint says nothing useful about
  an App bot.

The result is that under team no lane-posted review counts, so the lane can never reach unattended merge. Solo is
unaffected, because there the lane posts as the owner's own non-bot account.

Facts this decision relies on:

- The gate runs the default branch's scripts and config, so a PR cannot add its own trusted bot. Changing the
  configured bot is a change to `lanes.config.json`, which is an owner-only path (ADR 0002 and part 1 of ADR 0019).
- GitHub reserves the `[bot]` login suffix for Apps, and an App slug is globally unique. So the pair (login ends in
  `[bot]`, creator type `Bot`) names exactly one App. `github-actions[bot]` is a different login.
- ADR 0019 part 7 (no owner stage under team) is not implemented yet. Today the gate still requires `review/owner`
  under any profile, and it is posted by the owner's own non-bot account through `/approve`. The bot holds
  `statuses: write`, so it could post `review/owner` if trusted for it.
- Module map: `lib.mjs` is in module `lib`, `gate.mjs` in `gate` (depends on lib and preflight), `start.mjs` in
  `queue` (depends on lib and gate). The gate cannot import `start.mjs`, so the identity parser and the trust test
  live in `lib`.
- Open issue #135 (`status.mjs` trusts spoofable statuses) is a separate, display-side weakness. This ADR does not
  touch it (see Consequences).

## Decision

**1. Configuration.** `identity.app` gains an optional `botLogin` string, for example `"sour-dev-lanes[bot]"`. It is
additive, so it is not `contract:breaking`. The rules:

- The validator must match `^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\[bot\]$`: one App login, case-sensitive,
  no wildcards, no list.
- `botLogin` is **required when `profile` is `team`**. A team config without it is a validation error in the
  launcher and is ignored by the gate (part 3), so a missing value fails closed.
- Under `solo` it is accepted and ignored. A solo config, or one with no `identity`, trusts no bot, exactly as today.
- The numeric bot user id is not configured. The login is unique and reserved (see Context), and the gate also
  requires creator type `Bot`. A second identifier would be one more value the adopter must look up and keep correct,
  for no added protection. (Decision 1 for the owner.)

The parser moves out of `startIdentity` into a shared `parseIdentity` in `scripts/lanes/lib.mjs`. `start.mjs` calls it
and keeps its error wording, and `compileConfig` exposes the validated `identity` so the gate can read it.

**2. The trust rule.** A new `lib.mjs` function `isLaneBot(identity, actor)` is true only when all of these hold:

- `identity.profile === "team"`;
- `identity.app.botLogin` is set;
- `actor.login === identity.app.botLogin` (exact, case-sensitive);
- for a status creator, `actor.type === "Bot"`. A comment author, whose record carries no type, is matched on login
  alone, and the reserved `[bot]` suffix is what makes that safe.

`trustedStatuses(statuses, identity, reviewerNames)` keeps today's behaviour and adds one exception. A `review/*`
status from a bot is kept when `isLaneBot` is true **and** its context is `review/<name>` where `<name>` is one of
`reviewerNames`, the configured non-owner reviewers (the existing `NON_OWNER_REVIEWERS` and config names).
`review/owner` and any other `review/*` context are never trusted from the bot, under either profile, and whatever the
state of the part 7 owner-stage change. So a lane cannot approve itself. `github-actions[bot]`, every other App, and a
status with no creator stay rejected, because the exception requires the exact configured login. Callers pass the
identity and the reviewer names, and every existing call site is updated. The argument defaults to "no bot
trusted", so a call site that is missed fails closed rather than open.

**3. Verdict comments.** In the gate's comment walk (gate.mjs:97), an author passes when `isLaneBot(identity,
{ login })` or `authorCanWrite(...)` does. `authorCanWrite` and its `LOGIN` pattern are not loosened, so a bot login
never reaches the permissions API and every other bot still fails. A verdict comment carries no authority beyond its
`parseVerdictComment` format: it is still bound to the head SHA and the reviewer name, and the newest per reviewer wins,
as today. Bot-authored *issues* (gate.mjs, `issue-contract.mjs`) are untrusted by default. The one exception is ADR
0022: the configured lane bot's issue that a write-access actor released by removing `lane-filed`.

**4. Reuse and owner carry.** Reuse (lib.mjs ~652) filters a prior head's statuses through `trustedStatuses`, so a
reviewer status the lane bot posted on an earlier commit can be reused, together with its own verdict comment for the
same commit (#25, #154), and the existing file-change checks are unchanged. Owner carry (~675) looks only at
`review/owner`, which the bot is never trusted for, so it is unaffected. A reused verdict is still valid only for
byte-identical reviewed code (CLAUDE.md rule 2).

**5. Amendment to ADR 0019 part 7.** Add: "Under team the gate also trusts `review/<reviewer>` statuses and verdict
comments from the App bot named by `identity.app.botLogin` (ADR 0020), for configured reviewer names only and never
`review/owner`." Nothing else in ADR 0019 changes. The part 7 owner-stage skip stays a separate, unimplemented change.

**6. Sequencing.** The trial (#500) needs a lane whose reviews count, so it is blocked on the issue that implements
this ADR. The implementing work is two issues of small size: one for `lib.mjs`, `gate.mjs` and `start.mjs` (shared
`parseIdentity`, `isLaneBot`, `trustedStatuses`, gate call sites) with tests, and one for the `lanes.config.json`
value, because it is an owner-only path and needs the owner's `/approve`. The tests are:

- the bot is trusted for `review/<reviewer>` under team;
- it is not trusted for `review/owner`;
- a different bot, `github-actions[bot]`, and a same-named status with no creator are not trusted;
- nothing is trusted under solo, and under team with no `botLogin`;
- a verdict comment from the bot counts, and one from `github-actions[bot]` does not.

## Decisions for the owner

1. Login only (recommended), or also pin the numeric bot user id (336249257)? Login plus `Type: Bot` is enough
   because `[bot]` logins are reserved. Pinning adds one more value to maintain and would break if the App were
   recreated.
2. `botLogin` required under team (recommended, fails closed) or optional with "no trust" as the default. Requiring it
   makes a half-set-up team config fail at launch, not as a silent gate stall.
3. Confirm the bot may never post `review/owner`, even after the part 7 owner-stage change lands (recommended: yes).
4. The `botLogin` value in `lanes.config.json` is an owner-only change and needs `/approve`.

## Consequences

- Under team, lane reviews and verdict comments count and the lane can merge unattended, while the I3 protection
  against a workflow posting `review/*` with `GITHUB_TOKEN` is kept exactly. A compromised App token can still
  forge reviewer statuses. That is the risk ADR 0019 part 5 already states. It cannot forge owner approval, because
  approval is `review/owner` (never trusted from the bot) and native review.
- Solo behaviour, config and tests do not change. `trustedStatuses` gains optional arguments, so existing callers stay
  valid until updated.
- An existing team config lacking `botLogin` now fails validation. No team config is in use yet (#500 is not
  run), so this breaks nobody.
- Every `trustedStatuses` call site must pass the identity and reviewer names. A missed site fails closed (the lane's
  review is ignored and the gate waits), which is visible rather than dangerous.
- #135 (`status.mjs` trusting spoofable statuses) stays open. The new `trustedStatuses` is the function it should use,
  and it can adopt the same filter later without design changes.
- The gate's meaning of "trusted author" is now two-part (human with write permission, or the configured App bot), and
  is documented in `docs/SECURITY.md`.

## Governs

- scripts/lanes/lib.mjs
- scripts/lanes/gate.mjs
- scripts/lanes/start.mjs
- scripts/lanes/lib.test.mjs
- scripts/lanes/gate.test.mjs
- scripts/lanes/gate-decision.test.mjs
- scripts/lanes/start.test.mjs
- scripts/lanes/queue.test.mjs
- lanes.config.json
- docs/SECURITY.md
