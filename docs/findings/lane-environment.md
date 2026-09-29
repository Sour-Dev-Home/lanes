# Lane environment: missing `/usr/bin` and early stalls (spike #328)

Method: aggregate scan of the local Claude Code transcripts (1006 files: 556 main and subagent
transcripts under the `issue-N` worktree projects, the rest from other projects), on 2026-09-29, plus a
reproduction of the PATH behaviour with Git Bash. No transcript text, paths or personal data are quoted;
command shapes are redacted. Counts are of transcripts (sessions), not of tool calls, unless stated.

## 1. Missing `/usr/bin` in the Bash tool's PATH

### What the transcripts show

- Sessions with any `<tool>: command not found` result from the Bash tool: **9 of 147 lane main sessions
  and 24 of 409 lane subagent sessions** (about 6% each; 23 more in non-lane projects, which include
  genuinely absent tools such as `docker` or `python`). Restricting to basic coreutils
  (`head|ls|wc|tail|grep|cat|awk|rm`) leaves 26 failing calls in lane sessions (14 main, 12 subagent).
  So it hits **both background lane sessions and their subagents**, at a low, uneven rate.
- It is clustered in time: affected sessions start on 2026-09-27 (4), 09-28 (6) and 09-29 (1), against roughly
  1,000 unaffected ones across 08-25 to 09-29. It is not present in the sessions of 09-21 to 09-26.
- The failure is at the start of the session: the median affected call is the 3rd tool call. The first
  Bash call that uses a pipe (`... | head`) fails with exit 127, then the lane tries to diagnose.
- Failing shells that echo their PATH show it in **Windows form** (drive-letter paths, `;` separators,
  backslashes), with the Git `usr\bin` directory present (several times, duplicated). A working shell
  (this one) shows the POSIX form (`/usr/bin:/mingw64/bin:...`), also with duplicated entries. So the
  directory is *listed*, but the shell cannot resolve it: bash was handed a PATH it did not convert.
- The lanes' workaround is visible: across all transcripts, 282 main-session and 317 subagent Bash calls carry an
  `export PATH="/usr/bin:/mingw64/bin:..."` or `PATH="/usr/bin:..." cmd` prefix. The `export` form
  is never the failing call, so it restores lookup for the shell. The one-command form
  (`PATH=... gh ... | head`) does not: it sets PATH only for the first command, so the piped `head` still
  failed in the earliest failing calls.

### What sets PATH at that point

Not proven. What the evidence rules out and what it leaves:

- **A plugin `bin` directory is not the cause on this machine.** None of the four installed plugins
  ships a `bin` directory, and none of the affected shells' PATHs contains one.
- Reproduction (Git Bash 5.3.9, spawned from Node with a controlled environment):
  - Windows-form PATH containing `C:\Program Files\Git\usr\bin`: **works**; Git's bash converts it to
    `/usr/bin:...` at start-up.
  - POSIX-form PATH: works.
  - PATH with no Git directories at all: `ls`, `head`, `cut` all fail with `command not found` (127),
    which is the exact error seen.
  So the failure needs bash to start with a PATH that either lacks Git's `usr\bin`, or that the msys
  start-up conversion did not run over (for example an environment variable inherited by a
  non-msys child in a different casing, `Path` vs `PATH`, or a PATH already mangled by the launcher).
  I could not produce the second variant on demand. Likely trigger: the environment the background
  launcher (`start.mjs`) and the desktop supervisor pass down, changed on 09-27. That is a hypothesis,
  not a finding.

### Proposed fixes

