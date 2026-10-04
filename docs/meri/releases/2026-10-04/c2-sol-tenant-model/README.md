# Scoped Sol model support — source qualification

Exact `gpt-6.1-sol` now uses the shared Responses route and preserves encrypted tool continuation. Normalization removes unsupported parameters and retains the caller output ceiling. The legacy cost estimate has explicit Sol prices and applies the documented full-request long-context surcharge above 272,000 input tokens. Global Astra and Claude defaults stay unchanged.

The additive admin route changes only the existing active OpenAI credential's model override for the verified capiro-internal tenant, using the current override and readback timestamp as compare-and-set conditions. It supports returning to the null/default override. It does not rotate, decrypt, reencrypt, or validate the API key and makes no provider generation call. The normal admin guard and successful-mutation audit pattern remain.

Root ran 147 focused tests, API/core/orchestrator TypeScript checks, and shared/core builds successfully. Actual configured Hermes sessions independently reviewed both source areas. Review limitations are preserved, including the existing separate mutation/audit transactions. Root must verify the audit after applying configuration and reconcile any uncertain response without automatic replay.

This record qualifies source only. Immutable image builds, deployment, the internal tenant switch and live inference are not claimed here. The planned live model probe is separately budgeted, non-acceptance evidence. Original acceptance remains 0/75 and CD 0/7.

Published model/rate references read October 4, 2026: [model](https://developers.openai.com/api/docs/models/gpt-6.1-sol), [migration guide](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-6.1-sol). Exact tenant account model metadata access was independently verified before this source change; generation was not performed.
