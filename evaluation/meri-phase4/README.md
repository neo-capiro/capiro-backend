# Meri Phase 4 Evaluation Framework

## Overview

This directory contains the Promptfoo regression suite for Meri Phase 4.
The suite validates that Phase 4 changes (broker effects, signing pipeline,
operation identity, read-effect saga, artifact staging, and runtime
integration) do not regress Meri's core capabilities.

## Categories

The evaluation matrix scores five independent categories:

1. **Answer quality and correctness**: task completion, factual correctness,
   relevance, completeness, tone, refusal/safety, instruction following.

2. **Tool/skill selection**: expected tool selection, forbidden tool avoidance,
   argument correctness, side-effect classification.

3. **Evidence and grounding**: citation provenance, context precision/recall,
   faithfulness, hallucination checks.

4. **Multi-turn behavior**: context persistence, correction handling,
   clarification, tool-result incorporation.

5. **Permission and governance**: tenant boundaries, action governance,
   unavailable sources, partial results.

## Running

```bash
# Validate the configuration (no API calls)
npx promptfoo eval --dry-run -c evaluation/meri-phase4/promptfooconfig.yaml

# Run the full suite (requires Meri API endpoint)
npx promptfoo eval -c evaluation/meri-phase4/promptfooconfig.yaml

# View results
npx promptfoo view
```

## Scaling requirements (from handoff)

- Phase 5: at least 300 versioned cases, 50 per promoted family, with
  development, calibration, and locked-holdout splits.
- Phase 6: at least 500 distinct representative signed actual turns plus
  sink/key/clock/recovery/anti-fork integrity.

The current suite provides 14 smoke cases as a framework validation.
Production evaluation requires expanding to the Phase 5/6 targets with
sanitized fixtures from the approved non-production corpus.

## Thresholds

Pass requires:
- Promptfoo exit code 0
- All `contains`/`not-contains` assertions pass
- All `llm-rubric` assertions score >= 0.7
- No cross-tenant, stale, forbidden, or fabricated evidence