| # | Fix | Expected effect | Needs |
|---|-----|-----------------|-------|
| 1a | `lane.md` step 3: after `npm run setup`, run one fixed check `command -v head` and, on failure, stop with `lanes #<issue>: shell PATH broken` instead of improvising. | Lanes stop spending calls (and guard denials) on ad hoc PATH prefixes; the owner learns of the broken environment at once. | Nothing beyond a normal lane issue. |
| 1b | `start.mjs` launch flag / env: make the launcher set `PATH` explicitly to the POSIX form `/usr/bin:/mingw64/bin:$PATH` (or the Windows form with Git's `usr\bin` first) for the child process, and log the child's PATH at launch. | Removes the cause if it is inherited; the log gives the missing evidence (which launch path produced a bad PATH). | Owner (changes what background sessions inherit; touches the start guard's surface). |
| 1c | Report upstream (Claude Code): background/subagent Bash on Windows can start with a PATH that Git Bash does not resolve; include the repro above and the 09-27 onset. | A fix at the source; 1a/1b remain as a safety net. | Owner (external report, no private data). |
| 1d | Guard rule note: the `export PATH=...` prefix trips the loop/`$(...)` rules (33 of the week's 335 denials). Do not loosen the guards; do 1a so the prefix is never needed. | Removes those denials. | Nothing; the guards stay as they are. |

## 2. Early stalls between a tool call and its result

### What the transcripts show

- Across about 16,600 Bash calls in background sessions, the median time from call to result is
  **0.1 minute** (p95 0.9). `Write`: median under 1 second, p95 0.15 minute. `Edit`, `Read`: normal.
- The headline numbers come from a handful of outliers, not from a general delay:
  - Only **21 calls in total exceed 20 minutes** (5 background Bash, 1 background `Write`,
    2 other Bash, 10 `AskUserQuestion`, 2 `ExitPlanMode`, 1 background `AskUserQuestion`).
  - `git branch -m`: 79 calls, **median 0.45 minute**, mean 7.6 minutes. One call of 558 minutes
    produces the whole mean; only 1 of 79 exceeds 5 minutes. (The issue's 9.5-minute average over 62
    lanes is the same effect: one outlier dominates.)
  - `Write`: 1,864 calls, total 636 minutes, of which **570 minutes is one call**; the rest sum to about 66.
- The outliers are not permission waits: the long calls are `git branch -m`, `git checkout -b`,
  `git check-ignore`, `gh pr checks --watch`, `sleep 20; gh pr checks --watch`, `git add`. None of these
  is a permission-prompt tool. The `--watch` ones are watch loops the lane brief forbids, so a long run there is
  expected.
- **They line up across sessions.** Several different sessions show near-identical 558 to 570 minute
  gaps, and two show 710 minutes. For 9 of the 10 outliers that are not `AskUserQuestion`, **no session
  at all wrote an event during the gap** (checked over every transcript). That is the signature of the machine being asleep, suspended or the desktop
  supervisor being paused, which delays the result timestamp for every open call at once.
- Real waits do exist, but they are people: `AskUserQuestion` (median 1.6 minutes, 10 calls over 20 minutes,
  1,411 minutes in total) and `ExitPlanMode` (243 minutes), all in interactive sessions.

Conclusion: the early stalls are a **timestamp artifact of suspend/sleep on the host**, plus a few real
owner waits in interactive sessions. There is no queued-start or permission-prompt delay in lanes.

### Proposed fixes

| # | Fix | Expected effect | Needs |
|---|-----|-----------------|-------|
| 2a | Metrics (`delivery-metrics`): compute call duration with an outlier cap (drop calls where no session logged an event in the window, or cap at 30 minutes) and report the median next to the mean. | The "62 lanes, 9.5 minutes" figure stops reading as a lane problem; real slow tools stand out. | Nothing; a normal task issue. |
| 2b | Owner: keep the host awake while lanes run (power plan: no sleep on AC, or a wake lock in `start.mjs`'s launcher). | Removes the gaps and the wasted wall-clock. | Owner (host setting; a launcher wake lock also needs an ADR because it changes what `start.mjs` does to the machine). |
| 2c | Nothing for lane permission prompts: none found. Do not add a workaround. | n/a | n/a |

## Follow-up issues to file (not part of this PR)

- 1a: `lane.md` PATH check at step 3.
- 1b: `start.mjs` explicit child PATH and a launch-time log line (owner decides).
- 1c: the upstream report (owner files).
- 2a: outlier-robust durations in `delivery-metrics`.
- 2b: keep-awake for lane runs (owner decides, ADR if a wake lock is chosen).

## Limits of this study

- One machine, one week of transcripts. The launcher's actual environment at the moment of the failures was
  not logged, so the cause in section 1 is narrowed, not proven; fix 1b's log line is what settles it.
- The sleep explanation for section 2 rests on the absence of events in every local transcript during each
  gap; an event source outside Claude Code (for example a hung Windows process) would look the same.
