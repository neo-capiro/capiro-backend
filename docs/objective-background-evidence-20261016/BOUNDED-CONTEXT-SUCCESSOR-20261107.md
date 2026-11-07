# Complete Objective context capacity

This policy supersedes the 1,600-character required-record and 24,000-character
required-packet limits in IMPLEMENTATION.md. Those snippet limits could not
represent complete Directory envelopes or retained Profile Fill history. The
required Objective coverage policy is now `objective-v2-required-lossless-bounded-1m`.

All required records, fields, order, section labels, review dispositions and
original JSON rendering remain present. Historical source custody, source and
external digests, evidence references and the saved Objective intent retain their
existing owners. The coverage digest changes because it names this new policy.
No record is silently dropped, shortened, summarized, compressed or marked as
included without being rendered. Ordinary supplementary retrieval remains
bounded by its existing 1,600/24,000-character policy.

The final composed Objective prompt has two independent limits: 768 KiB of UTF-8
and 896 KiB for the UTF-8 serialization of `JSON.stringify(prompt)`. Core checks
these after composing all wrappers, required data, supplementary retrieval and
steering. Strategy checks the same limits and the actual full publication JSON
at 1 MiB before creating the request ledger. An oversized complete publication
uses the existing canonical, race-safe incomplete-context failure receipt after
transaction rollback. Its aggregate issue uses the existing `government_targets`
group; that issue denotes complete-context capacity, not a malformed target.

Meri must accept these bounded private Objective publications end to end before
Core activates this policy. Its coordinated change preserves public submission
limits (100,000 characters/128 KiB), bounds private accepted requests at 1 MiB,
and bounds immutable Objective selections at 2 MiB. Completion retention has a
separate bound because its existing identity contains three prompt copies. Core's
existing private retained reader permits 8 MiB; typed result-file limits are
unchanged. Every serialized envelope remains independently checked: adding the
maximum component sizes does not establish that the complete envelope fits.

The native harness must explicitly select Sonnet 4.6's extended context for
verified Objective runs, using the Claude SDK `[1m]` model/alias option while
preserving the bare Bedrock model identity. The current Objective compatibility
selection is `us.anthropic.claude-sonnet-4-6`. The 768 KiB input ceiling is a
conservative UTF-8 planning bound, not an observed token count; the remaining
context allowance reserves capacity for SDK instructions, tools and output.
Ordinary chat model selection and public request limits do not change.

This is bounded full-fidelity input, not unlimited historical growth. A future
corpus that exceeds the final bounds fails closed before model work. Any future
selection or paging policy must explicitly revise coverage and source semantics;
it cannot claim that omitted history was included.

Qualification uses synthetic large Directory and retained-history fixtures,
exact UTF-8/JSON boundary negatives, full-publication overflow, retained hash
reconstruction and the canonical failure receipt path. Customer source values
are excluded from fixtures and committed evidence. Local checks do not establish
deployed SDK/model execution or successful live generation.
