# MeriV2 Phase 0 Core Validation

Base commit: 1cdd372f0409986ac238beef2c4e9f310925fb37
Workflow run: https://github.com/neo-capiro/capirov2/actions/runs/30326333319
Result: FAIL

```text
$ pnpm --filter @capiro/api prisma:generate

> @capiro/api@0.0.0 prisma:generate /home/runner/work/capirov2/capirov2/apps/api
> prisma generate

Prisma schema loaded from prisma/schema.prisma

✔ Generated Prisma Client (v5.22.0) to ./../../node_modules/.pnpm/@prisma+client@5.22.0_prisma@5.22.0/node_modules/@prisma/client in 2.19s

Start by importing your Prisma Client (See: https://pris.ly/d/importing-client)

Tip: Interested in query caching in just a few lines of code? Try Accelerate today! https://pris.ly/tip-3-accelerate

exit_code=0
$ pnpm --filter @capiro/meriv2-core typecheck

> @capiro/meriv2-core@0.0.0 typecheck /home/runner/work/capirov2/capirov2/packages/meriv2-core
> tsc -p tsconfig.json --noEmit

src/alerts/alert.ts(16,8): error TS2307: Cannot find module '@capiro/shared' or its corresponding type declarations.
src/compliance/approval-gate.ts(19,31): error TS2307: Cannot find module '@capiro/shared' or its corresponding type declarations.
src/compliance/approval-gate.ts(24,31): error TS2307: Cannot find module '@capiro/shared' or its corresponding type declarations.
src/compliance/approval-gate.ts(25,79): error TS2307: Cannot find module '@capiro/shared' or its corresponding type declarations.
src/compliance/compliance-rules.ts(1,31): error TS2307: Cannot find module '@capiro/shared' or its corresponding type declarations.
src/domain/domain-primer.ts(33,37): error TS2307: Cannot find module '@capiro/shared' or its corresponding type declarations.
src/domain/domain-primer.ts(49,8): error TS2307: Cannot find module '@capiro/shared' or its corresponding type declarations.
src/grounding/auditor.ts(61,8): error TS2307: Cannot find module '@capiro/shared' or its corresponding type declarations.
src/grounding/auditor.ts(200,23): error TS7006: Parameter 'token' implicitly has an 'any' type.
src/grounding/auditor.ts(590,50): error TS7006: Parameter 'c' implicitly has an 'any' type.
src/grounding/auditor.ts(643,50): error TS7006: Parameter 'c' implicitly has an 'any' type.
src/grounding/auditor.ts(719,50): error TS7006: Parameter 'c' implicitly has an 'any' type.
src/grounding/auditor.ts(773,50): error TS7006: Parameter 'c' implicitly has an 'any' type.
src/grounding/evidence.ts(18,34): error TS2307: Cannot find module '@capiro/shared' or its corresponding type declarations.
src/ids/canonical-ids.ts(17,8): error TS2307: Cannot find module '@capiro/shared' or its corresponding type declarations.
src/ids/canonical-ids.ts(31,8): error TS2307: Cannot find module '@capiro/shared' or its corresponding type declarations.
src/registry/types.ts(2,48): error TS2307: Cannot find module '@capiro/shared' or its corresponding type declarations.
src/verifier/pe-structural.ts(24,36): error TS2307: Cannot find module '@capiro/shared' or its corresponding type declarations.
/home/runner/work/capirov2/capirov2/packages/meriv2-core:
 ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  @capiro/meriv2-core@0.0.0 typecheck: `tsc -p tsconfig.json --noEmit`
Exit status 2
exit_code=2
$ pnpm --filter @capiro/meriv2-core test

> @capiro/meriv2-core@0.0.0 test /home/runner/work/capirov2/capirov2/packages/meriv2-core
> jest --detectOpenHandles --forceExit

FAIL src/grounding/auditor.spec.ts
  ● Test suite failed to run

    [96msrc/grounding/auditor.ts[0m:[93m61[0m:[93m8[0m - [91merror[0m[90m TS2307: [0mCannot find module '@capiro/shared' or its corresponding type declarations.

    [7m61[0m } from '@capiro/shared';
    [7m  [0m [91m       ~~~~~~~~~~~~~~~~[0m
    [96msrc/grounding/auditor.ts[0m:[93m200[0m:[93m23[0m - [91merror[0m[90m TS7006: [0mParameter 'token' implicitly has an 'any' type.

    [7m200[0m   return invalid.map((token) => ({
    [7m   [0m [91m                      ~~~~~[0m
    [96msrc/grounding/auditor.ts[0m:[93m590[0m:[93m50[0m - [91merror[0m[90m TS7006: [0mParameter 'c' implicitly has an 'any' type.

    [7m590[0m     const codes = extractCitedPeCodes(s).filter((c) => dirByPe.has(c));
    [7m   [0m [91m                                                 ~[0m
    [96msrc/grounding/auditor.ts[0m:[93m643[0m:[93m50[0m - [91merror[0m[90m TS7006: [0mParameter 'c' implicitly has an 'any' type.

    [7m643[0m     const codes = extractCitedPeCodes(s).filter((c) => deltaByPe.has(c));
    [7m   [0m [91m                                                 ~[0m
    [96msrc/grounding/auditor.ts[0m:[93m719[0m:[93m50[0m - [91merror[0m[90m TS7006: [0mParameter 'c' implicitly has an 'any' type.

    [7m719[0m     const codes = extractCitedPeCodes(s).filter((c) => amtByPe.has(c));
    [7m   [0m [91m                                                 ~[0m
    [96msrc/grounding/auditor.ts[0m:[93m773[0m:[93m50[0m - [91merror[0m[90m TS7006: [0mParameter 'c' implicitly has an 'any' type.

    [7m773[0m     const codes = extractCitedPeCodes(s).filter((c) => amtByPe.has(c));
    [7m   [0m [91m                                                 ~[0m

FAIL src/grounding/auditor-golden.spec.ts
  ● Test suite failed to run

    [96msrc/grounding/auditor.ts[0m:[93m61[0m:[93m8[0m - [91merror[0m[90m TS2307: [0mCannot find module '@capiro/shared' or its corresponding type declarations.

    [7m61[0m } from '@capiro/shared';
    [7m  [0m [91m       ~~~~~~~~~~~~~~~~[0m
    [96msrc/grounding/auditor.ts[0m:[93m200[0m:[93m23[0m - [91merror[0m[90m TS7006: [0mParameter 'token' implicitly has an 'any' type.

    [7m200[0m   return invalid.map((token) => ({
    [7m   [0m [91m                      ~~~~~[0m
    [96msrc/grounding/auditor.ts[0m:[93m590[0m:[93m50[0m - [91merror[0m[90m TS7006: [0mParameter 'c' implicitly has an 'any' type.

    [7m590[0m     const codes = extractCitedPeCodes(s).filter((c) => dirByPe.has(c));
    [7m   [0m [91m                                                 ~[0m
    [96msrc/grounding/auditor.ts[0m:[93m643[0m:[93m50[0m - [91merror[0m[90m TS7006: [0mParameter 'c' implicitly has an 'any' type.

    [7m643[0m     const codes = extractCitedPeCodes(s).filter((c) => deltaByPe.has(c));
    [7m   [0m [91m                                                 ~[0m
    [96msrc/grounding/auditor.ts[0m:[93m719[0m:[93m50[0m - [91merror[0m[90m TS7006: [0mParameter 'c' implicitly has an 'any' type.

    [7m719[0m     const codes = extractCitedPeCodes(s).filter((c) => amtByPe.has(c));
    [7m   [0m [91m                                                 ~[0m
    [96msrc/grounding/auditor.ts[0m:[93m773[0m:[93m50[0m - [91merror[0m[90m TS7006: [0mParameter 'c' implicitly has an 'any' type.

    [7m773[0m     const codes = extractCitedPeCodes(s).filter((c) => amtByPe.has(c));
    [7m   [0m [91m                                                 ~[0m

PASS src/llm/llm-client.spec.ts
PASS src/grounding/grounded-json.spec.ts
FAIL src/compliance/compliance-rules.spec.ts
  ● Test suite failed to run

    [96msrc/compliance/compliance-rules.ts[0m:[93m1[0m:[93m31[0m - [91merror[0m[90m TS2307: [0mCannot find module '@capiro/shared' or its corresponding type declarations.

    [7m1[0m import type { RiskTier } from '@capiro/shared';
    [7m [0m [91m                              ~~~~~~~~~~~~~~~~[0m

FAIL src/grounding/claim-gate.spec.ts
  ● Test suite failed to run

    [96msrc/grounding/evidence.ts[0m:[93m18[0m:[93m34[0m - [91merror[0m[90m TS2307: [0mCannot find module '@capiro/shared' or its corresponding type declarations.

    [7m18[0m import { currentCycleFyOf } from '@capiro/shared';
    [7m  [0m [91m                                 ~~~~~~~~~~~~~~~~[0m

FAIL src/grounding/evidence.spec.ts
  ● Test suite failed to run

    [96msrc/grounding/evidence.ts[0m:[93m18[0m:[93m34[0m - [91merror[0m[90m TS2307: [0mCannot find module '@capiro/shared' or its corresponding type declarations.

    [7m18[0m import { currentCycleFyOf } from '@capiro/shared';
    [7m  [0m [91m                                 ~~~~~~~~~~~~~~~~[0m

FAIL src/verifier/pe-structural.spec.ts
  ● Test suite failed to run

    [96msrc/verifier/pe-structural.ts[0m:[93m24[0m:[93m36[0m - [91merror[0m[90m TS2307: [0mCannot find module '@capiro/shared' or its corresponding type declarations.

    [7m24[0m import { fmtFundingMillions } from '@capiro/shared';
    [7m  [0m [91m                                   ~~~~~~~~~~~~~~~~[0m

PASS src/context/compiler.spec.ts
PASS src/grounding/skeptic.spec.ts
FAIL src/scoping/cross-tenant-parity.spec.ts
  ● Test suite failed to run

    [96msrc/registry/types.ts[0m:[93m2[0m:[93m48[0m - [91merror[0m[90m TS2307: [0mCannot find module '@capiro/shared' or its corresponding type declarations.

    [7m2[0m import type { TenantContext, TenantRole } from '@capiro/shared';
    [7m [0m [91m                                               ~~~~~~~~~~~~~~~~[0m

FAIL src/compliance/action-approval.spec.ts
  ● Test suite failed to run

    [96msrc/compliance/approval-gate.ts[0m:[93m19[0m:[93m31[0m - [91merror[0m[90m TS2307: [0mCannot find module '@capiro/shared' or its corresponding type declarations.

    [7m19[0m import type { RiskTier } from '@capiro/shared';
    [7m  [0m [91m                              ~~~~~~~~~~~~~~~~[0m
    [96msrc/compliance/approval-gate.ts[0m:[93m24[0m:[93m31[0m - [91merror[0m[90m TS2307: [0mCannot find module '@capiro/shared' or its corresponding type declarations.

    [7m24[0m export type { RiskTier } from '@capiro/shared';
    [7m  [0m [91m                              ~~~~~~~~~~~~~~~~[0m
    [96msrc/compliance/approval-gate.ts[0m:[93m25[0m:[93m79[0m - [91merror[0m[90m TS2307: [0mCannot find module '@capiro/shared' or its corresponding type declarations.

    [7m25[0m export { RISK_TIERS, RISK_TIER_DEFAULT_OUTCOME, DELIVERABLE_RISK_TIERS } from '@capiro/shared';
    [7m  [0m [91m                                                                              ~~~~~~~~~~~~~~~~[0m

FAIL src/grounding/skeptic-audit.spec.ts
  ● Test suite failed to run

    [96msrc/grounding/auditor.ts[0m:[93m61[0m:[93m8[0m - [91merror[0m[90m TS2307: [0mCannot find module '@capiro/shared' or its corresponding type declarations.

    [7m61[0m } from '@capiro/shared';
    [7m  [0m [91m       ~~~~~~~~~~~~~~~~[0m
    [96msrc/grounding/auditor.ts[0m:[93m200[0m:[93m23[0m - [91merror[0m[90m TS7006: [0mParameter 'token' implicitly has an 'any' type.

    [7m200[0m   return invalid.map((token) => ({
    [7m   [0m [91m                      ~~~~~[0m
    [96msrc/grounding/auditor.ts[0m:[93m590[0m:[93m50[0m - [91merror[0m[90m TS7006: [0mParameter 'c' implicitly has an 'any' type.

    [7m590[0m     const codes = extractCitedPeCodes(s).filter((c) => dirByPe.has(c));
    [7m   [0m [91m                                                 ~[0m
    [96msrc/grounding/auditor.ts[0m:[93m643[0m:[93m50[0m - [91merror[0m[90m TS7006: [0mParameter 'c' implicitly has an 'any' type.

    [7m643[0m     const codes = extractCitedPeCodes(s).filter((c) => deltaByPe.has(c));
    [7m   [0m [91m                                                 ~[0m
    [96msrc/grounding/auditor.ts[0m:[93m719[0m:[93m50[0m - [91merror[0m[90m TS7006: [0mParameter 'c' implicitly has an 'any' type.

    [7m719[0m     const codes = extractCitedPeCodes(s).filter((c) => amtByPe.has(c));
    [7m   [0m [91m                                                 ~[0m
    [96msrc/grounding/auditor.ts[0m:[93m773[0m:[93m50[0m - [91merror[0m[90m TS7006: [0mParameter 'c' implicitly has an 'any' type.

    [7m773[0m     const codes = extractCitedPeCodes(s).filter((c) => amtByPe.has(c));
    [7m   [0m [91m                                                 ~[0m

FAIL src/compliance/approval-gate.spec.ts
  ● Test suite failed to run

    [96msrc/compliance/approval-gate.ts[0m:[93m19[0m:[93m31[0m - [91merror[0m[90m TS2307: [0mCannot find module '@capiro/shared' or its corresponding type declarations.

    [7m19[0m import type { RiskTier } from '@capiro/shared';
    [7m  [0m [91m                              ~~~~~~~~~~~~~~~~[0m
    [96msrc/compliance/approval-gate.ts[0m:[93m24[0m:[93m31[0m - [91merror[0m[90m TS2307: [0mCannot find module '@capiro/shared' or its corresponding type declarations.

    [7m24[0m export type { RiskTier } from '@capiro/shared';
    [7m  [0m [91m                              ~~~~~~~~~~~~~~~~[0m
    [96msrc/compliance/approval-gate.ts[0m:[93m25[0m:[93m79[0m - [91merror[0m[90m TS2307: [0mCannot find module '@capiro/shared' or its corresponding type declarations.

    [7m25[0m export { RISK_TIERS, RISK_TIER_DEFAULT_OUTCOME, DELIVERABLE_RISK_TIERS } from '@capiro/shared';
    [7m  [0m [91m                                                                              ~~~~~~~~~~~~~~~~[0m

PASS src/security/tool-result-wrap.spec.ts
FAIL src/tools/delegated/delegated-tool.spec.ts
  ● Test suite failed to run

    [96msrc/registry/types.ts[0m:[93m2[0m:[93m48[0m - [91merror[0m[90m TS2307: [0mCannot find module '@capiro/shared' or its corresponding type declarations.

    [7m2[0m import type { TenantContext, TenantRole } from '@capiro/shared';
    [7m [0m [91m                                               ~~~~~~~~~~~~~~~~[0m

PASS src/tools/hearing/hearing-tools.spec.ts
FAIL src/registry/tool-registry.spec.ts
  ● Test suite failed to run

    [96msrc/registry/types.ts[0m:[93m2[0m:[93m48[0m - [91merror[0m[90m TS2307: [0mCannot find module '@capiro/shared' or its corresponding type declarations.

    [7m2[0m import type { TenantContext, TenantRole } from '@capiro/shared';
    [7m [0m [91m                                               ~~~~~~~~~~~~~~~~[0m

PASS src/verifier/verifier-claims.spec.ts
FAIL src/ids/canonical-ids.spec.ts
  ● Test suite failed to run

    [96msrc/ids/canonical-ids.ts[0m:[93m17[0m:[93m8[0m - [91merror[0m[90m TS2307: [0mCannot find module '@capiro/shared' or its corresponding type declarations.

    [7m17[0m } from '@capiro/shared';
    [7m  [0m [91m       ~~~~~~~~~~~~~~~~[0m
    [96msrc/ids/canonical-ids.ts[0m:[93m31[0m:[93m8[0m - [91merror[0m[90m TS2307: [0mCannot find module '@capiro/shared' or its corresponding type declarations.

    [7m31[0m } from '@capiro/shared';
    [7m  [0m [91m       ~~~~~~~~~~~~~~~~[0m

FAIL src/tools/client/get-client-context.spec.ts
  ● Test suite failed to run

    [96msrc/registry/types.ts[0m:[93m2[0m:[93m48[0m - [91merror[0m[90m TS2307: [0mCannot find module '@capiro/shared' or its corresponding type declarations.

    [7m2[0m import type { TenantContext, TenantRole } from '@capiro/shared';
    [7m [0m [91m                                               ~~~~~~~~~~~~~~~~[0m

FAIL src/alerts/alert.spec.ts
  ● Test suite failed to run

    [96msrc/alerts/alert.ts[0m:[93m16[0m:[93m8[0m - [91merror[0m[90m TS2307: [0mCannot find module '@capiro/shared' or its corresponding type declarations.

    [7m16[0m } from '@capiro/shared';
    [7m  [0m [91m       ~~~~~~~~~~~~~~~~[0m

PASS test/parity/diff.spec.ts
PASS src/context/token-budget.spec.ts
FAIL src/domain/domain-primer.spec.ts
  ● Test suite failed to run

    [96msrc/domain/domain-primer.ts[0m:[93m33[0m:[93m37[0m - [91merror[0m[90m TS2307: [0mCannot find module '@capiro/shared' or its corresponding type declarations.

    [7m33[0m export { extractCitedPeCodes } from '@capiro/shared';
    [7m  [0m [91m                                    ~~~~~~~~~~~~~~~~[0m
    [96msrc/domain/domain-primer.ts[0m:[93m49[0m:[93m8[0m - [91merror[0m[90m TS2307: [0mCannot find module '@capiro/shared' or its corresponding type declarations.

    [7m49[0m } from '@capiro/shared';
    [7m  [0m [91m       ~~~~~~~~~~~~~~~~[0m

PASS src/grounding/claim-map.spec.ts
PASS src/scoping/scoping-wrapper.spec.ts
PASS src/intent/intent-router.spec.ts
PASS src/verifier/grounding-sources.spec.ts
PASS src/verifier/confidence.spec.ts

Summary of all failing tests
FAIL src/grounding/auditor.spec.ts
  ● Test suite failed to run

    [96msrc/grounding/auditor.ts[0m:[93m61[0m:[93m8[0m - [91merror[0m[90m TS2307: [0mCannot find module '@capiro/shared' or its corresponding type declarations.

    [7m61[0m } from '@capiro/shared';
    [7m  [0m [91m       ~~~~~~~~~~~~~~~~[0m
    [96msrc/grounding/auditor.ts[0m:[93m200[0m:[93m23[0m - [91merror[0m[90m TS7006: [0mParameter 'token' implicitly has an 'any' type.

    [7m200[0m   return invalid.map((token) => ({
    [7m   [0m [91m                      ~~~~~[0m
    [96msrc/grounding/auditor.ts[0m:[93m590[0m:[93m50[0m - [91merror[0m[90m TS7006: [0mParameter 'c' implicitly has an 'any' type.

    [7m590[0m     const codes = extractCitedPeCodes(s).filter((c) => dirByPe.has(c));
    [7m   [0m [91m                                                 ~[0m
    [96msrc/grounding/auditor.ts[0m:[93m643[0m:[93m50[0m - [91merror[0m[90m TS7006: [0mParameter 'c' implicitly has an 'any' type.

    [7m643[0m     const codes = extractCitedPeCodes(s).filter((c) => deltaByPe.has(c));
    [7m   [0m [91m                                                 ~[0m
    [96msrc/grounding/auditor.ts[0m:[93m719[0m:[93m50[0m - [91merror[0m[90m TS7006: [0mParameter 'c' implicitly has an 'any' type.

    [7m719[0m     const codes = extractCitedPeCodes(s).filter((c) => amtByPe.has(c));
    [7m   [0m [91m                                                 ~[0m
    [96msrc/grounding/auditor.ts[0m:[93m773[0m:[93m50[0m - [91merror[0m[90m TS7006: [0mParameter 'c' implicitly has an 'any' type.

    [7m773[0m     const codes = extractCitedPeCodes(s).filter((c) => amtByPe.has(c));
    [7m   [0m [91m                                                 ~[0m

FAIL src/grounding/auditor-golden.spec.ts
  ● Test suite failed to run

    [96msrc/grounding/auditor.ts[0m:[93m61[0m:[93m8[0m - [91merror[0m[90m TS2307: [0mCannot find module '@capiro/shared' or its corresponding type declarations.

    [7m61[0m } from '@capiro/shared';
    [7m  [0m [91m       ~~~~~~~~~~~~~~~~[0m
    [96msrc/grounding/auditor.ts[0m:[93m200[0m:[93m23[0m - [91merror[0m[90m TS7006: [0mParameter 'token' implicitly has an 'any' type.

    [7m200[0m   return invalid.map((token) => ({
    [7m   [0m [91m                      ~~~~~[0m
    [96msrc/grounding/auditor.ts[0m:[93m590[0m:[93m50[0m - [91merror[0m[90m TS7006: [0mParameter 'c' implicitly has an 'any' type.

    [7m590[0m     const codes = extractCitedPeCodes(s).filter((c) => dirByPe.has(c));
    [7m   [0m [91m                                                 ~[0m
    [96msrc/grounding/auditor.ts[0m:[93m643[0m:[93m50[0m - [91merror[0m[90m TS7006: [0mParameter 'c' implicitly has an 'any' type.

    [7m643[0m     const codes = extractCitedPeCodes(s).filter((c) => deltaByPe.has(c));
    [7m   [0m [91m                                                 ~[0m
    [96msrc/grounding/auditor.ts[0m:[93m719[0m:[93m50[0m - [91merror[0m[90m TS7006: [0mParameter 'c' implicitly has an 'any' type.

    [7m719[0m     const codes = extractCitedPeCodes(s).filter((c) => amtByPe.has(c));
    [7m   [0m [91m                                                 ~[0m
    [96msrc/grounding/auditor.ts[0m:[93m773[0m:[93m50[0m - [91merror[0m[90m TS7006: [0mParameter 'c' implicitly has an 'any' type.

    [7m773[0m     const codes = extractCitedPeCodes(s).filter((c) => amtByPe.has(c));
    [7m   [0m [91m                                                 ~[0m

FAIL src/compliance/compliance-rules.spec.ts
  ● Test suite failed to run

    [96msrc/compliance/compliance-rules.ts[0m:[93m1[0m:[93m31[0m - [91merror[0m[90m TS2307: [0mCannot find module '@capiro/shared' or its corresponding type declarations.

    [7m1[0m import type { RiskTier } from '@capiro/shared';
    [7m [0m [91m                              ~~~~~~~~~~~~~~~~[0m

FAIL src/grounding/claim-gate.spec.ts
  ● Test suite failed to run

    [96msrc/grounding/evidence.ts[0m:[93m18[0m:[93m34[0m - [91merror[0m[90m TS2307: [0mCannot find module '@capiro/shared' or its corresponding type declarations.

    [7m18[0m import { currentCycleFyOf } from '@capiro/shared';
    [7m  [0m [91m                                 ~~~~~~~~~~~~~~~~[0m

FAIL src/grounding/evidence.spec.ts
  ● Test suite failed to run

    [96msrc/grounding/evidence.ts[0m:[93m18[0m:[93m34[0m - [91merror[0m[90m TS2307: [0mCannot find module '@capiro/shared' or its corresponding type declarations.

    [7m18[0m import { currentCycleFyOf } from '@capiro/shared';
    [7m  [0m [91m                                 ~~~~~~~~~~~~~~~~[0m

FAIL src/verifier/pe-structural.spec.ts
  ● Test suite failed to run

    [96msrc/verifier/pe-structural.ts[0m:[93m24[0m:[93m36[0m - [91merror[0m[90m TS2307: [0mCannot find module '@capiro/shared' or its corresponding type declarations.

    [7m24[0m import { fmtFundingMillions } from '@capiro/shared';
    [7m  [0m [91m                                   ~~~~~~~~~~~~~~~~[0m

FAIL src/scoping/cross-tenant-parity.spec.ts
  ● Test suite failed to run

    [96msrc/registry/types.ts[0m:[93m2[0m:[93m48[0m - [91merror[0m[90m TS2307: [0mCannot find module '@capiro/shared' or its corresponding type declarations.

    [7m2[0m import type { TenantContext, TenantRole } from '@capiro/shared';
    [7m [0m [91m                                               ~~~~~~~~~~~~~~~~[0m

FAIL src/compliance/action-approval.spec.ts
  ● Test suite failed to run

    [96msrc/compliance/approval-gate.ts[0m:[93m19[0m:[93m31[0m - [91merror[0m[90m TS2307: [0mCannot find module '@capiro/shared' or its corresponding type declarations.

    [7m19[0m import type { RiskTier } from '@capiro/shared';
    [7m  [0m [91m                              ~~~~~~~~~~~~~~~~[0m
    [96msrc/compliance/approval-gate.ts[0m:[93m24[0m:[93m31[0m - [91merror[0m[90m TS2307: [0mCannot find module '@capiro/shared' or its corresponding type declarations.

    [7m24[0m export type { RiskTier } from '@capiro/shared';
    [7m  [0m [91m                              ~~~~~~~~~~~~~~~~[0m
    [96msrc/compliance/approval-gate.ts[0m:[93m25[0m:[93m79[0m - [91merror[0m[90m TS2307: [0mCannot find module '@capiro/shared' or its corresponding type declarations.

    [7m25[0m export { RISK_TIERS, RISK_TIER_DEFAULT_OUTCOME, DELIVERABLE_RISK_TIERS } from '@capiro/shared';
    [7m  [0m [91m                                                                              ~~~~~~~~~~~~~~~~[0m

FAIL src/grounding/skeptic-audit.spec.ts
  ● Test suite failed to run

    [96msrc/grounding/auditor.ts[0m:[93m61[0m:[93m8[0m - [91merror[0m[90m TS2307: [0mCannot find module '@capiro/shared' or its corresponding type declarations.

    [7m61[0m } from '@capiro/shared';
    [7m  [0m [91m       ~~~~~~~~~~~~~~~~[0m
    [96msrc/grounding/auditor.ts[0m:[93m200[0m:[93m23[0m - [91merror[0m[90m TS7006: [0mParameter 'token' implicitly has an 'any' type.

    [7m200[0m   return invalid.map((token) => ({
    [7m   [0m [91m                      ~~~~~[0m
    [96msrc/grounding/auditor.ts[0m:[93m590[0m:[93m50[0m - [91merror[0m[90m TS7006: [0mParameter 'c' implicitly has an 'any' type.

    [7m590[0m     const codes = extractCitedPeCodes(s).filter((c) => dirByPe.has(c));
    [7m   [0m [91m                                                 ~[0m
    [96msrc/grounding/auditor.ts[0m:[93m643[0m:[93m50[0m - [91merror[0m[90m TS7006: [0mParameter 'c' implicitly has an 'any' type.

    [7m643[0m     const codes = extractCitedPeCodes(s).filter((c) => deltaByPe.has(c));
    [7m   [0m [91m                                                 ~[0m
    [96msrc/grounding/auditor.ts[0m:[93m719[0m:[93m50[0m - [91merror[0m[90m TS7006: [0mParameter 'c' implicitly has an 'any' type.

    [7m719[0m     const codes = extractCitedPeCodes(s).filter((c) => amtByPe.has(c));
    [7m   [0m [91m                                                 ~[0m
    [96msrc/grounding/auditor.ts[0m:[93m773[0m:[93m50[0m - [91merror[0m[90m TS7006: [0mParameter 'c' implicitly has an 'any' type.

    [7m773[0m     const codes = extractCitedPeCodes(s).filter((c) => amtByPe.has(c));
    [7m   [0m [91m                                                 ~[0m

FAIL src/compliance/approval-gate.spec.ts
  ● Test suite failed to run

    [96msrc/compliance/approval-gate.ts[0m:[93m19[0m:[93m31[0m - [91merror[0m[90m TS2307: [0mCannot find module '@capiro/shared' or its corresponding type declarations.

    [7m19[0m import type { RiskTier } from '@capiro/shared';
    [7m  [0m [91m                              ~~~~~~~~~~~~~~~~[0m
    [96msrc/compliance/approval-gate.ts[0m:[93m24[0m:[93m31[0m - [91merror[0m[90m TS2307: [0mCannot find module '@capiro/shared' or its corresponding type declarations.

    [7m24[0m export type { RiskTier } from '@capiro/shared';
    [7m  [0m [91m                              ~~~~~~~~~~~~~~~~[0m
    [96msrc/compliance/approval-gate.ts[0m:[93m25[0m:[93m79[0m - [91merror[0m[90m TS2307: [0mCannot find module '@capiro/shared' or its corresponding type declarations.

    [7m25[0m export { RISK_TIERS, RISK_TIER_DEFAULT_OUTCOME, DELIVERABLE_RISK_TIERS } from '@capiro/shared';
    [7m  [0m [91m                                                                              ~~~~~~~~~~~~~~~~[0m

FAIL src/tools/delegated/delegated-tool.spec.ts
  ● Test suite failed to run

    [96msrc/registry/types.ts[0m:[93m2[0m:[93m48[0m - [91merror[0m[90m TS2307: [0mCannot find module '@capiro/shared' or its corresponding type declarations.

    [7m2[0m import type { TenantContext, TenantRole } from '@capiro/shared';
    [7m [0m [91m                                               ~~~~~~~~~~~~~~~~[0m

FAIL src/registry/tool-registry.spec.ts
  ● Test suite failed to run

    [96msrc/registry/types.ts[0m:[93m2[0m:[93m48[0m - [91merror[0m[90m TS2307: [0mCannot find module '@capiro/shared' or its corresponding type declarations.

    [7m2[0m import type { TenantContext, TenantRole } from '@capiro/shared';
    [7m [0m [91m                                               ~~~~~~~~~~~~~~~~[0m

FAIL src/ids/canonical-ids.spec.ts
  ● Test suite failed to run

    [96msrc/ids/canonical-ids.ts[0m:[93m17[0m:[93m8[0m - [91merror[0m[90m TS2307: [0mCannot find module '@capiro/shared' or its corresponding type declarations.

    [7m17[0m } from '@capiro/shared';
    [7m  [0m [91m       ~~~~~~~~~~~~~~~~[0m
    [96msrc/ids/canonical-ids.ts[0m:[93m31[0m:[93m8[0m - [91merror[0m[90m TS2307: [0mCannot find module '@capiro/shared' or its corresponding type declarations.

    [7m31[0m } from '@capiro/shared';
    [7m  [0m [91m       ~~~~~~~~~~~~~~~~[0m

FAIL src/tools/client/get-client-context.spec.ts
  ● Test suite failed to run

    [96msrc/registry/types.ts[0m:[93m2[0m:[93m48[0m - [91merror[0m[90m TS2307: [0mCannot find module '@capiro/shared' or its corresponding type declarations.

    [7m2[0m import type { TenantContext, TenantRole } from '@capiro/shared';
    [7m [0m [91m                                               ~~~~~~~~~~~~~~~~[0m

FAIL src/alerts/alert.spec.ts
  ● Test suite failed to run

    [96msrc/alerts/alert.ts[0m:[93m16[0m:[93m8[0m - [91merror[0m[90m TS2307: [0mCannot find module '@capiro/shared' or its corresponding type declarations.

    [7m16[0m } from '@capiro/shared';
    [7m  [0m [91m       ~~~~~~~~~~~~~~~~[0m

FAIL src/domain/domain-primer.spec.ts
  ● Test suite failed to run

    [96msrc/domain/domain-primer.ts[0m:[93m33[0m:[93m37[0m - [91merror[0m[90m TS2307: [0mCannot find module '@capiro/shared' or its corresponding type declarations.

    [7m33[0m export { extractCitedPeCodes } from '@capiro/shared';
    [7m  [0m [91m                                    ~~~~~~~~~~~~~~~~[0m
    [96msrc/domain/domain-primer.ts[0m:[93m49[0m:[93m8[0m - [91merror[0m[90m TS2307: [0mCannot find module '@capiro/shared' or its corresponding type declarations.

    [7m49[0m } from '@capiro/shared';
    [7m  [0m [91m       ~~~~~~~~~~~~~~~~[0m


Test Suites: 16 failed, 14 passed, 30 total
Tests:       118 passed, 118 total
Snapshots:   0 total
Time:        10.088 s
Ran all test suites.
/home/runner/work/capirov2/capirov2/packages/meriv2-core:
 ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  @capiro/meriv2-core@0.0.0 test: `jest --detectOpenHandles --forceExit`
Exit status 1
exit_code=1
```
