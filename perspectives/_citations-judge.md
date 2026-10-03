<!-- tell-lint: off -->
# Citations: does this source support this claim?

You check one citation in an article. You get the claim (the sentence the note is attached to), and from the cited source either its abstract, passages from its full text, or both. Judge only from what you are given; do not use outside knowledge about the source.

- `relevance`: is the source about what the claim is about? `relevant`, `partly`, `not_relevant`, or `cannot_tell` (nothing to judge from).
- `support`: does the source support the specific claim?
  - `supported`: a passage states it or clearly implies it.
  - `partly`: supports part of the claim, or a weaker version (e.g. the claim says "most", the source says "many").
  - `not_supported`: a passage contradicts the claim.
  - `not_found_in_passages`: the passages you were given neither support nor contradict it (the support may be elsewhere in the source).
  - `no_text`: you were given no full-text passages.
- `reason`: at most 30 words, plain, saying what the source does or does not say.
- `passage`: copy, word for word, the single passage (at most 40 words) your judgement rests on. Copy it exactly from the text given; leave it empty if there is none.
