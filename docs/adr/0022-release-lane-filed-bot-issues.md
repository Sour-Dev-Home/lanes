# 0022: A bot-authored lane-filed issue becomes trusted when a write-access actor removes lane-filed

Status: accepted

## Context

ADR 0019 has team lanes act as a GitHub App, so a lane files its follow-up issues (`/lane` step 8,
`gh issue create --label lane-filed`) as `sour-dev-lanes[bot]`, user type `Bot`. The owner approves one by removing
`lane-filed` (`docs/USING.md`, "A lane's own follow-up issues"). Under team that does not work:

- `issue-contract` (`scripts/lanes/issue-contract.mjs`, `main`) computes `canWrite` with `authorCanWrite` on
  `ISSUE_AUTHOR`, and `issuePlan` adds `ready` only when `canWrite === true`.
- The gate (`scripts/lanes/gate.mjs`, `issueAuthorCanWrite`) calls `authorCanWrite` on `issue.user.login`.
- `authorCanWrite` (`scripts/lanes/lib.mjs`) rejects any login that fails `LOGIN`, which excludes `[bot]`.

So the bot-authored issue never gets `ready` and the gate would reject a PR closing it anyway. On 2026-10-01 the owner
had to re-file #564 as #577 and #566 as #576. ADR 0020 part 3 deliberately left bot-authored issues untrusted: "issue
authorship is a different trust question from reviewing". That reasoning stands. What is missing is a way for a human
to vouch for one specific issue.

Facts this decision relies on:

- Removing `lane-filed` is already the owner's approval act under solo. The label means "a maintainer has not approved
  this text". The unlabel event is recorded by GitHub with its actor (`GET repos/{repo}/issues/{n}/events`, event
  `unlabeled`, `label.name`, `actor.login`). The bot cannot forge another actor.
- The bot holds `issues: write` (ADR 0019). It can remove or re-add labels and edit an issue body. So the label event
  alone does not prove who wrote the criteria the lane will build against; the body after the release must be checked.
- The REST issue payload has no body editor. GraphQL `issue { lastEditedAt editor { login } }` gives the last editor
  and time.
- The gate runs the default branch's scripts, so a PR cannot change this rule (ADR 0020 facts).
- Module map: `lib.mjs` is module `lib`; `gate.mjs` and `issue-contract.mjs` are module `gate`.

## Decision

**1. The rule.** `lib.mjs` gains a pure function `botIssueReleased(identity, issue, events, edit, canWrite)` and a reader
`readBotIssueRelease(api, identity, repo, number)` (injected `api` taking `gh api` arguments, like `authorCanWrite`).
A bot-authored issue is trusted only when ALL of these hold:

1. `identity.profile === "team"` and `isLaneBot(identity, issue.user)` is true with `issue.user.type === "Bot"`.
2. The issue does not currently carry `lane-filed`.
3. Among the issue's events, filtered to `labeled`/`unlabeled` with `label.name === "lane-filed"` and ordered by event
   id, there is at least one, and the last is `unlabeled` by an actor for whom `authorCanWrite` is true. An actor that
   is the bot (or any non-writer) fails, so the bot removing its own label, or re-adding it after the owner and then
   removing it, never counts.
4. If the issue body has been edited since that release event (`lastEditedAt` later than the event's `created_at`),
   the last editor (`editor.login`) passes `authorCanWrite`. An editor of null, a bot, or a missing field fails. An
   issue never edited, or last edited before the release, passes this clause.

A bot-authored issue that never carried `lane-filed` is never trusted, since clause 3 needs a release event. Any API
or parse error, a missing field, an unexpected shape, or truncated pagination means untrusted (fail closed). Events
are read with `--paginate`; the reader reads all pages or returns untrusted.

**2. Callers.** `issue-contract.mjs` `main` and `gate.mjs` replace the author check with
`authorCanWrite(...) || readBotIssueRelease(...)`. `main` reads the config for the identity. It also reads the
issue's `user.type` from the API rather than a new env var, so the workflow file does not change. Both callers are
evaluated fresh on every run, so a later bot edit after release (clause 4) makes the next `issue-contract` run
(trigger `edited`) remove `ready`, and the gate rejects the PR.
`authorCanWrite` and `LOGIN` are not loosened. `/lane` checks only `ready` and `lane.md` does not change. The
`issuePlan` comment text for a released bot issue is unchanged.

**3. Solo and other bots.** Solo is unchanged: `isLaneBot` is false there, so the new function returns false without
an API call. Every other bot, and `github-actions[bot]`, stays untrusted.

**4. Amendment to ADR 0020 part 3.** Replace the last two sentences of part 3 ("Bot-authored *issues* ... reviewing")
with: "Bot-authored *issues* (gate.mjs, `issue-contract.mjs`) are untrusted by default. The one exception is ADR 0022: the
configured lane bot's issue that a write-access actor released by removing `lane-filed`." Nothing else in ADR 0020
changes. The ADR 0020 file gets this note in the implementing issue.

**5. Out of scope: bot edits to owner-authored issues.** Under team the bot can also edit the body of an issue an
owner opened and the gate would still trust it (author is the owner). This ADR does not cover it. It needs its own
decision, because it changes owner-issue behaviour (an extra GraphQL read on every gate run).

**6. Sequencing.** Implementation is blocked by #559, which changes how `gate.mjs` reads reviews. Tests cover:
owner release trusted; bot self-release untrusted; owner release then bot re-add untrusted; re-add then owner removal
trusted; bot edit after release untrusted; owner edit after a bot edit trusted; edit before release trusted; issue
that never had `lane-filed` untrusted; still labelled untrusted; solo untrusted with no API call; API error, bad JSON
and a missing `editor` untrusted; a second bot untrusted.

## Decisions for the owner

1. Require the post-release body check (clause 4): approved, yes. Without it the bot could rewrite acceptance criteria
   after the owner approved the text. Cost: one GraphQL call per bot-authored released issue.
2. Bot edits to owner-authored issues: a follow-up, not this ADR (approved).
3. Event pagination: fail closed on any truncated read (approved).

## Consequences

- The owner can release a lane-filed follow-up under team by removing the label, as under solo, with no re-filing.
- No new account, credential or persistent state. The decision is recomputed from GitHub's own event and edit
  history on every run.
- A compromised App token still cannot make an issue trusted without a write-access human removing `lane-filed`, and
  cannot change the text afterwards without losing trust. It can still edit owner-authored issues (part 5, open).
- `issue-contract` and the gate each cost two or three extra API calls for a bot-authored issue only; other issues
  pay nothing.
- A human who removes `lane-filed` without reading the body approves what the bot wrote. That is the existing meaning
  of the label.
- The meaning of "trusted author" in `docs/SECURITY.md` gains a third case and is updated.

## Governs

- scripts/lanes/lib.mjs
- scripts/lanes/lib.test.mjs
- scripts/lanes/gate.mjs
- scripts/lanes/gate.test.mjs
- scripts/lanes/issue-contract.mjs
- scripts/lanes/issue-contract.test.mjs
- docs/USING.md
- docs/SECURITY.md
