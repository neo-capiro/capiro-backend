# MeriV2 Phase 0 Memory Containment Validation

Base commit: 1cdd372f0409986ac238beef2c4e9f310925fb37
Workflow run: https://github.com/neo-capiro/capirov2/actions/runs/30327794692
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

✔ Generated Prisma Client (v5.22.0) to ./../../node_modules/.pnpm/@prisma+client@5.22.0_prisma@5.22.0/node_modules/@prisma/client in 2.28s

Start by importing your Prisma Client (See: https://pris.ly/d/importing-client)

Tip: Interested in query caching in just a few lines of code? Try Accelerate today! https://pris.ly/tip-3-accelerate

exit_code=0
$ pnpm --filter @capiro/api typecheck

> @capiro/api@0.0.0 typecheck /home/runner/work/capirov2/capirov2/apps/api
> tsc --noEmit

src/meri/meri-memory-legal-hold.spec.ts(41,19): error TS2554: Expected 13 arguments, but got 12.
src/meri/meri.service.ts(881,9): error TS2322: Type 'string | undefined' is not assignable to type 'string'.
  Type 'undefined' is not assignable to type 'string'.
src/meri/meriv2-routing.helpers.spec.ts(15,62): error TS2345: Argument of type '(input: { readonly bearerToken: null; readonly configured: boolean; readonly enabled: boolean; } | { readonly configured: false; readonly bearerToken: string; readonly enabled: boolean; } | { ...; } | { ...; }) => void' is not assignable to parameter of type '(...args: [{ readonly bearerToken: null; readonly configured: boolean; readonly enabled: boolean; }, "missing bearer"] | [{ readonly configured: false; readonly bearerToken: string; readonly enabled: boolean; }, "unconfigured orchestrator"] | [...] | [...]) => any'.
  Types of parameters 'input' and 'args' are incompatible.
    Type '[{ readonly bearerToken: null; readonly configured: boolean; readonly enabled: boolean; }, "missing bearer"] | [{ readonly configured: false; readonly bearerToken: string; readonly enabled: boolean; }, "unconfigured orchestrator"] | [...] | [...]' is not assignable to type '[input: { readonly bearerToken: null; readonly configured: boolean; readonly enabled: boolean; } | { readonly configured: false; readonly bearerToken: string; readonly enabled: boolean; } | { ...; } | { ...; }]'.
      Type '[{ readonly bearerToken: null; readonly configured: boolean; readonly enabled: boolean; }, "missing bearer"]' is not assignable to type '[input: { readonly bearerToken: null; readonly configured: boolean; readonly enabled: boolean; } | { readonly configured: false; readonly bearerToken: string; readonly enabled: boolean; } | { ...; } | { ...; }]'.
        Source has 2 element(s) but target allows only 1.
/home/runner/work/capirov2/capirov2/apps/api:
 ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  @capiro/api@0.0.0 typecheck: `tsc --noEmit`
Exit status 2
exit_code=2
$ pnpm --filter @capiro/api test -- --runInBand --logHeapUsage src/memory/memory-mutation-auth.spec.ts src/memory/memory-autolearn-governance.spec.ts src/memory/memory-candidate-rules.spec.ts src/memory/memory-store.mutation.spec.ts src/meri/meriv2-routing.helpers.spec.ts

> @capiro/api@0.0.0 test /home/runner/work/capirov2/capirov2/apps/api
> jest --detectOpenHandles --forceExit "--runInBand" "--logHeapUsage" "src/memory/memory-mutation-auth.spec.ts" "src/memory/memory-autolearn-governance.spec.ts" "src/memory/memory-candidate-rules.spec.ts" "src/memory/memory-store.mutation.spec.ts" "src/meri/meriv2-routing.helpers.spec.ts"

PASS src/memory/memory-store.mutation.spec.ts (20.938 s, 1746 MB heap size)
PASS src/memory/memory-candidate-rules.spec.ts (1784 MB heap size)
PASS src/memory/memory-mutation-auth.spec.ts (1801 MB heap size)
PASS src/memory/memory-autolearn-governance.spec.ts (1839 MB heap size)
FAIL src/meri/meriv2-routing.helpers.spec.ts
  ● Test suite failed to run

    [96msrc/meri/meriv2-routing.helpers.spec.ts[0m:[93m15[0m:[93m62[0m - [91merror[0m[90m TS2345: [0mArgument of type '(input: { readonly bearerToken: null; readonly configured: boolean; readonly enabled: boolean; } | { readonly configured: false; readonly bearerToken: string; readonly enabled: boolean; } | { ...; } | { ...; }) => void' is not assignable to parameter of type '(...args: [{ readonly bearerToken: null; readonly configured: boolean; readonly enabled: boolean; }, "missing bearer"] | [{ readonly configured: false; readonly bearerToken: string; readonly enabled: boolean; }, "unconfigured orchestrator"] | [...] | [...]) => any'.
      Types of parameters 'input' and 'args' are incompatible.
        Type '[{ readonly bearerToken: null; readonly configured: boolean; readonly enabled: boolean; }, "missing bearer"] | [{ readonly configured: false; readonly bearerToken: string; readonly enabled: boolean; }, "unconfigured orchestrator"] | [...] | [...]' is not assignable to type '[input: { readonly bearerToken: null; readonly configured: boolean; readonly enabled: boolean; } | { readonly configured: false; readonly bearerToken: string; readonly enabled: boolean; } | { ...; } | { ...; }]'.
          Type '[{ readonly bearerToken: null; readonly configured: boolean; readonly enabled: boolean; }, "missing bearer"]' is not assignable to type '[input: { readonly bearerToken: null; readonly configured: boolean; readonly enabled: boolean; } | { readonly configured: false; readonly bearerToken: string; readonly enabled: boolean; } | { ...; } | { ...; }]'.
            Source has 2 element(s) but target allows only 1.

    [7m15[0m   ] as const)('keeps the turn on the contained path for %s', (input) => {
    [7m  [0m [91m                                                             ~~~~~~~~~~~~[0m

Test Suites: 1 failed, 4 passed, 5 total
Tests:       45 passed, 45 total
Snapshots:   0 total
Time:        23.093 s
Ran all test suites matching /src\/memory\/memory-mutation-auth.spec.ts|src\/memory\/memory-autolearn-governance.spec.ts|src\/memory\/memory-candidate-rules.spec.ts|src\/memory\/memory-store.mutation.spec.ts|src\/meri\/meriv2-routing.helpers.spec.ts/i.
/home/runner/work/capirov2/capirov2/apps/api:
 ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  @capiro/api@0.0.0 test: `jest --detectOpenHandles --forceExit "--runInBand" "--logHeapUsage" "src/memory/memory-mutation-auth.spec.ts" "src/memory/memory-autolearn-governance.spec.ts" "src/memory/memory-candidate-rules.spec.ts" "src/memory/memory-store.mutation.spec.ts" "src/meri/meriv2-routing.helpers.spec.ts"`
Exit status 1
exit_code=1
```
