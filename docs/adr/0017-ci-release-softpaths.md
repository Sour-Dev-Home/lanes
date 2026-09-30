# 0017: Narrower CI on pull requests, a tag-gated release, and lanes.config.json as a soft path

Status: accepted

## Context

`verify.yml` runs the full `npm test` (every `scripts/**/*.test.mjs`) on ubuntu Node 22 and 24 and windows Node 22, on
`pull_request`, `merge_group` and `push` to main alike; `verify` is a required check. A large adopter repo's suite would
slow every lane's feedback loop, and the README (#391) will claim macOS support the matrix does not cover. Lanes has
`package.json` at `0.1.0` and a CHANGELOG (#388), but no release workflow. `pickStartable`'s `softPaths` (pick.mjs;
default in start.mjs) is the only way two issues touching the same file can start together; `lanes.config.json` is
not in it, so issues that each add one module-map line or config key run one at a time. Nothing reads a PR's
`mergeable` state today. Standing constraints: zero npm dependencies, no extra adopter setup, lanes share the owner's
GitHub identity (ADR 0004/0007), `queue.mjs` never runs inside Claude or on a schedule (ADR 0005).

## Decision

1. **Affected tests, on `pull_request` only.** `scripts/lanes/affected-tests.mjs` (module `modules`) uses
   `lanes.config.json`'s `modules.entries` (`moduleOf`, `importSpecifiers` from modules.mjs) to print the test files of
   the changed modules plus every module that imports them, directly or transitively, or `ALL` when any changed file
   maps to no module, is a workflow, `package.json`, `lanes.config.json`, under `contracts/`, a test helper or fixture,
   or the diff cannot be read. `verify.yml` uses it only on `pull_request`; `merge_group` and `push` to main always run
   the full suite, so nothing merges without every test passing. `ci.affectedTests` in `lanes.config.json` (default
   `true`) set to `false` restores full runs on every event.
2. **macOS on `merge_group` and `push` only.** `verify.yml` adds macOS on Node 22, run on `merge_group` and `push` to
   main and never on `pull_request`; the required `verify` result includes it wherever it runs.
