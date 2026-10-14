---
area: general
pattern: mask-code-like-commonmark
severity: important
reviewer: security-reviewer
source: "#764"
---

When a stripper skips code so that quoted markers stay text, the code detection must match the renderer exactly, or
it becomes a way to hide text. A backslash-escaped backtick is a literal, and a backtick fence whose info string
holds a backtick is no fence; treating either as code masked a real comment, so hidden text reached the parsers. Err
toward stripping, and test each CommonMark exception (escapes, info strings, closer length and character, indent).
