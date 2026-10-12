# Exact14 root alias additions

These are the precise incoming additions. Current/full destination aliases remain unchanged; executable adoption depends on separately reviewed current-owner mode extensions.

| Alias | Proposed command |
| --- | --- |
| `typecheck:backend` | `turbo run typecheck --concurrency=1 --filter='!@capiro/web' --filter='!@capiro/onboard-web'` |
| `typecheck:frontend` | `turbo run typecheck --concurrency=1 --filter=@capiro/web --filter=@capiro/onboard-web` |
| `verify:engagement-phase-1:backend` | `pnpm --filter @capiro/api exec tsx scripts/verify-engagement-phase1-runtime.ts --run --backend-only && node --check scripts/run-engagement-phase1-local.mjs && node --check scripts/verify-engagement-phase1-local.mjs && node --check scripts/run-engagement-phase1-post-acceptance.mjs && node --check scripts/verify-engagement-phase1-background-final.mjs` |
| `verify:engagement-phase-1:frontend` | `pnpm --filter @capiro/api exec tsx scripts/verify-engagement-phase1-runtime.ts --run --frontend-only && node --check apps/web/scripts/engagement-phase1-browser-parity.mjs && node --check apps/web/scripts/engagement-phase1-post-acceptance.mjs` |
| `verify:engagement-phase-2:backend` | `bash scripts/verify-engagement-phase2-code.sh --backend-only` |
| `verify:engagement-phase-2:frontend` | `bash scripts/verify-engagement-phase2-code.sh --frontend-only` |
| `verify:engagement-phase-3:backend` | `node scripts/verify-engagement-phase3-code.mjs --run --backend-only` |
| `verify:engagement-phase-3:frontend` | `node scripts/verify-engagement-phase3-code.mjs --run --frontend-only` |
| `verify:outreach-v3-phase-1:backend` | `node scripts/verify-outreach-v3-phase1-code.mjs --run --backend-only` |
| `verify:outreach-v3-phase-1:frontend` | `node scripts/verify-outreach-v3-phase1-code.mjs --run --frontend-only` |
| `verify:outreach-v3-phase-3:backend` | `node scripts/verify-outreach-v3-phase3-code.mjs --run --backend-only` |
| `verify:outreach-v3-phase-3:frontend` | `node scripts/verify-outreach-v3-phase3-code.mjs --run --frontend-only` |
| `verify:outreach-v3-phase-4:backend` | `node scripts/verify-outreach-v3-phase4-code.mjs --run --backend-only` |
| `verify:outreach-v3-phase-4:frontend` | `node scripts/verify-outreach-v3-phase4-code.mjs --run --frontend-only` |

Backend and frontend Phase1 command strings equal projections derived from the current full alias, including its existing run operand and six syntax checks. Typecheck preserves current Web/Onboard partition; Phase2 shell aliases preserve its mode-only contract.
