---
area: general
pattern: tokenizer-contextual-keyword
severity: critical
reviewer: security-reviewer
source: "#381"
---

A hand-written tokenizer that stands in for a JavaScript parser will disagree with it somewhere: `of / 2` divides, `class A extends /'/ {}` takes a regex, `a./**/return / 2` is a member name, `0x1e+/'/` is a hex number plus a regex. Each disagreement let a security check miss code that runs at import, and patching them one by one took four review rounds.
Class every reserved and contextual word explicitly and refuse what depends on grammar, and back the tokenizer with the real parser on exactly the text it delimited: the Function constructor parses a body alone and refuses one that closes early, where a wrapper such as `(() => { body })` can absorb a stray brace.
