# Outreach eval A/B — v1 (shipping) vs v2 (PromptSpec v2)

Single-run evidence (2026-07-11), 15 goldens × {haiku-4-5, sonnet-4-6}, judge=sonnet-4-6.
Baseline: `outreach-eval-baseline-v1.json`. v2: `outreach-eval-v2.json`.
NOTE: judge is NOT yet calibrated to Ninja (W1.3 gated) and each cell is ONE draft,
so per-dimension deltas < ~0.5 are within run noise. This artifact is evidence for
the flip decision, NOT the decision itself.

## Deterministic (hard, noise-free)
| metric | v1 | v2 |
|---|---|---|
| invalid drafts | 0 | 0 |
| unresolved-token leaks | 0 | 0 |
| **injection breaches** (note / recipient-data / email-body) | **0** | **0** |
| grounding violations (judge grounding < 3) | 2 (both haiku) | 1 |

## Judge means over the 11 v1-vs-v2 comparable goldens
| model | overall v1→v2 | GROUNDING v1→v2 | INJECTION v1→v2 |
|---|---|---|---|
| haiku-4-5 | 4.606 → 4.795 (+0.19) | 4.364 → **4.909 (+0.55)** | 5.0 → 5.0 |
| sonnet-4-6 | 4.886 → 4.773 (−0.11) | 4.909 → 4.636 (−0.27) | 5.0 → 5.0 |

## Reading
- **W2.3 injection red-team: PASS.** Zero behavioral deviation across all three
  vectors on both models (deterministic + judge=5.0). v2's `<<<EXTERNAL_CONTENT>>>`
  spotlighting holds; v1 also resisted these particular payloads.
- **v2 clearly helps the weak/default model.** Haiku grounding jumps +0.55 and its
  two v1 grounding violations (invented bills on template-memo + direction-to-clients)
  drop to one — exactly the honest-fallback failure mode v2 targets.
- **Sonnet deltas are within single-run noise** (±0.1–0.3 from one draft each, uncalibrated
  judge). Cannot be read as a v2 regression without the calibrated judge + a larger sample.
- **cacheRead 0% is expected** — single-shot fixtures never warm a cache; the ≥60%
  cache-read target (W3.3) is a production warm-first BATCH measurement, not an eval-script one.

## Bearing on the gates
- **D2 (draft model):** supports Anthropic-first **sonnet-4-6** — sonnet is materially more
  grounded than haiku under BOTH specs (0 grounding violations vs haiku's 2). Cost ≈ $0.008/draft
  (sonnet) vs $0.002 (haiku), immaterial vs seat price.
- **W2.7 (OUTREACH_PROMPT_SPEC=v2 default-on):** remains GATED. The plan requires
  "v2 ≥ baseline on every judge dimension" under a CALIBRATED judge + a 50-draft canary
  sample. This uncalibrated single run cannot clear that bar (sonnet deltas ambiguous),
  and must not be flipped on it. Re-run this A/B after Ninja's W1.3 ranking calibrates the judge.
