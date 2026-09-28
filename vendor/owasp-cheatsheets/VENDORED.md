# Vendored: OWASP Cheat Sheet Series

- Upstream: https://github.com/OWASP/CheatSheetSeries (CC BY-SA 4.0, see LICENSE in this folder)
- Commit: `327812ee76aac6a87e32fbdce5b5d1cce39b5741` (2026-09-27), browsable at
  https://github.com/OWASP/CheatSheetSeries/tree/327812ee76aac6a87e32fbdce5b5d1cce39b5741
- Decision: ADR 0009 (`docs/adr/0009-owasp-cheatsheets.md`); the licence at this commit is CC BY-SA 4.0 (upstream
  `LICENSE.md`, SPDX `CC-BY-SA-4.0`), so the ADR's stop condition did not trigger.
- Sheets (in `sheets/`, copied byte-for-byte from upstream `cheatsheets/<name>.md`): Authentication, Session
  Management, Authorization, OAuth 2.0, Cross-Site Request Forgery Prevention, Cross Site Scripting Prevention, Content
  Security Policy, Input Validation, REST Security, Server Side Request Forgery Prevention, Secrets Management, Logging,
  Nodejs Security, CI CD Security, Docker Security, OS Command Injection Defense.
- Not vendored on purpose: every other sheet, and upstream's `assets/` folder. Some sheets link or embed images from
  `../assets/` and link other sheets by relative path; those links do not resolve here and were left unchanged,
  because the sheets must stay byte-identical.
- `INDEX.md` is not a sheet: it is lanes' own mapping text under lanes' MIT licence (ADR 0009, decision 2), not CC BY-SA.

To update: pick a new commit, repeat the security read on the diff between the two commits, and change the commit,
the file list and the blob ids below in the same PR (tier full, owner review: the security reviewer cites these
sheets). Check the licence at the new commit first; if it is no longer CC BY-SA 4.0, stop and ask the owner.

## Files

`LICENSE` is upstream `LICENSE.md` renamed; every other file keeps its upstream name. The blob id is the git object
id of the file at the pinned commit, so `scripts/lanes/vendor.test.mjs` can prove the bytes are unchanged without a
network call (`git hash-object <file>` prints the same value).

| Blob id | File |
|---|---|
| `31f26300fe110a9d9df6d1f0e8a53dc41383b7a4` | `LICENSE` |
| `176ca5c7cd87251903c4d32ec61a882d2d802fb6` | `Authentication_Cheat_Sheet.md` |
| `1f3b397428bbe3e07b011af1c02094e921ff183f` | `Session_Management_Cheat_Sheet.md` |
| `2a056661bf62a908708e9cb972daae611b10313c` | `Authorization_Cheat_Sheet.md` |
| `9e59fa6f25d467db7e93e441c48193c2e45cbf23` | `OAuth2_Cheat_Sheet.md` |
| `073cf826b65b216575a1be3ca3e657d3a76154de` | `Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.md` |
| `262fc3f69370a2dbe1dbc613084942cde252d467` | `Cross_Site_Scripting_Prevention_Cheat_Sheet.md` |
| `2c81cba7ac281e0e1b9f3278e1d579dd0ead4804` | `Content_Security_Policy_Cheat_Sheet.md` |
| `7535fa1f1656163a9891479845edfdf5bac2cacc` | `Input_Validation_Cheat_Sheet.md` |
| `cb297551e444eedb5816bee14b2e452d24b96246` | `REST_Security_Cheat_Sheet.md` |
| `e5f585e771bce4a5e4ec1a66a5e2c0c9ca0346f2` | `Server_Side_Request_Forgery_Prevention_Cheat_Sheet.md` |
| `3901ff24b5e24c94b71e9017c6e5ca52912bb0eb` | `Secrets_Management_Cheat_Sheet.md` |
| `55308d1ee82f22164d8ea6c07f6dd5ed9634ebd7` | `Logging_Cheat_Sheet.md` |
| `ac4d386a271dc280f1ad556b2b0bb250c0c5baf4` | `Nodejs_Security_Cheat_Sheet.md` |
| `51a81eaefba15d827c1b9cfc23ed7a71a376e983` | `CI_CD_Security_Cheat_Sheet.md` |
| `676f91b9b1bb45b708d12026b8f093c88609faea` | `Docker_Security_Cheat_Sheet.md` |
| `e323002b97f47ad1ea58af973b099d6d97f4afd0` | `OS_Command_Injection_Defense_Cheat_Sheet.md` |

## Attribution

The files in `sheets/` are from the OWASP Cheat Sheet Series (https://cheatsheetseries.owasp.org/), © the OWASP
Cheat Sheet Series contributors, licensed under the Creative Commons Attribution-ShareAlike 4.0 International licence
(https://creativecommons.org/licenses/by-sa/4.0/, full text in `LICENSE`). They are copied unmodified from commit
`327812ee76aac6a87e32fbdce5b5d1cce39b5741` of https://github.com/OWASP/CheatSheetSeries. ShareAlike applies to these
files only; nothing else in this repository is adapted from them (ADR 0009, decision 4).

## Security read

Read in full, before committing, at commit `327812ee76aac6a87e32fbdce5b5d1cce39b5741`: all sixteen files in `sheets/`.
Each was also searched for hidden characters (zero-width, bidirectional-override and Unicode tag characters: none
found) and for text addressed to an AI agent or model (none found).

Looked for, per sheet: any instruction to fetch a URL, install a package, run a command, read credentials or secrets,
disable checks or hooks, or override the user's or project's rules.

Findings: none of the sixteen sheets contains such an instruction addressed to the reader's agent or this repository.
All content is guidance for application developers, with commands and code shown as examples of patterns to apply in
the reader's own system. Worth knowing when a reviewer cites them:

- Example commands appear as illustrations, not as steps to run here: `pip install ipaddress dnspython` in a sample
  monitoring script (Server Side Request Forgery Prevention), `npm audit` and `npm audit fix` (Nodejs Security),
  `sudo ufw-docker install` and `docker run` variants (Docker Security), `curl`/`wget` injection payloads
  (OS Command Injection Defense). None should be run by a lane on the strength of the sheet.
- Secrets Management (section 9.2) describes rewriting git history to remove a leaked secret, and warns about the
  consequences. It is incident-response guidance; it does not override this repository's rule against force-pushing.
- CI CD Security ("Secure SCM Configuration") advises avoiding auto-merge rules. lanes merges with `gh pr merge
  --auto` behind required checks and the `lanes/gate` status; that is a deliberate design choice, and a finding that
  cites this line against the workflow is a design question for the owner, not a defect in a lane's diff.
- Logging embeds one remote image (`raw.githubusercontent.com/OWASP/CheatSheetSeries/master/assets/...`); other
  sheets reference `../assets/` images and PDFs that are not vendored. A Markdown viewer may fetch the remote image;
  nothing here asks an agent to.
- Links to other OWASP sheets, RFCs, vendor documentation and blogs are references for a human reader. The security
  reviewer should not fetch them; the vendored text is the cited authority.
