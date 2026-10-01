# 0024: Under the team profile the dashboard links the owner to the GitHub review where it used to offer an /approve line

Status: accepted

## Context

ADR 0021 retired `/approve` under the team profile: the owner approves in GitHub and the gate re-runs on the review.
The dashboard (ADR 0012, ADR 0014) still renders, for every waiting PR, a Copy button and "Paste the line into the
owner session" (`approveLine`, `renderWaiting` in `dashboard/app.js`). Under team that line does nothing. The page also
cannot say why a PR waits or whether the owner's review already covers the current head, and task cards do not link to
their issue, PR or failing run.

Constraints:

- `contracts/snapshot.schema.json` has top-level `additionalProperties: false`, `version` const 0, and the promise "no
  logins, emails, bodies or comments". `dashboard.yml` publishes it to public GitHub Pages every 5 minutes with a
  read-only token, so anything in the snapshot is world-readable.
- `snapshot.mjs` already reads `statusCheckRollup` (`checksOf` keeps only `name` and `result`). Rollup entries carry
  `detailsUrl` (check runs) and `targetUrl` (commit statuses). Whoever posts a status chooses its `targetUrl`, so it is
  untrusted input.
- `lib.mjs` already has `parseCodeOwnerUsers` and `nativeCodeOwnerApproval(reviews, prAuthor, headSha, owners,
  identity)`, which return `{ approved, by }`. Only the boolean is needed here.
- CLAUDE.md rule 7: no extra accounts, apps or credentials. A GitHub Projects board needs App projects permission, so
  it is out of scope.

## Decision

1. **Top level gains two optional fields.** `profile` is `"solo"` or `"team"`, taken from `lanes.config.json`
   `identity.profile` (via `parseIdentity`); absent when the key is absent, and the page treats absent as solo. `repo`
   is `"owner/name"`, read by `snapshot.mjs` and validated against `^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$` before it is
   written. The page does not derive the repo itself: a Pages URL breaks on custom domains and project-name mismatches,
   and a wrong guess would build links to someone else's repository. The repo name is already public.
2. **`issues[].pr.ownerApproved`** (optional boolean, written only under team). `snapshot.mjs` reads `CODEOWNERS` from
   the default branch and the PR's reviews, then calls `nativeCodeOwnerApproval(reviews, author, headSha,
   parseCodeOwnerUsers(text), identity)` and publishes `.approved` only. The login in `by` is never published, so the
   no-logins rule holds. Any read error, a missing CODEOWNERS or a missing `headSha` writes `false` or omits the field;
   the page reads absent as "not approved". Failure leans toward telling the owner to review, never toward claiming
   coverage. The extra reads run only under team and only for PRs the snapshot already lists.
3. **`checks[].url`** (optional string). `checksOf` takes `detailsUrl ?? targetUrl` and publishes it only if it
   matches `^https://github\.com/<owner>/<repo>/` for the snapshot's own repo, with no whitespace and no control
   characters. Anything else is omitted. The same check is repeated in the page, because a snapshot file can be edited
   or stale.
4. **Page behaviour.**
   - Solo (or `profile` absent): the copy line, the Copy button and the text are unchanged.
   - Team: no copy line. Each waiting PR shows a "Review in GitHub" link to `https://github.com/<repo>/pull/<N>/files`,
     the gate's reason (already in `blockedBy`), a note "your review covers this head" or "your review does not cover
     this head" from `ownerApproved`, and the text "Approve in GitHub; the gate re-runs on your review."
   - Task cards link to the issue (`/issues/<N>`) and the PR (`/pull/<N>`); a failing check links to its `url` when
     present.
   - Every link is made with `el()` plus `setAttribute('href', ...)` after the page validates that the value starts
     with `https://github.com/<repo>/` (repo from the snapshot, itself re-validated). Text goes in via `textContent`,
     `rel="noopener noreferrer"` is always set, and `innerHTML` is never used for snapshot data. A value that fails
     validation renders as plain text, with no link.
5. **The queue's terminal `/approve N M K` digest** (`scripts/lanes/queue.mjs`) is the same retirement on a different
   surface. It is governed by ADR 0021 and changed in its own issue, not by this ADR.
6. **Schema compatibility.** All additions are optional and `version` stays 0. Old snapshots stay valid and the old
   page ignores new fields. `contracts.test.mjs` field-by-field checking is extended to the new fields. A GitHub
   Projects board stays undecided and is not covered here.

## Decisions for the owner

Decided by the owner on 2026-10-01 in the `/plan-issues` request: replace the copy line with the review link under
team, keep it under solo, link cards to issues, PRs and failing runs, publish only a boolean for review coverage and
only github.com links inside this repository, and leave the Projects board for later.

## Consequences

- The team owner gets a working one-click path to the review, the gate's reason and a review-coverage signal, with no
  new credentials or accounts. The published data grows by one boolean per PR, a repo name and validated GitHub URLs.
- Under team, `snapshot.mjs` reads the PRs' reviews and the default branch's CODEOWNERS, within the read-only token and
  the existing `PR_LIMIT` ceiling.
- An attacker-set status `target_url` can never reach the page, because it is filtered twice. A reviewer approving
  through a team CODEOWNERS entry is not recognised (ADR 0021 part 1 reads user owners only), so the page may say "not
  covered" for it; this is the safe direction.
- Not decided: a Projects view.

## Governs

- contracts/snapshot.schema.json
- scripts/lanes/snapshot.mjs
- scripts/lanes/snapshot.test.mjs
- dashboard/app.js
- scripts/dashboard.test.mjs
- scripts/lanes/contracts.test.mjs
- docs/USING.md
