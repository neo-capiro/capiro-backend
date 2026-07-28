# MeriV2 Phase 0 API Boundary Validation

Base commit: 1cdd372f0409986ac238beef2c4e9f310925fb37
Workflow run: https://github.com/neo-capiro/capirov2/actions/runs/30326882124
Result: FAIL

```text
$ pnpm --filter @capiro/shared build

> @capiro/shared@0.0.0 build /home/runner/work/capirov2/capirov2/packages/shared
> tsc -p tsconfig.json

exit_code=0
$ pnpm --filter @capiro/meriv2-core build

> @capiro/meriv2-core@0.0.0 build /home/runner/work/capirov2/capirov2/packages/meriv2-core
> tsc -p tsconfig.json

exit_code=0
$ pnpm --filter @capiro/api prisma:generate

> @capiro/api@0.0.0 prisma:generate /home/runner/work/capirov2/capirov2/apps/api
> prisma generate

Prisma schema loaded from prisma/schema.prisma

✔ Generated Prisma Client (v5.22.0) to ./../../node_modules/.pnpm/@prisma+client@5.22.0_prisma@5.22.0/node_modules/@prisma/client in 2.27s

Start by importing your Prisma Client (See: https://pris.ly/d/importing-client)

Tip: Curious about the SQL queries Prisma ORM generates? Optimize helps you enhance your visibility: https://pris.ly/tip-2-optimize

exit_code=0
$ pnpm --filter @capiro/meriv2-core typecheck

> @capiro/meriv2-core@0.0.0 typecheck /home/runner/work/capirov2/capirov2/packages/meriv2-core
> tsc -p tsconfig.json --noEmit

exit_code=0
$ pnpm --filter @capiro/meriv2-core test -- --runInBand src/compliance/action-approval.spec.ts src/compliance/compliance-rules.spec.ts

> @capiro/meriv2-core@0.0.0 test /home/runner/work/capirov2/capirov2/packages/meriv2-core
> jest --detectOpenHandles --forceExit "--runInBand" "src/compliance/action-approval.spec.ts" "src/compliance/compliance-rules.spec.ts"

FAIL src/compliance/compliance-rules.spec.ts
  ● PROPOSED_CAPIRO_RULES — the tiered production proposal › pre-approves internal artifacts + task bookkeeping (PASS, audited)

    expect(received).toBe(expected) // Object.is equality

    Expected: "PASS"
    Received: "WARN"

    [0m [90m 156 |[39m     ]) {
     [90m 157 |[39m       [36mconst[39m d [33m=[39m decide(policy[33m,[39m tool)[33m;[39m
    [31m[1m>[22m[39m[90m 158 |[39m       expect(d[33m.[39moutcome)[33m.[39mtoBe([32m'PASS'[39m)[33m;[39m
     [90m     |[39m                         [31m[1m^[22m[39m
     [90m 159 |[39m       expect(d[33m.[39mruleId)[33m.[39mtoBe([32m'internal_artifacts.pass'[39m)[33m;[39m
     [90m 160 |[39m     }
     [90m 161 |[39m   })[33m;[39m[0m

      at Object.<anonymous> (src/compliance/compliance-rules.spec.ts:158:25)

PASS src/compliance/action-approval.spec.ts

Test Suites: 1 failed, 1 passed, 2 total
Tests:       1 failed, 32 passed, 33 total
Snapshots:   0 total
Time:        2.79 s
Ran all test suites matching /src\/compliance\/action-approval.spec.ts|src\/compliance\/compliance-rules.spec.ts/i.
/home/runner/work/capirov2/capirov2/packages/meriv2-core:
 ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  @capiro/meriv2-core@0.0.0 test: `jest --detectOpenHandles --forceExit "--runInBand" "src/compliance/action-approval.spec.ts" "src/compliance/compliance-rules.spec.ts"`
Exit status 1
exit_code=1
$ pnpm --filter @capiro/api typecheck

> @capiro/api@0.0.0 typecheck /home/runner/work/capirov2/capirov2/apps/api
> tsc --noEmit

exit_code=0
$ pnpm --filter @capiro/api test -- --runInBand src/meri/meri-write-tool-input.spec.ts src/meri/tool-service-secret.guard.spec.ts src/meri/meri-approval.service.spec.ts

> @capiro/api@0.0.0 test /home/runner/work/capirov2/capirov2/apps/api
> jest --detectOpenHandles --forceExit "--runInBand" "src/meri/meri-write-tool-input.spec.ts" "src/meri/tool-service-secret.guard.spec.ts" "src/meri/meri-approval.service.spec.ts"

PASS src/meri/meri-write-tool-input.spec.ts (16.327 s)
PASS src/meri/tool-service-secret.guard.spec.ts
[33m[Nest] 2411  - [39m07/28/2026, 3:49:04 AM [33m   WARN[39m [38;5;3m[ToolServiceSecretGuard] [39m[33m[tool-service-secret] development/test observe mode denied identity was observed for POST /api/clio/tools/send_email[39m
[33m[Nest] 2411  - [39m07/28/2026, 3:49:04 AM [33m   WARN[39m [38;5;3m[ToolServiceSecretGuard] [39m[33m[tool-service-secret] development/test observe mode denied identity was observed for POST /api/clio/tools/send_email[39m
PASS src/meri/meri-approval.service.spec.ts

Test Suites: 3 passed, 3 total
Tests:       21 passed, 21 total
Snapshots:   0 total
Time:        23.137 s
Ran all test suites matching /src\/meri\/meri-write-tool-input.spec.ts|src\/meri\/tool-service-secret.guard.spec.ts|src\/meri\/meri-approval.service.spec.ts/i.
exit_code=0
```