3. **A tag-triggered release.** `.github/workflows/release.yml` (`contents: write`) runs on a pushed `v*` tag and creates
   a GitHub Release from that version's `CHANGELOG.md` section, only when `scripts/lanes/release.mjs` confirms the
   tagged commit is reachable from `origin/main`, the tag equals `package.json`'s `version`, and `CHANGELOG.md` has that
   version's section. `start-guard.mjs` and `approve-guard.mjs` deny creating or pushing a `v*` tag from any Claude
   session, under ADR 0004/0007's accepted-risk rule (a bypass is minor, a regression critical); the owner tags from
   their own terminal. No tag ruleset: the shared identity defeats one. Release notes only, no `npm publish`.

   What the guards read as creating or pushing a `v*` tag (`releaseTagCommand` in `shell-lex.mjs`, one rule for both
   guards, PowerShell text included; #404, #424, #441):
   - `git tag` naming a `v*` name without a list, delete or verify option; `git push` with `--tags`, `--follow-tags` or
     `--mirror`, `-c push.followTags`, or a refspec whose destination is `v*`, `refs/tags/v*` or a pattern such as
     `refs/tags/*`; with `--repo` given, every positional word as a refspec; `git tag`/`git push` names known only at run
     time (`"$V"`, `$(cat VERSION)`, `${V:-v1}`).
   - `git update-ref` and `git symbolic-ref` of a `refs/tags/v*` ref (or one named at run time), except with `-d`; `git
     fast-import`, which writes any ref from its input.
   - A `-c alias.NAME=…` or `--config-env alias.NAME=…` alias used as the subcommand, read as what it expands to.
   - Config given by the environment: any `GIT_CONFIG_KEY_n` (or `GIT_CONFIG_PARAMETERS`) naming `push.followTags` or an
     `alias.…`, in the command or an earlier statement (`export …`). The setting is denied rather than followed.
   - `gh release create` (or `new`) naming a `v*` tag, one known only at run time, or none; `gh api` writing (POST, PATCH,
     or any request with body fields) a `git/refs` ref that is `refs/tags/v*` or known only at run time, or a release's
     `tag_name`.
   - Where they **fail closed**: `git update-ref --stdin`; a `!` alias, an alias whose value is known only at run time or
     given through `--config-env`, a chain of aliases deeper than eight; a run-time `GIT_CONFIG_KEY_n` before `git push` or
     any git command that is not `tag` or `update-ref`; `gh release create` with no tag named; `gh api` with `--input`
     on `git/refs` or `releases`.
   - **Outside the rule**, recorded and not guarded: aliases and `push.followTags` from git config files (`~/.gitconfig`,
     a repository's `.git/config`, `GIT_CONFIG_GLOBAL`): a guard sees the command line, and lanes act as the owner's
     account under the accepted-risk rule of ADR 0004/0007. Known gaps, not guarded yet: a run-time `GIT_CONFIG_KEY_n` set in an earlier statement (`export GIT_CONFIG_KEY_0=$K`) or behind a launcher, a `-c` key spliced at run time, and tag commands inside nested shell text (`bash -c "git push --tags"`, `ssh h git tag v1`), which the start guard denies and the approve guard scans only for `post-review`; #468 tracks them. Also outside: `gh api graphql` mutations (`createRef`) and creating a tag object through `git/tags`, which makes no ref. A `git config` write is not denied either, nor is a script file
     that itself pushes a tag: the guards read the names a command runs, not what a program does inside. `release.yml`
     still checks any pushed tag against `main`, `package.json` and `CHANGELOG.md`.

   A subcommand word in argument position is no program (#441): the approve guard reads `watch`, `ssh`, `script` and the
   other shell-text commands as a program wherever they stand, except as an argument of a program whose words are
   subcommands that never launch a program by name (`gh`, `systemctl`, `terraform` and the like: `gh run watch 123` is
   not one); after `{`, `!`, `then`, `env`, `xargs`, or a launcher such as `npx`, `npm exec` or `docker run`, they still
   fail closed, and the start guard reads `start.mjs` as a launch only as node's script, the value
   of a node option before it (`-r`, `--import`), or a `-e` text naming it, not as data to another script
   (`node lessons.mjs --paths … start.mjs`).
4. **An adopter smoke test.** `scripts/lanes/adopter-smoke.test.mjs` (module `install`, so affected tests pick it up
   whenever install or upgrade code changes) runs under `npm test`: it git-inits a temp repo, runs `install.mjs`,
   validates `lanes.lock.json` against `contracts/lanes-lock.schema.json` and its hashes, edits one lanes-owned file and
   one `lanes.config.json` key, runs `upgrade.mjs` and asserts the edited file is refused and the key kept.
   `setup-repo.mjs` is left out: it has no dry run and calls the GitHub API.
5. **`lanes.config.json` becomes a soft path.** `^lanes\.config\.json$` joins `start.softPaths` (this repo's config and
   start.mjs's default). Scheduling only: it stays an owner path, and every PR touching it still needs `/approve` or
   ADR 0015's fast path. `status.mjs` and the snapshot read each open lane PR's `mergeable` state and show `CONFLICTING`
   as `conflict: rebase needed`, and `queue.mjs` treats it as an owner wait (ADR 0005 step 5). Consolidating
   same-file issues stays the default; the soft path covers the one-line config additions consolidation cannot merge.
   Splitting the module map into its own file is rejected: ADR 0008 chose no new file, and a second owner file moves
   the hotspot.
6. **The scheduled queue does not change.** ADR 0005 and 0006 stand: a no-argument `queue.mjs` in the owner's own
   terminal already works every ready issue, and ADR 0016's budgets cap its spend.

## Consequences

- PR feedback narrows to the affected modules with a tested fail-safe; `merge_group` and `push` stay the full,
  unconditional check.
- macOS is covered without adding runner minutes to every PR.
- A tag push gains write authority (Releases), bounded by three mechanical checks and the guard denial.
- Issues that each add a line to `lanes.config.json` can run together, and a real conflict surfaces to the owner.

## Governs

- scripts/lanes/affected-tests.mjs
- scripts/lanes/affected-tests.test.mjs
- .github/workflows/verify.yml
- .github/workflows/release.yml
- scripts/lanes/release.mjs
- scripts/lanes/release.test.mjs
- scripts/lanes/adopter-smoke.test.mjs
- scripts/lanes/workflow.test.mjs
- scripts/lanes/start-guard.mjs
- scripts/lanes/approve-guard.mjs
- scripts/lanes/start.mjs
- scripts/lanes/status.mjs
- scripts/lanes/snapshot.mjs
- scripts/lanes/queue.mjs
- lanes.config.json
