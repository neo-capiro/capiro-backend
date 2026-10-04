# Case12 routing diagnosis — read-only review

## Verdict

The failure is in ordinary planning, not in capture admission. The supplied source snapshot shows the planner has no retrospective-approval recall intent. `PERSONAL_MEMORY_RE` recognizes `remember`, `memory`, `nickname`, `preference(s)`, and personal-voice phrases, but not approval/approved recall. A retrospective question that misses those words falls through to ordinary lookup planning. The Case12 capture guard is intentionally narrower: with an armed non-synthetic Case12 policy it admits only `subjectScope: 'client'` plus exactly `['institutional_knowledge']`. Do not change that guard.

There is an important evidence limitation: the declared read root `C:/dev/main/meri-c1-20261002` is not present in the accessible file view. The only readable source was the supplied `evidence/meri-context-plane.service.ts`, `evidence/meri-capture-api-provider-scope.ts`, and `evidence/meri-capture-api-provider-scope.spec.ts`; `prompt.txt` merely repeats the review request, and `response.txt`/`stderr.log` are empty. Thus the preserved original prompt itself and its captured plan are not in the accessible evidence. I cannot responsibly quote its literal text or assert one exact realized plan from that prompt. No capture was replayed.

## Code-grounded plan behavior

`planMeriTurn` checks `PERSONAL_MEMORY_RE` before `taskDomains`, then generic selected-client lookup. For the described retrospective-approval prompt, once subject resolution is `client` and no `taskDomains` term happens to match, the exact native fallback is:

- `subjectScope: 'client'`
- `targetHint: null`
- `queryClass: 'lookup'`
- `requestedDomains: ['clients', 'contacts', 'strategies_work', 'institutional_knowledge']`
- `query: undefined`
- `requireComplete: false`
- `timeWindow: null`

That plan fails Case12 admission because it requests four rails rather than memory alone. If the actual prompt contains a `taskDomains` keyword, its actual generic lookup plan instead uses those explicit domains (and selected-client analysis domains are unioned in); the unavailable literal prompt is needed to distinguish these cases.

For possessive shorthand there is a second possible planner failure. Subject resolution treats an explicit target as the selected client only on exact normalized-name equality or when `isSelectedClientMemoryPossessive` accepts it. That helper is deliberately constrained to possessive preference/nickname/voice/tone/memory attributes, and requires a unique authorized whole-word prefix for a shortened owner. If the original approval phrasing does not satisfy that narrow attribute grammar, a shorthand owner can become `external_entity` with a non-null target hint instead of the selected client. The Case12 guard rejects that scope even if the requested rail is institutional knowledge. Again, the exact target hint and domain list depend on the missing original wording.

The guard itself confirms the intended boundary: ordinary Case12 permits only selected-client + one institutional-knowledge rail; it rejects general scope and mail. Existing tests already cover guard rejection of general/mail, the Case14 memory-only path, Case01 selected-client memory, and four-rail selected-client analysis for Cases20/72. The current case14 test does not establish that retrospective approval wording routes to memory.

## Minimal ordinary-planner correction

1. Add a narrowly defined retrospective-approval-recall intent predicate in the planner (not the capture guard). It should require recall/question framing plus past approval semantics (for example, asking what was approved / what approval was given / what had previously been approved). Route that intent to the same semantic-recall plan as personal memory: `queryClass: 'semantic_recall'`, `requestedDomains: ['institutional_knowledge']`, query equal to the user task, `requireComplete: true`, no time window. Do not classify prospective requests to approve, approval-workflow actions, or generic mentions of an approval as retrospective recall.
2. Make the selected-client possessive shorthand resolver recognize the *bounded approval-recall attribute form* only when that retrospective-recall predicate holds. Reuse the existing authorization proof: owner exactly equals the selected client name, or is a whole-word prefix matching exactly one current authorized client whose full name is the selected name. Do not infer aliases from the selected UI name alone. Keep the existing cross-client conjunction and multi-sentence rejection checks in force. Ordinary unambiguous full-name targeting should remain unchanged.
3. Keep this correction in `planMeriTurn` / its ordinary-planner helpers. Do not special-case Case12, fixture IDs, exact prompt text, or loosen `assertCaptureApiRetrievalPlan`.

This is the smallest semantic change: recognize a missing read intent and, only for that intent, resolve its client-owned possessive shorthand under the current unique-authorized-name rule. It does not add retrieval capabilities or broaden authorization.

## Focused cases root should run

Positive assertions should inspect the complete plan (not merely that planning does not throw):

- Original Case12 literal prompt, with its actual selected-client ID/name and current authorized-name list: assert `client`, null target hint, semantic recall, exactly institutional knowledge, task text as query, complete required coverage, and Case12 guard admission.
- Retrospective approval recall using selected client's full possessive name and an unambiguous authorized shorthand; include ASCII and curly apostrophes. Both should produce that same memory-only plan.
- Existing Case14 wording (`What is the recently approved Aster memory? Cite its source.`) and Case01 preference wording remain unchanged.

Negative / boundary assertions:

- Same shorthand prefix matches two authorized clients (e.g. `Aster Defense` and `Aster Labs`): do not resolve it to the selected client; assert it cannot produce a Case12-admissible client memory plan.
- A shorthand owner is not in the current authorized-name set, or the unique prefix resolves to a different client than the selected one: no selected-client resolution.
- Cross-client wording (`Aster's approval and Bluehaven's`, `compare Aster's approval with Bluehaven's`) must not be treated as a single selected-client memory query; assert no broadened/cross-client plan and guard rejection where applicable.
- Multi-sentence prompt (`Aster's approval? Also, ...`) remains outside the possessive shorthand exception.
- Prospective/action wording (`Should we approve ...?`, `Please approve ...`) and generic approval-workflow/checklist requests do not take the retrospective memory route.
- A non-possessive, distinct external organization still resolves as external rather than being silently mapped to the selected UI client.
- Exercise the planner without a selected client and verify the new intent does not manufacture client scope; run the guard assertions unchanged to prove no captureguard widening.

The first test must use the preserved literal prompt and fixture context once root restores access to that evidence. Do not replay the capture; direct planner unit tests are sufficient.

## Scope / verification status

Read-only inspection only. No repository files were edited, no tests or captures were run, and no cloud or journal action was taken. The review file is the sole output created in the current review workspace. The requested literal-plan confirmation remains blocked by unavailable primary-root/original-prompt evidence; the planner and guard conclusions above are based on the readable source snapshot, not a fabricated replay result.
